#!/usr/bin/env python3
"""harnessbench: coding tasks with hidden tests, to compare coding-agent harnesses on the same model.

Each run starts a harness (`<cmd> --mode json --no-session -ne -ns -np -nc --no-mcp --model M "<prompt>"`) in a fresh
copy of a small project, with its own agent folder (no settings, extensions, skills or instructions of the user's; only
the model's provider). When it ends, hidden tests are copied in and run: a task counts as solved only when they pass.
Recorded per run: solved, wall time, turns, tool calls and tool errors, tokens (new, cached, output), cost.

  harnessbench.py selftest                       check every task's setup and verifier without a model
  harnessbench.py run --harness pi=CMD --harness lightspeed=CMD --model melious/glm-5.3-flash --reps 3
  harnessbench.py report results/<dir>

Runs go round-robin over repetitions, tasks and harnesses, so provider latency drifts hit every harness alike.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
RUN_TIMEOUT_S = 900


def write(root: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def sh(cmd: str, cwd: Path, timeout: int = 300) -> tuple[int, str]:
    p = subprocess.run(["bash", "-c", cmd], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr)[-3000:]


def git_init(root: Path) -> None:
    sh("git init -q && git add -A && git -c user.email=b@b -c user.name=bench commit -qm init", root)


@dataclass
class Task:
    name: str
    lang: str
    prompt: str
    setup: Callable[[Path], None]
    # Returns (solved, detail). Runs after the agent, in the task folder.
    verify: Callable[[Path], tuple[bool, str]]
    # What the task exercises, for the report.
    about: str
    # A correct solution, for the selftest: the verifier must accept it.
    solve: Callable[[Path], None]


def replace_in(root: Path, rel: str, old: str, new: str) -> None:
    path = root / rel
    text = path.read_text()
    assert old in text, f"{rel}: {old!r} not found"
    path.write_text(text.replace(old, new))


# --------------------------------------------------------------------------- py_bugs

PY_MODELS = '''from dataclasses import dataclass


@dataclass
class Item:
    name: str
    price_cents: int
    quantity: int
'''

PY_PRICING = '''from .models import Item


def line_total(item: Item, discount_percent: float = 0) -> int:
    """Price of `quantity` items in cents after a discount given in percent (10 means 10 %), rounded half up."""
    gross = item.price_cents * item.quantity
    return round(gross * (1 - discount_percent))


def total(items: list[Item], discount_percent: float = 0) -> int:
    return sum(line_total(i, discount_percent) for i in items)
'''

PY_REPORT = '''from .models import Item
from .pricing import line_total


def report(items: list[Item]) -> list[str]:
    """One line per item, sorted by name ignoring case: "<name>: <quantity> x <price> = <total>" (amounts in cents)."""
    lines = []
    for item in sorted(items, key=lambda i: i.name):
        lines.append(f"{item.name}: {item.quantity} x {item.price_cents} = {line_total(item)}")
    return lines


def low_stock(items: list[Item], threshold: int = 5) -> list[str]:
    """Names of items with fewer than `threshold` in stock."""
    return [i.name for i in items if i.quantity <= threshold]
'''

PY_TEST_VISIBLE = '''import unittest

from inv.models import Item
from inv.pricing import line_total, total
from inv.report import low_stock, report


class InventoryTest(unittest.TestCase):
    def test_line_total_discount(self):
        self.assertEqual(line_total(Item("pen", 250, 4), 10), 900)

    def test_report_sorted_ignoring_case(self):
        items = [Item("banana", 30, 2), Item("Apple", 50, 1)]
        self.assertEqual(report(items), ["Apple: 1 x 50 = 50", "banana: 2 x 30 = 60"])

    def test_low_stock(self):
        self.assertEqual(low_stock([Item("a", 1, 5), Item("b", 1, 4)]), ["b"])


if __name__ == "__main__":
    unittest.main()
'''

PY_TEST_HIDDEN = '''import unittest

from inv.models import Item
from inv.pricing import line_total, total
from inv.report import low_stock, report


class HiddenTest(unittest.TestCase):
    def test_no_discount(self):
        self.assertEqual(total([Item("a", 199, 3), Item("b", 1, 1)]), 598)

    def test_rounding(self):
        self.assertEqual(line_total(Item("x", 333, 1), 50), 167)

    def test_sort_mixed(self):
        items = [Item("cherry", 1, 1), Item("Banana", 1, 1), Item("apple", 1, 1)]
        self.assertEqual([l.split(":")[0] for l in report(items)], ["apple", "Banana", "cherry"])

    def test_threshold(self):
        self.assertEqual(low_stock([Item("a", 1, 2), Item("b", 1, 3)], threshold=3), ["a"])


if __name__ == "__main__":
    unittest.main()
'''


def py_bugs_setup(root: Path) -> None:
    write(root, {"inv/__init__.py": "", "inv/models.py": PY_MODELS, "inv/pricing.py": PY_PRICING,
                 "inv/report.py": PY_REPORT, "tests/__init__.py": "", "tests/test_inventory.py": PY_TEST_VISIBLE})
    git_init(root)


def py_bugs_verify(root: Path) -> tuple[bool, str]:
    write(root, {"tests/test_hidden_bench.py": PY_TEST_HIDDEN, "tests/test_inventory.py": PY_TEST_VISIBLE})
    code, out = sh("python3 -m unittest discover -s tests -t . 2>&1 | tail -15", root)
    ok = "OK" in out.splitlines()[-1:][0] if out.strip() else False
    return ok, out


# --------------------------------------------------------------------------- c_strjoin

C_STRUTIL_H = '''#ifndef STRUTIL_H
#define STRUTIL_H
#include <stddef.h>

/* Copies at most n-1 bytes of src into dst and terminates it; returns the length of src. */
size_t str_copy(char *dst, const char *src, size_t n);

#endif
'''

C_STRUTIL_C = '''#include "strutil.h"
#include <string.h>

size_t str_copy(char *dst, const char *src, size_t n)
{
	size_t len = strlen(src);
	if (n > 0) {
		size_t k = len < n - 1 ? len : n - 1;
		memcpy(dst, src, k);
		dst[k] = '\\0';
	}
	return len;
}
'''

C_MAIN = '''#include <stdio.h>
#include "strutil.h"

int main(int argc, char **argv)
{
	/* TODO: print the arguments joined with "," */
	(void)argc;
	(void)argv;
	return 0;
}
'''

C_MAKEFILE = '''CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O1

app: src/main.c src/strutil.c src/strutil.h
\t$(CC) $(CFLAGS) -o app src/main.c src/strutil.c

clean:
\trm -f app
'''

C_HIDDEN = '''#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "strutil.h"

static int fails = 0;
static void check(const char *got, const char *want)
{
	if (!got || strcmp(got, want) != 0) {
		printf("FAIL: got \\"%s\\", want \\"%s\\"\\n", got ? got : "(null)", want);
		fails++;
	}
}

int main(void)
{
	const char *abc[] = {"a", "bc", "def"};
	char *s;
	s = str_join(abc, 3, ", "); check(s, "a, bc, def"); free(s);
	s = str_join(abc, 1, "-"); check(s, "a"); free(s);
	s = str_join(abc, 0, "-"); check(s, ""); free(s);
	s = str_join(abc, 3, ""); check(s, "abcdef"); free(s);
	if (fails == 0) printf("HIDDEN OK\\n");
	return fails != 0;
}
'''


def c_strjoin_setup(root: Path) -> None:
    write(root, {"src/strutil.h": C_STRUTIL_H, "src/strutil.c": C_STRUTIL_C, "src/main.c": C_MAIN,
                 "Makefile": C_MAKEFILE})
    git_init(root)


def c_strjoin_verify(root: Path) -> tuple[bool, str]:
    code, out = sh("make clean >/dev/null; make 2>&1 && ./app x yy zzz", root)
    if code != 0 or out.strip().splitlines()[-1:] != ["x,yy,zzz"]:
        return False, f"app: {out}"
    write(root, {"bench_hidden.c": C_HIDDEN})
    code, out = sh("cc -std=c11 -Wall -Isrc -o bench_hidden bench_hidden.c src/strutil.c 2>&1 && ./bench_hidden", root)
    return code == 0 and "HIDDEN OK" in out, out


# --------------------------------------------------------------------------- rust_durations

RS_CARGO = '''[package]
name = "durations"
version = "0.1.0"
edition = "2021"

[dependencies]
'''

RS_LIB = '''//! Parses durations such as `1h30m`, `45s`, `2d4h` into seconds.

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    Empty,
    BadNumber,
    UnknownUnit(char),
    MissingUnit,
}

/// Seconds in `text`: one or more `<number><unit>` parts, units `d`, `h`, `m`, `s`, in any order.
pub fn parse_duration(text: &str) -> Result<u64, ParseError> {
    if text.is_empty() {
        return Err(ParseError::Empty);
    }
    let mut total = 0u64;
    let mut number = String::new();
    for c in text.chars() {
        if c.is_ascii_digit() {
            number.push(c);
            continue;
        }
        let value: u64 = number.parse().map_err(|_| ParseError::BadNumber)?;
        let unit = match c {
            'd' => 86_400,
            'h' => 3_600,
            'm' => 600,
            's' => 1,
            other => return Err(ParseError::UnknownUnit(other)),
        };
        total += value * unit;
    }
    Ok(total)
}
'''

RS_TEST_VISIBLE = '''use durations::{parse_duration, ParseError};

#[test]
fn hours_and_minutes() {
    assert_eq!(parse_duration("1h30m"), Ok(5400));
}

#[test]
fn trailing_number_is_an_error() {
    assert_eq!(parse_duration("10m5"), Err(ParseError::MissingUnit));
}
'''

RS_TEST_HIDDEN = '''use durations::{parse_duration, ParseError};

#[test]
fn days() {
    assert_eq!(parse_duration("2d4h"), Ok(2 * 86_400 + 4 * 3_600));
}

#[test]
fn seconds_only() {
    assert_eq!(parse_duration("45s"), Ok(45));
}

#[test]
fn bare_number() {
    assert_eq!(parse_duration("90"), Err(ParseError::MissingUnit));
}

#[test]
fn unit_without_number() {
    assert_eq!(parse_duration("h"), Err(ParseError::BadNumber));
}

#[test]
fn unknown_unit() {
    assert_eq!(parse_duration("3w"), Err(ParseError::UnknownUnit('w')));
}

#[test]
fn reset_between_parts() {
    assert_eq!(parse_duration("1m1s"), Ok(61));
}
'''


def rust_setup(root: Path) -> None:
    write(root, {"Cargo.toml": RS_CARGO, "src/lib.rs": RS_LIB, "tests/visible.rs": RS_TEST_VISIBLE})
    git_init(root)


def rust_verify(root: Path) -> tuple[bool, str]:
    write(root, {"tests/bench_hidden.rs": RS_TEST_HIDDEN, "tests/visible.rs": RS_TEST_VISIBLE})
    code, out = sh("cargo test --offline --quiet 2>&1 | tail -20", root, timeout=600)
    return code == 0 and "FAILED" not in out and "error" not in out.lower(), out


# --------------------------------------------------------------------------- ts_coupons

TS_CART = '''export interface Line {
	sku: string;
	unitCents: number;
	qty: number;
}

export function subtotal(lines: Line[]): number {
	return lines.reduce((sum, l) => sum + l.unitCents * l.qty, 0);
}
'''

TS_README = '''# cart

Add `applyCoupon(lines: Line[], code: string): number` to `src/cart.ts`: the total in cents after the coupon.

- `SAVE10`: 10 % off the subtotal, rounded down to whole cents.
- `FLAT500`: 500 cents off, but only when the subtotal is at least 2500; the total never goes below 0.
- `FREEPEN`: one item with sku `pen` free (the cheapest pen line's unit price), if there is a pen.
- Codes are case-insensitive and may have surrounding spaces. An unknown code throws `Error("unknown coupon: <code>")`
  with the code as given.
'''

TS_TEST_VISIBLE = '''import { expect, test } from "bun:test";
import { applyCoupon } from "../src/cart.ts";

test("SAVE10", () => {
	expect(applyCoupon([{ sku: "a", unitCents: 999, qty: 1 }], "SAVE10")).toBe(899);
});
'''

TS_TEST_HIDDEN = '''import { expect, test } from "bun:test";
import { applyCoupon } from "../src/cart.ts";

const pens = [
	{ sku: "pen", unitCents: 300, qty: 2 },
	{ sku: "pad", unitCents: 1000, qty: 1 },
	{ sku: "pen", unitCents: 250, qty: 1 },
];

test("FLAT500 needs 2500", () => {
	expect(applyCoupon([{ sku: "a", unitCents: 2499, qty: 1 }], "FLAT500")).toBe(2499);
	expect(applyCoupon([{ sku: "a", unitCents: 2500, qty: 1 }], "FLAT500")).toBe(2000);
});

test("FREEPEN takes the cheapest pen", () => {
	expect(applyCoupon(pens, "FREEPEN")).toBe(1600);
	expect(applyCoupon([{ sku: "pad", unitCents: 1000, qty: 1 }], "FREEPEN")).toBe(1000);
});

test("codes ignore case and spaces", () => {
	expect(applyCoupon([{ sku: "a", unitCents: 1000, qty: 1 }], "  save10 ")).toBe(900);
});

test("unknown code", () => {
	expect(() => applyCoupon([], "Bogus")).toThrow("unknown coupon: Bogus");
});
'''


def ts_setup(root: Path) -> None:
    write(root, {"src/cart.ts": TS_CART, "README.md": TS_README, "test/cart.test.ts": TS_TEST_VISIBLE,
                 "package.json": '{ "name": "cart", "private": true, "type": "module" }\n'})
    git_init(root)


def ts_verify(root: Path) -> tuple[bool, str]:
    write(root, {"test/bench_hidden.test.ts": TS_TEST_HIDDEN, "test/cart.test.ts": TS_TEST_VISIBLE})
    code, out = sh("bun test 2>&1 | tail -15", root)
    return code == 0 and " 0 fail" in out, out


# --------------------------------------------------------------------------- py_rename

RENAME_MODULES = ["accounts", "billing", "emails", "exports", "audit", "sessions", "teams", "invites", "search", "admin"]


def rename_setup(root: Path) -> None:
    files = {"app/__init__.py": "", "app/store.py": '''_USERS = {1: {"name": "Ada"}, 2: {"name": "Lin"}}


def fetch_user_record(user_id: int) -> dict:
    """The stored record of a user."""
    return dict(_USERS[user_id])
'''}
    for i, mod in enumerate(RENAME_MODULES):
        files[f"app/{mod}.py"] = f'''from app.store import fetch_user_record


def {mod}_summary(user_id: int) -> str:
    record = fetch_user_record(user_id)
    return "{mod}:" + record["name"]


def {mod}_names(ids: list[int]) -> list[str]:
    return [fetch_user_record(i)["name"] for i in ids]
'''
    files["tests/__init__.py"] = ""
    files["tests/test_app.py"] = "import unittest\n\n" + "".join(
        f"from app.{m} import {m}_summary\n" for m in RENAME_MODULES) + '''

class AppTest(unittest.TestCase):
    def test_summaries(self):
''' + "".join(f'        self.assertEqual({m}_summary(1), "{m}:Ada")\n' for m in RENAME_MODULES)
    files["NOTES.md"] = "`fetch_user_record` reads from the in-memory store.\n"
    write(root, files)
    git_init(root)


def rename_verify(root: Path) -> tuple[bool, str]:
    code, left = sh("grep -rn fetch_user_record --include='*.py' --include='*.md' . || true", root)
    if left.strip():
        return False, "old name still there:\n" + left
    code, out = sh("grep -rln 'def load_user' app/store.py && python3 -m unittest discover -s tests -t . 2>&1 | tail -5", root)
    return code == 0 and out.strip().endswith("OK"), out


# --------------------------------------------------------------------------- c_tabs_ring

def ring_source() -> str:
    filler = "".join(f'''
static int helper_{i}(struct ring *r, int v)
{{
	if (r->count > {i}) {{
		if (v % {i + 2} == 0)
			return v / {i + 2};
		else
			return v + {i};
	}}
	return 0;
}}
''' for i in range(40))
    return '''#include "ring.h"
''' + filler + '''
int ring_push(struct ring *r, int value)
{
	if (r == NULL)
		return -2;
	r->data[r->head] = value;
	r->head = (r->head + 1) % RING_CAP;
	r->count++;
	return 0;
}

int ring_pop(struct ring *r, int *out)
{
	if (r == NULL || out == NULL)
		return -2;
	if (r->count == 0)
		return -1;
	*out = r->data[r->tail];
	r->tail = (r->tail + 1) % RING_CAP;
	r->count--;
	return 0;
}

int ring_helpers_sum(struct ring *r, int v)
{
	int s = 0;
''' + "".join(f"\ts += helper_{i}(r, v);\n" for i in range(40)) + '''	return s;
}
'''


RING_H = '''#ifndef RING_H
#define RING_H
#include <stddef.h>
#define RING_CAP 4

struct ring {
	int data[RING_CAP];
	size_t head, tail, count;
};

int ring_push(struct ring *r, int value);
int ring_pop(struct ring *r, int *out);
int ring_helpers_sum(struct ring *r, int v);
#endif
'''

RING_HIDDEN = '''#include <stdio.h>
#include "ring.h"

int main(void)
{
	struct ring r = {0};
	int v, fails = 0;
	for (int i = 0; i < 4; i++)
		if (ring_push(&r, i) != 0) fails++;
	if (ring_push(&r, 99) != -1) { printf("FAIL: push into a full ring must return -1\\n"); fails++; }
	if (r.count != 4) { printf("FAIL: count changed by a rejected push\\n"); fails++; }
	if (ring_pop(&r, &v) != 0 || v != 0) { printf("FAIL: the first value was overwritten\\n"); fails++; }
	if (ring_push(&r, 7) != 0) { printf("FAIL: push after pop\\n"); fails++; }
	if (fails == 0) printf("HIDDEN OK\\n");
	return fails != 0;
}
'''


def tabs_setup(root: Path) -> None:
    write(root, {"ring.h": RING_H, "ring.c": ring_source(),
                 "Makefile": "ring.o: ring.c ring.h\n\tcc -std=c11 -Wall -Werror -c ring.c\n"})
    git_init(root)


def tabs_verify(root: Path) -> tuple[bool, str]:
    write(root, {"bench_hidden.c": RING_HIDDEN})
    code, out = sh("cc -std=c11 -Wall -o bench_hidden bench_hidden.c ring.c 2>&1 && ./bench_hidden", root)
    if code != 0 or "HIDDEN OK" not in out:
        return False, out
    code, tabs = sh("grep -c '^    ' ring.c || true", root)
    return tabs.strip() in ("0", ""), out + ("" if tabs.strip() in ("0", "") else f"\nlines indented with spaces: {tabs}")


# --------------------------------------------------------------------------- py_slow_suite

SLOW_RUNNER = '''import sys
import time
import unittest

# The suite is slow on purpose (integration tests against a simulated device).
class Slow(unittest.TestCase):
''' + "".join(f'''    def test_{i}(self):
        time.sleep(9)
        from device import checksum
        self.assertEqual(checksum(b"{'x' * (i + 1)}"), {(i + 1) * 120 % 251})
''' for i in range(8)) + '''

if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
'''

SLOW_DEVICE = '''def checksum(data: bytes) -> int:
    """Sum of the bytes modulo 251."""
    return sum(data) % 256
'''


def slow_setup(root: Path) -> None:
    write(root, {"run_tests.py": SLOW_RUNNER, "device.py": SLOW_DEVICE})
    git_init(root)


def slow_verify(root: Path) -> tuple[bool, str]:
    write(root, {"run_tests.py": SLOW_RUNNER})
    code, out = sh("python3 -c 'from device import checksum; assert checksum(bytes(range(256))) == sum(range(256)) % 251'"
                   " && echo OK", root)
    return code == 0 and "OK" in out, out


# --------------------------------------------------------------------------- search_large

def search_setup(root: Path) -> None:
    files = {}
    services = ["orders", "payments", "shipping", "catalog", "users", "reviews", "search", "notify", "ledger", "fraud"]
    for s in services:
        for k in range(30):
            files[f"services/{s}/handlers/h{k}.py"] = f'''"""Handler {k} of the {s} service."""
from services.{s}.config import TIMEOUT_SECONDS


def handle_{k}(request):
    return {{"service": "{s}", "timeout": TIMEOUT_SECONDS, "id": {k}}}
'''
        budget = 17 if s == "payments" else 5
        files[f"services/{s}/config.py"] = f'''TIMEOUT_SECONDS = {10 + len(s)}
# Number of retries the {s} gateway client makes before giving up.
RETRY_BUDGET = {budget}
'''
        files[f"services/{s}/client.py"] = f'''from services.{s}.config import RETRY_BUDGET


class GatewayClient:
    """Talks to the {s} gateway; retries up to RETRY_BUDGET ({budget}) times."""

    def call(self, op):
        for attempt in range(RETRY_BUDGET):
            pass
'''
    write(root, files)
    git_init(root)


def search_verify(root: Path) -> tuple[bool, str]:
    code, diff = sh("git status --porcelain", root)
    changed = sorted(line[3:] for line in diff.splitlines() if line.strip())
    want = ["services/payments/client.py", "services/payments/config.py"]
    if changed != want:
        return False, f"changed files: {changed}, want {want}"
    cfg = (root / "services/payments/config.py").read_text()
    client = (root / "services/payments/client.py").read_text()
    ok = "RETRY_BUDGET = 25" in cfg and "(25)" in client and "17" not in client
    return ok, cfg + client


# --------------------------------------------------------------------------- reference solutions


def py_bugs_solve(root: Path) -> None:
    replace_in(root, "inv/pricing.py", "(1 - discount_percent))", "(1 - discount_percent / 100) + 1e-9)")
    replace_in(root, "inv/report.py", "key=lambda i: i.name)", "key=lambda i: i.name.lower())")
    replace_in(root, "inv/report.py", "i.quantity <= threshold", "i.quantity < threshold")


def c_strjoin_solve(root: Path) -> None:
    replace_in(root, "src/strutil.h", "#endif", "char *str_join(const char **parts, size_t n, const char *sep);\n\n#endif")
    (root / "src/strutil.c").write_text((root / "src/strutil.c").read_text() + '''
#include <stdlib.h>

char *str_join(const char **parts, size_t n, const char *sep)
{
	size_t len = 1, slen = strlen(sep);
	for (size_t i = 0; i < n; i++)
		len += strlen(parts[i]) + (i ? slen : 0);
	char *out = malloc(len);
	if (!out)
		return NULL;
	out[0] = '\\0';
	for (size_t i = 0; i < n; i++) {
		if (i)
			strcat(out, sep);
		strcat(out, parts[i]);
	}
	return out;
}
''')
    replace_in(root, "src/main.c", '''	/* TODO: print the arguments joined with "," */
	(void)argc;
	(void)argv;
	return 0;''', '''	char *s = str_join((const char **)argv + 1, (size_t)(argc - 1), ",");
	puts(s);
	free(s);
	return 0;''')
    replace_in(root, "src/main.c", "#include <stdio.h>", "#include <stdio.h>\n#include <stdlib.h>")


def rust_solve(root: Path) -> None:
    replace_in(root, "src/lib.rs", "'m' => 600,", "'m' => 60,")
    replace_in(root, "src/lib.rs", "        total += value * unit;\n    }\n    Ok(total)",
               "        total += value * unit;\n        number.clear();\n    }\n    if !number.is_empty() {\n"
               "        return Err(ParseError::MissingUnit);\n    }\n    Ok(total)")


def ts_solve(root: Path) -> None:
    (root / "src/cart.ts").write_text((root / "src/cart.ts").read_text() + '''
export function applyCoupon(lines: Line[], code: string): number {
	const sub = subtotal(lines);
	switch (code.trim().toUpperCase()) {
		case "SAVE10":
			return Math.floor(sub * 0.9);
		case "FLAT500":
			return sub >= 2500 ? Math.max(0, sub - 500) : sub;
		case "FREEPEN": {
			const pens = lines.filter((l) => l.sku === "pen");
			return pens.length ? sub - Math.min(...pens.map((l) => l.unitCents)) : sub;
		}
		default:
			throw new Error(`unknown coupon: ${code}`);
	}
}
''')


def rename_solve(root: Path) -> None:
    sh("grep -rl fetch_user_record . --include='*.py' --include='*.md' | xargs sed -i 's/fetch_user_record/load_user/g'", root)


def tabs_solve(root: Path) -> None:
    replace_in(root, "ring.c", "\t\treturn -2;\n\tr->data[r->head] = value;",
               "\t\treturn -2;\n\tif (r->count == RING_CAP)\n\t\treturn -1;\n\tr->data[r->head] = value;")


def slow_solve(root: Path) -> None:
    replace_in(root, "device.py", "% 256", "% 251")


def search_solve(root: Path) -> None:
    replace_in(root, "services/payments/config.py", "RETRY_BUDGET = 17", "RETRY_BUDGET = 25")
    replace_in(root, "services/payments/client.py", "(17)", "(25)")


# --------------------------------------------------------------------------- tasks

TASKS: dict[str, Task] = {t.name: t for t in [
    Task("py_bugs", "python",
         "The tests in tests/ fail. Find and fix the bugs in the inv package (do not change the tests). "
         "Run the tests with `python3 -m unittest discover -s tests -t .` until they pass.",
         py_bugs_setup, py_bugs_verify, "three bugs in two files, visible tests", py_bugs_solve),
    Task("c_strjoin", "c",
         "Add `char *str_join(const char **parts, size_t n, const char *sep)` to src/strutil.c and declare it in "
         "src/strutil.h: it returns a newly allocated string with the n parts joined by sep (an empty string for n = 0). "
         "Then make `./app` print its arguments joined with \",\" followed by a newline. It must build with `make` "
         "(warnings are errors).",
         c_strjoin_setup, c_strjoin_verify, "C, compile errors matter (-Werror)", c_strjoin_solve),
    Task("rust_durations", "rust",
         "`cargo test` fails for the durations crate. Fix parse_duration in src/lib.rs so that it follows its "
         "documentation: a number without a unit after it is ParseError::MissingUnit, a unit without a number before it "
         "is ParseError::BadNumber. Do not change the tests.",
         rust_setup, rust_verify, "Rust, edge cases beyond the visible tests", rust_solve),
    Task("ts_coupons", "typescript",
         "Implement applyCoupon in src/cart.ts as README.md describes. `bun test` runs the tests.",
         ts_setup, ts_verify, "spec in a README, hidden cases", ts_solve),
    Task("py_rename", "python",
         "Rename the function fetch_user_record to load_user everywhere in this project: its definition, every import "
         "and call, and NOTES.md. The tests (`python3 -m unittest discover -s tests -t .`) must still pass.",
         rename_setup, rename_verify, "12 files, many identical edits", rename_solve),
    Task("c_tabs_ring", "c",
         "In ring.c, ring_push overwrites the oldest value when the ring is full. Make it return -1 instead and leave the "
         "ring unchanged when it already holds RING_CAP values. Keep the file's style (tabs). `make` must still build.",
         tabs_setup, tabs_verify, "tab-indented file, one precise edit", tabs_solve),
    Task("py_slow_suite", "python",
         "`python3 run_tests.py` runs this project's test suite; it takes over a minute and some tests fail. Fix the cause "
         "in device.py (do not change run_tests.py) and run the suite again to confirm it passes.",
         slow_setup, slow_verify, "a 72 s test run: waiting on a long command", slow_solve),
    Task("search_large", "python",
         "The payments gateway client's retry budget is set somewhere in this repository. Change it to 25, and update the "
         "client's docstring that mentions the old value. Change nothing else.",
         search_setup, search_verify, "find one value among 320 files", search_solve),
]}


# --------------------------------------------------------------------------- running


def make_agent_dir(base: Path, models_json: Path, provider: str) -> Path:
    """An agent folder with only the model's provider: no settings, extensions, skills or instruction files."""
    base.mkdir(parents=True, exist_ok=True)
    models = json.loads(models_json.read_text())
    provider_cfg = models.get("providers", {}).get(provider)
    out = {"providers": {provider: provider_cfg}} if provider_cfg else {"providers": {}}
    (base / "models.json").write_text(json.dumps(out, indent=2))
    (base / "settings.json").write_text("{}\n")
    return base


