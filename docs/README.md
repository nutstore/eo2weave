# Project Documentation Index

This directory is the documentation source of truth for the repository, organized by language:

- `docs/zh/` — Chinese docs (user + developer)
- `docs/en/` — English docs (user + developer)

Each language has two categories served by the docs center:

- `user/` — product usage guides
- `developer/` — developer guides (guides / architecture / reference)

Internal-only docs (design specs, requirements, product ideas) are not part of this public repository.

Note: completed feature PRDs / plans / migration designs are removed from the repo once shipped; consult git history (`git log -- docs/`) if needed.

## Recommended Reading Paths

- New users:
  - `docs/zh/user/getting-started.md` / `docs/en/user/getting-started.md`
- New contributors:
  - `docs/zh/developer/guides/quick-start.md` (中文)
  - `docs/en/developer/quick-start.md` (English)
  - `docs/zh/developer/architecture/index.md`

## Maintenance Rules

- Source of truth is `docs/`.
- The web app docs center renders `docs/` directly — the App Router docs route
  reads this directory server-side at build time (`web/lib/docs-server.ts`).
- There is no synced copy anymore (`web/public/docs/` was removed). Edits are
  visible in `next dev` immediately and require no sync step.
- Only `user/` and `developer/` are published; anything else in `docs/`
  (design notes, README) is not reachable from the docs center.
- Every docs-center page needs YAML frontmatter (`title`, `order`) for sidebar ordering.
