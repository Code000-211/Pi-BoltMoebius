//! The in-memory index: BM25 over sections, plus a section–entity graph searched with
//! personalized PageRank (HippoRAG's retrieval, without an LLM at query time).

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::store::{BadFile, Buf, Lists, Reader, StrMap, Strs, Writer};
use crate::{chunk, text};

pub struct Config {
    pub roots: Vec<PathBuf>,
    /// File extensions to index, lowercase, without the dot.
    pub extensions: Vec<String>,
    pub max_file_bytes: u64,
    pub max_files: usize,
    /// Entities from a model, merged with the rule-based ones.
    pub extra_entities: Option<std::sync::Arc<ExtraEntities>>,
}

/// One section, as the index holds it.
#[derive(Clone, Copy)]
pub struct SectionRef<'a> {
    pub file: u32,
    pub heading: &'a str,
    pub text: &'a str,
    /// 1-based, inclusive.
    pub line_start: u32,
    pub line_end: u32,
}

pub struct Hit<'a> {
    /// The section's number, for `Index::section`.
    pub id: u32,
    pub section: SectionRef<'a>,
    pub path: &'a Path,
    pub score: f32,
    /// Share of the query's terms the section contains, weighted by rarity, 0..=1. Words the
    /// index does not know count as missing.
    pub coverage: f32,
    /// How many of the entities the query names the section mentions, hubs left out.
    pub named: u32,
}

pub struct Results<'a> {
    pub hits: Vec<Hit<'a>>,
    /// The entities of the index the query names.
    pub entities: Vec<&'a str>,
    /// Distinct terms in the query.
    pub query_terms: usize,
}

pub struct SearchOpts<'a> {
    pub k: usize,
    pub path_prefix: Option<&'a Path>,
    pub max_per_file: usize,
    /// Rank with the entity graph as well as BM25 (off only to measure what the graph adds).
    pub graph: bool,
}

/// (path, modified, size) of every indexed file, to tell whether the index is stale.
pub type Signature = Vec<(PathBuf, SystemTime, u64)>;

/// The index, as flat arrays (see `store`): in memory after a build, in a mapped file after `load`.
/// Sections are numbered 0..n, entities n.. in the walk's graph.
pub struct Index {
    pub build_ms: u32,
    hub_limit: usize,
    /// Average section length in terms, which BM25's length norm divides by.
    avg_len: f32,
    // Files, and what they were when indexed.
    files: Strs,
    file_mtime: Buf<u64>,
    file_size: Buf<u64>,
    // Sections, a column each.
    sec_file: Buf<u32>,
    sec_start: Buf<u32>,
    sec_end: Buf<u32>,
    sec_heading: Strs,
    sec_text: Strs,
    sec_terms: Lists,
    /// Terms of the heading path, a subset of the section's terms.
    sec_heading_terms: Lists,
    sec_entities: Lists,
    /// term -> id; `post.get(id)` are its sections and `post_w` the term's BM25 weight in each, in
    /// the same order. The weight depends only on the index, so it is worked out when it is built.
    terms: StrMap,
    post: Lists,
    post_w: Buf<f32>,
    entity_names: Strs,
    /// Lowercased entity name, or its words joined by spaces -> entity, to find what a query names.
    entity_keys: StrMap,
    /// entity -> sections
    entity_sections: Lists,
    /// Lowercased name a code section defines (the last part of its heading) -> `def_sections`.
    defs: StrMap,
    def_sections: Lists,
    /// The walk's graph: the neighbours of node `u` are `graph.get(u)`, hubs already left out.
    graph: Lists,
}

/// A small index of changed files laid over a large one (see `Index::search_with`).
pub struct Overlay {
    /// The changed and added files, built with the large index's statistics.
    pub index: Index,
    /// Per section of the large index: whether its file was changed or removed since.
    pub excluded: Vec<bool>,
}

struct Ranked {
    ranked: Vec<(u32, f32)>,
    q_entities: Vec<u32>,
    qids: Vec<u32>,
    /// The query's terms as the delta numbers them, with their idf.
    dq: FxHashMap<u32, f32>,
    idf_total: f32,
    n_terms: usize,
    /// The first id of a delta section.
    d0: usize,
}

/// Per-thread buffers a search reuses, all zero outside the entries it lists as touched, so a
/// search costs what it touches rather than the size of the index.
#[derive(Default)]
struct Scratch {
    /// Per section: BM25 so far and how many query terms it has, side by side (one cache line).
    acc: Vec<(f32, u32)>,
    /// Per term: its idf when it is in the query, else 0.
    qidf: Vec<f32>,
    lexical: Vec<u32>,
    p: Vec<f32>,
    r: Vec<f32>,
    walked: Vec<u32>,
    queue: Vec<u32>,
    score: Vec<f32>,
    scored: Vec<u32>,
    together: Vec<u16>,
}

thread_local! {
    static SCRATCH: std::cell::RefCell<Scratch> = std::cell::RefCell::default();
}

/// Puts the `k` best of `v` (highest score, then lowest id) first, in order; the rest follows unordered.
fn top_sorted(v: &mut [(u32, f32)], k: usize) {
    let better = |a: &(u32, f32), b: &(u32, f32)| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0));
    if v.len() > k {
        v.select_nth_unstable_by(k, better);
        v[..k].sort_unstable_by(better);
    } else {
        v.sort_unstable_by(better);
    }
}

fn grow<T: Default + Clone>(v: &mut Vec<T>, len: usize) {
    if v.len() < len {
        v.resize(len, T::default());
    }
}

const K1: f32 = 1.2;
const B: f32 = 0.75;
/// Length normalisation for code sections: a long function is not padding the way a long page is.
const B_CODE: f32 = 0.5;
const HEADING_BOOST: u16 = 2;

/// Names found outside the index (by a NER model), keyed by `section_key` of the section's text.
pub type ExtraEntities = FxHashMap<u64, Vec<String>>;

