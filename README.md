# pi-harness-rsi

A **pi extension** for harness self-improvement (RSI, after Harness² / arXiv:2610.14224)
with **enforced context economy**: every artifact that may enter an LLM context is
budgeted by one choke point, and nothing is ever silently truncated.

Design: budgets, the editable surface, the safety model and a full example
workflow are documented below — and enforced in code (`src/context.ts`,
`src/guard.ts`, `src/ledger.ts`) with an executable test suite, so every
invariant here is executable rather than aspirational.
The loop: `snapshot → probe ×k → propose INV/DOM ×2k → probe ×2k → compose ×k → probe ×k → select → adopt → reflect`.

## Load it

```bash
pi -e /path/to/pi-harness-rsi/index.ts          # one-off
pi install /path/to/pi-harness-rsi              # registers in settings
```

## Commands

One command, verb first. The verb may be omitted: then the whole line is a
`start` task.

```
/rsi <verb> [flags] <args>
```

| Verb | What it does |
| --- | --- |
| *(none)* | **State view** — the in-flight run if there is one, otherwise the latest ledger and the exact command to type next. Never calls a model. |
| `start <task>` | Full loop: probe → propose → probe → compose → probe → select → adopt → reflect. Flags: `--k <n>` `--domain <name>` `--mode parallel\|sequential` `--yes` `--force` |
| `probe <task>` | Reference executions + digests only (no editor, no edits, no adoption). Flags: `--k <n>` `--domain <name>` |
| `status [runId]` | The in-flight run, else the latest ledger: identity `R=4k, P=3k`, USD, fallbacks, diversity, budget usage. |
| `watch [--once] [--lines <n>]` | Live view of the in-flight run: stage, elapsed, USD, latest notes — polls until the run closes. `--once` prints a single snapshot instead. |
| `stop` | Interrupt the in-flight run before its normal end (see *Interruption* below). |
| `adopt [label] [--run <id>] [--yes] [--force]` | Human gate: apply a composed surface, snapshot the library, reflect. |
| `revert <domain>/<slug> [--force]` | Restore the previous adopted surface for one library entry, under the same guards as adoption. Must resolve, else it errors. |
| `library [domain]` | Domains, entries, `INDEX.md`, `EXPERIENCE.md`. |
| `help` | The table above, in the terminal. |

`/rsi` with no arguments is the entry point: it prints where things stand and
what to type next.

**The three commands you actually type** — everything else is for when you want
to look:

```
/rsi probe fix the flaky session test                        # 1. what does the harness do today? (no edits)
/rsi status                                                  #    read the digests, then...
/rsi start --domain acme run the verifier after every edit    # 2. learn the habit (asks before adopting)
/rsi                                                          # 3. what next? one exact command
```

Every command that changes state ends by printing exactly one command to type
next, so the workflow is discoverable from the terminal (`/rsi` alone) and from
the end of any run.

**Argument rules** (they are what keep the surface predictable):

- The first word is a verb **only** if it is one of the lowercase verbs above.
  Anything else is task text, so `/rsi fix the flaky test` means `start`.
- **Flags come before the task.** Everything from the first task word onward is
  task text verbatim — `/rsi start --k 2 fix --verbose` has the task
  `fix --verbose`. (Verbs that take discrete arguments — `adopt`, `status`,
  `revert` — accept flags anywhere: `/rsi adopt final0 --run <id> --yes`.)
- `--flag=value` works too, and `--` ends flag parsing when the task itself
  starts with a dash: `/rsi start -- --verbose is not a flag`.
- An unknown flag, a value flag with no value, or a value on a boolean is an
  error with the usage line — never a silent reinterpretation of the task.

Adoption and reflection also maintain the library's health: a new lesson whose
cue matches an older one **supersedes** it (the old entry stays on disk for
audit, but stops entering missions), and every rendered lesson carries its
`adopted:` date so the editor can weigh staleness.

Headless (`pi --print "/rsi …"`) mirrors every report to stdout; adoption stays
gated — without `--yes` a headless run ends as `outcome: pending` and prints
the `/rsi adopt …` command to run next. There is no input loop to keep
responsive, so headless runs **await** the loop instead of detaching it: the
process exits when the run has actually finished, not while it is still
starting.

A `running` ledger whose owner pid (recorded in the ledger, same host) is no
longer alive is reported as orphaned — `/rsi status` says so and `/rsi watch`
does not present it as in flight, so a crashed or killed run cannot masquerade
as a live one.

