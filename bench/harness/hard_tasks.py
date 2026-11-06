"""The `hard` suite: tasks a model can fail, over more files, with more compile rounds and more context."""
from __future__ import annotations

import ast
import random
from pathlib import Path

from harnessbench import Task, git_init, replace_in, sh, write

# --------------------------------------------------------------------------- py_api

API_DOC = '''# list_books

`library.api.list_books(service, params)` lists books. `params` holds query-string values (all strings):

| Param | Meaning | Default | Valid |
|---|---|---|---|
| `author` | only books by this author, compared ignoring case | all | any text |
| `year_from` | only books from this year on (inclusive) | none | an integer |
| `year_to` | only books up to this year (inclusive) | none | an integer, not below `year_from` |
| `page` | which page | 1 | an integer >= 1 |
| `per_page` | books per page | 10 | an integer from 1 to 50 |

An invalid value raises `ValueError("invalid <param>")`, for example `ValueError("invalid per_page")`. Unknown params are
ignored.

The result is `{"items": [...], "total": <books matching>, "page": <page>, "per_page": <per_page>, "pages": <pages>}`,
where each item is `{"id", "title", "author", "year"}`, books are sorted by year, then title, and `pages` is the number
of pages the matching books fill (0 when none match). A page past the last one has no items.

The filtering is done by the repository: `BookRepo.find(author=None, year_from=None, year_to=None)` returns the matching
books in any order.
'''

API_FILES = {
    "library/__init__.py": "",
    "library/models.py": '''from dataclasses import dataclass


@dataclass(frozen=True)
class Book:
    id: int
    title: str
    author: str
    year: int
''',
    "library/repo.py": '''from .models import Book


class BookRepo:
    def __init__(self, books: list[Book]):
        self._books = list(books)

    def all(self) -> list[Book]:
        return list(self._books)
''',
    "library/service.py": '''from .repo import BookRepo


class BookService:
    def __init__(self, repo: BookRepo):
        self.repo = repo

    def list_books(self):
        return sorted(self.repo.all(), key=lambda b: b.title)
''',
    "library/api.py": '''from .service import BookService


def list_books(service: BookService, params: dict) -> dict:
    books = service.list_books()
    return {"items": [vars(b) for b in books], "total": len(books)}
''',
    "docs/API.md": API_DOC,
    "tests/__init__.py": "",
    "tests/test_api.py": '''import unittest

from library.api import list_books
from library.models import Book
from library.repo import BookRepo
from library.service import BookService

BOOKS = [Book(1, "Dune", "Herbert", 1965), Book(2, "Emma", "Austen", 1815), Book(3, "Persuasion", "Austen", 1817)]


class ApiTest(unittest.TestCase):
    def test_by_author(self):
        result = list_books(BookService(BookRepo(BOOKS)), {"author": "austen"})
        self.assertEqual([b["title"] for b in result["items"]], ["Emma", "Persuasion"])
        self.assertEqual((result["total"], result["page"], result["per_page"], result["pages"]), (2, 1, 10, 1))
''',
}

API_HIDDEN = '''import unittest

from library.api import list_books
from library.models import Book
from library.repo import BookRepo
from library.service import BookService

BOOKS = [Book(i, f"T{i:02d}", "Austen" if i % 3 else "Bronte", 1800 + i % 7) for i in range(1, 31)]


def call(params):
    return list_books(BookService(BookRepo(BOOKS)), params)


class HiddenApi(unittest.TestCase):
    def test_sorted_by_year_then_title(self):
        items = call({"per_page": "50"})["items"]
        keys = [(b["year"], b["title"]) for b in items]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(items), 30)

    def test_pages(self):
        r = call({"per_page": "7", "page": "5"})
        self.assertEqual((r["total"], r["pages"], len(r["items"])), (30, 5, 2))
        self.assertEqual(call({"per_page": "7", "page": "6"})["items"], [])

    def test_years_inclusive(self):
        r = call({"year_from": "1802", "year_to": "1803", "per_page": "50"})
        self.assertTrue(r["items"] and all(1802 <= b["year"] <= 1803 for b in r["items"]))
        self.assertEqual(r["total"], len([b for b in BOOKS if 1802 <= b.year <= 1803]))

    def test_none_match(self):
        r = call({"author": "nobody"})
        self.assertEqual((r["total"], r["pages"], r["items"]), (0, 0, []))

    def test_invalid(self):
        for params, name in [({"per_page": "0"}, "per_page"), ({"per_page": "51"}, "per_page"), ({"page": "0"}, "page"),
                             ({"page": "x"}, "page"), ({"year_from": "abc"}, "year_from"),
                             ({"year_from": "1805", "year_to": "1804"}, "year_to")]:
            with self.assertRaises(ValueError) as cm:
                call(params)
            self.assertEqual(str(cm.exception), f"invalid {name}")

    def test_unknown_params_ignored(self):
        self.assertEqual(call({"colour": "red"})["total"], 30)

    def test_repo_find(self):
        repo = BookRepo(BOOKS)
        self.assertEqual({b.id for b in repo.find(author="BRONTE")}, {b.id for b in BOOKS if b.author == "Bronte"})
        self.assertEqual(len(repo.find(year_from=1806)), len([b for b in BOOKS if b.year >= 1806]))
        self.assertEqual(len(repo.find()), 30)

    def test_item_shape(self):
        self.assertEqual(set(call({})["items"][0]), {"id", "title", "author", "year"})
'''


