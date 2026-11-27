# Unified packages search

The user selected unified search across built-in, registry, and authored packages.

- Place one search input above the source summary, with an accessible name, a clear button, and a live result count.
- Match package ID, description, and every available tool name using a case-insensitive substring. Trim surrounding whitespace. Missing manifests still allow searching by directory/ID.
- Filter existing rows in place. Typing must neither reload data nor rebuild package rows. Keep registry administration controls available.
- Index tool names beyond the six displayed chips. Re-evaluate a row when its tool preview arrives. Preserve the input and filtering across data reloads and package operations.
- Show matched/total counts while searching, and an explicit no-results message. Clearing or Escape restores every package.
- Use the extension's existing English and Chinese locale catalogs; the web application's four locale catalogs already contain their own search strings and need no changes.

Implementation: a page-owned search controller tracks searchable text for each row. Sections register managed, registry, and orphan rows; preview completion updates only its own row. Coalesce count updates and discard detached rows after rendering.

Verification: functional DOM tests cover unified matching, hidden tool names, asynchronous previews, reloads, clear/no-results behavior, no extra requests, and stable row identity. Run extension packages tests, locale checks, both typechecks, sequential builds without an active WXT watcher, and actual extension/bridge smoke checks.