Only one run can be in flight per project: `start`, `probe` and `adopt` refuse
while another run is active (in this session or in another process — see the
run lock); `watch` inspects it and `stop` interrupts it.

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
/rsi probe fix the flaky session test
```

Read `/rsi status`. The digests under `.pi/harness/runs/<id>/digests/` tell you
where the harness bleeds: repeated identical calls, failing checks, paths never
read. That is the input the improvement loop will act on.

**Then run the loop.** The task is not “the change you want” — it is the
capability you want the harness to acquire (it is what the reference executions
measure):

```
/rsi start --domain acme-api run the verifier before every edit and re-read files after editing
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
   (the candidate stays in `surfaces/` for later `/rsi adopt`).
7. `reflect` — one `EXPERIENCE.md` entry (cue / lesson / evidence / confidence,
   caps enforced) so the next run in this domain starts smarter.

**Iterate.** Repeat `/rsi start` with a new task in the same domain; each run
feeds on the previous library (`INDEX.md` + top lessons enter the propose
mission, still budget-capped). Check or undo with:

```
/rsi status                     # latest run + the exact next command
/rsi library acme-api           # domains, INDEX.md, EXPERIENCE.md
/rsi adopt final0 --run <id>    # apply a candidate you left pending
/rsi revert acme-api/<slug>     # restore the previous adopted surface
```

**Headless / scripted:**

```bash
pi --print "/rsi probe --domain acme-api $TASK"          # evidence only, silent adoption impossible
pi --print "/rsi start --domain acme-api --yes $TASK"    # explicit opt-out of the gate
```

**Cost & knobs:** a k=1 run is 4 solver probes + 3 editor sessions (7 child-`pi`
calls, each capped by `stageTimeoutMs`); with small models that is typically a
few tens of cents, and the run aborts fail-closed at `maxUsd` (default $2).
Because a free model spends `$0` and still takes time, a run is also capped by a
wall clock: `maxRunMinutes` (default **5**, `PI_RSI_MAX_MINUTES` to override)
ends the run with `outcome: aborted_timeout`, killing the in-flight stage rather
than waiting for the next one. `--k 2` doubles both sides of the identity
(R=8, P=6) and buys a real selection stage. `PI_RSI_FAKE=1` exercises the entire
loop with **zero** model calls.

## Example workflow

Scenario: `acme-api` (TypeScript). The agent keeps editing without running the
tests and re-reads nothing, so it repeats the same failing check three times per
session. You want the *harness* to learn the habit, not a one-off reminder.

```text
$ cd ~/code/acme-api && pi

▸ /rsi probe add a rate-limit header to the login endpoint
  … 1 reference run, digest in .pi/harness/runs/20261018-121500-add-a-rate-limit/digests/ref0.md

▸ /rsi status
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

▸ /rsi start --domain acme-api run the verifier after every edit and re-read files before the next edit
  rsi: profile=small k=1 mode=parallel fake=0 maxUsd=2 maxRun=5m confirmAdopt=1
  [rsi] final0: # digest: final0 (model=…, 88s, turns=9) — diff 2 file(s) changed
  rsi: adopt final0?
      adopt final0: added 2, removed 0, modified 1, always-on Δ +312 chars, surface Δ +1 104 chars
        + .pi/skills/acme-api-notes/SKILL.md
        + .pi/skills/acme-api-notes/scripts/check.sh
        ~ AGENTS.md
      The live tree is updated and a library snapshot is written.
  ✔ Yes
  rsi: adopted final0 · USD 0.0873 · R 4/4 P 3/3 identity OK
  /rsi library acme-api

▸ git status
  M AGENTS.md
  ?? .pi/skills/acme-api-notes/    # review and commit these like any other change
  ?? .pi/harness/library/          # your learned experience — version it
                                    # (runs/ and worktrees/ are self-ignored)

▸ /rsi library acme-api
  --- INDEX.md ---
  - **add-a-rate-limit-header** — checks failing after an edit → re-read the edited file and run the verifier before the next edit (2026-10-18)
```

Next week, `/rsi start --domain acme-api <new task>` loads that lesson into the
propose mission automatically (cue match), and the new reference digests sit next to the
old ones — so whether rework actually went down is measurable, not vibes. If a
run makes things worse:

