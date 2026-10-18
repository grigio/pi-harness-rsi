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

## How to use

**Prerequisites:** pi ≥ 1.3, bun, the extension loaded (see *Load it*), and a
verifier you trust — the whole loop is evidence-driven, so point `rsi.verifier`
at the command that tells you whether the project is healthy:

```jsonc
// ~/.config/pi/settings.json  (or the project's .pi/settings.json)
{ "rsi": { "verifier": "bun test", "maxUsd": 2 } }
```

**First run — look before you leap.** Start with a probe: it executes the *same
task* k times against the current surface in a throwaway worktree and writes
digests (errors, tool timeline, rework, verifier output). No editor, no edits:

```
/rsi-probe fix the flaky session test
```

Read `/rsi-status`. The digests under `.pi/harness/runs/<id>/digests/` tell you
where the harness bleeds: repeated identical calls, failing checks, paths never
read. That is the input the improvement loop will act on.

**Then run the loop.** The task is not “the change you want” — it is the
capability you want the harness to acquire (it is what the reference executions
measure):

```
/rsi --domain acme-api run the verifier before every edit and re-read files after editing
```

What happens, stage by stage:

1. `snapshot` — the surface (`AGENTS.md` + `.pi/skills` + `.pi/prompts`) is read;
   a git worktree is created under `.pi/harness/worktrees/`.
2. `probe ×k` — k solver runs of the task; digests + session JSONL kept as evidence.
3. `propose ×2k` — two *independent* editor sessions (INV lever, DOM lever) each
   reply with a `<edits>` delta over the surface; validator feedback is retried
   once verbatim, then it falls back to the current surface.
4. `probe ×2k` + `compose ×k` + `probe ×k` — each candidate is executed, a third
   editor session merges the best of both, the composed surface is executed again.
5. `select` (k>1) — an anonymised judge (`c0`, `c1`, …) picks from deliverables
   and digests only; labels and “why mine is better” text never reach it.
6. `adopt` — **the human gate**: pi shows the diff and asks. Confirm to update
   the live tree and write the library snapshot; decline and nothing changes
   (the candidate stays in `surfaces/` for later `/rsi-adopt`).
7. `reflect` — one `EXPERIENCE.md` entry (cue / lesson / evidence / confidence,
   caps enforced) so the next run in this domain starts smarter.

**Iterate.** Repeat `/rsi` with a new task in the same domain; each run feeds on
the previous library (`INDEX.md` + top lessons enter the propose mission, still
budget-capped). Check or undo with:

```
/rsi-library acme-api       # domains, INDEX.md, EXPERIENCE.md
/rsi-revert acme-api <slug> # restore the previous adopted surface
/rsi-adopt final0 --run <id> # apply a candidate you left pending
```

**Headless / scripted:**

```bash
pi --print "/rsi-probe --domain acme-api $TASK"          # evidence only, silent adoption impossible
pi --print "/rsi --domain acme-api --yes $TASK"          # explicit opt-out of the gate
```

**Cost & knobs:** a k=1 run is 4 solver probes + 3 editor sessions (7 child-`pi`
calls, each capped by `stageTimeoutMs`); with small models that is typically a
few tens of cents, and the run aborts fail-closed at `maxUsd` (default $2).
`--k 2` doubles both sides of the identity (R=8, P=6) and buys a real selection
stage. `PI_RSI_FAKE=1` exercises the entire loop with **zero** model calls.

## Example workflow

Scenario: `acme-api` (TypeScript). The agent keeps editing without running the
tests and re-reads nothing, so it repeats the same failing check three times per
session. You want the *harness* to learn the habit, not a one-off reminder.

```text
$ cd ~/code/acme-api && pi

▸ /rsi-probe add a rate-limit header to the login endpoint
  … 1 reference run, digest in .pi/harness/runs/20261018-121500-add-a-rate-limit/digests/ref0.md

▸ /rsi-status
  run 20261018-121500-add-a-rate-limit  task: add a rate-limit header to the login endpoint
  ledger: R 1 rollouts (probe-only run — R=4k/P=3k identity does not apply)
  usd: 0.0412 / max 2 (setting)
  outcome: probed
  notes:
    - ref0: # digest: ref0 (model=…, 96s, turns=11) — 1 deliverable file(s), verifier=yes

▸ cat .pi/harness/runs/20261018-121500-add-a-rate-limit/digests/ref0.md
  # digest: ref0 (model=…, 96s, turns=11)
  tools: bash×4 (2 err) edit×2 read×5
  errors:
    1. bash exit=1 @step=3  window: "FAIL src/auth.test.ts …"
  deliverable: src/auth.ts | git-diff: +41 −12
  verifier: bun test exit=1
  first_divergence: @step=3 hypothesis: bash failed first — the rest of the run reacts to it
  rework: 2 consecutive identical grep calls

  → the digest shows the real defect: 2 identical greps, 2 failing checks, no re-read.

▸ /rsi --domain acme-api run the verifier after every edit and re-read files before the next edit
  rsi: profile=small k=1 mode=parallel fake=0 maxUsd=2 confirmAdopt=1
  [rsi] final0: # digest: final0 (model=…, 88s, turns=9) — diff 2 file(s) changed
  rsi: adopt final0?
      adopt final0: added 2, removed 0, modified 1, always-on Δ +312 chars, surface Δ +1 104 chars
        + .pi/skills/acme-api-notes/SKILL.md
        + .pi/skills/acme-api-notes/scripts/check.sh
        ~ AGENTS.md
      The live tree is updated and a library snapshot is written.
  ✔ Yes
  rsi: adopted final0 · USD 0.0873 · R 4/4 P 3/3 identity OK

▸ git status
  M AGENTS.md
  ?? .pi/skills/acme-api-notes/    # review and commit these like any other change
  ?? .pi/harness/library/          # your learned experience — version it
                                    # (runs/ and worktrees/ are self-ignored)

▸ /rsi-library acme-api
  --- INDEX.md ---
  - **add-a-rate-limit-header** — checks failing after an edit → re-read the edited file and run the verifier before the next edit (2026-10-18)
```

Next week, `/rsi --domain acme-api <new task>` loads that lesson into the propose
mission automatically (cue match), and the new reference digests sit next to the
old ones — so whether rework actually went down is measurable, not vibes. If a
run makes things worse:

```text
▸ /rsi-revert acme-api add-a-rate-limit-header
  rsi: restored previous surface for acme-api/add-a-rate-limit-header (AGENTS.md)
```

(The pre-adoption surface comes back and the skill files it did not have are
removed again — `previous/` in the library is what makes this possible.)

Everything is auditable: each run’s missions, digests, session evidence, candidate
surfaces and the ledger (`R=4k, P=3k`, USD, fallbacks, budgets) live under
`.pi/harness/runs/<id>/` — nothing happened that the ledger cannot account for.

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
