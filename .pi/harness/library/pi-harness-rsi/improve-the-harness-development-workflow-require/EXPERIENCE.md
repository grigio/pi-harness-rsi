---
cue: Beginning a harness change and about to locate code or check state with a compound bash grep/git pipeline.
lesson: Explore with the read/grep/find tools instead of compound bash grep/git pipelines; treat a search with no matches as absent code, not a failed check, and continue from the result without rerunning or reacting to exit=1.
evidence: All 3 rollouts first diverged on a bash exit=1: ref0 had 4 errors at steps 2/4/6, inv0 2, dom0 3, with windows showing grep/git output; the adopted AGENTS.md diff adds exactly the read/grep/find and no-match rule.
confidence: medium
task: improve-the-harness-development-workflow-require
adopted: 2026-10-19
label: final0
---

# improve-the-harness-development-workflow-require

- **cue:** Beginning a harness change and about to locate code or check state with a compound bash grep/git pipeline.
- **lesson:** Explore with the read/grep/find tools instead of compound bash grep/git pipelines; treat a search with no matches as absent code, not a failed check, and continue from the result without rerunning or reacting to exit=1.
- **evidence:** All 3 rollouts first diverged on a bash exit=1: ref0 had 4 errors at steps 2/4/6, inv0 2, dom0 3, with windows showing grep/git output; the adopted AGENTS.md diff adds exactly the read/grep/find and no-match rule.
- **confidence:** medium
