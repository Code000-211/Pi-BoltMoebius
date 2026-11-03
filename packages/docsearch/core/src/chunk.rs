//! Splitting a document into sections an agent can read in one go.

/// Sections longer than this are split at paragraph breaks.
const MAX_CHARS: usize = 1600;
/// Windows cut from a long section aim for this size.
const TARGET_CHARS: usize = 1100;

pub struct Chunk {
    /// Headings above the section, outermost first, joined with " › ".
    pub heading: String,
    /// 1-based, inclusive.
    pub line_start: u32,
    pub line_end: u32,
    pub text: String,
}

fn heading_level(line: &str) -> Option<(usize, &str)> {
    let hashes = line.bytes().take_while(|&b| b == b'#').count();
    if (1..=6).contains(&hashes) && line[hashes..].starts_with([' ', '\t']) {
        Some((hashes, line[hashes..].trim().trim_end_matches('#').trim()))
    } else {
        None
    }
}

/// Splits Markdown at its headings (outside code fences); other text files become windows of
/// paragraphs under the file name.
pub fn split(text: &str, markdown: bool) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut section: Vec<&str> = Vec::new();
    let mut section_start = 1u32;
    let mut in_fence = false;

    for (i, line) in text.lines().enumerate() {
        let lineno = i as u32 + 1;
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
        }
        if markdown && !in_fence {
            if let Some((level, title)) = heading_level(line) {
                flush(&stack, &section, section_start, &mut out);
                while stack.last().is_some_and(|(l, _)| *l >= level) {
                    stack.pop();
                }
                stack.push((level, title.to_string()));
                section.clear();
                section_start = lineno;
            }
        }
        section.push(line);
    }
    flush(&stack, &section, section_start, &mut out);
    out
}

fn flush(stack: &[(usize, String)], lines: &[&str], start: u32, out: &mut Vec<Chunk>) {
    let heading = stack.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" › ");
    // A heading with nothing under it adds nothing: its title reaches the children's path.
    let body_lines = lines.iter().skip(if stack.is_empty() { 0 } else { 1 });
    if body_lines.clone().all(|l| l.trim().is_empty()) {
        return;
    }
    let total: usize = lines.iter().map(|l| l.len() + 1).sum();
    if total <= MAX_CHARS {
        out.push(Chunk { heading, line_start: start, line_end: start + lines.len() as u32 - 1, text: lines.join("\n") });
        return;
    }
    // Long section: cut windows at blank lines once a window reaches TARGET_CHARS, or at any
    // line once it passes MAX_CHARS (a long code block or table).
    let mut w_start = 0usize;
    let mut w_len = 0usize;
    for (i, line) in lines.iter().enumerate() {
        w_len += line.len() + 1;
        let at_break = line.trim().is_empty() && w_len >= TARGET_CHARS;
        if at_break || w_len >= MAX_CHARS || i + 1 == lines.len() {
            let slice = &lines[w_start..=i];
            if slice.iter().any(|l| !l.trim().is_empty()) {
                out.push(Chunk {
                    heading: heading.clone(),
                    line_start: start + w_start as u32,
                    line_end: start + i as u32,
                    text: slice.join("\n"),
                });
            }
            w_start = i + 1;
            w_len = 0;
        }
    }
}

