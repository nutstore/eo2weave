# Good First Issues — March 2027 batch plan (working notes)

> Working document for maintaining a steady supply of `good first issue` entries.
> Keep private or move to a private repo if shared; contains internal conventions.

## Candidate sources (scanned 2026-11-27, main @ f98327d3)

| Source | Count | Typical issue |
|---|---|---|
| `console.log` ungated in production paths | ~45 in `web/components` + `web/hooks` | Guard behind `import.meta.env.DEV` / a debug flag |
| `formatBytes` used across 31 files with no unit tests on the formatter itself | 1 formatter + 31 call sites | Add unit tests + edge cases (0, negative, PB+) |
| Hardcoded user-facing strings not in i18n | recurring (past batch #12/#13 pattern) | Extract to locale keys, all four locales |
| Small UX gaps found during dogfooding | 1-2 per release | e.g. keyboard shortcut missing, focus trap |

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
- Every issue: `good first issue` + `help wanted` labels, exact file paths, a verification command.
- Only tasks doable without deep architecture knowledge: pure functions, i18n extraction, log gating, small UI affordances.
- When a batch member is claimed (PR opened), refill from the candidate list within the same week.
- Never include refactors that touch store/persist core — those are maintainer-only.

## History

- Batch 1 (#9-#18, 10 issues): all closed. Pattern worked; supply stopped after batch 1.