/// A stable key for a section's text, to attach entities found by a model to it.
pub fn section_key(text: &str) -> u64 {
    use std::hash::Hasher;
    let mut h = rustc_hash::FxHasher::default();
    h.write(text.as_bytes());
    h.finish()
}

/// Lists the files under the roots that the index takes, honouring .gitignore and hidden files.
pub fn scan(cfg: &Config) -> Signature {
    let mut seen = FxHashSet::default();
    let mut out = Vec::new();
    for root in &cfg.roots {
        let walker = ignore::WalkBuilder::new(root).follow_links(false).build();
        for entry in walker.flatten() {
            if out.len() >= cfg.max_files {
                return out;
            }
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
            if !ext.is_some_and(|e| cfg.extensions.contains(&e)) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() == 0 || meta.len() > cfg.max_file_bytes || !seen.insert(path.to_path_buf()) {
                continue;
            }
            out.push((path.to_path_buf(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()));
        }
    }
    out
}

/// A path as the index stores it: the system's bytes on Unix, UTF-8 elsewhere (Windows).
#[cfg(unix)]
fn path_bytes(path: &Path) -> Cow<'_, [u8]> {
    use std::os::unix::ffi::OsStrExt;
    Cow::Borrowed(path.as_os_str().as_bytes())
}

#[cfg(not(unix))]
fn path_bytes(path: &Path) -> Cow<'_, [u8]> {
    match path.to_string_lossy() {
        Cow::Borrowed(s) => Cow::Borrowed(s.as_bytes()),
        Cow::Owned(s) => Cow::Owned(s.into_bytes()),
    }
}

#[cfg(unix)]
fn bytes_path(bytes: &[u8]) -> &Path {
    use std::os::unix::ffi::OsStrExt;
    Path::new(std::ffi::OsStr::from_bytes(bytes))
}

#[cfg(not(unix))]
fn bytes_path(bytes: &[u8]) -> &Path {
    Path::new(std::str::from_utf8(bytes).unwrap_or(""))
}

/// The language of a source file, split at its definitions rather than at headings.
fn code_lang(path: &Path) -> Option<chunk::Lang> {
    chunk::Lang::of(&path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase())
}

fn is_code(path: &Path) -> bool {
    code_lang(path).is_some()
}

struct Parsed {
    heading: String,
    line_start: u32,
    line_end: u32,
    text: String,
    terms: Vec<(String, u16)>,
    heading_terms: Vec<String>,
    len: u32,
    entities: Vec<String>,
}

fn parse_file(path: &Path, extra: Option<&ExtraEntities>) -> Vec<Parsed> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Vec::new(); // binary
    }
    let content = String::from_utf8_lossy(&bytes);
    let markdown = path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        matches!(e.to_ascii_lowercase().as_str(), "md" | "mdx" | "markdown")
    });
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let mut name_terms = Vec::new();
    text::terms(name.rsplit_once('.').map_or(name, |(stem, _)| stem), &mut name_terms);

    let chunks = match code_lang(path) {
        Some(lang) => chunk::split_code(&content, lang),
        None => chunk::split(&content, markdown),
    };
    let n_chunks = chunks.len();
    chunks
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let mut tf: FxHashMap<String, u16> = FxHashMap::default();
            let mut buf = Vec::new();
            text::terms(&c.text, &mut buf);
            let len = buf.len() as u32;
            for t in buf.drain(..) {
                *tf.entry(t).or_default() += 1;
            }
            text::terms(&c.heading, &mut buf);
            let mut heading_terms = buf.clone();
            heading_terms.sort_unstable();
            heading_terms.dedup();
            buf.extend(name_terms.iter().cloned());
            for t in buf.drain(..) {
                *tf.entry(t).or_default() += HEADING_BOOST;
            }
            let mut entities = Vec::new();
            text::entities(&c.text, &mut entities);
            if let Some(found) = extra.and_then(|x| x.get(&section_key(&c.text))) {
                entities.extend(found.iter().cloned());
            }
            if i == 0 || n_chunks == 1 {
                // The file's own name, so links to it reach it, and its stem when that is a
                // name itself (TP4.md -> "tp4").
                entities.push(name.to_lowercase());
                if let Some((stem, _)) = name.rsplit_once('.') {
                    if text::is_entity_word(stem) {
                        entities.push(stem.to_lowercase());
                    }
                }
            }
            entities.sort_unstable();
            entities.dedup();
            Parsed {
                heading: c.heading,
                line_start: c.line_start,
                line_end: c.line_end,
                text: c.text,
                terms: tf.into_iter().map(|(t, n)| (t, n.max(1))).collect(),
                heading_terms,
                len: len.max(1),
                entities,
            }
        })
        .collect()
}

/// Bumped whenever the file layout or what goes into it changes, so an old file is rebuilt.
const FORMAT: u64 = 3;
const MAGIC: &[u8; 8] = b"DSINDEX\0";

fn nanos(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64)
}

impl Index {
    pub fn build(cfg: &Config) -> Index {
        Self::build_from(cfg, scan(cfg), None)
    }