def py_api_setup(root: Path) -> None:
    write(root, API_FILES)
    git_init(root)


def py_api_verify(root: Path) -> tuple[bool, str]:
    write(root, {"tests/test_hidden_bench.py": API_HIDDEN, "tests/test_api.py": API_FILES["tests/test_api.py"]})
    code, out = sh("python3 -m unittest discover -s tests -t . 2>&1 | tail -20", root)
    return out.strip().endswith("OK"), out


def py_api_solve(root: Path) -> None:
    write(root, {
        "library/repo.py": API_FILES["library/repo.py"] + '''
    def find(self, author=None, year_from=None, year_to=None) -> list[Book]:
        return [b for b in self._books
                if (author is None or b.author.lower() == author.lower())
                and (year_from is None or b.year >= year_from) and (year_to is None or b.year <= year_to)]
''',
        "library/service.py": '''from .repo import BookRepo


class BookService:
    def __init__(self, repo: BookRepo):
        self.repo = repo

    def list_books(self, author=None, year_from=None, year_to=None):
        return sorted(self.repo.find(author, year_from, year_to), key=lambda b: (b.year, b.title))
''',
        "library/api.py": '''from .service import BookService


def _int(params, name, default=None, low=None, high=None):
    if name not in params:
        return default
    try:
        value = int(params[name])
    except (TypeError, ValueError):
        raise ValueError(f"invalid {name}") from None
    if (low is not None and value < low) or (high is not None and value > high):
        raise ValueError(f"invalid {name}")
    return value


def list_books(service: BookService, params: dict) -> dict:
    year_from = _int(params, "year_from")
    year_to = _int(params, "year_to")
    if year_from is not None and year_to is not None and year_to < year_from:
        raise ValueError("invalid year_to")
    page = _int(params, "page", 1, 1)
    per_page = _int(params, "per_page", 10, 1, 50)
    books = service.list_books(params.get("author"), year_from, year_to)
    start = (page - 1) * per_page
    return {"items": [vars(b) for b in books[start:start + per_page]], "total": len(books), "page": page,
            "per_page": per_page, "pages": -(-len(books) // per_page)}
''',
    })


# --------------------------------------------------------------------------- c_name_ptr

