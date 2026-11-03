//! Tokenising and entity extraction. No models: technical docs name their entities in a form
//! that rules find (identifiers, file names, `code spans`, version strings, acronyms).

/// Characters that join the parts of a compound identifier such as `rad_gemma4.h` or `qwen3.8-27b`.
fn is_joiner(c: char) -> bool {
    matches!(c, '_' | '-' | '.' | '/' | ':' | '+')
}

const STOPWORDS: &[&str] = &[
    // English
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "has", "have", "how",
    "i", "if", "in", "into", "is", "it", "its", "of", "on", "or", "so", "that", "the", "then", "there", "this",
    "to", "was", "what", "when", "where", "which", "who", "why", "with", "you", "your",
    // German
    "aber", "als", "am", "an", "auch", "auf", "aus", "bei", "bin", "bis", "das", "dass", "dem", "den", "der",
    "des", "die", "du", "ein", "eine", "einem", "einen", "einer", "es", "für", "hat", "ich", "im", "in", "ist",
    "mit", "nach", "nicht", "noch", "oder", "sich", "sie", "sind", "so", "und", "von", "vor", "wie", "wir",
    "wird", "wo", "zu", "zum", "zur",
];

pub fn is_stopword(w: &str) -> bool {
    STOPWORDS.contains(&w)
}

/// A light suffix stripper for English and German words, applied the same way to documents and
/// queries, so "converting", "converts" and "convert" meet. Identifiers are never stemmed.
fn stem(word: &str) -> &str {
    const SUFFIXES: &[&str] = &["ungen", "ung", "ing", "ies", "ed", "es", "en", "er", "s", "e"];
    let n = word.chars().count();
    for suf in SUFFIXES {
        if word.ends_with(suf) && n - suf.chars().count() >= 4 {
            return &word[..word.len() - suf.len()];
        }
    }
    word
}

/// Splits `part` at camelCase and letter/digit boundaries: "DFlash2" -> ["d", "flash", "2"].
fn camel_parts(part: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev: Option<char> = None;
    for c in part.chars() {
        if let Some(p) = prev {
            let boundary = (p.is_lowercase() && c.is_uppercase())
                || (p.is_alphabetic() && c.is_ascii_digit())
                || (p.is_ascii_digit() && c.is_alphabetic());
            if boundary && !cur.is_empty() {
                out.push(cur.to_lowercase());
                cur.clear();
            }
        }
        cur.push(c);
        prev = Some(c);
    }
    if !cur.is_empty() {
        out.push(cur.to_lowercase());
    }
    out
}