    /// An index of just these files. With `base`, its weights use the base's statistics (number of
    /// sections, document frequencies, average length), so its scores compare with the base's: that
    /// is how a few changed files are searched beside a large index without rebuilding it.
    pub fn build_from(cfg: &Config, signature: Signature, base: Option<&Index>) -> Index {
        let t0 = Instant::now();
        let parsed: Vec<Vec<Parsed>> = signature.par_iter().map(|(p, _, _)| parse_file(p, cfg.extra_entities.as_deref())).collect();

        let mut term_ids: FxHashMap<String, u32> = FxHashMap::default();
        let mut postings: Vec<Vec<(u32, u16)>> = Vec::new();
        let mut entity_ids: FxHashMap<String, u32> = FxHashMap::default();
        let mut entity_names: Vec<String> = Vec::new();
        let mut entity_sections: Vec<Vec<u32>> = Vec::new();
        let (mut sec_file, mut sec_start, mut sec_end, mut sec_len) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let (mut sec_heading, mut sec_text) = (Vec::new(), Vec::new());
        let (mut sec_terms, mut sec_heading_terms, mut sec_entities) = (Vec::new(), Vec::new(), Vec::new());
        let mut total_len = 0u64;

        for (file, chunks) in parsed.into_iter().enumerate() {
            for p in chunks {
                let sid = sec_file.len() as u32;
                let mut terms = Vec::with_capacity(p.terms.len());
                for (t, n) in p.terms {
                    let next = term_ids.len() as u32;
                    let id = *term_ids.entry(t).or_insert(next);
                    if id as usize == postings.len() {
                        postings.push(Vec::new());
                    }
                    postings[id as usize].push((sid, n));
                    terms.push(id);
                }
                let heading_terms: Vec<u32> = p.heading_terms.iter().filter_map(|t| term_ids.get(t).copied()).collect();
                let mut ents = Vec::with_capacity(p.entities.len());
                for e in p.entities {
                    let next = entity_ids.len() as u32;
                    let id = *entity_ids.entry(e.clone()).or_insert(next);
                    if id as usize == entity_names.len() {
                        entity_names.push(e);
                        entity_sections.push(Vec::new());
                    }
                    entity_sections[id as usize].push(sid);
                    ents.push(id);
                }
                total_len += p.len as u64;
                sec_file.push(file as u32);
                sec_start.push(p.line_start);
                sec_end.push(p.line_end);
                sec_len.push(p.len);
                sec_heading.push(p.heading);
                sec_text.push(p.text);
                sec_terms.push(terms);
                sec_heading_terms.push(heading_terms);
                sec_entities.push(ents);
            }
        }

        // A name written with punctuation between its words (`gen_stubs.py --check`) is also found
        // under its words alone, as `query_entities` joins a query's words.
        let aliases: Vec<(String, u32)> = entity_names
            .iter()
            .enumerate()
            .filter_map(|(id, name)| {
                let mut words = Vec::new();
                text::raw_words(name, |w| words.push(w));
                let key = words.join(" ");
                (key != *name && !key.is_empty()).then_some((key, id as u32))
            })
            .collect();
        for (key, id) in aliases {
            entity_ids.entry(key).or_insert(id);
        }
        let mut definitions: FxHashMap<String, Vec<u32>> = FxHashMap::default();
        for (i, heading) in sec_heading.iter().enumerate() {
            // Only code: a one-word Markdown heading ("Examples") defines nothing.
            if !is_code(&signature[sec_file[i] as usize].0) {
                continue;
            }
            let last = heading.rsplit(" › ").next().unwrap_or("");
            let name = last.rsplit("::").next().unwrap_or(last).trim_start_matches('~');
            if name.len() >= 3 && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                definitions.entry(name.to_lowercase()).or_default().push(i as u32);
            }
        }
        let ns = sec_file.len();
        let n = ns.max(1);
        let hub_limit = (n / 40).max(30);
        // The graph: a section's entities that are not hubs and its neighbours in the file; an
        // entity's sections unless it is a hub.
        let mut graph_off = Vec::with_capacity(ns + entity_sections.len() + 1);
        let mut adjacency = Vec::new();
        graph_off.push(0u32);
        for (u, ents) in sec_entities.iter().enumerate() {
            for &e in ents {
                if entity_sections[e as usize].len() <= hub_limit {
                    adjacency.push((ns + e as usize) as u32);
                }
            }
            if u > 0 && sec_file[u - 1] == sec_file[u] {
                adjacency.push(u as u32 - 1);
            }
            if u + 1 < ns && sec_file[u + 1] == sec_file[u] {
                adjacency.push(u as u32 + 1);
            }
            graph_off.push(adjacency.len() as u32);
        }
        for list in &entity_sections {
            if list.len() <= hub_limit {
                adjacency.extend_from_slice(list);
            }
            graph_off.push(adjacency.len() as u32);
        }
        let avg_len = base.map_or(total_len as f32 / n as f32, |b| b.avg_len);
        let len_norm: Vec<f32> = (0..ns)
            .map(|s| {
                let b = if is_code(&signature[sec_file[s] as usize].0) { B_CODE } else { B };
                K1 * (1.0 - b + b * sec_len[s] as f32 / avg_len)
            })
            .collect();

