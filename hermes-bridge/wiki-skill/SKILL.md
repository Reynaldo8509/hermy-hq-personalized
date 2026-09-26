---
name: wiki
description: >
  Long-term memory wiki. Use this whenever you learn, decide, or are corrected on
  something durable that is too big or too detailed for MEMORY.md. Read from and
  write to ~/.hermes/wiki as your warm, git-tracked, never-forget memory.
version: 1.0.0
---

# Memory Wiki

`MEMORY.md` and `USER.md` are your tiny hot cache (~1,300 tokens total, always in
context). The **wiki** at `~/.hermes/wiki/` is your warm, unlimited, git-tracked
long-term memory. It is browsed and edited by the operator in Hermy HQ, so keep it clean.

## When to write to the wiki (not MEMORY.md)
- After any complex task (5+ tool calls): append a line to `log/YYYY-MM.md` and, if you
  learned something reusable, create/update a `lessons/` entry.
- When the operator makes a **decision** → a `decisions/` entry with the rationale + date.
- When you learn a durable fact about a **project, person, or the business** that is
  bigger than a one-liner → a `projects/`, `people/`, or `facts/` entry.
- When corrected ("no, do it this way") → update the relevant entry; **don't delete the
  old value — mark it `status: superseded`** and add the new fact. Preserve history.
- Keep MEMORY.md for only ~10-20 always-true, high-frequency facts, plus a pointer:
  `Full long-term memory at ~/.hermes/wiki — grep/read it before answering project questions.`

## Entry format (one markdown file per entry, YAML frontmatter + body)
```
---
id: proj-viralpen
type: project        # fact | preference | decision | event | project | contact | lesson | metric | note
title: ViralPen.ai SaaS
status: active       # active | superseded | archived
confidence: high     # high | medium | low
provenance: user-stated   # user-stated | observed | web | session:<id>
tags: [saas, billing]
links: [decision-pricing-99]
updated: 2026-07-23
---
Multi-tenant article studio at ~/viralpen. $99/mo. Twitter OAuth.
## Open loops
- [ ] Migrate billing to usage-based (see decision-pricing-99)
```
Files live under type folders: `projects/`, `people/`, `decisions/`, `lessons/`,
`facts/`, `log/`. Keep `INDEX.md` updated (one line per entry: `id · title · type · updated`).

## Retrieval (before answering)
1. `INDEX.md` is injected hot — scan it for the right entry id.
2. `search_files ~/.hermes/wiki "<term>"` or read the specific file with `read_file`.
3. If still unsure, `session_search` the conversation history (free, unlimited).
Only pull the 1-2 entries you actually need — don't load the whole wiki.

## Hygiene
- After writing, `git -C ~/.hermes/wiki add -A && git commit -m "wiki: <what changed>"`.
- Never destroy history — supersede, don't overwrite.
- The nightly `wiki-consolidate` cron merges duplicates, demotes stale entries, and
  rebuilds INDEX.md — keep entries small and single-purpose so it can.
