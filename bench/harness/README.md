# harnessbench

Coding tasks with hidden tests, to compare coding-agent harnesses on the same model. A task counts as solved only when
its hidden tests pass after the run; the agent sees only the visible tests and the prompt.

| Task | Language | What it exercises |
|---|---|---|
| `py_bugs` | Python | three bugs in two files, visible tests |
| `c_strjoin` | C | a new function and its use, built with `-Werror` |
| `rust_durations` | Rust | a parser's edge cases beyond the visible tests |
| `ts_coupons` | TypeScript (bun) | a spec in a README, hidden cases |
| `py_rename` | Python | one rename across 12 files |
| `c_tabs_ring` | C | one precise edit in a tab-indented file of 600 lines (spaces fail it) |
| `py_slow_suite` | Python | a 72 s test suite: waiting on a long command |
| `search_large` | Python | one value among 320 files, nothing else changed |

The `hard` suite (`--suite hard`, in `hard_tasks.py`), tasks a model can fail:

| Task | Language | What it exercises |
|---|---|---|
| `py_api` | Python | a spec over four layers (api, service, repo), many hidden edge cases |
| `c_name_ptr` | C | a struct field from an array to an owned string over six files, `-Werror`, AddressSanitizer with leak checks |
| `rust_trait` | Rust | an enum turned into a trait with three types: several compile rounds |
| `py_trace` | Python | a wrong tax whose cause is a mapping table, in a repo of 400+ files |
| `py_twins` | Python | 2 of 40 near-identical functions: imprecise edits hit the wrong ones |
| `long_audit` | Python | 80 calls in 20 modules of 450 lines: much context, many edits |

Tool errors are split by cause: `guard` (the harness refused the call), `edit` (an edit or write did not apply),
`command` (a command exited with an error, often a test run expected to fail), `other`.

Each run gets a fresh copy of the project and its own agent folder holding only the model's provider (taken from
`--models-json`): no settings, extensions, skills, prompt templates or instruction files of the user's. Every harness
is started with `--mode json --no-session -ne -ns -np -nc --no-mcp`. Runs go round-robin over repetitions, tasks and
harnesses.

```bash
python3 harnessbench.py selftest   # every task: the untouched project fails, the reference solution passes
python3 harnessbench.py run --suite quick --model melious/glm-5.3-flash \
    --harness before=/path/to/old/pi-bolt --harness after=/path/to/new/pi-bolt   # before a pull request, ~5 min
python3 harnessbench.py run --harness pi='node /path/to/pi' --harness lightspeed=/path/to/pi-bolt \
    --model melious/glm-5.3-flash --reps 5
python3 harnessbench.py run --suite hard --model melious/glm-5.3 --model melious/deepseek-v4.1-flash \
    --harness pi='node /path/to/pi' --harness lightspeed=/path/to/pi-bolt --reps 3 --parallel 4
python3 harnessbench.py report results/<dir>
```

Needs python3, cc, make, cargo and bun. The runs call the model's API and cost money.

`--suite quick` runs one task for each part of the harness a change may touch (Python, C with its checks, C over six
files with headers in include/, Rust, TypeScript, a precise edit, search, a definition lookup, a 72 s command),
2 repetitions, 8 at once, each stopped after 300 s: about 5 minutes for two builds. It finds a failure or a large
slowdown, not a 10% change; for that, `--suite all --reps 5` (about 40 minutes). With two harnesses the report
compares them run by run: the ratios of wall time, cost and turns, with a bootstrap 95% interval. A build to compare
is the whole `out/pi-bolt` folder, copied: its `pi` alone lacks the native addons (`native/`), and C then gets no
libclang checks.