def error_kind(tool: str, text: str) -> str:
    """Why a tool call failed: the harness refused it (`guard`), an edit did not apply (`edit`), a command exited with
    an error (`command`, often a test run that is expected to fail), or something else."""
    if text.startswith("Not run:"):
        return "guard"
    if tool in ("edit", "write"):
        return "edit"
    if tool == "bash":
        return "command"
    return "other"


def tool_suites() -> dict[str, list[Task]]:
    from hard_tasks import HARD_TASKS  # noqa: PLC0415 - hard_tasks imports this module

    return {"easy": list(TASKS.values()), "hard": HARD_TASKS, "all": list(TASKS.values()) + HARD_TASKS}


def parse_events(stdout: str) -> dict:
    stats = {"turns": 0, "tool_calls": 0, "tool_errors": 0, "error_kinds": {}, "tools": {}, "input": 0, "cache_read": 0,
             "t_model": 0.0, "t_tools": 0.0, "t_first_event": None, "t_last_event": None,
             "cache_write": 0, "output": 0, "cost": 0.0, "stop": None, "error": None, "final_text": ""}
    turn_start = None
    tool_spans: dict[str, float] = {}
    turn_tools: list[tuple[float, float]] = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = event.get("_t")
        kind = event.get("type")
        if t is not None:
            if stats["t_first_event"] is None:
                stats["t_first_event"] = t
            stats["t_last_event"] = t
            if kind == "turn_start":
                turn_start = t
            elif kind == "message_end" and (event.get("message") or {}).get("role") == "assistant" and turn_start is not None:
                # From the turn's start to the end of the model's message: request preparation, waiting, generation.
                stats["t_model"] += t - turn_start
                turn_start = None
            elif kind == "tool_execution_start":
                tool_spans[event.get("toolCallId", "")] = t
            elif kind == "tool_execution_end" and event.get("toolCallId", "") in tool_spans:
                turn_tools.append((tool_spans.pop(event.get("toolCallId", "")), t))
            elif kind == "turn_end" and turn_tools:
                # Tools of one turn may overlap: count the span they cover.
                stats["t_tools"] += max(e for _, e in turn_tools) - min(s for s, _ in turn_tools)
                turn_tools = []
        if kind != "message_end":
            continue
        message = event.get("message") or {}
        role = message.get("role")
        if role == "assistant":
            stats["turns"] += 1
            usage = message.get("usage") or {}
            stats["input"] += usage.get("input", 0) or 0
            stats["cache_read"] += usage.get("cacheRead", 0) or 0
            stats["cache_write"] += usage.get("cacheWrite", 0) or 0
            stats["output"] += usage.get("output", 0) or 0
            stats["cost"] += ((usage.get("cost") or {}).get("total") or 0)
            stats["stop"] = message.get("stopReason")
            if message.get("errorMessage"):
                stats["error"] = message["errorMessage"][:300]
            texts = [c.get("text", "") for c in message.get("content", []) if isinstance(c, dict) and c.get("type") == "text"]
            if texts:
                stats["final_text"] = "".join(texts)[-400:]
            for c in message.get("content", []):
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    stats["tool_calls"] += 1
                    stats["tools"][c["name"]] = stats["tools"].get(c["name"], 0) + 1
        elif role == "toolResult" and message.get("isError"):
            stats["tool_errors"] += 1
            text = "".join(c.get("text", "") for c in message.get("content", []) if isinstance(c, dict))
            kind = error_kind(message.get("toolName", ""), text.strip())
            stats["error_kinds"][kind] = stats["error_kinds"].get(kind, 0) + 1
    return stats


