# pi-harness-rsi — project instructions

This repository **is the harness** (a pi extension), not a host project. A change
must improve the extension for *any* project it is loaded into.

## Before editing
- Read `package.json`, `tsconfig.json`, the lint config, CI and the files you will
  touch with `read`; locate symbols with `grep`/`find`.
- Inspect with the `read`/`grep`/`find` tools, not compound `bash grep` chains. A
  search with no matches is **not** a failed check; do not rerun it or react to it.
- Read the existing tests for the area first and copy their offline, temp-dir style.
- Stop exploring once you have what you need: edit, then run checks.

## Order of work
- Make one focused change at a time. After each behaviour change, add or extend
  its regression test before moving on.
- Run the narrow test first (`bun test test/<file>.test.ts`), then the full gate.

## Finish gate — all three, in order
```bash
bunx tsc -p tsconfig.json   # typecheck
bun run lint                # Biome lint + format check
bun test                    # full suite, includes the zero-cost fake loops
```
- `bun run check` runs the three in that order. Do not report a change finished
  until all three pass.
- On failure, fix the root cause and rerun the whole gate; never skip, weaken or
  delete a check. Use `bun run format` only for formatting.
- Pin this contract in a test (e.g. `test/workflow.test.ts`) so removing a gate
  or a rule fails the suite.

## Every behaviour change needs a regression test
- Add or extend a test under `test/` that **fails on the old behaviour** and
  passes after the change. Assert the invariant or outcome, not implementation
  detail.
- For a bug fix, reproduce the exact input or sequence that used to fail and pin
  the fixed outcome.
- Keep tests deterministic and offline: `PI_RSI_FAKE=1`, `mkdtemp` temporary
  trees, no network or model calls.
- A docs-only change needs no new test unless it changes a contract (command
  surface, settings, workflow); then pin that contract in a test.

## Keep harness code general (never tied to a host project)
- `index.ts` and `src/**` run inside arbitrary host projects. Never hardcode a
  host's project name, absolute paths, language, package manager, framework,
  verifier or agent instructions. Read them from settings, git/filesystem
  discovery, or the captured project identity.
- Host-specific examples belong in `README.md`, never in runtime defaults.
  Defaults stay generic: `AGENTS.md`, `.pi/skills`, `.pi/prompts`, `.pi/harness`.
- Add ecosystem handling as *data* (e.g. `LABEL_FILES` in `src/continuity.ts`,
  forbidden globs in `src/config.ts`) with tests for at least two ecosystems,
  not as an `if` in the orchestration path.
- A probe sandbox must never inherit the live host's cwd or project trust.
- Machine-specific values (`/home/<user>`, fixed ports, LAN hosts) must not ship.

## Report when you stop
- End with the files changed and the commands you ran, quoting their pass/fail
  results (e.g. `bun test`: 214 pass, 0 fail).
- If a check could not run, say why; do not claim the change is finished.