/// The name a line defines, when it starts a function, method, class or struct: top-level C/C++
/// definitions (`int foo(...)` with the body's `{` on this or the next lines), Python `def` and
/// `class` up to one indent, Rust `fn`, `struct`, `enum`, `impl`.
fn defined_name(lines: &[&str], i: usize, python: bool) -> Option<String> {
    let line = lines[i];
    let t = line.trim_start();
    let indent = line.len() - t.len();
    let ident = |s: &str| -> String { s.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect() };
    if python {
        for kw in ["def ", "async def ", "class "] {
            if indent <= 4 && t.starts_with(kw) {
                let n = ident(&t[kw.len()..]);
                return (!n.is_empty()).then_some(n);
            }
        }
        return None;
    }
    for kw in ["pub fn ", "fn ", "pub(crate) fn ", "pub struct ", "struct ", "pub enum ", "enum ", "impl ", "pub trait ", "trait "] {
        if indent <= 4 && t.starts_with(kw) {
            let n = ident(t[kw.len()..].trim_start_matches(['<', '\'']));
            if !n.is_empty() {
                return Some(n);
            }
        }
    }
    // C, C++, HIP: a definition at column 0 (or 4, inside a namespace or class).
    if indent > 4 || t.is_empty() || t.starts_with(['#', '/', '*', '}', '{', ')']) || t.trim_end().ends_with(';') {
        return None;
    }
    if let Some(rest) = t.strip_prefix("class ").or_else(|| t.strip_prefix("struct ")) {
        let n = ident(rest);
        let opens = lines[i..lines.len().min(i + 3)].iter().any(|l| l.contains('{'));
        return (!n.is_empty() && opens && !t.trim_end().ends_with(';')).then_some(n);
    }
    let paren = t.find('(')?;
    let before = t[..paren].trim_end();
    let name: String = before.rsplit(|c: char| !(c.is_alphanumeric() || c == '_' || c == ':' || c == '~')).next()?.to_string();
    let last = name.rsplit("::").next().unwrap_or(&name).trim_start_matches('~');
    // (A line of prose in a comment block, "the result (in bytes) ...", is not a definition of `the`.)
    if last.is_empty()
        || matches!(last, "if" | "for" | "while" | "switch" | "return" | "sizeof" | "catch" | "defined")
        || crate::text::is_stopword(&last.to_lowercase())
    {
        return None;
    }
    // A type or qualifier before the name, so this is not a call statement.
    if before.len() == name.len() && !name.contains("::") {
        return None;
    }
    // The body opens before any `;` within the next few lines.
    let window = lines[i..lines.len().min(i + 6)].join("\n");
    let brace = window.find('{')?;
    if window[..brace].contains(';') {
        return None;
    }
    Some(name)
}

/// Splits source code at its definitions: one section per function, class or struct, named
/// by it, so that a search for a name lands on where it is defined.
pub fn split_code(text: &str, python: bool) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut start = 0usize;
    for i in 0..lines.len() {
        if let Some(name) = defined_name(&lines, i, python) {
            // Comments and attributes just above a definition belong to it.
            let mut head = i;
            while head > start && {
                let p = lines[head - 1].trim_start();
                p.starts_with("//") || p.starts_with("///") || p.starts_with('*') || p.starts_with("/*") || p.starts_with('#') && !p.starts_with("#include") || p.starts_with('@') || p.starts_with("template")
            } {
                head -= 1;
            }
            // A header with nothing of its own before the next definition (`class Box:` right
            // above `def size`) joins it, and names it too.
            let only_header = !stack.is_empty() && lines[start + 1.min(head - start)..head].iter().all(|l| l.trim().is_empty());
            if only_header && head > start {
                let outer = stack.pop().map(|(_, n)| n).unwrap_or_default();
                stack = vec![(1, format!("{outer} › {name}"))];
                continue;
            }
            if head > start {
                flush(&stack, &lines[start..head], start as u32 + 1, &mut out);
            }
            stack = vec![(1, name)];
            start = head;
        }
    }
    if start < lines.len() {
        flush(&stack, &lines[start..], start as u32 + 1, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_nest_and_fences_hide_hashes() {
        let doc = "# A\nintro\n## B\nb text\n```sh\n# not a heading\n```\n# C\nc text\n";
        let c = split(doc, true);
        let h: Vec<_> = c.iter().map(|c| c.heading.as_str()).collect();
        assert_eq!(h, ["A", "A › B", "C"]);
        assert_eq!((c[1].line_start, c[1].line_end), (3, 7));
    }

    #[test]
    fn code_splits_at_definitions() {
        let src = "#include <x.h>\n\n// Adds.\nstatic int add(int a, int b)\n{\n    return a + b;\n}\n\nvoid Pool::evict(Block *b) {\n    free(b);\n}\nint x = f(1);\n";
        let c = split_code(src, false);
        let h: Vec<_> = c.iter().map(|c| c.heading.as_str()).collect();
        assert_eq!(h, ["", "add", "Pool::evict"]);
        assert_eq!(c[1].line_start, 3, "the comment above belongs to the function");
        let py = split_code("import os\n\ndef load(p):\n    return p\n\nclass Box:\n    def size(self):\n        return 1\n", true);
        let h: Vec<_> = py.iter().map(|c| c.heading.as_str()).collect();
        assert_eq!(h, ["", "load", "Box › size"]);
    }

    #[test]
    fn long_sections_split() {
        let para = "word ".repeat(100);
        let doc = format!("# T\n{para}\n\n{para}\n\n{para}\n\n{para}\n");
        let c = split(&doc, true);
        assert!(c.len() >= 2);
        assert!(c.iter().all(|c| c.text.len() <= MAX_CHARS + 600));
    }
}
