# Unified packages search implementation plan

> **For agentic workers:** Use superpowers:executing-plans for the local implementation and explicit reviewer feedback for verification.

**Goal:** Search all package sources without repeating catalog requests or rebuilding rows.

**Architecture:** Add a page-owned DOM search controller. Pass its optional row-registration API to the existing section builders. Preserve all current package operations and source counts; show filtered counts next to search.

**Tech Stack:** TypeScript, native DOM, chrome.i18n, Vitest/happy-dom, WXT.

- [x] Write failing functional tests for the search controller and section integration, including asynchronous registry previews and 200-package row preservation.
- [x] Add `browser-extension/entrypoints/packages/package-search.ts`: register/update row text, apply a trimmed case-insensitive query, clear/Escape handling, coalesced matched/total feedback, detached row cleanup.
- [x] Wire optional search registration into `shared.ts`, `builtin-section.ts`, `mine-section.ts`, and `registry-section.ts`. Include every tool name and orphan package IDs.
- [x] Add the search input, clear button, and status to `index.html`; initialize localized UI and the search controller in `main.ts`. Keep existing layout and make hidden rows override flex display.
- [x] Add matching English/Chinese extension locale keys and verify parity.
- [x] Run extension packages/locale tests and extension/web typechecks. Review the diff, address findings, and run only affected checks again when changes require them.
- [x] Run sequential production/development builds in an isolated temporary copy so the active WXT server never shares their output directory. Smoke-test unified search and the real extension's background/bridge; leave changes available for user review.

Validation: 46 extension package/locale tests passed; extension and web typechecks passed; isolated production/development builds passed. Both builds passed the 203-row browser search smoke test. Chromium and Helium loaded the development build, injected nativeHostCall, and completed a bridge version request without errors. The active WXT server regenerated the loaded development HTML and locale catalogs after its own config restart.
