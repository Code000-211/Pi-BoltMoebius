#!/bin/bash
# compare.sh NAME [BASE]: runs the three test sets with the current dsq build and prints Hit@1/3/10 and MRR per
# set; given BASE (the NAME of an earlier run), also how many queries moved up or down against it. Compare per query,
# not only the averages: a change can move as many queries down as up.
#
#   DOCSEARCH_EVAL_DATA  folder holding the frozen snapshots the test sets point into (see README.md):
#                        corpus/ (radiance's Markdown and text files) and code/ (its source files).
#                        Each run's ranks are kept there as ranks-NAME-<set>.tsv.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DATA=${DOCSEARCH_EVAL_DATA:?set DOCSEARCH_EVAL_DATA to the folder with corpus/ and code/}
DSQ=${DSQ:-$HERE/../target/release/dsq}
for set in docs names desc; do
  case $set in
    docs) root=corpus; tsv=docs-eval.tsv; ext=md,mdx,markdown,txt,rst,adoc,org ;;
    names) root=code; tsv=code-names.tsv; ext=cpp,h,hpp,c,cc,hip,py,rs,sh ;;
    desc) root=code; tsv=code-eval.tsv; ext=cpp,h,hpp,c,cc,hip,py,rs,sh ;;
  esac
  DSQ_EXT=$ext DSQ_VERBOSE=1 "$DSQ" "$DATA/$root" --eval "$HERE/$tsv" 2>&1 >/dev/null | grep "^rules" | cut -f2- > "$DATA/ranks-$1-$set.tsv"
done
python3 - "$DATA" "$1" "${2:-}" <<'PY'
import sys
data, name, base = sys.argv[1], sys.argv[2], sys.argv[3]
def load(n, s):
    out = []
    for line in open(f"{data}/ranks-{n}-{s}.tsv"):
        kind, rank, query = line.rstrip("\n").split("\t", 2)
        out.append((kind, None if rank == "-" else int(rank), query))
    return out
def stats(rows):
    at = lambda k: 100 * sum(1 for _, r, _ in rows if r and r <= k) / len(rows)
    mrr = sum(1 / r for _, r, _ in rows if r) / len(rows)
    return f"Hit@1 {at(1):3.0f}%  Hit@3 {at(3):3.0f}%  Hit@10 {at(10):3.0f}%  MRR {mrr:.3f}"
for s in ["docs", "names", "desc"]:
    rows = load(name, s)
    line = f"{s:<6} {stats(rows)}"
    if base:
        b = load(base, s)
        up = sum(1 for (_, x, _), (_, y, _) in zip(b, rows) if (y or 99) < (x or 99))
        down = sum(1 for (_, x, _), (_, y, _) in zip(b, rows) if (y or 99) > (x or 99))
        line += f"   vs {base}: {up} up, {down} down"
    print(line)
PY