```text
▸ /rsi revert acme-api/add-a-rate-limit-header
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

Because `scripts/**` is *executable capability* mounted into every probe
sandbox, candidates are **script-scanned** (fetch-and-execute, `sudo`, credential
paths, reverse shells, env exfil — fail-closed like the tripwires), and the
adoption gate shows the content of every added/modified script (bounded excerpt
+ hash), not just its path.

Never editable: `tests/**`, `**/*.test.ts`, `.github/**`, `package.json`, lockfiles
(`rsi.forbiddenGlobs`), plus grader-gaming tripwire phrases
(`pass_rate`, `delete the failing test`, …) scanned in every candidate.

## What to gitignore in the host project

The extension manages most of this itself: on every run it writes
`.pi/harness/.gitignore` containing `worktrees/`, `runs/` and `run.lock`
(idempotent, it never touches `.gitignore` at the repo root or
`.git/info/exclude`), so the ephemeral artifacts below never show up in
`git status`.

**Commit these** — they are the harness's durable state, and without them a
fresh clone starts from zero:

| Path | Why |
| --- | --- |
| `AGENTS.md`, `.pi/skills/`, `.pi/prompts/` | the adopted surface — the habits the harness actually learned |
| `.pi/harness/library/` | `INDEX.md`, `EXPERIENCE.md`, `surface/`, `previous/`, `history/` — the experience that seeds the next run and makes `/rsi revert` work |
| `.pi/settings.json` | the `rsi` config (verifier, budget, profile) so runs are reproducible across machines |
| `.pi/harness/.gitignore` | optional to commit (it is regenerated anyway); committing it documents the intent |

**Never commit** — regenerated and/or self-contained:

| Path | Why |
| --- | --- |
| `.pi/harness/runs/` | per-run evidence: session JSONL, rollouts, digests, candidate surfaces; large, contains verbatim transcripts and duplicated source |
| `.pi/harness/worktrees/` | throwaway working copies of the whole repo, one per reference execution |
| `.pi/harness/run.lock` | cross-process run lock (live pid + run id); regenerated, never useful in history |

If you prefer a single rule at the repo root instead of the generated file:

```gitignore
.pi/harness/runs/
.pi/harness/worktrees/
.pi/harness/run.lock
```

(Do **not** ignore `.pi/harness/` or `.pi/harness/library/` wholesale — that
would silently drop the learned experience you are supposed to version).

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
    "profile": "small",          // or "large" (doubles every budget below)
    "k": 1,                      // references per domain index (R=4k, P=3k)
    "mode": "parallel",          // or "sequential"
    "editorModel": null,         // child-pi model overrides (null = inherit the session's model)
    "solverModel": null,
    "thinking": null,            // child-pi --thinking level, when set
    "tools": "read,bash,edit,write,grep,find,ls",   // solver tool allowlist
    "editorTools": "read,grep,find,ls",             // editor is answer-only
    "verifier": null,            // e.g. "bun test" — evidence line, never a score
    "confirmAdopt": true,        // keep the P6 human gate on
    "requireClean": true,        // refuse to start on a dirty tree (unless --force)
    "maxUsd": 2,
    "maxRunMinutes": 5,          // wall-clock cap for the whole run (free models spend $0 but still take time)
    "maxParallel": 2,
    "libraryDir": ".pi/harness/library",   // absolute or repo-relative
    "worktreeRoot": ".pi/harness/worktrees",
    "keepRuns": 20,              // run dirs kept under .pi/harness/runs (pending adoptions are never pruned)
    "stageTimeoutMs": 600000,
    "budgets": {},               // per-key overrides on the active profile
    "forbiddenGlobs": []         // replaces defaults when non-empty
  }
}
```

Environment overrides: `PI_RSI_MAX_USD`, `PI_RSI_MAX_MINUTES`, `PI_RSI_PI_BIN`
(child binary), `PI_RSI_FAKE=1` + `PI_RSI_FAKE_SCENARIO=valid|invalid-first|always-invalid`
(deterministic loop, **zero model calls**).

## Safety model

- **P6**: adoption only through the confirm gate (`/rsi adopt --yes` to opt out
  explicitly); a dirty working tree refuses adoption unless `--force`.
- **Revert is guarded too**: `/rsi revert <domain>/<slug>` applies the snapshot
  inside the same transaction as adoption — dirty-tree check (`--force` to
  override), cross-process run lock, re-validation, and restore-on-throw — so a
  restore can no longer clobber uncommitted work or race an adoption.
- **Fail closed**: invalid editor output → one retry carrying the verbatim
  validator error → fallback to the current surface (counted in the ledger).
- **Fail open** only at selection (judge unavailable → pick `c0`, recorded),
  because refusing selection cannot corrupt a grader.
- **Interruption**: `/rsi stop` interrupts the run before its normal end. In
  the session that owns the run, the current child-`pi` call — rollout *or*
  verifier — is SIGTERMed (both run async and are killed as a process tree); from
  another session (headless runs included) it writes a `STOP` sentinel into the
  run dir. Either way the loop checks the stop signal at every stage boundary
  and closes with outcome `aborted` — nothing half-applied, evidence and
  candidates stay under the run dir, and no adoption happens. `/rsi watch`
  shows the live stage, spend and notes (it tails until the run closes; `--once`
  prints a snapshot), with a ledger-backed disk view for runs started in another
  session.
- **Budget check granularity**: `rsi.maxUsd` is evaluated at stage boundaries,
  not mid-rollout, so a stage that already launched its parallel children can
  overshoot the cap by one stage's spend before the run aborts fail-closed.
  Crashed children that never report provider cost count as $0 — keep `maxUsd` a
  real ceiling, not the exact spend. The wall-clock cap (`rsi.maxRunMinutes`) is
  the budget that binds when spend is $0: its timer aborts the run signal, so
  the in-flight child is killed immediately rather than at the next boundary.
- **Retention**: each new run prunes run dirs beyond `rsi.keepRuns` — but only
  runs that are old *and* decided; anything awaiting `/rsi adopt` (and the
  in-flight run) is never deleted, so the raw evidence a lesson came from
  stays repairable. `/rsi probe` goes through the same bookkeeping, so it also
  prunes stale runs/sandboxes even though it edits nothing in the surface.
- **One run per project (cross-process lock)**: the in-process registry only
  sees this `pi` session, so every run also takes `.pi/harness/run.lock`
  (pid + run id + host). A second session — or a headless `pi --print` — refuses
  to start while a live lock exists, and `/rsi adopt` takes the same lock before
  touching the tree. A lock whose pid is dead, is older than 12 h, or is
  unreadable is ignored (fail open), so a crashed run never wedges the project.
- **Delta-only validation**: `readSurface` snapshots what is already in the
  tree; candidates are validated as `base ⊕ delta` and `validate(base, candidate)`
  reports only the errors/warnings the proposal *adds* — a hostile script or
  tripwire phrase that already exists in the host tree is inherited, not
  re-litigated on every proposal. The tripwire boundary is about what a
  proposal adds or rewrites, not a full audit of the host project.
- **Matched conditions**: clean git trees probe a detached worktree at `HEAD`;
  a dirty tree (only reachable with `--force`) or a non-git project probes a
  byte-faithful copy of the live tree instead, so rollouts always measure the
  surface that was snapshotted rather than a stale checkout.
- **Sandbox boundary (be precise)**: a probe sandbox isolates the *working
  files*, not the process. A git-worktree sandbox shares the host repository’s
  `.git`, so a solver with `bash` can touch refs/config/hooks; a copy sandbox
  copies the tree, including untracked files (e.g. `.env`). Run untrusted tasks
  in a container/VM, or point the project at a throwaway clone.
- **Digest truncation is reported**: when a digest has to drop sections to fit
  its budget, the run records a `digest … capped` note instead of hiding it.
- Every run writes `.pi/harness/runs/<id>/`: `ledger.json`, `report.json`,
  `status.txt`, missions, digests, evidence (sessions + rollouts), candidate
  surfaces, `selection.json`. Library: `.pi/harness/library/<domain>/<slug>/`
  with `EXPERIENCE.md`, `INDEX.md`, `surface/`, `previous/` and `history/`
  (previous snapshots archived on each new adoption; `/rsi revert` restores the
  most recent `previous/`).

## Development

```bash
bun install          # dev deps (types only)
bun test             # full suite, includes fake loops for k=1 and k=2 (PI_RSI_FAKE=1)
bun run typecheck    # tsc --noEmit, strict + noUncheckedIndexedAccess
bun run lint         # Biome: lint + format check (bun run format to fix)
PI_RSI_FAKE=1 pi --offline -ne -e ./index.ts --print "/rsi start --domain demo <task>"   # zero-cost e2e
```

`src/args.ts` is the whole command surface: `VERBS`, per-verb `FLAGS`, the
parser and the `HELP` table. Adding a verb means one entry in `VERBS`, one in
`FLAGS`, one in `HELP`, and one `case` in `index.ts` (whose `default:` branch
types `verb` as `never`, so a missing `case` is a compile error, not a command
that silently does nothing); `test/args.test.ts` asserts `HELP` covers every
verb, so a missing row fails the suite.

Layout: `index.ts` (command dispatch: one `/rsi`, verb-first) · `src/args.ts`
(verb + flag parsing, help text) · `src/loop.ts` (orchestration) · `src/watch.ts`
(live run registry: `/rsi watch`, `/rsi stop`) · `src/lock.ts` (cross-process
run lock) · `src/context.ts` (budget choke point) · `src/surface.ts` (whitelist +
validation + gate review) · `src/guard.ts` (tripwires/script scan/gates) ·
`src/trajectory.ts` (digests) · `src/editor.ts` (missions, reply parsing) ·
`src/selection.ts` · `src/library.ts` (lessons, supersession) · `src/ledger.ts` ·
`src/probe.ts` · `src/proc.ts` (interruptible child processes: rollouts + verifier) · `src/retention.ts` (run pruning) · `src/runs.ts` (run discovery) ·
`src/worktree.ts` · `src/fake.ts`.
