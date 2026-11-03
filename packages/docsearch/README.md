# docsearch

Search over a project's code and documentation for Pi-Bolt's agent, in a Rust addon compiled into the executable. It
adds the tool `project_search`, adds matching doc sections to a typed prompt (auto-recall), and the command `/docs`.

- **No model at search time.** BM25 over sections, plus a graph of sections and the names they mention, walked with
  personalized PageRank (the retrieval of HippoRAG and E²GraphRAG, with rule-based entities instead of an LLM or NER).
- **Docs are split at their headings, code at its definitions**: one section per function, class or struct, named by
  it, in C, C++, HIP, CUDA, Rust, Python, JavaScript, TypeScript, Go and shell scripts. A query that names a function
  or type gets its definition first.
- **The index is a file, mapped.** The first process on a folder builds and saves it; every later one is ready in
  milliseconds and shares the same pages. Changed files are searched from a small overlay within a second of the
  change; the saved index is rebuilt once the files have been quiet for 30 seconds.

## Measured

On radiance (1,400 files, 45,000 sections; test sets in `eval/`, 60 doc queries, 60 function names, 40 function
descriptions):

| | Hit@1 | Hit@3 | Hit@10 |
|---|---|---|---|
| Docs | 73% | 83% | 88% |
| Code, function by name | 87% | 97% | 98% |
| Code, function by description | 15% | 32% | 55% |
| TypeScript, function or type by name (Pi-Bolt's sources) | 98% | 100% | 100% |

TypeScript, JavaScript, Go and shell files were split like plain text until the change that added them: the same 60
TypeScript names had 53% / 83% / 98% then (search p50 33 → 38 µs, build 93 → 107 ms for 568 files).

| | |
|---|---|
| Search, seen from Bun, each query once (p50) | docs 77 µs, names 99 µs, descriptions 336 µs |
| The same query again (result cache) | ~15 µs |
| Index build (once per folder) | ~0.9 s |
| Ready in a process when the index file exists | ~12 ms |
| Memory per process with the mapped index | ~32 MB private, ~110 MB page cache shared by all |
| A changed file searchable after | ≤ ~1 s (51 ms in the test), nothing written to disk |

Against the grep tool's native search (nativeGrep), on the same snapshots: docs Hit@3 83% vs 40% (grep for the
rarest word of the question), definition first for a function name 83% vs 55%, at 0.05–0.2 ms vs 0.3–6 ms. grep stays
the tool for exact text across all files, such as every call site. In pibench (melious/glm-5.3-flash, 5 runs per task)
`docs_lookup` took 0.6 s instead of 1.4 s and one turn instead of two; the other tasks moved within the noise.

Tried and dropped, with the numbers in the history of this package's work: GLiNER entities (one more doc query found
of 60, 25 minutes of indexing), section similarity from EmbeddingGemma as graph edges or as expansion (no gain), query
embeddings (docs Hit@10 88% → 97%, but ~22 ms per search on the CPU).

## Build and install

Needs Rust (stable) and Pi-Bolt's `pi-bolt compile`.

```sh
packages/docsearch/install.sh                 # builds the addon, copies it and the extension to ~/.pi/agent/extensions/docsearch
pi-bolt compile --only klar-ui,docsearch      # compiles it into the executable (list the extensions you compile in)
```

`install.sh` honours `PI_CODING_AGENT_DIR`. The addon is loaded by a literal `require`, so `pi-bolt compile` embeds
it in the executable. `PI_DOCSEARCH=off` leaves the extension out of a run (no tool, no recall), to measure without it.

## Settings

`~/.pi/agent/docsearch.json`:

| Key | Default | |
|---|---|---|
| `project` | `true` | Index the project Pi runs in (its git root, else the working directory; never `~` or `/`). |
| `roots` | `[]` | More folders, indexed everywhere. |
| `code` | `true` | Index source files as well as docs. |
| `extensions` | | Replace the indexed file extensions. |
| `results`, `resultChars` | `6`, `[1500, 1000, 600]` | The best three results come with this much text, the rest as `path:lines` only. |
| `autoRecall` | `true` | Add matching doc sections to a typed prompt; `/docs auto on\|off`. |

The index files live in `~/.cache/docsearch/index/` (`DOCSEARCH_CACHE_DIR` to move them). A folder whose build takes
less than 100 ms is kept in memory only. Files unused for 30 days are removed.

## Layout

- `core/`: the index (`index.rs`), its flat file format (`store.rs`), splitting (`chunk.rs`), terms and entities
  (`text.rs`, `lexicon.rs` for German questions), and the engine that keeps it current (`engine.rs`).
  `cargo run --release --bin dsq -- <root> -- <query>` searches from the command line.
- `node/`: the Node-API binding the extension loads.
- `extension/index.ts`: the Pi extension.
- `eval/`: test sets and the scripts that measure against them.

## Measuring a change

The test sets point at frozen snapshots of radiance taken on 2026-11-03: `corpus/` with its tracked Markdown and text
files, `code/` with its tracked source files. `ts-names.tsv` points at `ts/`, Pi-Bolt's TypeScript at commit `5641c898`
of this fork: `git archive 5641c898 packages/{coding-agent,ai,agent,tui}/src | tar -x -C ts`, without
`models.generated.ts`. Put them in one folder, then:

```sh
cargo build --release -p docsearch-core
DOCSEARCH_EVAL_DATA=<folder> packages/docsearch/eval/compare.sh before   # before the change
DOCSEARCH_EVAL_DATA=<folder> packages/docsearch/eval/compare.sh after before
```

`compare.sh` counts the queries that moved up and down, not only the averages. `cargo test -p docsearch-core` checks
splitting, entities, the file format and that the overlay ranks like a rebuild.
