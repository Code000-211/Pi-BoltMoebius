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

Each run gets a fresh copy of the project and its own agent folder holding only the model's provider (taken from
`--models-json`): no settings, extensions, skills, prompt templates or instruction files of the user's. Every harness
is started with `--mode json --no-session -ne -ns -np -nc --no-mcp`. Runs go round-robin over repetitions, tasks and
harnesses.

```bash
python3 harnessbench.py selftest   # every task: the untouched project fails, the reference solution passes
python3 harnessbench.py run --harness pi='node /path/to/pi' --harness lightspeed=/path/to/pi-bolt \
    --model melious/glm-5.3-flash --reps 5
python3 harnessbench.py report results/<dir>
```

Needs python3, cc, make, cargo and bun. The runs call the model's API and cost money.
