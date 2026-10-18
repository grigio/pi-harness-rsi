# pi-harness-rsi

A **pi extension** for harness self-improvement (RSI, after Harness² / arXiv:2610.14224)
with **enforced context economy**: every artifact that may enter an LLM context is
budgeted by one choke point, and nothing is ever silently truncated.

Design: [PLAN-rsi.md](./PLAN-rsi.md) (budgets, invariants, non-goals).
The loop: `snapshot → probe ×k → propose INV/DOM ×2k → probe ×2k → compose ×k → probe ×k → select → adopt → reflect`.

## Load it

```bash
pi -e /path/to/pi-harness-rsi/index.ts          # one-off
pi install /path/to/pi-harness-rsi              # registers in settings
```

## Commands

| Command | What it does |
| --- | --- |
| `/rsi <task>` | Full loop. Flags: `--domain <name>` `--k <n>` `--mode parallel\|sequential` `--force` `--yes` |
| `/rsi-probe <task>` | Reference executions + digests only (no editor, no edits) |
| `/rsi-status [runId]` | Ledger identity `R=4k, P=3k`, USD, fallbacks, diversity, budget usage |
| `/rsi-adopt [label] [--yes] [--force] [--run <id>]` | Human gate: apply a composed surface, snapshot library, reflect |
| `/rsi-revert [domain/slug]` | Restore the previous adopted surface from the library |
| `/rsi-library [domain]` | Domains, entries, `INDEX.md`, `EXPERIENCE.md` |

Headless (`pi --print "/rsi …"`) mirrors every report to stdout; adoption stays
gated — without `--yes` a headless run ends as `outcome: pending` and tells you
the `/rsi-adopt` command to run next.

## The editable surface (everything else is immutable)

- `AGENTS.md` (always-on, char-budgeted per profile)
- `.pi/prompts/<name>.md`
- `.pi/skills/<name>/{SKILL.md, scripts/**}`

Never editable: `tests/**`, `**/*.test.ts`, `.github/**`, `package.json`, lockfiles
(`rsi.forbiddenGlobs`), plus grader-gaming tripwire phrases
(`pass_rate`, `delete the failing test`, …) scanned in every candidate.

## Context budgets (profile `small`, the default)

| Artifact | Budget |
| --- | --- |
| `AGENTS.md` | 6 000 chars |
| trajectory digest | 6 000 chars, fixed section shape, drops lowest-priority sections *whole* |
| propose mission | 16 000 chars |
| compose mission | 24 000 chars |
| select mission / reflect mission | 16 000 / 8 000 chars |
| `<notes>` | 600 chars |
| skill description / skill body warn | 300 / 4 000 chars |

`context.assemble()` is the single choke point: mandatory parts **raise**
(`BudgetError`) instead of truncating; optional parts are dropped whole with a
`## dropped-over-budget` notice so the editor gets a pointer, never a slice.
Profile `large` doubles these (set `rsi.profile`).

## Settings (`settings.json`)

```jsonc
{
  "rsi": {
    "profile": "small",          // or "large"
    "k": 1,                      // references per domain index (R=4k, P=3k)
    "mode": "parallel",          // or "sequential"
    "editorModel": null,          // child-pi model overrides
    "solverModel": null,
    "verifier": null,             // e.g. "bun test" — evidence line, never a score
    "confirmAdopt": true,         // keep the P6 human gate on
    "maxUsd": 2,
    "maxParallel": 2,
    "stageTimeoutMs": 600000,
    "forbiddenGlobs": []          // replaces defaults when non-empty
  }
}
```

Environment overrides: `PI_RSI_MAX_USD`, `PI_RSI_PI_BIN` (child binary),
`PI_RSI_FAKE=1` + `PI_RSI_FAKE_SCENARIO=valid|invalid-first|always-invalid`
(deterministic loop, **zero model calls**).

## Safety model

- **P6**: adoption only through the confirm gate (`/rsi-adopt --yes` to opt out
  explicitly); a dirty working tree refuses adoption unless `--force`.
- **Fail closed**: invalid editor output → one retry carrying the verbatim
  validator error → fallback to the current surface (counted in the ledger).
- **Fail open** only at selection (judge unavailable → pick `c0`, recorded),
  because refusing selection cannot corrupt a grader.
- Every run writes `.pi/harness/runs/<id>/`: `ledger.json`, `report.json`,
  `status.txt`, missions, digests, evidence (sessions + rollouts), candidate
  surfaces, `selection.json`. Library: `.pi/harness/library/<domain>/<slug>/`
  with `EXPERIENCE.md`, `INDEX.md`, `surface/`, `previous/`.

## Development

```bash
bun install          # dev deps (types only)
bun test             # 49 tests, includes full fake loops for k=1 and k=2 (PI_RSI_FAKE=1)
bun run typecheck    # tsc --noEmit, strict
PI_RSI_FAKE=1 pi --offline -ne -e ./index.ts --print "/rsi --domain demo <task>"   # zero-cost e2e
```

Layout: `index.ts` (commands) · `src/loop.ts` (orchestration) · `src/context.ts`
(budget choke point) · `src/surface.ts` (whitelist + validation) · `src/guard.ts`
(tripwires/gates) · `src/trajectory.ts` (digests) · `src/editor.ts` (missions,
reply parsing) · `src/selection.ts` · `src/library.ts` · `src/ledger.ts` ·
`src/probe.ts` · `src/worktree.ts` · `src/fake.ts`.