        let post = Lists::from_vecs(postings.iter().map(|p| p.iter().map(|x| x.0).collect::<Vec<u32>>()));
        // BM25 per posting, as a search would compute it: idf × tf (k1 + 1) / (tf + length norm).
        let nf = base.map_or(ns, |b| b.section_count()) as f32;
        let base_df: Vec<Option<usize>> = match base {
            None => Vec::new(),
            Some(b) => {
                let mut df = vec![None; term_ids.len()];
                for (t, &id) in &term_ids {
                    df[id as usize] = b.terms.get(t).map(|bt| b.post.len_of(bt as usize));
                }
                df
            }
        };
        let post_w: Vec<f32> = postings
            .iter()
            .enumerate()
            .flat_map(|(id, p)| {
                let df = base_df.get(id).copied().flatten().unwrap_or(p.len()) as f32;
                let term_idf = ((nf - df + 0.5) / (df + 0.5) + 1.0).ln();
                let len_norm = &len_norm;
                p.iter().map(move |&(s, tf)| {
                    let tf = tf as f32;
                    term_idf * tf * (K1 + 1.0) / (tf + len_norm[s as usize])
                })
            })
            .collect();
        let (def_names, def_lists): (Vec<String>, Vec<Vec<u32>>) = definitions.into_iter().unzip();
        Index {
            hub_limit,
            avg_len,
            files: Strs::from_iter(signature.iter().map(|(p, _, _)| path_bytes(p))),
            file_mtime: signature.iter().map(|x| nanos(x.1)).collect::<Vec<_>>().into(),
            file_size: signature.iter().map(|x| x.2).collect::<Vec<_>>().into(),
            sec_file: sec_file.into(),
            sec_start: sec_start.into(),
            sec_end: sec_end.into(),
            sec_heading: Strs::from_iter(sec_heading.iter().map(|s| s.as_bytes())),
            sec_text: Strs::from_iter(sec_text.iter().map(|s| s.as_bytes())),
            sec_terms: Lists::from_vecs(&sec_terms),
            sec_heading_terms: Lists::from_vecs(&sec_heading_terms),
            sec_entities: Lists::from_vecs(&sec_entities),
            terms: StrMap::build(term_ids.into_iter().collect()),
            post,
            post_w: post_w.into(),
            entity_names: Strs::from_iter(entity_names.iter().map(|s| s.as_bytes())),
            entity_keys: StrMap::build(entity_ids.into_iter().collect()),
            entity_sections: Lists::from_vecs(&entity_sections),
            defs: StrMap::build(def_names.into_iter().enumerate().map(|(i, n)| (n, i as u32)).collect()),
            def_sections: Lists::from_vecs(&def_lists),
            graph: Lists { off: graph_off.into(), val: adjacency.into() },
            build_ms: t0.elapsed().as_millis() as u32,
        }
    }

    /// Writes the index to `path` (through a temporary file renamed over it, so a reader never
    /// sees half a file).
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let tmp = path.with_extension(format!("tmp{}", std::process::id()));
        let file = std::fs::File::create(&tmp)?;
        let mut w = Writer::new(std::io::BufWriter::with_capacity(1 << 20, file));
        w.buf(&u64::from_le_bytes(*MAGIC).to_le_bytes())?;
        w.buf(&[FORMAT, self.hub_limit as u64, self.build_ms as u64, self.avg_len.to_bits() as u64])?;
        w.strs(&self.files)?;
        w.buf(&self.file_mtime)?;
        w.buf(&self.file_size)?;
        w.buf(&self.sec_file)?;
        w.buf(&self.sec_start)?;
        w.buf(&self.sec_end)?;
        w.strs(&self.sec_heading)?;
        w.strs(&self.sec_text)?;
        w.lists(&self.sec_terms)?;
        w.lists(&self.sec_heading_terms)?;
        w.lists(&self.sec_entities)?;
        w.map(&self.terms)?;
        w.lists(&self.post)?;
        w.buf(&self.post_w)?;
        w.strs(&self.entity_names)?;
        w.map(&self.entity_keys)?;
        w.lists(&self.entity_sections)?;
        w.map(&self.defs)?;
        w.lists(&self.def_sections)?;
        w.lists(&self.graph)?;
        let file = w.into_inner().into_inner().map_err(|e| e.into_error())?;
        file.sync_data()?;
        std::fs::rename(&tmp, path)
    }

    /// Maps a file `save` wrote. Nothing is read until a search touches it, and every process that
    /// maps the same file shares its pages. A file of another format, or damaged, is refused.
    pub fn load(path: &Path) -> Result<Index, BadFile> {
        let file = std::fs::File::open(path).map_err(|_| BadFile)?;
        // SAFETY: the file is only ever replaced by renaming a new one over it, never written in
        // place, so the mapped pages do not change under us.
        let map = std::sync::Arc::new(unsafe { memmap2::Mmap::map(&file) }.map_err(|_| BadFile)?);
        let mut r = Reader::new(map, 0);
        let magic: Buf<u8> = r.buf()?;
        if magic.get(..8) != Some(MAGIC.as_slice()) {
            return Err(BadFile);
        }
        let head: Buf<u64> = r.buf()?;
        if head.len() != 4 || head[0] != FORMAT {
            return Err(BadFile);
        }
        let ix = Index {
            hub_limit: head[1] as usize,
            build_ms: head[2] as u32,
            avg_len: f32::from_bits(head[3] as u32),
            files: r.strs()?,
            file_mtime: r.buf()?,
            file_size: r.buf()?,
            sec_file: r.buf()?,
            sec_start: r.buf()?,
            sec_end: r.buf()?,
            sec_heading: r.utf8()?,
            sec_text: r.utf8()?,
            sec_terms: r.lists()?,
            sec_heading_terms: r.lists()?,
            sec_entities: r.lists()?,
            terms: r.map()?,
            post: r.lists()?,
            post_w: r.buf()?,
            entity_names: r.utf8()?,
            entity_keys: r.map()?,
            entity_sections: r.lists()?,
            defs: r.map()?,
            def_sections: r.lists()?,
            graph: r.lists()?,
        };
        ix.check().then_some(ix).ok_or(BadFile)
    }

    /// That the arrays agree in length and every id stays in bounds, so a search cannot index past
    /// an array of a damaged file.
    fn check(&self) -> bool {
        let (nf, ns, nt, ne) = (self.files.len(), self.sec_file.len(), self.post.len(), self.entity_names.len());
        let ids_below = |l: &Lists, n: usize| l.val.iter().all(|&v| (v as usize) < n);
        let vals_below = |m: &StrMap, n: usize| m.vals.iter().all(|&v| (v as usize) < n);
        self.file_mtime.len() == nf
            && self.file_size.len() == nf
            && [self.sec_start.len(), self.sec_end.len(), self.sec_heading.len(), self.sec_text.len()].iter().all(|&l| l == ns)
            && [self.sec_terms.len(), self.sec_heading_terms.len(), self.sec_entities.len()].iter().all(|&l| l == ns)
            && self.sec_file.iter().all(|&f| (f as usize) < nf)
            && ids_below(&self.sec_terms, nt)
            && ids_below(&self.sec_heading_terms, nt)
            && ids_below(&self.sec_entities, ne)
            && self.post_w.len() == self.post.val.len()
            && ids_below(&self.post, ns)
            && vals_below(&self.terms, nt)
            && self.entity_sections.len() == ne
            && ids_below(&self.entity_sections, ns)
            && vals_below(&self.entity_keys, ne)
            && vals_below(&self.defs, self.def_sections.len())
            && ids_below(&self.def_sections, ns)
            && self.graph.len() == ns + ne
            && ids_below(&self.graph, ns + ne)
    }

    /// What changed since this index was built: the files of `sig` that are new or differ, and per
    /// file of this index whether it changed or is gone.
    pub fn diff(&self, sig: &Signature) -> (Signature, Vec<bool>) {
        let by_path: FxHashMap<&[u8], usize> = (0..self.files.len()).map(|i| (self.files.bytes(i), i)).collect();
        let mut gone = vec![true; self.files.len()];
        let mut changed = Vec::new();
        for (p, t, size) in sig {
            match by_path.get(path_bytes(p).as_ref()) {
                Some(&i) if self.file_mtime[i] == nanos(*t) && self.file_size[i] == *size => gone[i] = false,
                Some(&i) => {
                    gone[i] = true;
                    changed.push((p.clone(), *t, *size));
                }
                None => changed.push((p.clone(), *t, *size)),
            }
        }
        (changed, gone)
    }

    /// Per section, whether its file is one of `files`.
    pub fn sections_in(&self, files: &[bool]) -> Vec<bool> {
        self.sec_file.iter().map(|&f| files[f as usize]).collect()
    }

    /// Whether the index was built from exactly these files, as `scan` lists them now.
    pub fn matches(&self, sig: &Signature) -> bool {
        sig.len() == self.files.len()
            && sig.iter().enumerate().all(|(i, (p, t, size))| {
                self.files.bytes(i) == path_bytes(p).as_ref() && self.file_mtime[i] == nanos(*t) && self.file_size[i] == *size
            })
    }

    pub fn section_count(&self) -> usize {
        self.sec_file.len()
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn file_path(&self, i: usize) -> &Path {
        bytes_path(self.files.bytes(i))
    }

    pub fn section(&self, s: usize) -> SectionRef<'_> {
        SectionRef {
            file: self.sec_file[s],
            heading: self.sec_heading.str(s),
            text: self.sec_text.str(s),
            line_start: self.sec_start[s],
            line_end: self.sec_end[s],
        }
    }

    pub fn term_count(&self) -> usize {
        self.terms.len()
    }

    pub fn entity_count(&self) -> usize {
        self.entity_names.len()
    }

    /// The entities a query mentions: runs of up to five of its words that name one (the longest
    /// at each word wins, as a leftmost-longest match would), and for a compound word that names
    /// none, its parts (`dflash2-b16` -> `dflash2`).
    fn query_entities(&self, query: &str) -> Vec<u32> {
        let q = query.to_lowercase();
        let mut words: Vec<&str> = Vec::new();
        text::raw_words(&q, |w| words.push(w));
        let mut out = Vec::new();
        let mut key = String::new();
        let mut i = 0;
        while i < words.len() {
            let mut taken = 0;
            for span in (1..=5.min(words.len() - i)).rev() {
                key.clear();
                for (j, w) in words[i..i + span].iter().enumerate() {
                    if j > 0 {
                        key.push(' ');
                    }
                    key.push_str(w);
                }
                if let Some(id) = self.entity_keys.get(&key) {
                    out.push(id);
                    taken = span;
                    break;
                }
            }
            if taken == 0 {
                for part in words[i].split(['_', '-', '.', '/', ':', '+']).filter(|p| !p.is_empty() && *p != words[i]) {
                    if let Some(id) = self.entity_keys.get(part) {
                        out.push(id);
                    }
                }
            }
            i += taken.max(1);
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    pub fn search<'a>(&'a self, query: &str, opts: &SearchOpts) -> Results<'a> {
        self.search_with(None, query, opts)
    }

    /// Searches this index with `delta` laid over it: the sections of the files `delta` replaces
    /// are left out, and its own sections, scored with this index's statistics, compete with the rest.
    pub fn search_with<'a>(&'a self, delta: Option<&'a Overlay>, query: &str, opts: &SearchOpts) -> Results<'a> {
        if self.section_count() == 0 && delta.is_none_or(|o| o.index.section_count() == 0) {
            return Results { hits: Vec::new(), entities: Vec::new(), query_terms: 0 };
        }
        let query = text::with_translations(query);
        let r = self.rank(delta, &query, opts);
        self.collect(delta, r, opts)
    }

    fn rank(&self, delta: Option<&Overlay>, query: &str, opts: &SearchOpts) -> Ranked {
        let n = self.section_count();
        // Delta sections are numbered after every node of the walk's graph.
        let d0 = self.graph.len().max(n);
        let nd = delta.map_or(0, |o| o.index.section_count());
        let mut qterms = Vec::new();
        text::terms(query, &mut qterms);
        qterms.sort_unstable();
        qterms.dedup();
        let qids: Vec<u32> = qterms.iter().filter_map(|t| self.terms.get(t)).collect();
        let n_query = qterms.len().max(1) as f32;
        let idf = |df: f32| ((n as f32 - df + 0.5) / (df + 0.5) + 1.0).ln();
        // A term's frequency is the base's; a term only the delta has counts as it does there.
        let delta_df = |t: &str| delta.and_then(|o| o.index.terms.get(t).map(|id| o.index.post.len_of(id as usize)));
        let idf_total: f32 = qterms
            .iter()
            .map(|t| idf(self.terms.get(t).map(|id| self.post.len_of(id as usize)).or_else(|| delta_df(t)).unwrap_or(0) as f32))
            .sum::<f32>()
            .max(1e-6);
        let dq: FxHashMap<u32, f32> = match delta {
            None => FxHashMap::default(),
            Some(o) => qterms
                .iter()
                .filter_map(|t| {
                    let id = o.index.terms.get(t)?;
                    let df = self.terms.get(t).map_or(o.index.post.len_of(id as usize), |b| self.post.len_of(b as usize));
                    Some((id, idf(df as f32)))
                })
                .collect(),
        };

        SCRATCH.with(|cell| {
        let sc = &mut *cell.borrow_mut();
        let nodes = self.graph.len();
        let ids = if nd > 0 { d0 + nd } else { n };
        grow(&mut sc.acc, ids);
        grow(&mut sc.qidf, self.terms.len());
        for &t in &qids {
            sc.qidf[t as usize] = idf(self.post.len_of(t as usize) as f32);
        }
        grow(&mut sc.score, ids);
        grow(&mut sc.together, n);
        grow(&mut sc.p, nodes);
        grow(&mut sc.r, nodes);
        let excluded = delta.map(|o| o.excluded.as_slice());

        // BM25, with the share of query terms matched kept for coordination and the caller.
        for &t in &qids {
            let (a, b) = (self.post.off[t as usize] as usize, self.post.off[t as usize + 1] as usize);
            for (&s, &w) in self.post.val[a..b].iter().zip(&self.post_w[a..b]) {
                if excluded.is_some_and(|x| x[s as usize]) {
                    continue;
                }
                let a = &mut sc.acc[s as usize];
                if a.1 == 0 {
                    sc.lexical.push(s);
                }
                a.0 += w;
                a.1 += 1;
            }
        }
        if let Some(o) = delta {
            // Its weights were worked out with this index's statistics (`build_from`).
            for &t in dq.keys() {
                let (a, b) = (o.index.post.off[t as usize] as usize, o.index.post.off[t as usize + 1] as usize);
                for (&s, &w) in o.index.post.val[a..b].iter().zip(&o.index.post_w[a..b]) {
                    let id = d0 + s as usize;
                    let a = &mut sc.acc[id];
                    if a.1 == 0 {
                        sc.lexical.push(id as u32);
                    }
                    a.0 += w;
                    a.1 += 1;
                }
            }
        }
        let mut lexical: Vec<(u32, f32)> = sc
            .lexical
            .iter()
            .map(|&s| {
                let (v, m) = sc.acc[s as usize];
                (s, v * (0.5 + 0.5 * (m as f32 / n_query)))
            })
            .collect();
        for &s in &sc.lexical {
            sc.acc[s as usize] = (0.0, 0);
        }
        sc.lexical.clear();

        // Seeds for the walk: the entities the query names, weighted by rarity, and the best
        // lexical hits, so the walk also spreads from where BM25 already looks.
        let q_entities = self.query_entities(query);
        let mut seeds: Vec<(usize, f32)> = q_entities
            .iter()
            .filter(|&&e| self.entity_sections.len_of(e as usize) > 0)
            .map(|&e| {
                let df = self.entity_sections.len_of(e as usize) as f32;
                (n + e as usize, (n as f32 / df).ln().max(0.1))
            })
            .collect();
        // Only the best 300 are used below: select them instead of sorting every match.
        top_sorted(&mut lexical, 300);
        let top_lex = lexical.first().map_or(1.0, |x| x.1).max(1e-6);
        let entity_mass: f32 = seeds.iter().map(|s| s.1).sum();
        let lex_weight = if seeds.is_empty() { 1.0 } else { 0.3 * entity_mass };
        // (Delta sections are not in the graph, so they cannot start the walk.)
        let lex_seeds: Vec<(u32, f32)> = lexical.iter().filter(|x| (x.0 as usize) < n).take(5).copied().collect();
        let lex_sum: f32 = lex_seeds.iter().map(|x| x.1).sum::<f32>().max(1e-6);
        seeds.extend(lex_seeds.iter().map(|&(s, v)| (s as usize, lex_weight * v / lex_sum)));
        if !opts.graph {
            seeds.clear();
        }

        // Fuse: lexical evidence first, the graph lifts sections tied to what the query names.
        let add = |sc: &mut Scratch, s: u32, v: f32| {
            if sc.score[s as usize] == 0.0 {
                sc.scored.push(s);
            }
            sc.score[s as usize] += v;
            // (A sum that lands on exactly 0.0 would be listed twice; scores here are positive.)
        };
        for &(s, v) in lexical.iter().take(300) {
            add(sc, s, v / top_lex);
        }
        self.personalized_pagerank(sc, &seeds);
        let top_ppr = sc.walked.iter().filter(|&&u| (u as usize) < n).map(|&u| sc.p[u as usize]).fold(0.0f32, f32::max).max(1e-9);
        for i in 0..sc.walked.len() {
            let u = sc.walked[i];
            let v = sc.p[u as usize];
            if (u as usize) < n && v > 0.0 {
                add(sc, u, 0.4 * v / top_ppr);
            }
        }
        for &u in &sc.walked {
            sc.p[u as usize] = 0.0;
            sc.r[u as usize] = 0.0;
        }
        sc.walked.clear();
        // E²GraphRAG's local retrieval: a section that names several of the query's entities
        // together is where they meet.
        if opts.graph && q_entities.len() >= 2 {
            let mut met = Vec::new();
            for &e in &q_entities {
                for &s in self.entity_sections.get(e as usize) {
                    if sc.together[s as usize] == 0 {
                        met.push(s);
                    }
                    sc.together[s as usize] += 1;
                }
            }
            for s in met {
                let c = sc.together[s as usize];
                sc.together[s as usize] = 0;
                if c >= 2 {
                    add(sc, s, 0.25 * (c - 1) as f32);
                }
            }
        }
        // Go to definition: a word of the query that a section defines puts that section first, when
        // the word is written as a name (`evict_lru`, `PrefixCache::trim`, `allocRun`, `gfx1201`) or
        // is the whole query. Plain words ("the", "real", "level") name types often enough to
        // mislead a question written in prose.
        let mut words = Vec::new();
        text::raw_words(query, |w| words.push(w));
        let single = words.len() == 1;
        let mut named: Vec<u32> = Vec::new();
        for w in words {
            let looks_like_name = w.contains(['_', ':'])
                || w.chars().any(|c| c.is_ascii_digit())
                || w.chars().skip(1).any(|c| c.is_uppercase()) && w.chars().any(|c| c.is_lowercase());
            if !(single || looks_like_name) {
                continue;
            }
            let last = w.rsplit("::").next().unwrap_or(w).to_lowercase();
            if let Some(d) = self.defs.get(&last) {
                named.extend_from_slice(self.def_sections.get(d as usize));
            }
            if let Some(d) = delta.and_then(|o| o.index.defs.get(&last).map(|d| (o, d))) {
                named.extend(d.0.index.def_sections.get(d.1 as usize).iter().map(|&s| (d0 + s as usize) as u32));
            }
        }
        named.sort_unstable();
        named.dedup();
        for s in named {
            add(sc, s, 1.0);
        }
        // A heading that says what the query asks names the section best.
        let mut ranked: Vec<(u32, f32)> = Vec::with_capacity(sc.scored.len());
        for &s in &sc.scored {
            let in_heading: f32 = match delta {
                Some(o) if s as usize >= d0 => {
                    o.index.sec_heading_terms.get(s as usize - d0).iter().filter_map(|t| dq.get(t)).sum()
                }
                _ => self.sec_heading_terms.get(s as usize).iter().map(|&t| sc.qidf[t as usize]).sum(),
            };
            ranked.push((s, sc.score[s as usize] + 0.3 * in_heading / idf_total));
            sc.score[s as usize] = 0.0;
        }
        sc.scored.clear();
        for &t in &qids {
            sc.qidf[t as usize] = 0.0;
        }
        Ranked { ranked, q_entities, qids, dq, idf_total, n_terms: qterms.len(), d0 }
        })
    }

    fn collect<'a>(&'a self, delta: Option<&'a Overlay>, r: Ranked, opts: &SearchOpts) -> Results<'a> {
        let Ranked { mut ranked, q_entities, qids, dq, idf_total, n_terms, d0 } = r;
        let n = self.section_count();
        let idf = |df: f32| ((n as f32 - df + 0.5) / (df + 0.5) + 1.0).ln();
        let qidf: FxHashMap<u32, f32> = qids.iter().map(|&t| (t, idf(self.post.len_of(t as usize) as f32))).collect();
        // The query's entities as the delta numbers them, by name.
        let dq_entities: Vec<u32> = delta.map_or(Vec::new(), |o| {
            q_entities.iter().filter_map(|&e| o.index.entity_keys.get(self.entity_names.str(e as usize))).collect()
        });
        let mut per_file: FxHashMap<u64, usize> = FxHashMap::default();
        let mut hits = Vec::new();
        // Ordered a chunk at a time: a search usually stops within the first few dozen.
        let mut sorted = 0;
        for i in 0..ranked.len() {
            if i == sorted {
                let chunk = 64.max(sorted);
                top_sorted(&mut ranked[sorted..], chunk);
                sorted = (sorted + chunk).min(ranked.len());
            }
            let (s, score) = ranked[i];
            // Either a delta section, or one of this index the delta does not replace.
            let (ix, local, file_key) = match delta {
                Some(o) if s as usize >= d0 => {
                    let l = s as usize - d0;
                    (&o.index, l, (1u64 << 32) | o.index.sec_file[l] as u64)
                }
                Some(o) if o.excluded[s as usize] => continue,
                _ => (self, s as usize, self.sec_file[s as usize] as u64),
            };
            let sec = ix.section(local);
            let path = ix.file_path(sec.file as usize);
            if opts.path_prefix.is_some_and(|p| !path.starts_with(p)) {
                continue;
            }
            let c = per_file.entry(file_key).or_default();
            if *c >= opts.max_per_file {
                continue;
            }
            *c += 1;
            let (terms_idf, named) = if std::ptr::eq(ix, self) {
                let ents = self.sec_entities.get(local);
                let named = q_entities
                    .iter()
                    .filter(|&&e| self.entity_sections.len_of(e as usize) <= self.hub_limit && ents.contains(&e))
                    .count() as u32;
                (self.sec_terms.get(local).iter().filter_map(|t| qidf.get(t)).sum::<f32>(), named)
            } else {
                let ents = ix.sec_entities.get(local);
                let named = dq_entities.iter().filter(|e| ents.contains(e)).count() as u32;
                (ix.sec_terms.get(local).iter().filter_map(|t| dq.get(t)).sum::<f32>(), named)
            };
            hits.push(Hit { id: s, section: sec, path, score, coverage: (terms_idf / idf_total).min(1.0), named });
            if hits.len() >= opts.k {
                break;
            }
        }
        Results {
            hits,
            entities: q_entities.iter().map(|&e| self.entity_names.str(e as usize)).collect(),
            query_terms: n_terms,
        }
    }

    /// Approximate personalized PageRank by forward push (Andersen, Chung, Lang 2006) on the graph
    /// of sections (ids 0..n) and entities (ids n..), with neighbouring sections of a file linked.
    /// The work is local to the seeds, whatever the size of the index. Leaves the scores in
    /// `sc.p` and the nodes it touched in `sc.walked`.
    fn personalized_pagerank(&self, sc: &mut Scratch, seeds: &[(usize, f32)]) {
        const ALPHA: f32 = 0.5; // restart probability, as in HippoRAG
        const EPS: f32 = 1e-4;
        const MAX_PUSHES: usize = 200_000;
        let total: f32 = seeds.iter().map(|s| s.1).sum();
        if total <= 0.0 {
            return;
        }
        let off = &*self.graph.off;
        let adjacency = &*self.graph.val;
        let deg = |u: usize| (off[u + 1] - off[u]) as usize;
        sc.queue.clear();
        for &(u, w) in seeds {
            if sc.r[u] == 0.0 && sc.p[u] == 0.0 {
                sc.walked.push(u as u32);
            }
            if sc.r[u] == 0.0 {
                sc.queue.push(u as u32);
            }
            sc.r[u] += w / total;
        }
        // The seed order the hash map used to give is gone; pop in reverse insertion order.
        sc.queue.reverse();
        let mut pushes = 0;
        while let Some(u) = sc.queue.pop() {
            let u = u as usize;
            let ru = sc.r[u];
            let d = deg(u);
            if d == 0 {
                sc.p[u] += ru;
                sc.r[u] = 0.0;
                continue;
            }
            if ru < EPS * d as f32 {
                continue;
            }
            pushes += 1;
            if pushes > MAX_PUSHES {
                break;
            }
            sc.p[u] += ALPHA * ru;
            sc.r[u] = 0.0;
            let share = (1.0 - ALPHA) * ru / d as f32;
            for &v in &adjacency[off[u] as usize..off[u + 1] as usize] {
                let v = v as usize;
                let before = sc.r[v];
                if before == 0.0 && sc.p[v] == 0.0 {
                    sc.walked.push(v as u32);
                }
                sc.r[v] += share;
                let dv = deg(v).max(1) as f32;
                if before < EPS * dv && sc.r[v] >= EPS * dv {
                    sc.queue.push(v as u32);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> (PathBuf, Index) {
        let dir = std::env::temp_dir().join(format!("docsearch-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("guide.md"),
            "# Guide\n## Drafting\nThe DFlash2 drafter proposes a tree of tokens.\n\
             ## Serving\nStart the server with `rad-serve` and a model.\n\
             ## Trees\nTree verification in DFlash2 checks every branch, see [ops](ops.md).\n",
        )
        .unwrap();
        std::fs::write(dir.join("ops.md"), "# Ops\nThe verify op takes the DFlash2 tree.\n").unwrap();
        std::fs::write(dir.join("skip.rs"), "fn dflash2() {}\n").unwrap();
        let cfg = Config {
            roots: vec![dir.clone()],
            extensions: vec!["md".into()],
            max_file_bytes: 1 << 20,
            max_files: 100,
            extra_entities: None,
        };
        (dir, Index::build(&cfg))
    }

    #[test]
    fn query_names_entities_and_ranks_their_sections() {
        let (dir, ix) = corpus("ranks");
        assert_eq!(ix.file_count(), 2, "only .md files");
        let res = ix.search("how does DFlash2 tree verification work", &SearchOpts { k: 3, path_prefix: None, max_per_file: 3, graph: true });
        assert!(res.entities.contains(&"dflash2"), "{:?}", res.entities);
        assert_eq!(res.hits[0].section.heading, "Guide › Trees");
        let res = ix.search("rad-serve", &SearchOpts { k: 1, path_prefix: None, max_per_file: 3, graph: true });
        assert_eq!(res.hits[0].section.heading, "Guide › Serving");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn overlay_searches_changed_files_like_a_rebuild() {
        let (dir, base) = corpus("overlay");
        let cfg = Config {
            roots: vec![dir.clone()],
            extensions: vec!["md".into()],
            max_file_bytes: 1 << 20,
            max_files: 100,
            extra_entities: None,
        };
        // guide.md loses its Serving section and gains one about zebrafish.
        std::fs::write(
            dir.join("guide.md"),
            "# Guide\n## Drafting\nThe DFlash2 drafter proposes a tree of tokens.\n\
             ## Zebrafish\nThe zebrafish loader reads `fish.bin` files.\n\
             ## Trees\nTree verification in DFlash2 checks every branch, see [ops](ops.md).\n",
        )
        .unwrap();
        let sig = scan(&cfg);
        let changed: Signature = sig.iter().filter(|(p, _, _)| p.ends_with("guide.md")).cloned().collect();
        let guide = (0..base.file_count()).find(|&i| base.file_path(i).ends_with("guide.md")).unwrap() as u32;
        let excluded = (0..base.section_count()).map(|s| base.sec_file[s] == guide).collect();
        let overlay = Overlay { index: Index::build_from(&cfg, changed, Some(&base)), excluded };
        let opts = SearchOpts { k: 3, path_prefix: None, max_per_file: 3, graph: true };

        let hit = |r: &Results| r.hits.first().map(|h| (h.path.file_name().unwrap().to_string_lossy().into_owned(), h.section.heading.to_string()));
        let r = base.search_with(Some(&overlay), "zebrafish loader", &opts);
        assert_eq!(hit(&r), Some(("guide.md".into(), "Guide › Zebrafish".into())));
        let r = base.search_with(Some(&overlay), "rad-serve", &opts);
        assert!(r.hits.iter().all(|h| h.section.heading != "Guide › Serving"), "a removed section came back");
        // The same first hits as a full rebuild, for words in changed and unchanged files.
        let rebuilt = Index::build(&cfg);
        for q in ["zebrafish loader", "DFlash2 tree verification", "verify op", "drafter"] {
            assert_eq!(hit(&base.search_with(Some(&overlay), q, &opts)), hit(&rebuilt.search(q, &opts)), "{q}");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn saved_index_searches_like_the_built_one() {
        let (dir, built) = corpus("saved");
        let file = dir.join("index.bin");
        built.save(&file).unwrap();
        let loaded = Index::load(&file).unwrap();
        let opts = SearchOpts { k: 5, path_prefix: None, max_per_file: 3, graph: true };
        for q in ["how does DFlash2 tree verification work", "rad-serve", "verify op", "drafter"] {
            let a: Vec<_> = built.search(q, &opts).hits.iter().map(|h| (h.id, h.score)).collect();
            let b: Vec<_> = loaded.search(q, &opts).hits.iter().map(|h| (h.id, h.score)).collect();
            assert_eq!(a, b, "{q}");
        }
        assert!(loaded.matches(&scan(&Config {
            roots: vec![dir.clone()],
            extensions: vec!["md".into()],
            max_file_bytes: 1 << 20,
            max_files: 100,
            extra_entities: None,
        })));
        // A damaged file is refused, not trusted.
        let mut bytes = std::fs::read(&file).unwrap();
        let mid = bytes.len() / 2;
        bytes.truncate(mid);
        std::fs::write(&file, bytes).unwrap();
        assert!(Index::load(&file).is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
