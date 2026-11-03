//! Command-line search over a folder, for trying queries and timing the index.
//!
//!   dsq <root>... -- <query>...
//!   dsq <root>... --bench <query file, one query per line>
//!   dsq <root> --eval <eval.tsv> [<entities.tsv>]
//!
//! `--eval` compares variants on queries with known answers: TSV lines `type \t query \t targets`,
//! targets as `path:start-end | path:start-end`. A hit counts when it is in a target's file and
//! its lines overlap the target's. `entities.tsv` holds names a NER model found
//! (`key \t label \t probability \t name`, from `ner-probe --enrich`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use docsearch_core::index::ExtraEntities;
use docsearch_core::{Config, Index, SearchOpts};

fn config(roots: Vec<PathBuf>, extra: Option<ExtraEntities>) -> Config {
    Config {
        roots,
        // DSQ_EXT=cpp,h,py indexes other files than docs.
        extensions: std::env::var("DSQ_EXT").map_or_else(
            |_| ["md", "mdx", "markdown", "txt", "rst", "adoc", "org"].map(String::from).to_vec(),
            |v| v.split(',').map(|e| e.trim().to_string()).collect(),
        ),
        max_file_bytes: 4 << 20,
        max_files: 50_000,
        extra_entities: extra.map(Arc::new),
    }
}

/// The index for `cfg`; with DSQ_MAPPED=1 saved and mapped back, to measure the mapped index.
fn make(cfg: &Config) -> Index {
    let ix = Index::build(cfg);
    if std::env::var_os("DSQ_MAPPED").is_none() {
        return ix;
    }
    // On disk, not in /tmp (often a RAM disk); unlinked once mapped, which keeps the mapping.
    let dir = std::env::var_os("HOME").map_or_else(std::env::temp_dir, |h| PathBuf::from(h).join(".cache/docsearch"));
    std::fs::create_dir_all(&dir).expect("cache dir");
    let file = dir.join(format!("dsq-{}.idx", std::process::id()));
    ix.save(&file).expect("save");
    drop(ix);
    let t = Instant::now();
    let ix = Index::load(&file).expect("load");
    eprintln!("mapped {} MB in {} µs", std::fs::metadata(&file).map_or(0, |m| m.len() >> 20), t.elapsed().as_micros());
    std::fs::remove_file(&file).ok();
    ix
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(i) = args.iter().position(|a| a == "--eval") {
        return eval(Path::new(&args[0]), &args[i + 1], args.get(i + 2).map(String::as_str));
    }
    let split = args.iter().position(|a| a == "--" || a == "--bench").unwrap_or(args.len());
    let roots: Vec<PathBuf> = args[..split].iter().map(PathBuf::from).collect();
    let ix = make(&config(roots, None));
    eprintln!(
        "{} files, {} sections, {} terms, {} entities, built in {} ms",
        ix.file_count(),
        ix.section_count(),
        ix.term_count(),
        ix.entity_count(),
        ix.build_ms
    );
    let opts = SearchOpts { k: 6, path_prefix: None, max_per_file: 3, graph: true };

    if args.get(split).is_some_and(|a| a == "--bench") {
        let queries = std::fs::read_to_string(&args[split + 1]).expect("query file");
        let queries: Vec<&str> = queries.lines().filter(|l| !l.trim().is_empty()).collect();
        let mut times = Vec::new();
        for _ in 0..20 {
            for q in &queries {
                let t = Instant::now();
                std::hint::black_box(ix.search(q, &opts).hits.len());
                times.push(t.elapsed().as_micros());
            }
        }
        times.sort_unstable();
        let pct = |p: f64| times[((times.len() - 1) as f64 * p) as usize];
        println!("{} searches: p50 {} µs, p90 {} µs, p99 {} µs, max {} µs", times.len(), pct(0.5), pct(0.9), pct(0.99), pct(1.0));
        return;
    }

    let query = args[split + 1..].join(" ");
    let t = Instant::now();
    let res = ix.search(&query, &opts);
    let us = t.elapsed().as_micros();
    println!("query entities: {:?}  ({us} µs)", res.entities);
    for (i, h) in res.hits.iter().enumerate() {
        let first = h.section.text.lines().find(|l| !l.trim().is_empty() && !l.starts_with('#')).unwrap_or("");
        println!(
            "[{}] {}:{}-{}  {}  score {:.2} cov {:.2}\n     {}",
            i + 1,
            h.path.display(),
            h.section.line_start,
            h.section.line_end,
            h.section.heading,
            h.score,
            h.coverage,
            first.chars().take(110).collect::<String>()
        );
    }
}

