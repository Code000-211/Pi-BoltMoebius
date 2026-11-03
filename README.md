# Pi-Bolt with project_search

A fork of [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt). This page covers only what the fork adds.

## project_search

[docsearch](packages/docsearch) is a search over the project's code and documentation, written in Rust and compiled into
Pi-Bolt with `pi-bolt compile`. The agent gets the tool `project_search`, matching doc sections are added to a typed prompt
before the model runs, and `/docs` searches by hand. No model runs at search time: BM25 over sections and a graph of sections
and the names they mention. Code is split at its definitions, so a function's name finds its definition first.

| | Pi-Bolt's `grep` | `project_search` |
|---|---:|---:|
| Doc question: the answer among the first 3 results | 40% | **83%** |
| Function by name: the definition first | 55% | **83%** |
| Function by name: the definition among the first 3 | 77% | **97%** |
| Time per search, docs | 0.33 ms | **0.06 ms** |
| Time per search, function by name | 6.4 ms | **0.05 ms** |

<sub>Both in one Bun process on the same snapshot of a 1,400-file C++/HIP project (radiance), Linux x86-64; 60 doc questions
and 60 function names with known answers. grep was given the rarest word of each question, which favours it: an agent does not
know the counts before it searches. Medians.</sub>

What it changes for the agent, in pibench runs (`melious/glm-5.3-flash`, median of 5 runs, with and without docsearch):

| Task | Without | With |
|---|---:|---:|
| Look up a setting in the docs | 1.4 s, 2 turns | **0.6 s, 1 turn** |
| Find a function by what it does | 6.5 s, 8 turns | **5.6 s, 6 turns** |
| Find where a function is defined | 1.3 s | **0.9 s** |

<sub>Tasks that did not use it moved by up to 30% either way between runs, which is the noise at 5 runs; every run of both
variants gave the right answer.</sub>

- **Ready at once:** the index is a file that is mapped. The first process on a project builds it (0.9 s for 1,400 files);
  every later one is ready in 12 ms instead.
- **One copy in memory:** about 32 MB per process, plus 110 MB of index that every process on the project shares, where an
  index held in each process would take about 460 MB.
- **Current while you edit:** a changed file is searchable within a second (51 ms in the test), without rewriting the index;
  it is rebuilt and saved once nothing has changed for 30 s.
- **grep stays:** for exact text across all files, such as every call site of a function, the agent still uses `grep`.

## Install

Needs Rust (stable) and an installed Pi-Bolt.

```sh
packages/docsearch/install.sh                 # builds the addon, installs the extension to ~/.pi/agent/extensions/docsearch
pi-bolt compile --only docsearch              # compiles it into the executable; list every extension you compile in
```

Settings, the test sets and how to measure a change: [packages/docsearch](packages/docsearch).
