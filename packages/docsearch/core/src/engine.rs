//! Keeps an index current without making a search wait. The index of a configuration is saved in a
//! file (`~/.cache/docsearch/index/<hash>.idx`) and mapped, so a new process is ready at once and
//! every process on the same roots shares one copy in memory. A search checks for changed files in
//! the background at most every few seconds. Changed files go into a small index laid over the
//! saved one (milliseconds, nothing written); once the files have been quiet for a while, one
//! process rebuilds and saves (the others wait on a lock and then map its file). A search uses
//! whatever is current.

use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::index::{scan, Config, Index, Overlay, Results, SearchOpts, Signature};

pub struct Engine {
    cfg: Config,
    /// Where this configuration's index is saved; none when it cannot be (entities from a model).
    file: Option<PathBuf>,
    current: Mutex<Option<Arc<View>>>,
    /// Which version of `file` the current base index was mapped from.
    mapped: Mutex<Option<FileId>>,
    /// When the overlay last changed, to rebuild once the files are quiet.
    overlay_since: Mutex<Option<Instant>>,
    ready: Condvar,
    busy: AtomicBool,
    last_check: Mutex<Instant>,
    generations: AtomicU64,
}

/// How often a search may trigger a check for changed files. A check costs a scan and, when files
/// changed, building the small overlay of just those files.
const CHECK_EVERY: Duration = Duration::from_secs(1);
/// Without a saved index every change is a full rebuild: then never more often than five builds' time.
const BUILDS_BETWEEN_CHECKS: u32 = 5;
/// The overlay is folded into a rebuilt, saved index once no file changed for this long...
const QUIET_BEFORE_REBUILD: Duration = Duration::from_secs(30);
/// ...or at once when it grows past this many files (a branch switch, a big refactor).
const OVERLAY_MAX_FILES: usize = 200;

/// What a search runs on: the base index, and the files changed since laid over it.
pub struct View {
    /// Which view this is: a new one for every change, never reused (unlike its address once it is freed).
    pub generation: u64,
    pub base: Arc<Index>,
    overlay: Option<Overlay>,
    /// What the overlay was built from: the changed files, and which files of the base it replaces.
    changed: Signature,
    gone: Vec<bool>,
}

impl View {
    fn plain(base: Arc<Index>) -> View {
        View { generation: 0, base, overlay: None, changed: Vec::new(), gone: Vec::new() }
    }

    pub fn search<'a>(&'a self, query: &str, opts: &SearchOpts) -> Results<'a> {
        self.base.search_with(self.overlay.as_ref(), query, opts)
    }

    /// Whether this view shows exactly these files, as `scan` lists them now.
    fn matches(&self, sig: &Signature) -> bool {
        match &self.overlay {
            None => self.base.matches(sig),
            Some(_) => {
                let (changed, gone) = self.base.diff(sig);
                changed == self.changed && gone == self.gone
            }
        }
    }

    pub fn file_count(&self) -> usize {
        let gone = self.gone.iter().filter(|&&g| g).count();
        self.base.file_count() - gone + self.overlay.as_ref().map_or(0, |o| o.index.file_count())
    }

    pub fn section_count(&self) -> usize {
        let gone = self.overlay.as_ref().map_or(0, |o| o.excluded.iter().filter(|&&x| x).count());
        self.base.section_count() - gone + self.overlay.as_ref().map_or(0, |o| o.index.section_count())
    }

    pub fn term_count(&self) -> usize {
        self.base.term_count()
    }

    pub fn entity_count(&self) -> usize {
        self.base.entity_count()
    }

    pub fn build_ms(&self) -> u32 {
        self.base.build_ms
    }

    /// Files in the overlay, changed since the base index was saved.
    pub fn overlay_files(&self) -> usize {
        self.overlay.as_ref().map_or(0, |o| o.index.file_count())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Start,
    Check,
    Rebuild,
}

/// Builds faster than this stay in memory: loading a file would save nothing, and every small or
/// temporary folder Pi starts in would leave one behind.
const SAVE_ABOVE_MS: u32 = 100;

/// A version of a file. A new index always arrives by a rename, which gives it a new inode; the
/// modification time is not part of it, because opening an index touches it (see `take_saved`).
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileId(u64, u64);

#[cfg(unix)]
fn file_id(path: &Path) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).ok()?;
    Some(FileId(m.dev(), m.ino()))
}

/// Without inodes (Windows): the file a rename brought keeps the creation time it was written with.
#[cfg(not(unix))]
fn file_id(path: &Path) -> Option<FileId> {
    let m = std::fs::metadata(path).ok()?;
    let created = m.created().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(FileId(created.as_nanos() as u64, m.len()))
}