/// Words a NER model tags that name nothing in particular.
const GENERIC: &[&str] = &[
    "bin", "base", "cmake", "command", "commands", "concept", "configure", "file", "files", "gpu", "gpus", "host",
    "kernel", "kernels", "launcher", "log", "logs", "memory", "model", "models", "node", "org", "port", "program",
    "programs", "router", "scratch", "sh", "software", "sudo", "test", "tests", "tool", "tools", "user", "users", "vram",
];

/// A name is kept when it is more than one generic word: several words, or a capital, digit or
/// joiner inside it, as names are written.
fn specific(name: &str) -> bool {
    let n = name.trim();
    if n.chars().count() < 3 || GENERIC.contains(&n.to_lowercase().as_str()) {
        return false;
    }
    n.split_whitespace().count() >= 2
        || n.chars().any(|c| c.is_uppercase() || c.is_ascii_digit())
        || n.contains(['_', '-', '.', '/'])
}

fn load_entities(path: &str, filtered: bool) -> (ExtraEntities, usize) {
    let mut out = ExtraEntities::default();
    let mut n = 0;
    for line in std::fs::read_to_string(path).expect("entities file").lines() {
        let mut f = line.splitn(4, '\t');
        let (Some(key), Some(_label), Some(_p), Some(name)) = (f.next(), f.next(), f.next(), f.next()) else { continue };
        let name = name.trim().trim_matches(|c: char| !c.is_alphanumeric());
        if name.is_empty() || filtered && !specific(name) {
            continue;
        }
        let Ok(key) = key.parse::<u64>() else { continue };
        out.entry(key).or_default().push(name.to_lowercase());
        n += 1;
    }
    (out, n)
}

struct Query {
    kind: String,
    text: String,
    targets: Vec<(String, u32, u32)>,
}

fn load_queries(path: &str) -> Vec<Query> {
    std::fs::read_to_string(path)
        .expect("eval file")
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let (kind, text, targets) = (f.next()?, f.next()?, f.next()?);
            let targets = targets
                .split('|')
                .filter_map(|t| {
                    let (file, range) = t.trim().rsplit_once(':')?;
                    let (a, b) = range.split_once('-').unwrap_or((range, range));
                    Some((file.to_string(), a.trim().parse().ok()?, b.trim().parse().ok()?))
                })
                .collect::<Vec<_>>();
            (!targets.is_empty()).then(|| Query { kind: kind.trim().into(), text: text.trim().into(), targets })
        })
        .collect()
}

/// The 1-based rank of the first hit that overlaps a target, within the first `k`.
fn rank(ix: &Index, root: &Path, q: &Query, graph: bool, k: usize) -> Option<usize> {
    let res = ix.search(&q.text, &SearchOpts { k, path_prefix: None, max_per_file: 3, graph });
    res.hits.iter().position(|h| {
        let rel = h.path.strip_prefix(root).unwrap_or(h.path).to_string_lossy();
        q.targets.iter().any(|(f, a, b)| rel == *f && h.section.line_start <= *b && h.section.line_end >= *a)
    })
    .map(|i| i + 1)
}

