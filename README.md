# mend: one patch tool for every AI edit format

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alvenze/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alvenze/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies one patch, written the way AI models write edits, to a
tree of text files. It reads four formats: unified diffs (with wrong
line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool
calls as JSON. Every file is changed or nothing is: when any edit
fails, no file is written.

## How it works

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is a patch file relative to the working directory (the tree
  root), or standard input when absent or `-`.
- `--format=NAME` reads one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: same output and exit code, no
  file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` applied, `1` some edits failed, `2` usage, no-patch,
format or parse error. On success it prints one `A`/`D`/`M`/`R` line
per changed path, then `ok: <n> files`. On failure it prints one
`error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`.

Matching runs in three tiers: exact lines, then ignoring trailing
whitespace, then ignoring leading and trailing whitespace, taking the
first tier where the old lines occur at all. Context lines are written
as the file's own lines, and at tier 2 the other new lines are
re-indented from the patch's indentation to the file's. Unified hunks
take the occurrence nearest their stated line; SEARCH/REPLACE blocks
need exactly one occurrence; V4A chunks search forward from a cursor
and can anchor on a line or on the end of the file. JSON edits match
exactly, including CRLF files.

## How to run it

Node 22, standard library only, no dependencies to install:

    node main.ts fix.patch
    cat fix.patch | node main.ts
    node main.ts --format=v4a --check edit.patch

Run the practice set with the kit's checker (from this directory):

    node check.ts ../program/generator/practice.json

## Limits

- Files and patches are UTF-8 text. A path is safe when it is not
  empty, does not start with `/`, holds no `\`, and has no empty, `.`
  or `..` segment; unsafe paths fail the edit.
- A patch that changes nothing prints only `ok: 0 files`.
- The entry is one file, `main.ts`, plus `runner.ts` (the kit's trial
  hand-over, kept as shipped) and `check.ts` (the kit's practice
  checker).

## License

MIT. See [LICENSE](LICENSE).
