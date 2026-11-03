# Pi-Bolt fork

A fork of [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt). This page covers only what it changes. Measured numbers
are marked as such; the others are limits the code sets.

- [Faster grep and find](#faster-grep-and-find)
- [project_search](#project_search)
- [Diagnostics after every edit](#diagnostics-after-every-edit)
- [Read before edit](#read-before-edit)
- [Edit tool: indentation-tolerant matching](#edit-tool-indentation-tolerant-matching)
- [Nested AGENTS.md and CLAUDE.md](#nested-agentsmd-and-claudemd)
- [System prompt](#system-prompt)
- [bash tool](#bash-tool)
- [Melious provider](#melious-provider)
- [Tests](#tests)

## Faster grep and find

The in-process `grep` and `find` keep the project's file tree and file contents in memory between calls, and match
literal patterns with a native SIMD search (AVX2 on x86-64, NEON on ARM64).

| Measured | Pi-Bolt | This fork | |
|---|---:|---:|---:|
| `grep` a function name (case-sensitive), p50 | 12.8 ms | **7.5 ms** | 1.7× |
| `grep` a word, ignoring case, p50 | 11.3 ms | **1.9 ms** | 6× |
| `grep` a word, ignoring case, p90 | 41 ms | **6.5 ms** | 6.3× |
| `find` a glob, p50 | 1.65 ms | **0.22 ms** | 7.5× |
| First `grep` in a process | 19 ms | 22 ms | same |

<sub>Measured: both implementations in Bun on a 1,400-file C++/HIP project, Linux x86-64 (Ryzen 7 5800X3D); 60 function
names and 60 words, each searched 5 times, medians; two runs agreed within 0.4 ms.</sub>

- File tree reused for 2 s without checks, then revalidated against the modification times of up to 256 folders.
- `grep` with a glob uses the cached tree too (it walked the folders again on every call): the walk keeps the files ignore
  files leave out aside, for globs, which take them as ripgrep's `--glob` does. Measured on the same project, p50 of 24
  searches: `*.cpp` 3.8 → 2.2 ms, `*.{h,hpp}` 2.7 → 1.4 ms, `src/**/*.hip` 1.4 → 0.08 ms.
- Contents cached up to 64 MB in all and 512 KB per file; within 1.5 s of a check, a file is not stat'ed again.
- A file read or written that the cached tree does not know makes it walk again only when the file is in its folder and
  not below a folder an ignore file leaves out (before: every cached tree, for any such file, such as a read in `build/`).
- A `find` glob that matches nothing returns the closest paths by fuzzy match instead.
- Without a C compiler to build the native search, the caches still work and matching falls back to TypeScript.

## project_search

[docsearch](packages/docsearch): a search over the project's code and documentation, in Rust, compiled into Pi-Bolt with
`pi-bolt compile`. The agent gets the tool `project_search`, matching doc sections are added to a typed prompt, and `/docs`
searches by hand. No model runs at search time: BM25 over sections and a graph of sections and the names they mention. Code
is split at its definitions, so a function's name finds its definition first.

| Measured | `grep` | `project_search` |
|---|---:|---:|
| Doc question: the answer among the first 3 results | 40% | **83%** |
| Function by name: the definition first | 55% | **83%** |
| Function by name: the definition among the first 3 | 77% | **97%** |
| Time per search, docs | 0.33 ms | **0.06 ms** |
| Time per search, function by name | 6.4 ms | **0.05 ms** |

<sub>Both in one Bun process on the same snapshot of the same project; 60 doc questions and 60 function names with known
answers. grep was given each question's rarest word, which favours it: an agent does not know the counts before it searches.</sub>

| Measured in pibench (`melious/glm-5.3-flash`, median of 5 runs) | Without | With |
|---|---:|---:|
| Look up a setting in the docs | 1.4 s, 2 turns | **0.6 s, 1 turn** |
| Find a function by what it does | 6.5 s, 8 turns | **5.6 s, 6 turns** |
| Find where a function is defined | 1.3 s | **0.9 s** |

<sub>Tasks that did not use it moved by up to 30% either way between runs, the noise at 5 runs; every run gave the right
answer.</sub>

- The index is a mapped file: the first process builds it (0.9 s for 1,400 files), every later one is ready in 12 ms.
- About 32 MB per process, plus 110 MB of index shared by every process on the project (about 460 MB each without).
- A changed file is searchable within a second (51 ms in the test) without rewriting the index; the index is rebuilt once
  nothing has changed for 30 s. `grep` stays the tool for exact text across all files, such as every call site.

Install: `packages/docsearch/install.sh`, then `pi-bolt compile` ([details](packages/docsearch)).

## Diagnostics after every edit

After `edit` or `write` on C, C++, HIP or Rust, the tool result lists the compiler diagnostics the edit introduced, as a
`<new-diagnostics>` block. The ones that were there before are left out: they are collected in the background when the file
is read.

| Limit | |
|---|---:|
| Diagnostics listed per edit | 15, then "and N more" |
| C/C++/HIP, clangd: wait for an edit / for the baseline on read | 350 ms / 1.5 s |
| Rust, rust-analyzer: wait for an edit / for the baseline on read | 400 ms / 0.8 s |
| Rust: cargo check results that arrive later | settled 0.3 s after the check ends, or after 2 s without news; then added to the next tool result (up to 10 per file) |
| Error limit passed to the compiler | 20 |

- **C, C++, HIP** (`.c .cc .cpp .cxx .cu .hip` and headers): through libclang in process when a libclang library is found
  (`LIBCLANG_PATH`, ROCm's, or the system's), else clangd (`CLANGD_PATH`, `/opt/rocm/llvm/bin/clangd`, or on `PATH`).
  Flags come from `compile_commands.json` in the project or one of up to 5 parent folders (also in `build/`, `out/`,
  `cmake-build-*`), cleaned of GCC-only flags; HIP gets one `--offload-arch` (`HCC_AMDGPU_TARGET`, `HIP_OFFLOAD_ARCH`, else
  `gfx1100`). A header is checked inside a source file that includes it.
- **Rust:** rust-analyzer (`RUST_ANALYZER_PATH` or on `PATH`) with cargo check on save.
- Without these tools the edit goes through as before, with no diagnostics. A diagnostic that was fixed and comes back is
  reported again; a second copy of an existing one counts as new.

## Read before edit

- `edit` and `write` refuse to change an existing file the agent has not read in this session.
- They refuse a file that changed since it was read: its content differs from what was last read or written. A newer
  modification time (more than 10 ms) with the same content, such as after `touch` or a formatter that changed nothing,
  is not a change.
- `edit` still applies to a file that changed on disk when every `oldText` matches the current content exactly once,
  and says so in its result; the agent does not have to read the file again. `write` replaces the whole file, so it
  keeps refusing.
- The edit tool's guidelines tell the model to read a file before its first edit.
- Files of 1 MB or more read in pieces can still be edited. Files with CRLF line endings or a BOM keep them across edits.
- After an edit, the result shows the changed lines with 3 lines of context.

## Edit tool: indentation-tolerant matching

When `oldText` matches neither exactly nor by the existing fuzzy match, the edit tool compares line by line ignoring
leading and trailing whitespace (Codex's `seek_sequence`), and re-indents `newText` to the file's indentation, for example
when the model sends spaces and the file uses tabs. More than one match is still refused.

When `oldText` matches nowhere, the error shows the closest text in the file with its line numbers (up to 20 lines)
and the first line that differs, so the model can correct the edit without reading the file again. Candidates are the
lines equal to one of `oldText`'s lines, else the lines most like its first line (character-pair similarity of at least
0.5). Measured on 50,000 near-identical lines: 9 ms when one line of `oldText` is in the file, 48 ms when none is.

## Nested AGENTS.md and CLAUDE.md

When the agent reads a file, the `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md` of each folder between the project root
and that file is added to the result, once per session (as Claude Code does). The root's own file is not repeated.

## System prompt

- Added: make independent tool calls in parallel in one response.
- Added: keep changes to what was asked: no unrequested features, unrelated refactors, or comments on unchanged code.
- Added: a `<communication>` section (verify premises first, bottom line first, correct directly, short paragraphs, label
  certainty as verified, likely or unsupported).
- Removed: "Be concise in your responses".

## bash tool

- A command without shell syntax (no pipes, redirection, variables, quotes or globs) runs its program directly, without
  starting a shell.
- Other commands run in a bash started ahead of time and kept ready, when the shell and folder match.
- Shell lookups on Windows are cached. Not measured.
- The model gets the output without escape sequences, control characters or progress-bar redraws (a line rewritten
  after `\r` only as it was last written), and commands run with `NO_COLOR=1` unless `NO_COLOR` or `FORCE_COLOR` is set.
- Output over 2000 lines or 32 KB (was 50 KB, the end only) keeps its first 40 lines (up to 4 KB) and its end, so the
  first compiler error and the summary are both there. The full output is still saved to a file.

## Melious provider

Provider `melious` (`MELIOUS_API_KEY`, `https://api.melious.ai/v1`), with 18 models built in and default model `glm-5.3`.
With a key, context windows and prices are fetched from Melious when the model list is loaded (15 s timeout), and models
Melious lists that are not built in are added. Without a connection, the built-in list is used.

## Tests

- `packages/coding-agent/test/claude-harness.test.ts`: 18 cases, with mock clangd and rust-analyzer, for the diagnostics,
  read before edit, nested instruction files, the search caches, the bash fast paths and the edit fallback.
- `packages/ai/test/melious-models.test.ts`: 3 cases for the Melious catalog.
- `packages/docsearch`: 11 Rust tests, and test sets that measure a change query by query (`eval/`).
