# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. Two owners write it: upstream (`pingdotgg/t3code`) and this fork.

## Before exploring, read these

- **`docs/internals/glossary.md`**: upstream's glossary, the shared vocabulary for the whole codebase.
- **`docs/internals/`**: upstream's architectural decisions and cross-component constraints. Read the pages that touch the area you're about to work in (`overview.md` first when the area is new to you).
- **`CONTEXT.md`** at the repo root: the fork's own terms, for concepts that exist only in this fork.
- **`docs/adr/`**: the fork's own decisions. Read ADRs that touch the area you're about to work in.

If `CONTEXT.md` or `docs/adr/` don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Who writes where

Upstream's files are read-only in this fork, so upstream syncs merge cleanly. A new fork term goes in `CONTEXT.md`, and a new fork decision is a new ADR in `docs/adr/`, even when it refines an upstream page.

```
/
├── CONTEXT.md                 ← fork terms
├── docs/adr/                  ← fork decisions
│   └── 0001-<decision>.md
└── docs/internals/            ← upstream, read-only
    ├── glossary.md
    └── overview.md, providers.md, …
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/internals/glossary.md` or `CONTEXT.md`. Don't drift to synonyms the glossaries explicitly avoid.

If the concept you need isn't in either glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`, which records it in `CONTEXT.md`).

## Flag decision conflicts

If your output contradicts a fork ADR or an upstream `docs/internals/` page, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (…), but worth reopening because…_