CN_FILES = {
    "include/user.h": '''#ifndef USER_H
#define USER_H

#define NAME_MAX_LEN 32

struct user {
	int id;
	char name[NAME_MAX_LEN];
	int age;
};

void user_init(struct user *u, int id, const char *name, int age);

#endif
''',
    "include/store.h": '''#ifndef STORE_H
#define STORE_H
#include "user.h"

#define STORE_CAP 64

struct store {
	struct user users[STORE_CAP];
	int count;
};

void store_init(struct store *s);
/* Adds a user; returns 0, or -1 when the store is full. */
int store_add(struct store *s, int id, const char *name, int age);
const struct user *store_find(const struct store *s, const char *name);
/* Removes every user. */
void store_clear(struct store *s);

#endif
''',
    "include/format.h": '''#ifndef FORMAT_H
#define FORMAT_H
#include <stddef.h>
#include "user.h"

/* Writes "<id>:<name>:<age>" into buf; returns what snprintf returns. */
int user_format(const struct user *u, char *buf, size_t n);

#endif
''',
    "include/sort.h": '''#ifndef SORT_H
#define SORT_H
#include "store.h"

void store_sort_by_name(struct store *s);

#endif
''',
    "src/user.c": '''#include <string.h>
#include "user.h"

void user_init(struct user *u, int id, const char *name, int age)
{
	u->id = id;
	strncpy(u->name, name, NAME_MAX_LEN - 1);
	u->name[NAME_MAX_LEN - 1] = '\\0';
	u->age = age;
}
''',
    "src/store.c": '''#include <string.h>
#include "store.h"

void store_init(struct store *s)
{
	s->count = 0;
}

int store_add(struct store *s, int id, const char *name, int age)
{
	if (s->count >= STORE_CAP)
		return -1;
	user_init(&s->users[s->count], id, name, age);
	s->count++;
	return 0;
}

const struct user *store_find(const struct store *s, const char *name)
{
	for (int i = 0; i < s->count; i++)
		if (strcmp(s->users[i].name, name) == 0)
			return &s->users[i];
	return NULL;
}

void store_clear(struct store *s)
{
	s->count = 0;
}
''',
    "src/format.c": '''#include <stdio.h>
#include "format.h"

int user_format(const struct user *u, char *buf, size_t n)
{
	return snprintf(buf, n, "%d:%s:%d", u->id, u->name, u->age);
}
''',
    "src/sort.c": '''#include <stdlib.h>
#include <string.h>
#include "sort.h"

static int by_name(const void *a, const void *b)
{
	const struct user *ua = a, *ub = b;
	return strcmp(ua->name, ub->name);
}

void store_sort_by_name(struct store *s)
{
	qsort(s->users, (size_t)s->count, sizeof(s->users[0]), by_name);
}
''',
    "src/main.c": '''#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "format.h"
#include "sort.h"
#include "store.h"

/* ./app name=age ...: prints the users sorted by name. */
int main(int argc, char **argv)
{
	static struct store s;
	char line[256];
	store_init(&s);
	for (int i = 1; i < argc; i++) {
		char *eq = strchr(argv[i], '=');
		if (!eq)
			continue;
		*eq = '\\0';
		store_add(&s, i, argv[i], atoi(eq + 1));
	}
	store_sort_by_name(&s);
	for (int i = 0; i < s.count; i++) {
		user_format(&s.users[i], line, sizeof line);
		puts(line);
	}
	store_clear(&s);
	return 0;
}
''',
    "Makefile": '''CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -Iinclude
SRC = src/user.c src/store.c src/format.c src/sort.c src/main.c

app: $(SRC) include/*.h
\t$(CC) $(CFLAGS) -o app $(SRC)

clean:
\trm -f app
''',
}

CN_HIDDEN = '''#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "format.h"
#include "sort.h"
#include "store.h"

static int fails = 0;
#define CHECK(cond, msg) do { if (!(cond)) { printf("FAIL: %s\\n", msg); fails++; } } while (0)

int main(void)
{
	const char *long_a = "Aloysius-Bartholomew-Constantine-Demetrius-Evangelista-Fitzgerald";
	const char *long_b = "Aloysius-Bartholomew-Constantine-Demetrius-Evangelista-Abernathy";
	static struct store s;
	char line[256];
	char name[80];
	store_init(&s);
	strcpy(name, long_a);
	CHECK(store_add(&s, 1, name, 30) == 0, "add a");
	strcpy(name, "overwritten");
	CHECK(store_add(&s, 2, long_b, 40) == 0, "add b");
	CHECK(store_find(&s, long_a) != NULL, "find a by its full name");
	CHECK(store_find(&s, long_b) != NULL, "find b by its full name");
	store_sort_by_name(&s);
	user_format(&s.users[0], line, sizeof line);
	CHECK(strcmp(line, "2:Aloysius-Bartholomew-Constantine-Demetrius-Evangelista-Abernathy:40") == 0, "format b first");
	store_clear(&s);
	CHECK(s.count == 0, "clear");
	CHECK(store_add(&s, 3, "x", 1) == 0, "add after clear");
	store_clear(&s);
	struct user u;
	user_init(&u, 9, long_a, 9);
	CHECK(strcmp(u.name, long_a) == 0, "user_init keeps the whole name");
	user_free(&u);
	if (fails == 0)
		printf("HIDDEN OK\\n");
	return fails != 0;
}
'''


def c_name_setup(root: Path) -> None:
    write(root, CN_FILES)
    git_init(root)


def c_name_verify(root: Path) -> tuple[bool, str]:
    code, out = sh("make clean >/dev/null; make 2>&1 && ./app zed=1 amy=2", root)
    if code != 0 or out.strip().splitlines()[-2:] != ["2:amy:2", "1:zed:1"]:
        return False, "app: " + out
    write(root, {"bench_hidden.c": CN_HIDDEN})
    code, out = sh("cc -std=c11 -g -fsanitize=address -Iinclude -o bench_hidden bench_hidden.c src/user.c src/store.c "
                   "src/format.c src/sort.c 2>&1 && ASAN_OPTIONS=detect_leaks=1 ./bench_hidden 2>&1", root)
    return code == 0 and "HIDDEN OK" in out, out


