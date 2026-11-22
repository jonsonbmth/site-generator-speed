# site-generator-speed

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

A faster drop-in for **makefun-site 1.0.0**, built for the make.fun bounty
"Build a static site faster" (`site-generator-speed-01-run-20261122`).

`run(input)` returns exactly the answer makefun-site 1.0.0 returns for one
case's input `{ site, templates, files }`: the output tree of the site build
(each page's `index.html`, the index and tag pages, `build-report.txt` and
each static file), byte for byte. It is a clean-room, dependency-free
reimplementation optimised for CPU time: a fused single-pass Markdown
renderer, a compiled-template engine, fast-path HTML escaping and slug
generation, and no per-line regex battery in the hot paths.

## How to run

```sh
node main.ts
```

`main.ts` reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`),
answers each case alone with `run()` from `solve.js`, and writes
`/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`).

## Layout

- `solve.js` — the entry: `run(input)`, ES module, Node stdlib only.
- `main.ts` — the harness driver (reads cases, writes answers).
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT.

## Honest limits

- It reproduces makefun-site 1.0.0's own dialect exactly as its code does —
  its front matter, template dialect, Markdown subset, slug rule and report —
  not CommonMark, not Hugo/Zola/Eleventy semantics.
- It answers each case alone; nothing is cached from one case to the next.
- Node 22 or newer.
