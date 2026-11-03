//! Node-API binding: `new DocIndex({ roots })`, then `search(query, { k })`. Calls are synchronous
//! and take microseconds; building and refreshing happen on a thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use docsearch_core::{Config, Engine, SearchOpts};
use napi_derive::napi;

const DEFAULT_EXTENSIONS: [&str; 7] = ["md", "mdx", "markdown", "txt", "rst", "adoc", "org"];

#[napi(object)]
pub struct Options {
    pub roots: Vec<String>,
    pub extensions: Option<Vec<String>>,
    pub max_file_bytes: Option<u32>,
    pub max_files: Option<u32>,
}

#[napi(object)]
pub struct QueryOptions {
    /// Number of sections to return (default 6).
    pub k: Option<u32>,
    /// Longest text returned per section; longer sections are cut at a line (default 1500).
    pub max_chars: Option<u32>,
    /// Only files under this path.
    pub path_prefix: Option<String>,
    /// At most this many sections per file (default 3).
    pub max_per_file: Option<u32>,
    /// How long to wait for the first build, in ms (default 5000).
    pub wait_ms: Option<u32>,
}

#[napi(object)]
#[derive(Clone)]
pub struct Hit {
    pub path: String,
    pub line_start: u32,
    pub line_end: u32,
    pub heading: String,
    pub score: f64,
    pub coverage: f64,
    pub named: u32,
    pub text: String,
    pub truncated: bool,
}

#[napi(object)]
#[derive(Clone)]
pub struct SearchResult {
    /// False when the first build had not finished within `waitMs`.
    pub ready: bool,
    pub hits: Vec<Hit>,
    pub entities: Vec<String>,
    pub query_terms: u32,
    pub micros: u32,
}

#[napi(object)]
pub struct Stats {
    pub ready: bool,
    pub building: bool,
    pub roots: Vec<String>,
    pub files: u32,
    pub sections: u32,
    pub terms: u32,
    pub entities: u32,
    pub build_ms: u32,
    /// Files changed since the index was saved, searched from a small overlay until it is rebuilt.
    pub overlay_files: u32,
}

fn cut(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut end = text.floor_char_boundary(max);
    if let Some(nl) = text[..end].rfind('\n').filter(|&i| i > max / 2) {
        end = nl;
    }
    (text[..end].to_string(), true)
}

/// A query and the options that shape its result.
type CacheKey = (String, u32, u32, Option<String>, u32);

/// Results of recent searches on one index: an agent asks the same thing more than once (the
/// prompt's recall, then the tool; a retry). Emptied whenever another view takes over (by its
/// generation: the address of a freed view can come back for the next one).
#[derive(Default)]
struct Cache {
    generation: u64,
    results: HashMap<CacheKey, SearchResult>,
}

const CACHE_ENTRIES: usize = 256;

#[napi]
pub struct DocIndex {
    engine: Arc<Engine>,
    cache: Mutex<Cache>,
}

#[napi]
impl DocIndex {
    #[napi(constructor)]
    pub fn new(opts: Options) -> Self {
        let cfg = Config {
            roots: opts.roots.iter().map(PathBuf::from).collect(),
            extensions: opts
                .extensions
                .unwrap_or_else(|| DEFAULT_EXTENSIONS.map(String::from).to_vec())
                .into_iter()
                .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
                .collect(),
            max_file_bytes: opts.max_file_bytes.unwrap_or(4 << 20) as u64,
            max_files: opts.max_files.unwrap_or(50_000) as usize,
            extra_entities: None,
        };
        DocIndex { engine: Engine::start(cfg), cache: Mutex::new(Cache::default()) }
    }

    #[napi]
    pub fn search(&self, query: String, opts: Option<QueryOptions>) -> SearchResult {
        let t0 = Instant::now();
        let o = opts.unwrap_or(QueryOptions { k: None, max_chars: None, path_prefix: None, max_per_file: None, wait_ms: None });
        let Some(ix) = self.engine.index(Duration::from_millis(o.wait_ms.unwrap_or(5000) as u64)) else {
            return SearchResult { ready: false, hits: Vec::new(), entities: Vec::new(), query_terms: 0, micros: 0 };
        };
        self.engine.maybe_refresh();
        let key: CacheKey = (query.clone(), o.k.unwrap_or(6), o.max_chars.unwrap_or(1500), o.path_prefix.clone(), o.max_per_file.unwrap_or(3));
        {
            let mut cache = self.cache.lock().unwrap();
            if cache.generation != ix.generation {
                cache.generation = ix.generation;
                cache.results.clear();
            }
            if let Some(hit) = cache.results.get(&key) {
                let mut r = hit.clone();
                r.micros = t0.elapsed().as_micros() as u32;
                return r;
            }
        }
        let prefix = o.path_prefix.as_deref().map(Path::new);
        let res = ix.search(
            &query,
            &SearchOpts {
                k: o.k.unwrap_or(6).clamp(1, 50) as usize,
                path_prefix: prefix,
                max_per_file: o.max_per_file.unwrap_or(3).max(1) as usize,
                graph: true,
            },
        );
        let max_chars = o.max_chars.unwrap_or(1500).max(200) as usize;
        let hits = res
            .hits
            .iter()
            .map(|h| {
                let (text, truncated) = cut(h.section.text, max_chars);
                Hit {
                    path: h.path.to_string_lossy().into_owned(),
                    line_start: h.section.line_start,
                    line_end: h.section.line_end,
                    heading: h.section.heading.to_string(),
                    score: h.score as f64,
                    coverage: h.coverage as f64,
                    named: h.named,
                    text,
                    truncated,
                }
            })
            .collect();
        let result = SearchResult {
            ready: true,
            hits,
            entities: res.entities.iter().map(|e| e.to_string()).collect(),
            query_terms: res.query_terms as u32,
            micros: t0.elapsed().as_micros() as u32,
        };
        let mut cache = self.cache.lock().unwrap();
        if cache.generation == ix.generation {
            if cache.results.len() >= CACHE_ENTRIES {
                cache.results.clear();
            }
            cache.results.insert(key, result.clone());
        }
        result
    }

    #[napi]
    pub fn stats(&self) -> Stats {
        let roots = self.engine.config().roots.iter().map(|r| r.to_string_lossy().into_owned()).collect();
        let building = self.engine.building();
        match self.engine.index(Duration::ZERO) {
            Some(ix) => Stats {
                ready: true,
                building,
                roots,
                files: ix.file_count() as u32,
                sections: ix.section_count() as u32,
                terms: ix.term_count() as u32,
                entities: ix.entity_count() as u32,
                build_ms: ix.build_ms(),
                overlay_files: ix.overlay_files() as u32,
            },
            None => Stats { ready: false, building, roots, files: 0, sections: 0, terms: 0, entities: 0, build_ms: 0, overlay_files: 0 },
        }
    }

    /// Rebuilds now, whether or not files changed.
    #[napi]
    pub fn rebuild(&self) {
        self.engine.rebuild_in_background();
    }
}
