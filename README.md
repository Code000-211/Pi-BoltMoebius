# Pi-Lightspeed

**A Pi-Bolt fork whose agent wastes less time.** [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt) is Pi, the coding agent,
compiled ahead of time to one native executable. Pi-Lightspeed keeps all of that and works on the agent itself: how fast
it finds code, what it learns from each edit, how it runs long commands, and how much context it sends again. Measured
numbers say how they were measured; anything not measured says so.

The executable is still called `pi-bolt`, and Pi-Bolt's commands (`pi-bolt compile`, `pi-bolt update`) work as before.

**Measured against stock Pi 1.4.0** with [harnessbench](bench/harness) (14 coding tasks with hidden tests, two models, 5
runs each, 280 runs): the same tasks solved (137/140 vs 138/140) in **17% less time** (1,740 vs 2,099 s; 95% CI of the
ratio 0.69–0.92), with fewer turns (median 4 vs 5) and 20% lower cost. [Details](#benchmark).

## At a glance

| Area | What Pi-Lightspeed does better | Measured |
|---|---|---|
| [Search](#finding-code) | `grep`/`find` keep the file tree and contents in memory and match with SIMD | `grep` 1.7–6× faster, `find` 7.5× (p50) |
| [Search](#project_search) | `project_search`: code and docs search that finds a function's definition first | definition first 55% → **83%**; doc answer in top 3 40% → **83%** |
| [Editing](#compiler-diagnostics-after-every-edit) | The compiler's new errors after every `edit`/`write`, from ten languages' checkers in the background with no wait | Rust type error on Moebius: reported in **3 s** (rust-analyzer: none in 84 s) |
| [Editing](#fewer-refused-edits) | An exact edit applies even to a file seen only through bash | 21% of real edits were refused before |
| [Editing](#edit-matching) | Edits that miss by indentation still apply; a miss shows the closest lines | |
| [Editing](#no-edits-behind-the-edit-tools-back) | `sed -i` and text redirected into files are sent to `edit`/`write`, which check what they change | 65 of 2,615 real commands |
| [Commands](#background-jobs-instead-of-sleep) | Long commands become background jobs that wake the agent; a `wait` tool; no fixed `sleep` | 97 real `sleep` calls had waited 3.2 h |
| [Commands](#job-hub) | A job hub (`alt+j`): every background job, its live output, stop with `x` | |
| [Commands](#bash-output-and-speed) | Output keeps the first error *and* the summary; read-only commands start while the model still writes | |
| [Remote](#working-on-another-machine) | `/remote host:folder`: read, edit, write and bash work there over ssh, with the same checks | one ssh login, then a round trip per call |
| [Context](#context-and-compaction) | Compaction at 128k at most, old tool results shortened, summaries from the prompt cache and made ahead | compaction input 54k → **8.4k** new tokens; no stop at the threshold (14–95 s before) |
| [Turns](#fewer-turns) | A listing of the project in the prompt, an edit and its test in one response, a smaller prompt than Pi's | median 4 turns vs 5–6 |
| [Provider](#melious-provider) | Melious built in, with live context windows and prices | |

## Contents

- [Install](#install)
- [Finding code](#finding-code) · [project_search](#project_search)
- [Editing](#editing): [diagnostics](#compiler-diagnostics-after-every-edit) ·
  [fewer refused edits](#fewer-refused-edits) · [edit matching](#edit-matching) ·
  [no edits behind the edit tool's back](#no-edits-behind-the-edit-tools-back)
- [Running commands](#running-commands): [background jobs](#background-jobs-instead-of-sleep) ·
  [job hub](#job-hub) · [output and speed](#bash-output-and-speed)
- [Working on another machine](#working-on-another-machine)
- [Context and compaction](#context-and-compaction) · [Fewer turns](#fewer-turns) · [Benchmark](#benchmark)
- [System prompt](#system-prompt) · [Melious provider](#melious-provider)
- [Switches](#switches) · [Tests](#tests) · [Credits](#credits)

## Install

There are no releases of Pi-Lightspeed yet; it is built from source with Pi-Bolt's own scripts. Needs git, Python 3 and Node.js
22.19 or later. Tested on Linux x86-64.

```bash
git clone https://github.com/Code000-211/Pi-Lightspeed.git && cd Pi-Lightspeed
scripts/fetch-runtime.sh             # Pi-Bolt's runtime from its latest signed release -> .work/runtime/bun
scripts/prepare-pi.sh                # builds Pi from this repository
scripts/build-pi.sh --kit .work/kit  # -> out/pi-bolt/pi, and the kit for compiling extensions in
out/pi-bolt/pi --version
```

To replace an installed Pi-Bolt, put `out/pi-bolt` where its installer put the build (on Linux x86-64
`~/.pi-bolt/pi-bolt-linux-x64`; keep the old folder to go back), then compile your extensions in again:

```bash
pi-bolt compile --kit .work/kit --runtime .work/runtime/bun
```

[docsearch](packages/docsearch) (`project_search`) is installed with `packages/docsearch/install.sh` before that compile.

## Finding code

`grep` and `find` keep the project's file tree and file contents in memory between calls, and match literal patterns with
a native SIMD search (AVX2 on x86-64, NEON on ARM64). They are not on by default (`--tools +grep,+find` or the
`defaultTools` setting): their schemas cost every request about 400 tokens, and models search with `rg` in bash anyway.

| Measured | Pi-Bolt | Pi-Lightspeed | |
|---|---:|---:|---:|
| `grep` a function name (case-sensitive), p50 | 12.8 ms | **7.5 ms** | 1.7× |
| `grep` a word, ignoring case, p50 | 11.3 ms | **1.9 ms** | 6× |
| `grep` a word, ignoring case, p90 | 41 ms | **6.5 ms** | 6.3× |
| `find` a glob, p50 | 1.65 ms | **0.22 ms** | 7.5× |
| First `grep` in a process | 19 ms | 22 ms | same |

<sub>Measured: both implementations in Bun on a 1,400-file C++/HIP project, Linux x86-64 (Ryzen 7 5800X3D); 60 function
names and 60 words, each searched 5 times, medians; two runs agreed within 0.4 ms.</sub>

**Never stale.** After every `bash` command (the agent's or a `!` command) the next search checks the tree and the files'
times at once, so files a command created or changed (`sed -i`, a code generator) are found right away.

<details>
<summary>How the caches work</summary>

- The file tree is reused for 2 s without checks, then revalidated against the modification times of up to 4096 folders
  (measured: 0.2 ms for 137 folders, 0.43 ms for 296). A larger tree is walked again.
- `grep` with a glob uses the cached tree too (it walked the folders on every call). Measured on the same project, p50 of
  24 searches: `*.cpp` 3.8 → 2.2 ms, `*.{h,hpp}` 2.7 → 1.4 ms, `src/**/*.hip` 1.4 → 0.08 ms. The files ignore files leave
  out are kept aside for globs, which take them as ripgrep's `--glob` does.
- Contents are cached up to 64 MB in all and 512 KB per file; within 1.5 s of a check, a file is not stat'ed again. When
  the pool is full, the files stored longest ago go first. (Before, a changed file's old bytes stayed counted, so after
  64 MB of changes nothing new was cached.)
- A file read or written that the cached tree does not know makes it walk again only when the file is in its folder and
  not below a folder an ignore file leaves out (before: every cached tree, for any such file, such as a read in `build/`).
- A `find` glob that matches nothing returns the closest paths by fuzzy match instead.
- Without a C compiler to build the native search, the caches still work and matching falls back to TypeScript.

</details>

### project_search

[docsearch](packages/docsearch) searches the project's code and documentation, in Rust, compiled into Pi-Bolt. The agent
gets the tool `project_search`, matching doc sections are added to a typed prompt, and `/docs` searches by hand. No model
runs at search time: BM25 over sections plus a graph of sections and the names they mention. Code is split at its
definitions (C/C++/HIP, Rust, Python, TypeScript/JavaScript, Go, shell), so a function's name finds its definition first.

| Measured | `grep` | `project_search` |
|---|---:|---:|
| Doc question: the answer among the first 3 results | 40% | **83%** |
| Function by name: the definition first | 55% | **83%** |
| Function by name: the definition among the first 3 | 77% | **97%** |
| Time per search, docs | 0.33 ms | **0.06 ms** |
| Time per search, function by name | 6.4 ms | **0.05 ms** |

<sub>Both in one Bun process on the same snapshot of the same project; 60 doc questions and 60 function names with known
answers. grep was given each question's rarest word, which favours it: an agent does not know the counts before it
searches.</sub>

| In pibench (`melious/glm-5.3-flash`, median of 5 runs) | Without | With |
|---|---:|---:|
| Look up a setting in the docs | 1.4 s, 2 turns | **0.6 s, 1 turn** |
| Find a function by what it does | 6.5 s, 8 turns | **5.6 s, 6 turns** |
| Find where a function is defined | 1.3 s | **0.9 s** |

<sub>Tasks that did not use it moved by up to 30% either way between runs, the noise at 5 runs; every run gave the right
answer.</sub>

<details>
<summary>Index, memory and updates</summary>

- TypeScript, JavaScript, Go and shell files are split at their definitions (they were split like plain text). Measured
  on 60 function and type names in Pi-Bolt's own sources: the definition first 53% → 98%, among the first 3 83% → 100%.
- The index is a mapped file: the first process builds it (0.9 s for 1,400 files), every later one is ready in 0.3 ms
  (12.4 ms before). The first process to map a version checks its contents once; a stamp beside it lets the others skip
  reading every page.
- About 32 MB per process, plus 110 MB of index shared by every process on the project (about 460 MB each without).
- A changed file is searchable within a second (51 ms in the test) without rewriting the index. The index is rebuilt once
  nothing has changed for 30 s and 20 files changed or 10 minutes passed (before: after any 30 s without changes, about
  0.9 s of CPU and a new mapping in every process).
- While the first build runs, a search waits on a worker thread, so the screen and Escape keep working (before, it
  blocked the event loop for up to 5 s).
- `grep` stays the tool for exact text across all files, such as every call site.

</details>

## Editing

### Compiler diagnostics after every edit

After `edit` or `write`, the compiler's diagnostics **the edit introduced** come as a message before the model's next
request (see [background checks](#background-checks)). Errors that were there before are left out: they are collected
in the background when the file is read. The model sees its mistake in its next step instead of at the next build.

- **C, C++, HIP**: checked in the background like the other languages (before, the edit waited for the reparse: 0.1 s
  on a warm translation unit, 1 s right after the read, seconds on a large one), through libclang in the process when a
  libclang library is found (`LIBCLANG_PATH`, ROCm's, or the system's). libclang gets the builtin headers (`stddef.h`)
  from the folder next to the library it loaded. Flags come from `compile_commands.json` in the
  project or up to 5 parent folders (also `build/`, `out/`, `cmake-build-*`); without one, the `-I` folders of the
  project's Makefile, else its `include/` or `inc/`. When a header is still not found, only that is reported, not each
  use of what it declares. A header is checked inside a source that
  includes it, also through `-I` folders, with the other headers the agent changed.
- Without these tools the edit goes through as before, with no diagnostics.

#### Background checks

Files are checked after the edit, in the background: `edit` and `write` (and a bash command that changed a
file) return at once, and only errors that are new against the state before come as a message before the model's next
request. When the model would end its run while a check of its edits still runs, Pi waits for it (`PI_CHECKS_WAIT`,
default 30 s) and the run goes on with the errors. Edits in quick succession make one check, a unit runs one check at
a time, and a check an edit overtook runs again instead of reporting.

| Language | Tool (the fastest found, each only when installed) | Checks | Time |
|---|---|---|---:|
| C, C++, HIP | libclang (above) | types, syntax | 0.1 s warm |
| Rust | `cargo check` on the file's package, in `target/pi-check` | types | 1.4 s warm on Moebius |
| Python | ty | types, undefined names | 24-31 ms a file |
| TypeScript | `tsc` (TypeScript 7's native one before the project's) on the `tsconfig.json` project | types | 0.2 s small project |
| JavaScript | `node --check` | syntax | |
| Shell | `bash -n`, then shuck's errors | syntax, errors | 2-4 ms |
| Luau | luau-analyze | syntax; types under `--!strict` | 5 ms |
| JSON, TOML, YAML | Bun's parsers, in the process | syntax | ~1 ms all three |

Linters run where the project configures them, and their findings wait: they are collected against the state before
the agent first changed the unit and reported once, when the model would end its run, so they do not interrupt work in
progress (errors come at once).

| Language | Linter (the fastest found) | Runs when the project has | Time |
|---|---|---|---:|
| Rust | clippy, in place of `cargo check` | `clippy.toml`, clippy lints in `Cargo.toml`, or `cargo clippy` in CI | as `cargo check` |
| Python | ruff | `ruff.toml` or `[tool.ruff]` | 8 ms a file |
| JS/TS | Biome; else oxlint (about 2-3x Biome, 50-100x ESLint) | `biome.json`; an oxlint or ESLint configuration | 31-35 ms a file |
| Shell | shuck's warnings (about 20x ShellCheck) | `.shellcheckrc` or `shuck.toml` | 2-4 ms |
| Markdown | rumdl (about 10x markdownlint-cli2) | a markdownlint or rumdl configuration | 3 ms |
| YAML | ryl (a Rust yamllint) | a yamllint or ryl configuration | 1 ms |
| Luau | selene | `selene.toml` | 3 ms |
| C/C++/HIP | clangd-tidy (about 10x clang-tidy) | `.clang-tidy` and `compile_commands.json` | 0.2 s a file |

On Moebius (443 Rust files), a type error the model wrote was reported 3 s after the edit, before the run ended, and
fixed; rust-analyzer, which Pi used before, reported nothing within 84 s and took 3.2 GB. `PI_CHECKS=off` turns the
checks off (for a harness that runs its own, as Moebius's lens), `PI_CHECKS=rust,python` keeps those named, and
`PI_CHECKS_CARGO_TARGET=shared` lets cargo check use the project's `target/`.

<details>
<summary>Limits and details</summary>

| Limit | |
|---|---:|
| Background checks: errors listed in one report | 15, then "and N more" |
| Background checks: wait before a run ends, at most | 30 s (`PI_CHECKS_WAIT`) |
| Error limit passed to the compiler | 20 |
| libclang translation units kept | the 8 used last (before: all, for the whole session) |

- GCC-only flags are removed; HIP gets one `--offload-arch` (`HCC_AMDGPU_TARGET`, `HIP_OFFLOAD_ARCH`, else `gfx1100`).
- A unit is parsed again when its flags change; a failed reparse uses the unit's own flags (before: none).
- A header no source read in the session includes is checked on its own with the flags of a source near it (before, the
  source read last stood in).
- A diagnostic that was fixed and comes back is reported again; a second copy of an existing one counts as new.

</details>

### Fewer refused edits

Pi refuses to edit a file the agent has not read, so it never overwrites what it did not see. That guard also turned
every edit of a file the agent had seen through `cat` or `grep` into a refusal, a read and a second edit: in real
sessions (23 Oct – 1 Nov 2026) that was **21% of all edits** (49 of 232), 3.7 s each (median).

- `edit` applies to an unread file when **every `oldText` matches it exactly once**: the file then counts as read, its
  diagnostics before the edit are taken, and the result says so. Inexact edits and `write` still refuse.
- A bash command that prints files whole with `cat` (output not cut) counts as reading them.
- The same holds for a file that changed on disk since it was read: an exact, unique match applies without a re-read.
- `touch`, or a formatter that changed nothing, is not a change (same content, newer time).
- Files of 1 MB or more read in pieces can still be edited; CRLF line endings and a BOM are kept.

### Edit matching

- When `oldText` matches neither exactly nor by the existing fuzzy match, lines are compared ignoring leading and trailing
  whitespace (Codex's `seek_sequence`), and `newText` is re-indented to the file's indentation: the model's spaces become
  the file's tabs, also for lines nested deeper than any line of `oldText`. More than one match is still refused.
- When `oldText` matches nowhere, the error shows **the closest text in the file** with line numbers (up to 20 lines) and
  the first line that differs, so the model fixes the edit without reading the file again (9–48 ms on 50,000 lines).
- After an edit, the result shows the changed lines with 3 lines of context.
- When the agent reads a file, the `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md` of each folder between the project
  root and that file is added to the result, once per session (as Claude Code does).

### No edits behind the edit tool's back

Models often change files through bash instead: Claude Opus changed files with bash 155 times and with `edit` 25 times
in real sessions. Those changes skip everything above. While the `edit` tool is there, the bash tool refuses a command
that changes a file as `edit` or `write` would and says to use them:

- `sed -i` and `perl -i` on one file;
- text the command spells out (`echo`, `printf`, a heredoc through `cat` or `tee`) written into a file that exists.

The same replacement over many files (`sed -i … src/*.py`, `xargs sed -i`) runs: one `sed` beats 20 edits (in
harnessbench, a rule against it made models 2.8–6× slower on such a task). New files, appends (`>>`, `tee -a`), files under `/tmp` (also after `cd /tmp`), a program's output redirected into a file
(`make > build.log`) and anything inside quotes, such as a command run over `ssh`, still run. Scripts that rewrite files
(`python3 - <<EOF … open(p, "w")`) are not caught.

## Running commands

### Background jobs instead of sleep

In real sessions, models waited for builds and tests with commands like `sleep 295; tail build.log`: 97 such calls waited
3.2 hours, either past the moment the job had ended or not long enough, which cost another turn. Pi-Lightspeed gives the agent
a way to wait that ends exactly when the job does (as [oh-my-pi](https://github.com/can1357/oh-my-pi) does).

- **Automatic background.** A command still running after 120 s goes on in the background as a job (`bg1`, `bg2`, …);
  `background: true` starts it there right away. The call returns the output so far, the pid and the output file. A
  command still running at its `timeout` goes there too instead of being ended: in Terminal-Bench, 7 of 8 timeouts had
  ended a loop waiting for a build (915 s of waiting lost), and in Pi's sessions 16 had ended builds and runs after 7
  minutes on average. Only a command started with `background: true` is ended by its timeout (and any command where
  background jobs are off).
- **The agent is woken.** When a job ends, the agent gets its exit code and the last 2 KB of its output: before its next
  request while it works, or as a new turn when it is idle. Jobs that end within 1.5 s come in one report.
- **`wait` tool.** Blocks until one of the session's jobs ends and returns its report; with nothing running it returns
  at once. It blocks up to 2 min, then 5 and 10 (oh-my-pi starts at 5 s, which only cost turns), and from the second empty one on tells the model to do other
  work. A message from the user ends a wait.
- **Sleeps that end with the job.** A command that starts with a sleep of more than 10 s (`sleep 45; tail build.log`)
  while jobs run: Pi sleeps for it, stops early when a job ends, and then runs the rest. Before, such a command was
  refused, which cost a turn 22 times in 230 Terminal-Bench runs, after which the model looked at once and again later.
- **No long fixed sleeps.** A command that sleeps longer than a command runs before it goes to the background (120 s)
  outside a loop is not run; the error tells the model to call `wait`, or to loop on the condition itself
  (`until curl -sf …; do sleep 2; done`, also over ssh for a job on another machine).
- Jobs end with Pi and never keep `pi -p` running; `pi -p` waits for running jobs and gives their reports a turn first.

Not measured yet: how much time this saves with real models.

### Job hub

`alt+j` or `/jobs` opens every background job of the session (like oh-my-pi's agent hub, without subagents). Example:

```text
Jobs  1 running · 1 ended
› ● bg2   running        2m 5s  cargo build --release
  ✗ bg1   exit 101         10s  cargo test
command cargo build --release
output  /tmp/pi-bash-….log
   Compiling …                      ← the end of its output, live
↑↓ select · enter output · x stop · escape close
```

Enter shows a job's whole output to scroll through, `x` stops it. While jobs run, the status line shows
`● 2 jobs running (alt+j)`.

### bash output and speed

- **Both ends of long output.** Output over 2000 lines or 32 KB keeps its first 40 lines and its end (was 50 KB, the end
  only), so the first compiler error and the summary both reach the model. The full output is saved to a file.
- **Clean output.** Escape sequences, control characters and progress-bar redraws are removed, and commands run with
  `NO_COLOR=1` unless `NO_COLOR` or `FORCE_COLOR` is set.
- **Early start.** Commands that only read (`git status/log/diff/show`, `cat`, `rg`, `grep`, `find` without
  `-exec`/`-delete`, …, without redirections or substitutions) start while the model's message still streams, as `read`
  and `grep` do. With a fast faux model, results are ready when the message ends instead of 5.4–5.9 ms after. In pibench
  the difference was within the noise (13.4 vs 13.8 s), as real bash commands took 12 ms median.
- **No shell where none is needed.** A command without shell syntax runs its program directly; others run in a bash
  started ahead of time and kept ready.
- `pi -p` and `pi --mode json` exit again after a command ran through that pre-started bash (its pipes held the event
  loop).

## Working on another machine

`/remote dev:~/Projects/Radiance` (or `pi-bolt --remote dev:~/Projects/Radiance`) moves `read`, `edit`, `write` and
`bash` to that folder on another machine over ssh; `/remote off` moves them back, `/remote` says where they work. The
session remembers it, so resuming it works there again, and the status line shows `⇄ dev:/home/dev/Projects/Radiance`.

- **The same checks there.** Read before edit, exact-unique edits of unread files, the closest-text hint, `sed -i` sent
  to `edit`, background jobs, `wait` and the sleep guard all work on the remote files and commands. Compiler diagnostics
  after edits do not (the compilers run on this machine).
- **One login.** ssh keeps one master connection per host (ControlMaster), so every later call is a round trip on it.
  A key's passphrase or a password is asked for in Pi, not shown and not kept; the connection then lasts 4 hours. In
  `pi -p` nothing is asked: a key without passphrase or an ssh agent is needed.
- **Commands end there too.** A command runs in its own process group on the host, and a watcher ends that group when the
  connection's input closes: an abort, a timeout, a stopped background job or Pi's exit leaves nothing running there.
- **The prompt cache holds.** The tools keep their declarations; the system prompt says where they work. `grep`, `find`
  and `ls` search this machine, so they are off meanwhile: the model searches there with `rg` or `find` in bash.
- It replaces extensions such as pi-ssh-remote, which replaced the built-in tools with plain ones and so turned off
  everything above, also for local work.

Not measured on a real host yet: checked with an ssh stand-in that runs the remote side on this machine.

## Context and compaction

- **Compaction at 128,000 tokens at most**, whatever the window (`compaction.maxContextTokens`). Every turn re-reads the
  context; on a 1M window it used to wait until 900,000.
- **Old tool results shortened.** Once the context passes 40,000 tokens, tool results older than the latest 8 with 2,000
  characters or more (or an image) go to the model as a one-line note; the session keeps them. The boundary moves in steps
  of 8, so the prompt cache is rebuilt once per step (`toolResultPruning`). The compaction threshold is checked against
  the request as it is sent: a step that takes the context back below the threshold does not compact (it did before).
- **Summaries made ahead.** From 15% (at most 40,000 tokens) below the threshold, the summary is made in the
  background while the agent works, and the compaction at the threshold takes it. Until it is ready the agent goes on
  above the threshold, by at most half the threshold and half the way to the window's limit; only there does it stop
  to wait. Before, the agent stood still for each summary: 14, 56, 60 and 95 s in four real sessions. A session that
  ends between the start and the threshold has paid for a summary it did not use. Not when an extension makes or vets
  compactions.
- **The task stays word for word.** A summary drops requirements and constraints of the task (arXiv 2608.11242: about
  17% survive; 2606.22528: violations 0% before, 30% after compaction). After Pi's own compactions the user's messages
  from the compacted part (a task sent via RPC included) stay next to the summary verbatim, oldest first, up to 16,000
  characters: the first (the task), then the newest that fit; one that a later message contains whole (a continued run
  sent its task again with notes) is left out. The summary request is told so and does not restate them (when not all
  fit, it is told which stay, and summarizes the others). Not for compactions an extension makes itself.
- **Summaries from the prompt cache.** The compaction summary is asked for as a continuation of the session's own
  request, so the provider reads the conversation from its cache (as deepseek-harness does). Before, all 4 compactions in
  real sessions read nothing from the cache (26k to 508k input tokens, 14 to 95 s each).

| Measured: `melious/deepseek-v4.1-flash`, manual compaction, 4 runs each | Before | Pi-Lightspeed |
|---|---:|---:|
| After ten long answers (76k–119k tokens): new input tokens, median | 54k | **8.4k** (+70k–110k from cache) |
| After reading six large files (82k tokens): new input tokens | 4.2k | 0.4k–0.7k (+82k from cache) |
| Time, median | 4.5 s | 4.4 s |

<sub>The time follows the summary's length, not the input. With large files the standalone request sent less because it
cuts every tool result to 2,000 characters, so its summary also saw less. Falls back to the standalone request for
another compaction model, an overflow, a tool call, or an answer cut off with reasoning on. Measured with DeepSeek
only.</sub>

A test checks that every request of a session starts with the previous one, as sent to Anthropic and OpenAI-compatible
providers, so a change that would break the prompt cache fails it.

## Fewer turns

Every turn costs a request (about 0.8 s with these models even when the answer is short), and in harnessbench 95% of a
run's time was the model's. So:

- **The project is in the prompt.** A `<project>` section, taken once per session, lists the working folder's files (git's,
  up to 150; a larger project by folders with file counts). Nearly every run used to begin by listing the folder.
  Small files' contents in it were measured too and dropped (faster with deepseek-v4.1-flash, slower with
  glm-5.3-flash, which then planned everything at once). `PI_PROJECT_SNAPSHOT=off` leaves it out.
- **An edit and its test in one response.** The calls of a response run in order when one of them is `edit`, `write` or
  `bash`, and the prompt says that all edits for a fix and the command that tests them can go together.
- **A smaller prompt than Pi's.** 2.2k characters of rules, tool list and docs pointer against Pi's 2.9k: "Be concise in
  your responses" (longer finishing rules made glm-5.3-flash deliberate more and run slower), no `grep`/`find` schemas by
  default, a two-line docs pointer. The first version of this fork carried 1,000 tokens more per request than Pi and was slower.
- `cat` in bash counts as reading, so `write` and `edit` do not refuse a file the model has seen.

## Benchmark

[harnessbench](bench/harness): 14 small projects (Python, C, Rust, TypeScript), each with hidden tests that decide
whether the task is solved; every harness runs with no extensions, skills or instruction files, the same provider config,
and its own agent folder. Pi 1.4.0 from npm (Node 24) against Pi-Lightspeed, 10 runs of each task, 5 November 2026:

| Model | | Solved | Time, sum | Turns, median | Cost |
|---|---|---:|---:|---:|---:|
| glm-5.3-flash | Pi 1.4.0 | 140/140 | 2,215 s | 6 | $0.23 |
| | Pi-Lightspeed | 138/140 | **1,883 s** | 5 | $0.17 |
| deepseek-v4.1-flash | Pi 1.4.0 | 137/140 | 1,745 s | 5 | $0.30 |
| | Pi-Lightspeed | 137/140 | **1,466 s** | 4 | $0.25 |

<sub>Time ratio 0.846 (95% CI 0.709–0.934, bootstrap over task/model pairs and runs); geometric mean of the 28 per-pair
ratios 0.781 (0.701–0.867); 26 of the 28 pairs faster by median. The run before (an older build) gave 0.855
(0.755–0.931). With glm the same task takes 4 to 44 s, by how long the model thinks: which one or two glm pairs come out
slower changes from run to run, and over all 5 runs of this build (up to 55 per pair) glm is faster in every pair by
median and mean. Failures: a rounding case for both harnesses, and twice glm printing the program name with the
arguments in a C task. The 75 s test suite of one task takes the same time in both. Provider latency varies by run:
compare within a run, not across.</sub>

## System prompt

- Rules: Pi's, minus the ones above made redundant, plus: put calls that need no answer in between into one response (an
  edit and the command that tests it); commands running over two minutes go to the background, do not sleep or poll.
- The docs pointer is two lines instead of seven.

## Melious provider

Provider `melious` (`MELIOUS_API_KEY`, `https://api.melious.ai/v1`), with 18 models built in and default model
`glm-5.3`. With a key, context windows and prices are fetched from Melious when the model list is loaded (15 s timeout),
and models Melious lists that are not built in are added. Without a connection, the built-in list is used.

## Switches

Everything above is on by default.

| Setting or variable | Effect |
|---|---|
| `compaction.maxContextTokens` | Cap for the compaction threshold (default 128000) |
| `toolResultPruning` | Shortening old tool results: `enabled`, `triggerTokens` (40000), `keepRecent` (8), `minChars` (2000) |
| `PI_PROJECT_SNAPSHOT=off` | No project listing in the system prompt |
| `--remote <host>[:<folder>]`, `PI_REMOTE` | Start working on that machine (as `/remote`) |
| `PI_SSH_COMMAND` | The ssh program (default `ssh`) |
| `PI_CHECKS` | `off`, or the background checks to keep (`cpp,rust,python,typescript,javascript,shell,luau,json,toml,yaml`, and the linters `js-lint,markdown,yaml-lint,luau-lint,cpp-lint`) |
| `PI_CHECKS_WAIT` | Seconds a run that would end waits for the checks of its edits (default 30) |
| `PI_CHECKS_CARGO_TARGET` | `shared` to let the background `cargo check` use the project's `target/` |
| `LIBCLANG_PATH` | Where the libclang library for the C/C++ checks is |
| `HCC_AMDGPU_TARGET`, `HIP_OFFLOAD_ARCH` | GPU target for HIP diagnostics (default `gfx1100`) |
| `app.jobs.hub` keybinding | Opens the job hub (default `alt+j`) |

## Tests

Pi-Lightspeed's own tests, in `packages/coding-agent` unless noted:

- `test/claude-harness.test.ts`: read before edit, nested instruction files, compile flags, the search caches, the
  bash fast paths and the edit fallback.
- `test/libclang.test.ts`: against real libclang (skipped when the bridge is not built).
- `test/background-jobs.test.ts`, `test/suite/agent-session-bash-background.test.ts`, `test/job-hub.test.ts`: jobs,
  their reports and wake-ups, `wait`, the sleep guard and the hub.
- `test/bash-file-writes.test.ts`: which commands count as changing files, and the bash tool refusing them.
- `test/remote-ssh.test.ts`, `test/suite/agent-session-remote.test.ts`, `test/secret-input.test.ts`: the remote
  operations through an ssh stand-in (quoting, errors, commands ended there, the passphrase question), and a session
  working there.
- `test/suite/request-prefix.test.ts`: every request starts with the previous one; a snapshot of the built-in tool
  schemas.
- `test/tool-result-pruning.test.ts`, `test/native-search.test.ts`, `test/tools.test.ts`, and
  `packages/ai/test/melious-models.test.ts`.
- `packages/docsearch`: 17 Rust tests, and test sets that measure a ranking change query by query (`eval/`).

Run them with `bun x --bun vitest run` in `packages/coding-agent`.

## Credits

Ideas taken from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (compaction on the cached prefix,
moving commands to the background, no sleep polling, the request-prefix test), [oh-my-pi](https://github.com/can1357/oh-my-pi)
(background jobs, `wait`, the hub), Codex (`seek_sequence`) and Claude Code (nested instruction files). Built on
[Pi-Bolt](https://github.com/opensec-git/Pi-Bolt) and [Pi](https://github.com/earendil-works/pi).