def run_one(task: Task, harness: str, cmd: list[str], agent_dir: Path, model: str, work: Path, events_dir: Path,
            rep: int) -> dict:
    root = Path(tempfile.mkdtemp(prefix=f"hb-{task.name}-{harness}-", dir=work))
    events_name = f"{task.name}-{harness}-{model.replace('/', '_')}-{rep}"
    task.setup(root)
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent_dir), CARGO_TARGET_DIR=str(root / "target"))
    args = cmd + ["--mode", "json", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--model", model, task.prompt]
    start = time.monotonic()
    # Each event line is stamped when it arrives (`_t`, seconds since the start), for the time split in parse_events.
    p = subprocess.Popen(args, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         stdin=subprocess.DEVNULL)
    stamped: list[str] = []
    err_chunks: list[str] = []
    reader = threading.Thread(target=lambda: err_chunks.append(p.stderr.read()), daemon=True)
    reader.start()

    def read_stdout() -> None:
        for line in p.stdout:
            t = round(time.monotonic() - start, 3)
            try:
                event = json.loads(line)
                event["_t"] = t
                stamped.append(json.dumps(event))
            except json.JSONDecodeError:
                stamped.append(line.rstrip("\n"))

    out_reader = threading.Thread(target=read_stdout, daemon=True)
    out_reader.start()
    try:
        p.wait(timeout=RUN_TIMEOUT_S)
        timed_out = False
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
        timed_out = True
    out_reader.join(timeout=10)
    reader.join(timeout=10)
    wall = time.monotonic() - start
    stdout, stderr = "\n".join(stamped), "".join(err_chunks)
    (events_dir / f"{events_name}.jsonl").write_text(stdout)
    if stderr.strip():
        (events_dir / f"{events_name}.stderr").write_text(stderr[-20000:])
    stats = parse_events(stdout)
    try:
        solved, detail = task.verify(root)
    except Exception as exc:  # noqa: BLE001 - a broken run must not stop the benchmark
        solved, detail = False, f"verifier crashed: {exc}"
    shutil.rmtree(root, ignore_errors=True)
    return {"task": task.name, "harness": harness, "rep": rep, "model": model, "solved": solved, "wall": round(wall, 2),
            "timed_out": timed_out, "detail": detail[-1500:], **stats}


def cmd_run(a: argparse.Namespace) -> None:
    harnesses: dict[str, list[str]] = {}
    for spec in a.harness:
        name, _, command = spec.partition("=")
        harnesses[name] = shlex.split(command)
    suite = tool_suites()[a.suite]
    tasks = [t for t in suite if not a.task or t.name in a.task]
    models: list[str] = a.model
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = Path(a.out or RESULTS / stamp)
    events_dir = out_dir / "events"
    events_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="harnessbench-"))
    providers = sorted({m.split("/")[0] for m in models})
    agent_dirs = {}
    for h in harnesses:
        base = make_agent_dir(work / f"agent-{h}", Path(a.models_json).expanduser(), providers[0])
        if len(providers) > 1:
            all_models = json.loads(Path(a.models_json).expanduser().read_text()).get("providers", {})
            (base / "models.json").write_text(json.dumps({"providers": {p: all_models[p] for p in providers if p in all_models}}))
        agent_dirs[h] = base
    (out_dir / "config.json").write_text(json.dumps({"harnesses": harnesses, "models": models, "reps": a.reps,
                                                     "suite": a.suite, "tasks": [t.name for t in tasks]}, indent=2))
    runs_file = out_dir / "runs.jsonl"
    jobs = []
    for rep in range(a.reps):
        for model in models:
            for task in tasks:
                order = list(harnesses) if rep % 2 == 0 else list(reversed(harnesses))
                jobs += [(rep, model, task, h) for h in order]
    done = 0

    def one(job):
        rep, model, task, h = job
        return run_one(task, h, harnesses[h], agent_dirs[h], model, work, events_dir, rep)

    # Runs in parallel share the machine: wall times include that load alike for every harness.
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.parallel) as pool:
        for result in pool.map(one, jobs):
            done += 1
            with runs_file.open("a") as f:
                f.write(json.dumps(result) + "\n")
            mark = "solved" if result["solved"] else "FAILED"
            print(f"[{done}/{len(jobs)}] {result['model']:28} {result['task']:16} {result['harness']:12} {mark:6} "
                  f"{result['wall']:7.1f} s {result['turns']:3} turns  errors {result['error_kinds'] or '-'}  "
                  f"${result['cost']:.4f}", flush=True)
    shutil.rmtree(work, ignore_errors=True)
    report(out_dir)