/// Hands memory freed after a build back to the system. glibc keeps it for later allocations
/// otherwise, and a process that maps the saved index would go on holding the build's ~400 MB.
fn release_freed_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        // SAFETY: malloc_trim only returns free heap memory to the system.
        unsafe {
            malloc_trim(0);
        }
    }
}

/// Index files untouched this long belong to folders no longer searched (a removed worktree).
const KEEP_UNUSED: Duration = Duration::from_secs(30 * 24 * 3600);

/// Removes the index files beside `current` that were not rebuilt or opened for `KEEP_UNUSED`.
fn prune_old_indexes(current: &Path) {
    let Some(dir) = current.parent() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > KEEP_UNUSED);
        if old && path != current && path.extension().is_some_and(|x| x == "idx" || x == "lock") {
            std::fs::remove_file(&path).ok();
        }
    }
}

/// `$DOCSEARCH_CACHE_DIR`, else `$XDG_CACHE_HOME/docsearch/index`, else `~/.cache/docsearch/index`.
fn cache_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("DOCSEARCH_CACHE_DIR") {
        return Some(PathBuf::from(d));
    }
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))?;
    Some(base.join("docsearch").join("index"))
}

/// The file for this configuration: the same roots and settings share one, whichever process asks.
fn index_file(cfg: &Config) -> Option<PathBuf> {
    if cfg.extra_entities.is_some() {
        return None;
    }
    let mut roots: Vec<PathBuf> = cfg.roots.iter().map(|r| r.canonicalize().unwrap_or_else(|_| r.clone())).collect();
    roots.sort();
    let mut exts = cfg.extensions.clone();
    exts.sort();
    let mut h = rustc_hash::FxHasher::default();
    (roots, exts, cfg.max_file_bytes, cfg.max_files).hash(&mut h);
    let dir = cache_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{:016x}.idx", h.finish())))
}

