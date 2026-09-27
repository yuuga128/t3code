# Skills the user starts

An agent can't call these skills: each has `disable-model-invocation: true`, so it runs only when the user types its command. When a step needs one, tell the user the command and, in one line, why it fits now. Read `~/.claude/skills/<name>/SKILL.md` first, so the recommendation matches what the skill does.

| When                                                     | Command                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| The user is unsure which flow fits                       | `/ask-matt`, a router over these skills                                   |
| A decision too big for one session                       | `/wayfinder`: a map of decision tickets, worked one per session           |
| A plan or design needs sharpening                        | `/grill-me`, or `/grill-with-docs` to also record ADRs and glossary terms |
| Decisions are made and the work is ready to build        | `/to-spec`, then `/to-tickets`, in a fresh session                        |
| One ticket to build                                      | `/implement`                                                              |
| A whole spec and its tickets to build                    | `/implement-spec`                                                         |
| Work moves to a new session                              | `/handoff` (see AGENTS.md, "This fork" › "Handoffs")                      |
| Work should continue in a background agent now           | `/claude-handoff`                                                         |
| Issues are piling up unsorted                            | `/triage`                                                                 |
| A research answer will drive a costly decision           | `/research-wave`, researchers then claim-verifiers                        |
| The code's module structure feels tangled                | `/improve-codebase-architecture`                                          |
| A session is over and there's something to learn from it | `/retro`                                                                  |
| The user wants a concept explained                       | `/teach`                                                                  |
| An agent's last message didn't land                      | `/wait-what`                                                              |
| A decision needs someone else's answers                  | `/to-questionnaire`                                                       |