def c_name_solve(root: Path) -> None:
    replace_in(root, "include/user.h", "\tchar name[NAME_MAX_LEN];", "\tchar *name;")
    replace_in(root, "include/user.h", "int age);\n", "int age);\nvoid user_free(struct user *u);\n")
    write(root, {"src/user.c": '''#include <stdlib.h>
#include <string.h>
#include "user.h"

void user_init(struct user *u, int id, const char *name, int age)
{
	size_t n = strlen(name) + 1;
	u->id = id;
	u->name = malloc(n);
	if (u->name)
		memcpy(u->name, name, n);
	u->age = age;
}

void user_free(struct user *u)
{
	free(u->name);
	u->name = NULL;
}
'''})
    replace_in(root, "src/store.c", "void store_clear(struct store *s)\n{\n\ts->count = 0;",
               "void store_clear(struct store *s)\n{\n\tfor (int i = 0; i < s->count; i++)\n\t\tuser_free(&s->users[i]);\n\ts->count = 0;")


# --------------------------------------------------------------------------- rust_trait

RT_LIB = '''//! Shapes and their areas.

#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    Circle { r: f64 },
    Rect { w: f64, h: f64 },
}

impl Shape {
    pub fn area(&self) -> f64 {
        match self {
            Shape::Circle { r } => std::f64::consts::PI * r * r,
            Shape::Rect { w, h } => w * h,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Shape::Circle { .. } => "circle",
            Shape::Rect { .. } => "rect",
        }
    }
}

pub fn total_area(shapes: &[Shape]) -> f64 {
    shapes.iter().map(|s| s.area()).sum()
}

/// The shape with the largest area; the first of them on a tie.
pub fn largest(shapes: &[Shape]) -> Option<&Shape> {
    let mut best: Option<&Shape> = None;
    for s in shapes {
        if best.map_or(true, |b| s.area() > b.area()) {
            best = Some(s);
        }
    }
    best
}
'''

RT_VISIBLE = '''use shapes::*;

#[test]
fn rect_area() {
    assert_eq!(Shape::Rect { w: 2.0, h: 3.0 }.area(), 6.0);
}

#[test]
fn largest_first_on_tie() {
    let shapes = vec![Shape::Rect { w: 1.0, h: 4.0 }, Shape::Rect { w: 2.0, h: 2.0 }];
    assert_eq!(largest(&shapes), Some(&shapes[0]));
}
'''

RT_TASK = '''Replace the `Shape` enum in src/lib.rs by a trait:

```rust
pub trait Shape {
    fn area(&self) -> f64;
    fn perimeter(&self) -> f64;
    fn name(&self) -> String;
}
```

implemented by `pub struct Circle { pub r: f64 }`, `pub struct Rect { pub w: f64, pub h: f64 }` and a new
`pub struct Triangle` made with `Triangle::new(a: f64, b: f64, c: f64) -> Option<Triangle>` from its three sides
(None when they cannot form a triangle, including degenerate ones; area by Heron's formula). Names are "circle", "rect"
and "triangle". `total_area` and `largest` take `&[Box<dyn Shape>]`; `largest` returns `Option<&dyn Shape>`, still the
first on a tie. Rewrite tests/visible.rs for the new API with the same checks. `cargo test` must pass.
'''

RT_HIDDEN = '''use shapes::*;

fn boxed() -> Vec<Box<dyn Shape>> {
    vec![
        Box::new(Rect { w: 1.0, h: 4.0 }),
        Box::new(Triangle::new(3.0, 4.0, 5.0).unwrap()),
        Box::new(Rect { w: 2.0, h: 3.0 }),
        Box::new(Circle { r: 1.0 }),
    ]
}

#[test]
fn triangle() {
    let t = Triangle::new(3.0, 4.0, 5.0).unwrap();
    assert!((t.area() - 6.0).abs() < 1e-9);
    assert!((t.perimeter() - 12.0).abs() < 1e-9);
    assert_eq!(t.name(), "triangle");
    assert!(Triangle::new(1.0, 2.0, 3.0).is_none());
    assert!(Triangle::new(1.0, 1.0, 5.0).is_none());
    assert!(Triangle::new(-1.0, 1.0, 1.0).is_none());
}

#[test]
fn circle_and_rect() {
    let c = Circle { r: 2.0 };
    assert!((c.perimeter() - 4.0 * std::f64::consts::PI).abs() < 1e-9);
    assert_eq!(c.name(), "circle");
    assert_eq!(Rect { w: 2.0, h: 3.0 }.perimeter(), 10.0);
    assert_eq!(Rect { w: 2.0, h: 3.0 }.name(), "rect");
}

#[test]
fn totals_and_largest() {
    let shapes = boxed();
    let expected = 4.0 + 6.0 + 6.0 + std::f64::consts::PI;
    assert!((total_area(&shapes) - expected).abs() < 1e-9);
    let big = largest(&shapes).unwrap();
    assert_eq!(big.name(), "triangle");
    assert!(largest(&[]).is_none());
}
'''