/// Calls `f` with each raw word of `text`: a run of alphanumerics and joiners, with joiners
/// trimmed from both ends ("model." -> "model", "`spec.md`" -> "spec.md").
pub fn raw_words<'t>(text: &'t str, mut f: impl FnMut(&'t str)) {
    let mut start: Option<usize> = None;
    let flush = |s: usize, e: usize, f: &mut dyn FnMut(&'t str)| {
        let w = text[s..e].trim_matches(is_joiner);
        if !w.is_empty() {
            f(w);
        }
    };
    for (i, c) in text.char_indices() {
        let inside = c.is_alphanumeric() || is_joiner(c);
        match (inside, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                flush(s, i, &mut f);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        flush(s, text.len(), &mut f);
    }
}

fn keep(t: &str) -> bool {
    t.chars().count() >= 2 || t.chars().any(|c| c.is_ascii_digit())
}

/// Pushes the search terms of `text` to `out`. A compound word yields itself and its parts, so
/// `rad_gemma4_dflash.h` is found by "gemma4 dflash" as well as by its full name.
pub fn terms(text: &str, out: &mut Vec<String>) {
    raw_words(text, |w| {
        let lower = w.to_lowercase();
        let compound = w.contains(is_joiner);
        let mixed = !compound && camel_parts(w).len() > 1;
        if !compound && !mixed {
            if keep(&lower) && !is_stopword(&lower) {
                let s = if lower.chars().all(char::is_alphabetic) { stem(&lower) } else { &lower };
                out.push(s.to_string());
            }
            return;
        }
        out.push(lower.clone());
        for part in w.split(is_joiner).filter(|p| !p.is_empty()) {
            let pl = part.to_lowercase();
            if keep(&pl) && !is_stopword(&pl) && pl != lower {
                out.push(pl.clone());
            }
            let sub = camel_parts(part);
            if sub.len() > 1 {
                for s in sub {
                    if s.len() >= 2 && !s.chars().all(|c| c.is_ascii_digit()) && !is_stopword(&s) && s != pl {
                        out.push(s);
                    }
                }
            }
        }
    });
}

/// Whether a raw word names something: an identifier, a file name, a version, an acronym.
pub fn is_entity_word(w: &str) -> bool {
    let n = w.chars().count();
    if !(2..=64).contains(&n) {
        return false;
    }
    let alpha = w.chars().filter(|c| c.is_alphabetic()).count();
    let digit = w.chars().filter(|c| c.is_ascii_digit()).count();
    let upper = w.chars().filter(|c| c.is_uppercase()).count();
    if alpha == 0 {
        return false; // plain numbers and dates are not entities
    }
    let compound = w.contains(is_joiner);
    let camel = w.chars().skip(1).any(|c| c.is_uppercase()) && w.chars().any(|c| c.is_lowercase());
    let acronym = upper == alpha && (2..=6).contains(&alpha) && !is_stopword(&w.to_lowercase());
    let alnum = digit > 0;
    compound || camel || acronym || alnum
}

/// The entities a chunk mentions, lowercased: code spans, identifier-like words and link targets.
pub fn entities(text: &str, out: &mut Vec<String>) {
    // `code spans` (not fences): the author marked these as names.
    let mut rest = text;
    while let Some(a) = rest.find('`') {
        let after = &rest[a + 1..];
        if after.starts_with('`') {
            rest = after.trim_start_matches('`');
            continue;
        }
        match after.find(['`', '\n']) {
            Some(b) if after.as_bytes()[b] == b'`' => {
                // `--flag` and `flag` are one name; a span of one plain word (`build`) is not a
                // name, BM25 has it already.
                let span = after[..b].trim().trim_matches(is_joiner);
                let words = span.split_whitespace().count();
                if (2..=64).contains(&span.chars().count()) && (2..=3).contains(&words)
                    || words == 1 && is_entity_word(span)
                {
                    out.push(span.to_lowercase());
                }
                rest = &after[b + 1..];
            }
            Some(b) => rest = &after[b..],
            None => break,
        }
    }
    // Markdown link targets: [text](docs/PLUGIN.md#anchor) names the file PLUGIN.md.
    let mut rest = text;
    while let Some(i) = rest.find("](") {
        let after = &rest[i + 2..];
        let Some(end) = after.find(')') else { break };
        let target = after[..end].split('#').next().unwrap_or("");
        if !target.is_empty() && !target.contains("://") {
            if let Some(name) = target.rsplit('/').next().filter(|n| n.contains('.')) {
                out.push(name.to_lowercase());
            }
        }
        rest = &after[end..];
    }
    for line in text.lines() {
        // Lines in capitals (licence text, banners) shout; their words are not names.
        let letters = line.chars().filter(|c| c.is_alphabetic()).count();
        let upper = line.chars().filter(|c| c.is_uppercase()).count();
        if letters >= 20 && upper * 10 > letters * 6 {
            continue;
        }
        raw_words(line, |w| {
            if is_entity_word(w) {
                out.push(w.to_lowercase());
            }
        });
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn german_words_bring_english() {
        let q = super::with_translations("Wo werden die Karten im Speicher verteilt?");
        for w in ["card", "memory", "distribute"] {
            assert!(q.contains(w), "{w} missing from {q}");
        }
        assert_eq!(super::with_translations("evict_lru"), "evict_lru");
    }

    use super::*;

    fn t(s: &str) -> Vec<String> {
        let mut v = Vec::new();
        terms(s, &mut v);
        v
    }

    #[test]
    fn compounds_keep_whole_and_parts() {
        let v = t("see rad_gemma4_dflash.h.");
        assert!(v.contains(&"rad_gemma4_dflash.h".to_string()));
        assert!(v.contains(&"gemma4".to_string()));
        assert!(v.contains(&"gemma".to_string()));
        assert!(v.contains(&"dflash".to_string()));
    }

    #[test]
    fn stems_meet() {
        assert_eq!(t("converting"), t("converts"));
        assert_eq!(t("Checkpoints"), t("checkpoint"));
    }

    #[test]
    fn entity_rules() {
        let mut v = Vec::new();
        entities("Use `pi-bolt compile` with DFlash2 on gfx1201, see [x](docs/PLUGIN.md#a) and the MTP head.", &mut v);
        for e in ["pi-bolt compile", "dflash2", "gfx1201", "plugin.md", "mtp"] {
            assert!(v.contains(&e.to_string()), "{e} missing from {v:?}");
        }
        assert!(!v.contains(&"head".to_string()));

        let mut v = Vec::new();
        entities("Pass `--draft-short-from N` or `--draft-short-from`; run `build` in `the` repo.", &mut v);
        assert!(v.contains(&"draft-short-from".to_string()), "{v:?}");
        assert!(v.contains(&"draft-short-from n".to_string()), "{v:?}");
        assert!(!v.iter().any(|e| e == "build" || e == "the"), "{v:?}");

        let mut v = Vec::new();
        entities("THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND\nUse TP4 IN the DIR.", &mut v);
        assert_eq!(v, ["tp4", "dir"]);
    }
}

/// The query with English words added for the German technical words in it (see `lexicon`), so
/// `query("Wo wird der Speicher freigegeben")` also searches for "memory storage free release".
pub fn with_translations(query: &str) -> std::borrow::Cow<'_, str> {
    use std::sync::OnceLock;
    static BY_STEM: OnceLock<rustc_hash::FxHashMap<String, &'static str>> = OnceLock::new();
    let by_stem = BY_STEM.get_or_init(|| {
        let mut m = rustc_hash::FxHashMap::default();
        for (de, en) in crate::lexicon::DE_EN {
            let mut t = Vec::new();
            terms(de, &mut t);
            if let Some(stem) = t.into_iter().next() {
                m.insert(stem, *en);
            }
        }
        m
    });
    let mut t = Vec::new();
    terms(query, &mut t);
    let mut added = String::new();
    for term in t {
        // Participles and verb forms: "verteilt", "geteilt", "freigegeben" -> "verteil", "teil", "freigegeb".
        let bare = term.strip_prefix("ge").filter(|r| r.len() >= 4).unwrap_or(&term);
        let candidates = [term.as_str(), term.strip_suffix('t').unwrap_or(""), bare, bare.strip_suffix('t').unwrap_or("")];
        if let Some(en) = candidates.iter().filter(|c| !c.is_empty()).find_map(|c| by_stem.get(*c)) {
            added.push(' ');
            added.push_str(en);
        }
    }
    if added.is_empty() {
        std::borrow::Cow::Borrowed(query)
    } else {
        std::borrow::Cow::Owned(format!("{query}{added}"))
    }
}
