[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dunoil/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dunoil/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

`mend` is a command-line tool that applies an AI-written edit to a tree of text files. It reads a patch in one of four formats, unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits, finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace, full whitespace), and writes every change or none, printing what it changed or why it failed.

Run it as `node main.ts [options] [PATCH]` with the working directory as the root of the tree. See `SPEC.md` for the full contract. It uses Node 22 and the standard library only, and passes 100 of 100 practice checks.