def rust_trait_setup(root: Path) -> None:
    write(root, {"Cargo.toml": '[package]\nname = "shapes"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
                 "src/lib.rs": RT_LIB, "tests/visible.rs": RT_VISIBLE})
    git_init(root)


def rust_trait_verify(root: Path) -> tuple[bool, str]:
    write(root, {"tests/bench_hidden.rs": RT_HIDDEN})
    code, out = sh("cargo test --offline --quiet 2>&1 | tail -25", root, timeout=600)
    return code == 0 and "FAILED" not in out and "error" not in out.lower(), out


def rust_trait_solve(root: Path) -> None:
    write(root, {"src/lib.rs": '''pub trait Shape {
    fn area(&self) -> f64;
    fn perimeter(&self) -> f64;
    fn name(&self) -> String;
}

pub struct Circle { pub r: f64 }
pub struct Rect { pub w: f64, pub h: f64 }
pub struct Triangle { a: f64, b: f64, c: f64 }

impl Triangle {
    pub fn new(a: f64, b: f64, c: f64) -> Option<Triangle> {
        if a <= 0.0 || b <= 0.0 || c <= 0.0 || a + b <= c || a + c <= b || b + c <= a {
            return None;
        }
        Some(Triangle { a, b, c })
    }
}

impl Shape for Circle {
    fn area(&self) -> f64 { std::f64::consts::PI * self.r * self.r }
    fn perimeter(&self) -> f64 { 2.0 * std::f64::consts::PI * self.r }
    fn name(&self) -> String { "circle".into() }
}

impl Shape for Rect {
    fn area(&self) -> f64 { self.w * self.h }
    fn perimeter(&self) -> f64 { 2.0 * (self.w + self.h) }
    fn name(&self) -> String { "rect".into() }
}

impl Shape for Triangle {
    fn area(&self) -> f64 {
        let s = (self.a + self.b + self.c) / 2.0;
        (s * (s - self.a) * (s - self.b) * (s - self.c)).sqrt()
    }
    fn perimeter(&self) -> f64 { self.a + self.b + self.c }
    fn name(&self) -> String { "triangle".into() }
}

pub fn total_area(shapes: &[Box<dyn Shape>]) -> f64 {
    shapes.iter().map(|s| s.area()).sum()
}

pub fn largest(shapes: &[Box<dyn Shape>]) -> Option<&dyn Shape> {
    let mut best: Option<&dyn Shape> = None;
    for s in shapes {
        if best.map_or(true, |b| s.area() > b.area()) {
            best = Some(s.as_ref());
        }
    }
    best
}
''', "tests/visible.rs": '''use shapes::*;

#[test]
fn rect_area() {
    assert_eq!(Rect { w: 2.0, h: 3.0 }.area(), 6.0);
}

#[test]
fn largest_first_on_tie() {
    let shapes: Vec<Box<dyn Shape>> = vec![Box::new(Rect { w: 1.0, h: 4.0 }), Box::new(Rect { w: 2.0, h: 2.0 })];
    assert_eq!(largest(&shapes).unwrap().perimeter(), 10.0);
}
'''})


# --------------------------------------------------------------------------- py_trace

COUNTRIES = [("AT", "austria", 0.20), ("AU", "australia", 0.10), ("DE", "germany", 0.19), ("FR", "france", 0.20),
             ("IT", "italy", 0.22), ("ES", "spain", 0.21), ("NL", "netherlands", 0.21), ("BE", "belgium", 0.21),
             ("SE", "sweden", 0.25), ("DK", "denmark", 0.25), ("FI", "finland", 0.255), ("PL", "poland", 0.23),
             ("CZ", "czechia", 0.21), ("PT", "portugal", 0.23), ("IE", "ireland", 0.23), ("NZ", "new_zealand", 0.15),
             ("CA", "canada", 0.05), ("JP", "japan", 0.10), ("CH", "switzerland", 0.081), ("NO", "norway", 0.25)]