impl Engine {
    pub fn start(cfg: Config) -> Arc<Engine> {
        let engine = Arc::new(Engine {
            file: index_file(&cfg),
            cfg,
            current: Mutex::new(None),
            mapped: Mutex::new(None),
            overlay_since: Mutex::new(None),
            ready: Condvar::new(),
            busy: AtomicBool::new(false),
            last_check: Mutex::new(Instant::now()),
            generations: AtomicU64::new(0),
        });
        engine.update_in_background(Mode::Start);
        engine
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    pub fn building(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    /// The current view, waiting up to `wait` for the first one.
    pub fn index(&self, wait: Duration) -> Option<Arc<View>> {
        let guard = self.current.lock().unwrap();
        let (guard, _) = self.ready.wait_timeout_while(guard, wait, |cur| cur.is_none()).unwrap();
        guard.clone()
    }

    /// Starts a background check for added, removed or changed files, at most every few seconds.
    pub fn maybe_refresh(self: &Arc<Self>) {
        let mut last = self.last_check.lock().unwrap();
        if last.elapsed() < CHECK_EVERY {
            return;
        }
        let build = self.current.lock().unwrap().as_ref().map_or(0, |v| v.base.build_ms);
        if !self.saves() && last.elapsed() < Duration::from_millis(build as u64) * BUILDS_BETWEEN_CHECKS {
            return;
        }
        *last = Instant::now();
        drop(last);
        self.update_in_background(Mode::Check);
    }

    /// Rebuilds now, whether or not files changed.
    pub fn rebuild_in_background(self: &Arc<Self>) {
        self.update_in_background(Mode::Rebuild);
    }

    /// Whether this configuration's index is (or will be) a saved file rather than built in memory.
    fn saves(&self) -> bool {
        self.file.as_ref().is_some_and(|f| f.exists())
    }

    fn update_in_background(self: &Arc<Self>, mode: Mode) {
        if self.busy.swap(true, Ordering::AcqRel) {
            return;
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            me.update(mode);
            me.busy.store(false, Ordering::Release);
        });
    }

    fn set(&self, mut view: View, from: Option<FileId>) {
        view.generation = self.generations.fetch_add(1, Ordering::Relaxed) + 1;
        *self.overlay_since.lock().unwrap() = view.overlay.as_ref().map(|_| Instant::now());
        *self.current.lock().unwrap() = Some(Arc::new(view));
        if from.is_some() {
            *self.mapped.lock().unwrap() = from;
        }
        self.ready.notify_all();
    }

    fn current(&self) -> Option<Arc<View>> {
        self.current.lock().unwrap().clone()
    }

    /// Maps the saved index when it is newer than the one in use (another process rebuilt it).
    fn take_saved(&self, file: &Path) -> bool {
        let id = file_id(file);
        if id.is_none() || id == *self.mapped.lock().unwrap() {
            return false;
        }
        match Index::load(file) {
            Ok(ix) => {
                // Marks the file as in use, for `prune_old_indexes`; the inode stays, so the other
                // processes do not take it for a new index.
                if let Ok(f) = std::fs::File::options().write(true).open(file) {
                    f.set_modified(std::time::SystemTime::now()).ok();
                }
                self.set(View::plain(Arc::new(ix)), id);
                true
            }
            Err(_) => false,
        }
    }

    fn update(&self, mode: Mode) {
        let Some(file) = self.file.clone() else {
            // Nowhere to save: build in memory, as before there were files.
            if mode != Mode::Check || !self.current().is_some_and(|v| v.matches(&scan(&self.cfg))) {
                self.set(View::plain(Arc::new(Index::build(&self.cfg))), None);
            }
            return;
        };
        if mode == Mode::Rebuild {
            return self.rebuild(&file);
        }
        // First the saved file, so a search can start at once.
        self.take_saved(&file);
        let Some(view) = self.current() else {
            // Nothing saved yet: a small folder stays in memory, a large one is saved.
            let built = Index::build(&self.cfg);
            if built.build_ms < SAVE_ABOVE_MS {
                self.set(View::plain(Arc::new(built)), None);
            } else {
                self.save_and_take(built, &file);
            }
            return;
        };
        let sig = scan(&self.cfg);
        if view.matches(&sig) {
            // Quiet since the overlay was built: fold it into a saved index.
            let quiet = self.overlay_since.lock().unwrap().is_some_and(|t| t.elapsed() >= QUIET_BEFORE_REBUILD);
            if view.overlay.is_some() && quiet {
                self.rebuild(&file);
            }
            return;
        }
        // A small folder, or one that changed too much for an overlay: rebuild it whole.
        let (changed, gone) = view.base.diff(&sig);
        if view.base.build_ms < SAVE_ABOVE_MS || !file.exists() || changed.len() + gone.iter().filter(|&&g| g).count() > OVERLAY_MAX_FILES {
            return self.rebuild(&file);
        }
        // Otherwise just the changed files, beside the saved index (only their own reading: ms).
        let index = Index::build_from(&self.cfg, changed.clone(), Some(&view.base));
        let excluded = view.base.sections_in(&gone);
        let base = Arc::clone(&view.base);
        self.set(View { generation: 0, base, overlay: Some(Overlay { index, excluded }), changed, gone }, None);
    }

    /// Rebuilds everything; one process at a time saves, the others wait here and take its file.
    fn rebuild(&self, file: &Path) {
        if !file.exists() {
            // Nothing saved for this folder: build here, and save only a build that took a while.
            let built = Index::build(&self.cfg);
            if built.build_ms < SAVE_ABOVE_MS {
                self.set(View::plain(Arc::new(built)), None);
            } else {
                self.save_and_take(built, file);
            }
            return;
        }
        let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(file.with_extension("lock"));
        let _guard = lock.as_ref().ok().filter(|l| l.lock().is_ok());
        // Another process may have saved what we were about to build.
        if self.take_saved(file) && self.current().is_some_and(|v| v.matches(&scan(&self.cfg))) {
            return;
        }
        let built = Index::build(&self.cfg);
        self.save_and_take(built, file);
    }

    /// Saves `built` and maps the file, so this process shares it with the others.
    fn save_and_take(&self, built: Index, file: &Path) {
        if built.save(file).is_ok() && self.take_saved(file) {
            drop(built);
            release_freed_memory();
            prune_old_indexes(file);
            return;
        }
        // Saving failed (a full or read-only disk): keep the build in memory.
        self.set(View::plain(Arc::new(built)), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_view_has_a_new_generation() {
        let dir = std::env::temp_dir().join(format!("docsearch-test-generation-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "# Title\n\nSome text about generations.\n").unwrap();
        let cfg = Config {
            roots: vec![dir.clone()],
            extensions: vec!["md".into()],
            max_file_bytes: 1 << 20,
            max_files: 100,
            extra_entities: Some(Default::default()), // (Not saved: built in memory.)
        };
        let engine = Engine::start(cfg);
        let first = engine.index(Duration::from_secs(10)).unwrap().generation;
        assert!(first > 0);
        while engine.building() {
            std::thread::sleep(Duration::from_millis(5));
        }
        engine.rebuild_in_background();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut next = first;
        while next == first && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
            next = engine.index(Duration::ZERO).unwrap().generation;
        }
        assert!(next > first);
        std::fs::remove_dir_all(&dir).ok();
    }
}
