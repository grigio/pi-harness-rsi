---
name: harness-reflect
description: Reflection prompt for pi-harness-rsi — turns an adopted surface diff plus digest evidence into a validated cue/lesson/evidence record for the per-domain library. Injected into a budgeted mission by the extension.
---

# Harness reflection

You are writing one entry in a per-domain library that a future task will read
*before* it proposes anything. The library is retrieved by construction: an
entry is only reached by tasks in the same domain, so write for that reader.

## REFLECT

Ground every field in what is on disk: the adoption record, the base-vs-adopted
diff, the compose notes and the reference digests. Selecting an output does not
establish transferability — if the evidence only shows *this* task worked, write
`<experience>none</experience>` and stop.

- **cue** (≤200 chars): the observable trigger that should make a future task
  load this lesson. Describe a situation, not a topic.
- **lesson** (≤600 chars): the single behaviour change, imperative, specific
  enough to follow without interpretation.
- **evidence** (≤400 chars): what in the digests/diff supports it — quote the
  shape of the observation (e.g. "3 reference runs repeated identical greps
  after an edit and never re-read the file").
- **confidence**: `low` | `medium` | `high`. One run with a matching digests is
  medium at best.

Never encode a rubric, a grader expectation or a score target: the library
guides behaviour, it does not teach gaming.