def trace_setup(root: Path) -> None:
    rnd = random.Random(7)
    files: dict[str, str] = {"shop/__init__.py": "", "shop/pricing/__init__.py": "", "shop/pricing/regions/__init__.py": ""}
    registry_lines = []
    for code, module, rate in COUNTRIES:
        files[f"shop/pricing/regions/{module}.py"] = f'''"""Tax rules for {module.replace('_', ' ').title()}."""

STANDARD_RATE = {rate}
REDUCED_RATE = {round(rate / 2, 3)}
REDUCED_CATEGORIES = {{"books", "food"}}


def rate_for(category: str) -> float:
    return REDUCED_RATE if category in REDUCED_CATEGORIES else STANDARD_RATE
'''
        # The bug: AT is registered with Australia's rules.
        registry_lines.append(f'    "{code}": "{"australia" if code == "AT" else module}",')
    files["shop/pricing/registry.py"] = '''"""Country codes to the module with their tax rules."""
import importlib

REGION_MODULES = {
''' + "\n".join(registry_lines) + '''
}


def rules_for(country: str):
    return importlib.import_module(f"shop.pricing.regions.{REGION_MODULES[country]}")
'''
    files["shop/pricing/tax.py"] = '''from shop.pricing.registry import rules_for


def tax_cents(net_cents: int, category: str, country: str) -> int:
    return round(net_cents * rules_for(country).rate_for(category))
'''
    files["shop/checkout.py"] = '''from shop.pricing.tax import tax_cents


def checkout(lines, country: str) -> int:
    """Total in cents with tax: lines are (net_cents, category)."""
    return sum(net + tax_cents(net, cat, country) for net, cat in lines)
'''
    for k in range(400):
        area = rnd.choice(["orders", "users", "catalog", "shipping", "reports", "admin", "notify", "search"])
        files[f"shop/{area}/m{k:03d}.py"] = f'''"""{area} helper {k}."""


def compute_{k}(values):
    total = 0
    for v in values:
        total += v * {k % 13 + 1}
    return total  # tax and rate handling live in shop.pricing
'''
    for area in {"orders", "users", "catalog", "shipping", "reports", "admin", "notify", "search"}:
        files[f"shop/{area}/__init__.py"] = ""
    files["tests/__init__.py"] = ""
    files["tests/test_checkout.py"] = '''import unittest

from shop.checkout import checkout


class CheckoutTest(unittest.TestCase):
    def test_austria(self):
        self.assertEqual(checkout([(1000, "electronics"), (2000, "books")], "AT"), 1000 + 200 + 2000 + 200)
'''
    write(root, files)
    git_init(root)


TRACE_HIDDEN = '''import unittest

from shop.checkout import checkout


class HiddenCheckout(unittest.TestCase):
    def test_regions(self):
        self.assertEqual(checkout([(1000, "electronics")], "AT"), 1200)
        self.assertEqual(checkout([(1000, "electronics")], "AU"), 1100)
        self.assertEqual(checkout([(1000, "food")], "DE"), 1095)
        self.assertEqual(checkout([(1000, "electronics")], "CH"), 1081)
'''


def trace_verify(root: Path) -> tuple[bool, str]:
    write(root, {"tests/test_hidden_bench.py": TRACE_HIDDEN})
    code, out = sh("python3 -m unittest discover -s tests -t . 2>&1 | tail -15", root)
    if not out.strip().endswith("OK"):
        return False, out
    code, rules = sh("git diff --stat -- shop/pricing/regions", root)
    return not rules.strip(), out + ("" if not rules.strip() else "\nchanged a region's rules: " + rules)


def trace_solve(root: Path) -> None:
    replace_in(root, "shop/pricing/registry.py", '"AT": "australia"', '"AT": "austria"')


# --------------------------------------------------------------------------- py_twins

TWIN_NAMES = ["order", "payment", "refund", "shipment", "invoice", "chargeback", "signup", "login", "logout", "reset",
              "upload", "download", "share", "comment", "like", "follow", "block", "report", "subscribe", "renew",
              "cancel", "pause", "resume", "export", "import_", "merge", "split", "archive", "restore", "purge",
              "invite", "accept", "decline", "escalate", "assign", "close", "reopen", "tag", "untag", "notify"]


def twin_source() -> str:
    body = '"""Event handlers. Every handler dispatches its event with a timeout."""\nimport audit\nfrom dispatch import dispatch\n'
    for n in TWIN_NAMES:
        body += f'''

def handle_{n}(event):
    """Handle a {n.rstrip('_')} event."""
    timeout = 30
    result = dispatch("{n.rstrip('_')}", event, timeout=timeout)
    return result
'''
    return body


def twins_setup(root: Path) -> None:
    write(root, {"handlers.py": twin_source(), "audit.py": "LOG = []\n\n\ndef log(kind, event):\n    LOG.append((kind, event))\n",
                 "dispatch.py": "def dispatch(kind, event, timeout):\n    return (kind, event, timeout)\n"})
    git_init(root)