fn eval(root: &Path, eval_path: &str, entities: Option<&str>) {
    let queries = load_queries(eval_path);
    let kinds = ["1", "2", "3", "4"];
    let kind_names = ["paraphrase", "names in prose", "keywords", "German"];
    let mut variants: Vec<(String, Option<ExtraEntities>, bool)> =
        vec![("BM25 only (no graph)".into(), None, false), ("rules (today)".into(), None, true)];
    if let Some(p) = entities {
        let (raw, n_raw) = load_entities(p, false);
        let (filtered, n_f) = load_entities(p, true);
        variants.push((format!("rules + GLiNER raw ({n_raw})"), Some(raw), true));
        variants.push((format!("rules + GLiNER filtered ({n_f})"), Some(filtered), true));
    }
    println!("{} queries; per type: {}", queries.len(), kinds.iter().zip(kind_names).map(|(k, n)| format!("{n} {}", queries.iter().filter(|q| q.kind == *k).count())).collect::<Vec<_>>().join(", "));
    println!(
        "\n{:<32} {:>6} {:>6} {:>6} {:>7} {:>6} | {:>7} {:>7} {:>7} | {:>8} {:>8}",
        "variant", "Hit@1", "Hit@3", "Hit@5", "Hit@10", "MRR", "p50 µs", "p95 µs", "p99 µs", "entities", "build ms"
    );
    let mut per_kind_rows = Vec::new();
    for (name, extra, graph) in variants {
        let ix = make(&config(vec![root.to_path_buf()], extra));
        let ranks: Vec<Option<usize>> = queries.iter().map(|q| rank(&ix, root, q, graph, 10)).collect();
        if std::env::var_os("DSQ_VERBOSE").is_some() {
            for (q, r) in queries.iter().zip(&ranks) {
                eprintln!("{name}\t{}\t{}\t{}", q.kind, r.map_or("-".into(), |r| r.to_string()), q.text);
            }
        }
        let at = |k: usize, sel: &dyn Fn(&Query) -> bool| {
            let qs: Vec<_> = queries.iter().zip(&ranks).filter(|(q, _)| sel(q)).collect();
            qs.iter().filter(|(_, r)| r.is_some_and(|r| r <= k)).count() as f64 / qs.len().max(1) as f64
        };
        let mrr = ranks.iter().map(|r| r.map_or(0.0, |r| 1.0 / r as f64)).sum::<f64>() / queries.len() as f64;
        // Latency: every query 30 times, k = 6 as the tool asks.
        let mut times = Vec::new();
        for _ in 0..30 {
            for q in &queries {
                let t = Instant::now();
                std::hint::black_box(ix.search(&q.text, &SearchOpts { k: 6, path_prefix: None, max_per_file: 3, graph }).hits.len());
                times.push(t.elapsed().as_nanos() as f64 / 1000.0);
            }
        }
        times.sort_by(f64::total_cmp);
        let pct = |p: f64| times[((times.len() - 1) as f64 * p) as usize];
        let all = |_: &Query| true;
        println!(
            "{:<32} {:>5.0}% {:>5.0}% {:>5.0}% {:>6.0}% {:>6.3} | {:>7.0} {:>7.0} {:>7.0} | {:>8} {:>8}",
            name,
            100.0 * at(1, &all),
            100.0 * at(3, &all),
            100.0 * at(5, &all),
            100.0 * at(10, &all),
            mrr,
            pct(0.5),
            pct(0.95),
            pct(0.99),
            ix.entity_count(),
            ix.build_ms
        );
        let row: Vec<String> = kinds
            .iter()
            .map(|k| format!("{:>3.0}% / {:>3.0}%", 100.0 * at(1, &|q: &Query| q.kind == *k), 100.0 * at(5, &|q: &Query| q.kind == *k)))
            .collect();
        per_kind_rows.push((name, row));
    }
    println!("\nHit@1 / Hit@5 per query type");
    println!("{:<32} {}", "variant", kind_names.iter().map(|n| format!("{n:>16}")).collect::<String>());
    for (name, row) in per_kind_rows {
        println!("{:<32} {}", name, row.iter().map(|c| format!("{c:>16}")).collect::<String>());
    }
}
