# Implementation sessions

Every implementer builds test-first and ends on the implementer's report; every review ends on a verdict. The sections through **Review** apply to both session types.

The roles below are named after Claude Code's subagents in `.claude/agents/`. Under Codex, the same roles take the sessions and models in `~/.codex/AGENTS.md`: `implementor` is the ticket session, `implementor-pro` the escalation session, and each `reviewer` a fresh Standards or Spec reviewer.

## Test-first

The implementer is the `/implement` session itself, or an implementer subagent under `/implement-spec`. It builds with the `tdd` skill, and two rules here settle what that skill leaves open:

- **Seams.** Test at the seams the spec and the ticket name (and, for server behaviour, the typed receipts in AGENTS.md "Verifying"). `/to-spec` agreed them with the user, which settles `tdd`'s step of confirming seams. A seam nobody named goes in the report's Concerns.
- **Red.** Run each test and see it go **red** before the code it covers exists. Note its failure line as you go: the report quotes it.

## The implementer's report

The implementer's final message, in these sections, each with "none" when empty:

1. **Criteria.** One row per acceptance criterion in the ticket:

   | Criterion | Test (`file` › name) | Red: the failure line seen | Green: the change that made it pass |
   | --------- | -------------------- | -------------------------- | ----------------------------------- |

2. **Not test-first.** Code built without a red test before it (config, styling, glue), and why.
3. **Tests edited to pass.** Each test changed after its code existed, and why the test was wrong rather than the code, citing the ticket or spec line that says so.
4. **Concerns.** Anything in the ticket, the spec or the code that looked wrong, risky or unclear, and any seam nobody named.
5. **Findings.** From the second review on: each reviewer finding, marked fixed, deferred or disputed, with the reason.
6. **Checks.** The commits, then the summary line of each command under **Checks** below (for example `Tests 535 passed (535)`).

## Checks

The checks are the targeted ones in `docs/operations/development.md` "Checks": tests for the files you touched, lint for the files you changed, typecheck for each package you changed. The implementer runs them at the end of every round, and the Spec reviewer reruns them. CI owns the full suite (AGENTS.md "Verifying").

## Review

`/code-review` runs two `reviewer` subagents on the branch's diff, one per axis, with the ticket as the spec; every re-review runs both axes again. Give the Spec reviewer the implementer's report as well: it checks the report's claims instead of taking them on trust. Each reviewer ends on **Pass** or **Fail** and sorts its findings into Must fix, Concerns and Out of scope; `.claude/agents/reviewer.md` holds the format and what counts as Must fix.

- **Must fix** blocks: the work is reviewed again once each one is fixed.
- **The branch holds still** while a reviewer runs: edits wait until both verdicts are in.
- **After the final Pass**, each further change to the branch (a Concern's fix, or a merge that resolves conflicts or edits a test) gets a **delta review** before the PR merges: both axes on `git diff <passing commit>..HEAD`, with that commit as the base. A merge with no conflicts and no test edits needs only the checks. A Concern left unfixed stays in the PR's Concerns.
- **Out of scope** findings each become an issue labelled `needs-triage`.
- **The evidence goes on the PR:** the final report and both final reviews, so the user can see what was checked.

## `/implement`: one ticket, one session

The session is the implementer. It runs on the model and effort the user chose and builds its one ticket itself, writing the report before `/code-review`. After the review it fixes each Must fix, fixes or answers each Concern, marks every finding in the report's Findings section, and runs `/code-review` again while a Must fix remains. A third Fail goes to the user, with what keeps failing and the fix it recommends. The final report and reviews go in the PR description. Implementer subagents (`implementor`, `implementor-pro`) belong to `/implement-spec` sessions.

## `/implement-spec`: a whole spec

The session is the **orchestrator**. It follows `/implement-spec` and dispatches every ticket on the frontier to an implementer subagent, each with `isolation: "worktree"` for its own worktree and branch, while the orchestrator itself writes no ticket code.

### Rounds

A **round** is one implementation attempt, then the review above. A round **passes** when both reviewers return **Pass**. Concerns wait for `/implement-spec`'s final `/code-review` of the whole branch.

A passing ticket merges into the PR branch, its final report and reviews go on the PR as one comment, and the frontier moves on. A failing round leads to the next:

| Round | Implementer                | Context                                                                                                      |
| ----- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1     | `implementor`              | fresh: the ticket and its pointers                                                                           |
| 2–3   | the same `implementor`     | kept: resume it with `SendMessage`, sending both reviews                                                     |
| 4     | `implementor-pro`          | fresh: the ticket, its branch, and a short account of rounds 1–3 (what was tried, what failed, the findings) |
| 5     | the same `implementor-pro` | kept                                                                                                         |

After a failed round 5 the ticket is **blocked**. Keep working the rest of the frontier, and tell the user, in plain words, what caused the failure and what fix you recommend, with a one-line trade-off. Tickets that depend on it wait with it.

The fix for the final `/code-review` is one more ticket, and gets the same rounds.