def twins_verify(root: Path) -> tuple[bool, str]:
    src = (root / "handlers.py").read_text()
    try:
        new = {f.name: ast.unparse(f) for f in ast.parse(src).body if isinstance(f, ast.FunctionDef)}
    except SyntaxError as e:
        return False, f"syntax error: {e}"
    old = {f.name: ast.unparse(f) for f in ast.parse(twin_source()).body if isinstance(f, ast.FunctionDef)}
    changed = sorted(n for n in old if new.get(n) != old[n])
    if changed != ["handle_chargeback", "handle_refund"] or set(new) != set(old):
        return False, f"changed: {changed}"
    code, out = sh("python3 -c 'import audit, handlers\n"
                   "assert handlers.handle_refund(1) == (\"refund\", 1, 90)\n"
                   "assert handlers.handle_chargeback(2) == (\"chargeback\", 2, 90)\n"
                   "assert handlers.handle_payment(3) == (\"payment\", 3, 30)\n"
                   "assert audit.LOG == [(\"refund\", 1), (\"chargeback\", 2)], audit.LOG\n"
                   "print(\"OK\")'", root)
    return out.strip().endswith("OK"), out


TWINS_TASK = ("In handlers.py, change only handle_refund and handle_chargeback: their timeout becomes 90 instead of 30, and "
              "each calls audit.log(<its event kind>, event) before dispatching, for example audit.log(\"refund\", event). "
              "Every other handler must stay exactly as it is.")


def twins_solve(root: Path) -> None:
    for n in ["refund", "chargeback"]:
        replace_in(root, "handlers.py",
                   f'    """Handle a {n} event."""\n    timeout = 30\n    result = dispatch(',
                   f'    """Handle a {n} event."""\n    timeout = 90\n    audit.log("{n}", event)\n    result = dispatch(')


# --------------------------------------------------------------------------- long_audit

def audit_module(k: int, rnd: random.Random) -> tuple[str, int]:
    parts = [f'"""Module {k}: record processing."""\nfrom hashing import legacy_hash, stable_hash  # noqa: F401\n']
    calls = 0
    for j in range(55):
        kind = rnd.random()
        if j % 14 == 3:
            calls += 1
            if kind < 0.3:
                line = f"    return legacy_hash(record, salt={j})"
            else:
                line = "    return legacy_hash(record)"
        else:
            line = f"    return sum(ord(c) for c in str(record)) * {j + 1}"
        parts.append(f'''

def step_{k}_{j}(record):
    """Step {j} of module {k}: normalises the record before it is stored, keeps the original keys, drops empty values,
    and returns the record's identity for the dedup index."""
    if record is None:
        return None
{line}
''')
    return "".join(parts), calls


def audit_setup(root: Path) -> None:
    rnd = random.Random(11)
    files = {"hashing.py": '''import hashlib


def legacy_hash(value, salt=0):
    """Deprecated: unstable across processes. Use stable_hash(value, seed=...)."""
    return hash((str(value), salt))


def stable_hash(value, seed=0):
    return int(hashlib.sha256(f"{seed}:{value}".encode()).hexdigest()[:12], 16)
''', "src/__init__.py": ""}
    for k in range(20):
        files[f"src/mod_{k:02d}.py"], _ = audit_module(k, rnd)
    write(root, files)
    git_init(root)


AUDIT_TASK = ("legacy_hash in hashing.py is deprecated. Replace every call to it in src/ with stable_hash, with the same "
              "arguments, except that the keyword salt= becomes seed= (stable_hash(value, seed=N)). Do not change hashing.py.")


def audit_verify(root: Path) -> tuple[bool, str]:
    code, left = sh("grep -rn 'legacy_hash(' src || true", root)
    if left.strip():
        return False, "calls left:\n" + left[:1500]
    code, out = sh('''python3 - <<'EOF'
import importlib, random, sys
sys.path.insert(0, ".")
from hashing import stable_hash
bad = 0
for k in range(20):
    m = importlib.import_module(f"src.mod_{k:02d}")
    for j in range(55):
        f = getattr(m, f"step_{k}_{j}", None)
        if f is None:
            print("missing", k, j); bad += 1; continue
        if j % 14 == 3:
            r = f("abc")
            if r not in (stable_hash("abc"), stable_hash("abc", seed=j)):
                print("wrong result", k, j); bad += 1
        elif f("abc") != sum(ord(c) for c in "abc") * (j + 1):
            print("changed", k, j); bad += 1
print("OK" if bad == 0 else f"{bad} wrong")
EOF''', root)
    if not out.strip().endswith("OK"):
        return False, out
    code, salt = sh("grep -rn 'salt=' src || true", root)
    code, diff = sh("git diff --stat -- hashing.py", root)
    return not salt.strip() and not diff.strip(), out + salt + diff