def report(out_dir: Path) -> None:
    runs = [json.loads(l) for l in (out_dir / "runs.jsonl").read_text().splitlines() if l.strip()]
    harnesses = list(dict.fromkeys(r["harness"] for r in runs))
    models = list(dict.fromkeys(r["model"] for r in runs))
    tasks = list(dict.fromkeys(r["task"] for r in runs))
    med = lambda xs: statistics.median(xs) if xs else float("nan")  # noqa: E731

    def kinds(rs: list[dict]) -> str:
        total: dict[str, int] = {}
        for r in rs:
            for k, v in (r.get("error_kinds") or {}).items():
                total[k] = total.get(k, 0) + v
        return " ".join(f"{k} {v}" for k, v in sorted(total.items())) or "-"

    lines = [f"# harnessbench: {out_dir.name}", "", f"{len(runs)} runs, models: {', '.join(models)}.", ""]
    lines.append("| Model | Harness | Solved | Wall time, median | Wall time, sum | Model / tools / rest, sum | Turns, median | Tool errors (by cause) | New input | Cached input | Output | Cost |")
    lines.append("|---|---|---:|---:|---:|---|---:|---|---:|---:|---:|---:|")
    for m in models + (["all"] if len(models) > 1 else []):
        for h in harnesses:
            rs = [r for r in runs if r["harness"] == h and (m == "all" or r["model"] == m)]
            if not rs:
                continue
            model_s = sum(r.get("t_model", 0) for r in rs)
            tools_s = sum(r.get("t_tools", 0) for r in rs)
            wall_s = sum(r["wall"] for r in rs)
            lines.append(f"| {m} | {h} | {sum(r['solved'] for r in rs)}/{len(rs)} | {med([r['wall'] for r in rs]):.1f} s | "
                         f"{wall_s:.0f} s | {model_s:.0f} / {tools_s:.0f} / {wall_s - model_s - tools_s:.0f} s | "
                         f"{med([r['turns'] for r in rs]):.0f} | {kinds(rs)} | "
                         f"{sum(r['input'] + r['cache_write'] for r in rs) / 1000:.0f}k | {sum(r['cache_read'] for r in rs) / 1000:.0f}k | "
                         f"{sum(r['output'] for r in rs) / 1000:.0f}k | ${sum(r['cost'] for r in rs):.2f} |")
    for m in models:
        lines += ["", f"Per task, {m} (solved, median wall time, median turns):", ""]
        lines.append("| Task | " + " | ".join(harnesses) + " |")
        lines.append("|---|" + "---|" * len(harnesses))
        for t in tasks:
            cells = []
            for h in harnesses:
                rs = [r for r in runs if r["harness"] == h and r["task"] == t and r["model"] == m]
                cells.append(f"{sum(r['solved'] for r in rs)}/{len(rs)}, {med([r['wall'] for r in rs]):.0f} s, "
                             f"{med([r['turns'] for r in rs]):.0f} turns" if rs else "-")
            lines.append(f"| {t} | " + " | ".join(cells) + " |")
    lines += ["", "Tool calls by tool:", ""]
    for h in harnesses:
        counts: dict[str, int] = {}
        for r in runs:
            if r["harness"] == h:
                for k, v in r["tools"].items():
                    counts[k] = counts.get(k, 0) + v
        lines.append(f"- {h}: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])))
    timeouts = [r for r in runs if r.get("timed_out")]
    if timeouts:
        lines += ["", "Timed out: " + ", ".join(f"{r['task']}/{r['harness']}/{r['model']}" for r in timeouts)]
    text = "\n".join(lines) + "\n"
    (out_dir / "report.md").write_text(text)
    print(text)


def cmd_selftest(a: argparse.Namespace) -> None:
    """Each task's verifier must reject the untouched project and accept the reference solution."""
    work = Path(tempfile.mkdtemp(prefix="harnessbench-selftest-"))
    bad = 0
    for task in tool_suites()[a.suite]:
        root = work / task.name
        root.mkdir()
        task.setup(root)
        unsolved_ok = not task.verify(root)[0]
        fresh = work / f"{task.name}-solved"
        fresh.mkdir()
        task.setup(fresh)
        task.solve(fresh)
        solved, detail = task.verify(fresh)
        bad += (not unsolved_ok) + (not solved)
        print(f"{task.name:16} untouched: {'rejected' if unsolved_ok else 'ACCEPTED (broken)'}, "
              f"reference: {'accepted' if solved else 'REJECTED: ' + detail[-300:]}")
    shutil.rmtree(work, ignore_errors=True)
    sys.exit(1 if bad else 0)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--harness", action="append", required=True, help="name=command, e.g. pi='node /x/pi'")
    run.add_argument("--model", action="append", required=True, help="repeatable; providers from --models-json")
    run.add_argument("--suite", choices=["easy", "hard", "all"], default="easy")
    run.add_argument("--parallel", type=int, default=1)
    run.add_argument("--models-json", default="~/.pi/agent/models.json", help="where the model's provider is defined")
    run.add_argument("--reps", type=int, default=3)
    run.add_argument("--task", action="append")
    run.add_argument("--out")
    run.set_defaults(func=cmd_run)
    rep = sub.add_parser("report")
    rep.add_argument("dir")
    rep.set_defaults(func=lambda a: report(Path(a.dir)))
    st = sub.add_parser("selftest")
    st.add_argument("--suite", choices=["easy", "hard", "all"], default="all")
    st.set_defaults(func=cmd_selftest)
    a = parser.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
