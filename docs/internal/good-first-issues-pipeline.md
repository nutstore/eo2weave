# Good First Issues — March 2027 batch plan (working notes)

> Working document for maintaining a steady supply of `good first issue` entries.
> Published in the repository on purpose: the conventions below are process, not
> secrets. Keep it that way — never add anything here that cannot be public.

## Candidate sources (scanned 2026-11-27 on main @ f98327d3; the log-gating counts re-verified on 3f5ffae3)

| Source | Count | Typical issue |
|---|---|---|
| `console.log` ungated in production paths | 25 ungated calls across 4 files in `web/components` + `web/hooks` (split as #374 + #377) | Guard behind `process.env.NODE_ENV !== 'production'` — **not** `import.meta.env.DEV` (see note below) |
| Hardcoded user-facing strings not in i18n | recurring (past batch #12/#13 pattern) | Extract to locale keys, all four locales |
| Small UX gaps found during dogfooding | 1-2 per release | e.g. keyboard shortcut missing, focus trap |

Guarding debug logging in `web/`: the app is Next.js 15 (`web/package.json`), so the guard is `process.env.NODE_ENV !== 'production'`. **`import.meta.env` is Vite-only and does not exist here** — `web/` uses `import.meta.url` for worker URLs and `import.meta.hot` in the SQLite module, but never `import.meta.env`, so that guard would hit `undefined.DEV` at runtime. Working precedent: `web/components/settings/ProviderManager.tsx:1780`.

Counts exclude, on purpose:

- `web/components/code-viewer/*` — those occurrences are text inside sample-code template strings and never execute.
- `web/components/settings/ProviderManager.tsx` — its single call is already inside a `process.env.NODE_ENV` guard (L1780).
- `web/components/workspace/command-palette-commands.tsx` — 10 stubs inside `createDefaultHandlers`, which no module imports (`git grep -n createDefaultHandlers -- web` matches only its own definition), so they never run. Removing the dead export is a separate cleanup, not log gating.

A raw count over the TypeScript sources (`grep -ro "console\.log" web/components web/hooks --include='*.ts' --include='*.tsx' | wc -l`) returns **45**: 25 live ungated calls (the number above), 11 in already-guarded or never-executed code, and 9 code-viewer sample strings. Dropping the `--include` filters adds 6 matches from the `code-viewer/*.md` example docs (51 total), none of which execute.

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
- **Verified counts only.** Before listing a file as an ungated-log candidate, confirm the calls actually execute — `git grep -n "<enclosing symbol>" -- web` for callers — and that no `process.env.NODE_ENV` guard already sits above them. A dead export or an already-guarded call inflates a raw `grep -c` and produces busywork tasks.
- **Scope acceptance greps to the module under change.** A tree-wide `grep -rn "<name>" web/` also matches deliberately separate local implementations (`formatSize` has three) and the test file; the criterion must name the import path or the exact files.
- Only tasks doable without deep architecture knowledge: pure functions, i18n extraction, log gating, small UI affordances.
- When a batch member is claimed (PR opened), refill from the candidate list within the same week.
- Never include refactors that touch store/persist core — those are maintainer-only.

## History

- Batch 1 (#9-#18, 10 issues): all closed. Pattern worked; supply stopped after batch 1.
