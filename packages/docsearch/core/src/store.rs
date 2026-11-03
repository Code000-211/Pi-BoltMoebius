//! Flat arrays that live either in memory (a fresh build) or in a mapped index file, so a saved
//! index is used where it lies: opening one reads nothing, and every process that maps the same
//! file shares its pages.

use std::hash::Hasher;
use std::io::Write;
use std::sync::Arc;

use memmap2::Mmap;

/// Plain values a byte image of the file can be read as.
pub trait Pod: Copy + Default + 'static {}
impl Pod for u8 {}
impl Pod for u16 {}
impl Pod for u32 {}
impl Pod for u64 {}
impl Pod for f32 {}

/// A `[T]` owned or in a mapped file.
pub enum Buf<T: Pod> {
    Owned(Vec<T>),
    Mapped { map: Arc<Mmap>, off: usize, len: usize },
}

impl<T: Pod> Default for Buf<T> {
    fn default() -> Self {
        Buf::Owned(Vec::new())
    }
}

impl<T: Pod> std::ops::Deref for Buf<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        match self {
            Buf::Owned(v) => v,
            // SAFETY: `Reader` checked that `off..off + len * size_of::<T>()` lies in the map and that
            // `off` is aligned for `T`; the map stays alive as long as this `Buf`, and is not written to.
            Buf::Mapped { map, off, len } => unsafe { std::slice::from_raw_parts(map.as_ptr().add(*off).cast::<T>(), *len) },
        }
    }
}

impl<T: Pod> From<Vec<T>> for Buf<T> {
    fn from(v: Vec<T>) -> Self {
        Buf::Owned(v)
    }
}

/// Lists of `u32`, the `i`-th being `val[off[i]..off[i + 1]]` (CSR).
#[derive(Default)]
pub struct Lists {
    pub off: Buf<u32>,
    pub val: Buf<u32>,
}

