# Good First Issues — March 2027 batch plan (working notes)

> Working document for maintaining a steady supply of `good first issue` entries.
> Published in the repository on purpose: the conventions below are process, not
> secrets. Keep it that way — never add anything here that cannot be public.

## Candidate sources (scanned 2026-11-27, main @ f98327d3)

| Source | Count | Typical issue |
|---|---|---|
| `console.log` ungated in production paths | 36 executable calls across 6 files in `web/components` + `web/hooks` | Guard behind `import.meta.env.DEV` / a debug flag |
| Hardcoded user-facing strings not in i18n | recurring (past batch #12/#13 pattern) | Extract to locale keys, all four locales |
| Small UX gaps found during dogfooding | 1-2 per release | e.g. keyboard shortcut missing, focus trap |

Counts exclude `console.log` occurrences that live inside code-viewer sample strings (`web/components/code-viewer/*`) — they never execute. A raw `grep -c` therefore reads higher than the number above.

Not a candidate: "unify the size formatters". `formatBytes`/`formatSize` in `web/lib/utils.ts` already have unit tests (`web/lib/utils.test.ts`, since #119), and the three local variants (`web/storage/diagnostics.ts`, `web/components/sync/FileDiffViewer.tsx`, `web/skills/skill-resources.ts`) are deliberately different — see the #14 note in `skill-resources.ts`.

## Template (match the style of the closed batch #9-#18)

```markdown
### Why
<one sentence: what is wrong / missing>

### What
<concrete change, files named>

### Acceptance
- [ ] <verifiable criterion>
- [ ] <criterion>

### Files
- `path/to/file.ts`

### Verification
`cd web && pnpm vitest run <relevant file>` — <expected>
```

## Rules

- Batch size: 3-5 open at a time. Never more — an empty backlog reads worse than a full one.
- Labels: every beginner task carries `good first issue` **and** `help wanted` (`good first issue` is GitHub's beginner subset of `help wanted`). Larger-scope tasks carry `help wanted` alone — that is what makes the README's second pool a real step up rather than the same list again.
- Every issue: exact file paths and a verification command, whatever its labels.
- Only tasks doable without deep architecture knowledge: pure functions, i18n extraction, log gating, small UI affordances.
- When a batch member is claimed (PR opened), refill from the candidate list within the same week.
- Never include refactors that touch store/persist core — those are maintainer-only.

## History

- Batch 1 (#9-#18, 10 issues): all closed. Pattern worked; supply stopped after batch 1.