def audit_solve(root: Path) -> None:
    sh(r"sed -i -E 's/legacy_hash\(record, salt=/stable_hash(record, seed=/; s/legacy_hash\(record\)/stable_hash(record)/' src/mod_*.py", root)


# --------------------------------------------------------------------------- def_lookup

DEF_RULES = '''__all__ = ["normalize_amount"]


def normalize_amount(value):
    """Rounds a money amount to whole cents."""
    cents = int(value * 100)
    return cents / 100
'''


def def_lookup_setup(root: Path) -> None:
    files = {
        "billing/__init__.py": "from billing._impl.r_rules import *  # noqa: F403\n",
        "billing/_impl/__init__.py": "",
        "billing/_impl/r_rules.py": DEF_RULES,
        "README.md": "# shop\n\nAmounts go through `normalize_amount` before they are shown or stored.\n",
    }
    apps = ["orders", "refunds", "invoices", "carts", "coupons", "payouts", "fees", "taxes", "gifts", "loyalty"]
    for app in apps:
        for k in range(40):
            files[f"apps/{app}/h{k}.py"] = f'''from billing import normalize_amount


def total_{k}(items):
    """Total of the {app} items of kind {k}."""
    return normalize_amount(sum(items))
'''
    write(root, files)
    git_init(root)


def def_lookup_verify(root: Path) -> tuple[bool, str]:
    code, diff = sh("git status --porcelain", root)
    # Bytecode caches Python wrote when the agent ran the code are not changes.
    changed = sorted(line[3:] for line in diff.splitlines() if line.strip() and "__pycache__" not in line)
    if changed != ["billing/_impl/r_rules.py"]:
        return False, f"changed files: {changed}"
    check = (
        "from billing import normalize_amount as n; "
        "cases = [(2.675, 2.68), (1.005, 1.01), (2.674, 2.67), (10, 10.0), (0.125, 0.13), (3.333, 3.33)]; "
        "bad = [(v, n(v), w) for v, w in cases if abs(n(v) - w) > 1e-9]; print('OK' if not bad else bad)"
    )
    code, out = sh(f'python3 -c "{check}"', root)
    return code == 0 and out.strip() == "OK", out


def def_lookup_solve(root: Path) -> None:
    replace_in(root, "billing/_impl/r_rules.py", "    cents = int(value * 100)\n    return cents / 100\n",
               "    from decimal import ROUND_HALF_UP, Decimal\n\n"
               "    return float(Decimal(str(value)).quantize(Decimal(\"0.01\"), rounding=ROUND_HALF_UP))\n")


HARD_TASKS = [
    Task("py_api", "python", "Implement the behaviour docs/API.md describes for list_books, across the api, service and repo "
         "layers. The tests run with `python3 -m unittest discover -s tests -t .`.",
         py_api_setup, py_api_verify, "a spec over four layers, many hidden edge cases", py_api_solve),
    Task("c_name_ptr", "c",
         "Users' names are cut at 31 characters. Change struct user's name to a `char *` that owns an allocated copy of the "
         "name, add `void user_free(struct user *u)` (declared in include/user.h) that frees it, and free every user's name "
         "where users are dropped (store_clear). Everything must build with `make` (warnings are errors), and `./app "
         "name=age ...` must keep working. Nothing may leak.",
         c_name_setup, c_name_verify, "six C files, -Werror, AddressSanitizer with leak checks", c_name_solve),
    Task("rust_trait", "rust", RT_TASK, rust_trait_setup, rust_trait_verify, "enum to trait, several compile rounds",
         rust_trait_solve),
    Task("py_trace", "python",
         "`python3 -m unittest discover -s tests -t .` fails: checkout charges the wrong tax for Austria. Find the cause "
         "and fix it there; the tax rules of every country are correct.",
         trace_setup, trace_verify, "the cause is a mapping, in a repo of 400+ files", trace_solve),
    Task("py_twins", "python", TWINS_TASK, twins_setup, twins_verify, "2 of 40 near-identical functions", twins_solve),
    Task("long_audit", "python", AUDIT_TASK, audit_setup, audit_verify, "80 calls in 20 modules of 450 lines: context and many edits",
         audit_solve),
    Task("def_lookup", "python",
         "Money amounts come out wrong everywhere: 2.675 is shown as 2.67, and 1.005 as 1.0. normalize_amount must round "
         "half up to whole cents (2.675 -> 2.68). Fix it where it is defined; change nothing else.",
         def_lookup_setup, def_lookup_verify, "a function used in 400 files, defined behind a re-export", def_lookup_solve),
]
