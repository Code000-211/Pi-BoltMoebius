# Benchmarks

- [`harness/`](harness): harnessbench, coding tasks with hidden tests to compare coding-agent harnesses on the same model
  (see its README). This is how Pi-Lightspeed's changes are measured.
- `benchmark.py`, `harness.py`, `fake_model.py`, `fixtures/`, `orderfile_session.py`: Pi-Bolt's startup, headless and
  interactive scenarios against a scripted model server. `scripts/train-runtime-hints.sh` runs `orderfile_session.py`
  to retrain the runtime profile in `profiles/`. Each tool takes the builds to compare as `--build name=command`.

Pi-Bolt's other runtime benchmarks, their published results and its documentation were removed in Pi-Lightspeed:
they measured the Bun runtime, not the agent. They are in the upstream repository
([opensec-git/Pi-Bolt](https://github.com/opensec-git/Pi-Bolt)).