impl Lists {
    pub fn from_vecs<I: IntoIterator<Item = V>, V: AsRef<[u32]>>(lists: I) -> Lists {
        let mut off = vec![0u32];
        let mut val = Vec::new();
        for l in lists {
            val.extend_from_slice(l.as_ref());
            off.push(val.len() as u32);
        }
        Lists { off: off.into(), val: val.into() }
    }
    #[inline]
    pub fn get(&self, i: usize) -> &[u32] {
        &self.val[self.off[i] as usize..self.off[i + 1] as usize]
    }
    #[inline]
    pub fn len_of(&self, i: usize) -> usize {
        (self.off[i + 1] - self.off[i]) as usize
    }
    pub fn len(&self) -> usize {
        self.off.len().saturating_sub(1)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Byte strings, the `i`-th being `bytes[off[i]..off[i + 1]]`.
#[derive(Default)]
pub struct Strs {
    pub off: Buf<u32>,
    pub bytes: Buf<u8>,
}

impl Strs {
    pub fn from_iter<I: IntoIterator<Item = S>, S: AsRef<[u8]>>(items: I) -> Strs {
        let mut off = vec![0u32];
        let mut bytes = Vec::new();
        for s in items {
            bytes.extend_from_slice(s.as_ref());
            off.push(bytes.len() as u32);
        }
        Strs { off: off.into(), bytes: bytes.into() }
    }
    #[inline]
    pub fn bytes(&self, i: usize) -> &[u8] {
        &self.bytes[self.off[i] as usize..self.off[i + 1] as usize]
    }
    /// The `i`-th string. Only call it on tables built from `str`s.
    #[inline]
    pub fn str(&self, i: usize) -> &str {
        // SAFETY: tables read through `str` are built from Rust strings, and a mapped file is checked
        // as a whole (`Reader::utf8`) before it is used.
        unsafe { std::str::from_utf8_unchecked(self.bytes(i)) }
    }
    pub fn len(&self) -> usize {
        self.off.len().saturating_sub(1)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn hash(key: &[u8]) -> u64 {
    let mut h = rustc_hash::FxHasher::default();
    h.write(key);
    h.finish()
}

/// String -> `u32`, as an open-addressing table over `keys`, usable straight from the file.
#[derive(Default)]
pub struct StrMap {
    pub keys: Strs,
    pub vals: Buf<u32>,
    /// `0` is empty, else the key's index + 1. A power of two, at most half full.
    pub slots: Buf<u32>,
}

impl StrMap {
    pub fn build(entries: Vec<(String, u32)>) -> StrMap {
        let n = entries.len();
        let cap = (n * 2).next_power_of_two().max(8);
        let mask = cap - 1;
        let mut slots = vec![0u32; cap];
        for (i, (k, _)) in entries.iter().enumerate() {
            let mut at = hash(k.as_bytes()) as usize & mask;
            while slots[at] != 0 {
                at = (at + 1) & mask;
            }
            slots[at] = i as u32 + 1;
        }
        let vals = entries.iter().map(|e| e.1).collect::<Vec<_>>();
        StrMap { keys: Strs::from_iter(entries.iter().map(|e| e.0.as_bytes())), vals: vals.into(), slots: slots.into() }
    }
    #[inline]
    pub fn get(&self, key: &str) -> Option<u32> {
        let mask = self.slots.len().checked_sub(1)?;
        let mut at = hash(key.as_bytes()) as usize & mask;
        loop {
            let s = self.slots[at];
            if s == 0 {
                return None;
            }
            if self.keys.bytes(s as usize - 1) == key.as_bytes() {
                return Some(self.vals[s as usize - 1]);
            }
            at = (at + 1) & mask;
        }
    }
    pub fn len(&self) -> usize {
        self.keys.len()
    }
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// Writes arrays one after another, each as its byte length (u64) and its bytes, padded to 8.
pub struct Writer<W: Write> {
    out: W,
}

impl<W: Write> Writer<W> {
    pub fn new(out: W) -> Self {
        Writer { out }
    }
    pub fn buf<T: Pod>(&mut self, v: &[T]) -> std::io::Result<()> {
        // SAFETY: `T` is one of the plain number types above; their bytes are their value.
        let bytes = unsafe { std::slice::from_raw_parts(v.as_ptr().cast::<u8>(), std::mem::size_of_val(v)) };
        self.out.write_all(&(bytes.len() as u64).to_le_bytes())?;
        self.out.write_all(bytes)?;
        let pad = (8 - bytes.len() % 8) % 8;
        self.out.write_all(&[0u8; 8][..pad])
    }
    pub fn lists(&mut self, l: &Lists) -> std::io::Result<()> {
        self.buf(&l.off)?;
        self.buf(&l.val)
    }
    pub fn strs(&mut self, s: &Strs) -> std::io::Result<()> {
        self.buf(&s.off)?;
        self.buf(&s.bytes)
    }
    pub fn map(&mut self, m: &StrMap) -> std::io::Result<()> {
        self.strs(&m.keys)?;
        self.buf(&m.vals)?;
        self.buf(&m.slots)
    }
    pub fn into_inner(self) -> W {
        self.out
    }
}

/// Reads what `Writer` wrote, as views into the map.
pub struct Reader {
    map: Arc<Mmap>,
    at: usize,
}

#[derive(Debug)]
pub struct BadFile;

impl Reader {
    pub fn new(map: Arc<Mmap>, start: usize) -> Self {
        Reader { map, at: start }
    }
    pub fn buf<T: Pod>(&mut self) -> Result<Buf<T>, BadFile> {
        let size = std::mem::size_of::<T>();
        let head = self.map.get(self.at..self.at + 8).ok_or(BadFile)?;
        let n = u64::from_le_bytes(head.try_into().unwrap()) as usize;
        let off = self.at + 8;
        if n % size != 0 || off % std::mem::align_of::<T>() != 0 || off.checked_add(n).is_none_or(|e| e > self.map.len()) {
            return Err(BadFile);
        }
        self.at = off + n + (8 - n % 8) % 8;
        Ok(Buf::Mapped { map: Arc::clone(&self.map), off, len: n / size })
    }
    pub fn lists(&mut self) -> Result<Lists, BadFile> {
        let l = Lists { off: self.buf()?, val: self.buf()? };
        check_offsets(&l.off, l.val.len())?;
        Ok(l)
    }
    pub fn strs(&mut self) -> Result<Strs, BadFile> {
        let s = Strs { off: self.buf()?, bytes: self.buf()? };
        check_offsets(&s.off, s.bytes.len())?;
        Ok(s)
    }
    /// A table read through `Strs::str`: its bytes must be UTF-8 where the offsets cut them.
    pub fn utf8(&mut self) -> Result<Strs, BadFile> {
        let s = self.strs()?;
        for i in 0..s.len() {
            std::str::from_utf8(s.bytes(i)).map_err(|_| BadFile)?;
        }
        Ok(s)
    }
    pub fn map(&mut self) -> Result<StrMap, BadFile> {
        let m = StrMap { keys: self.strs()?, vals: self.buf()?, slots: self.buf()? };
        if m.vals.len() != m.keys.len() || !m.slots.len().is_power_of_two() || m.slots.iter().any(|&s| s as usize > m.keys.len()) {
            return Err(BadFile);
        }
        Ok(m)
    }
}

/// Offsets that start at 0, never fall and end at `len`, so every `get` stays in bounds.
fn check_offsets(off: &[u32], len: usize) -> Result<(), BadFile> {
    let ok = off.first() == Some(&0) && off.windows(2).all(|w| w[0] <= w[1]) && off.last().is_some_and(|&l| l as usize == len);
    if ok { Ok(()) } else { Err(BadFile) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strmap_finds_every_key_and_nothing_else() {
        let m = StrMap::build((0..1000).map(|i| (format!("k{i}"), i * 3)).collect());
        for i in 0..1000 {
            assert_eq!(m.get(&format!("k{i}")), Some(i * 3));
        }
        assert_eq!(m.get("nope"), None);
        assert_eq!(StrMap::default().get("x"), None);
    }
}
