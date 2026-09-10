# Project Status

> One-page operational status. Architecture / design decisions / historical bugs
> live in code comments and git history — this file is **what's done vs. what's
> pending**.

---

## 1. Status snapshot

| Area | State |
|---|---|
| Disk executor (FSAccess + Native Host + Composite, chunked NM protocol) | ✅ Shipped |
| Authorization UI (Cable badge, scope management) | ✅ Shipped |
| Command execution (`exec_sync` + `ExecAuthModal` + `ExecPolicy`) | ✅ Shipped |
| Background processes (`exec_start` / `logs` / `status` / `stop`) + pre-exec auto-flush | ✅ Shipped |
| Installers: macOS zip (per-user), macOS pkg (system), Windows 7z SFX (per-user) | ✅ Shipped |
| Next.js App Router migration | ✅ Shipped (2026-08-26) |
| Agent Bridge (MCP) for external CLIs | ✅ Shipped (2026-08-21) |
| Conversation sharing (ticket #480096) | 🔵 Tracking — see §3 |

---

## 2. Roadmap (tiers — architectural, not flags)

| Tier | Scope | State |
|---|---|---|
| 1 | Pure file-I/O agent | ✅ Done |
| 1.5 | Controlled command execution (transparent + approval, no fake sandbox) | ✅ Done |
| 2 | Sandboxed exec (Docker / Seatbelt / VM) | ❌ Future — independent design |
| 3 | Full coding agent (PTY + long-lived + file watching) | ❌ Future |

> Tier ≥2 must be built on OS-level isolation, never bolted onto the plain
> file-I/O native host.

---

## 3. Pending work

### Blocked on real hardware
- [ ] **Windows 真机 e2e** — pick_folder → 读写 → exec → exec_start/stop on an
      actual Windows machine. Code and 7z SFX installer are done; cross-compiled
      exe builds clean. Just need a real host.
- [ ] **CI: add Windows target** to the build matrix (`x86_64-pc-windows-gnu`
      or `-msvc`). Protect today's green Windows compile from regressing.

### Blocked on certificates / accounts
- [ ] **macOS Gatekeeper notarization** — unsigned `.pkg` recipients still get a
      "installing to system volume" nag. Per-user `.zip` route avoids this;
      pkg route waits on an Apple Developer account + notarization creds.
- [ ] **Windows Authenticode signing** — same tier as macOS notarization.

### Needs evaluation
- [ ] **Conversation sharing** (ticket #480096) — local-first product, no online
      share path exists today. Candidate directions:
  - [ ] Self-contained export (single HTML / zip with embedded images)
  - [ ] Temporary share link via cloud storage (Nutstore relay)
  - [ ] One-time-token backend (requires server-side storage + lifecycle/expiry)
  - [ ] Peer-to-peer encrypted share (one-time key)

### Known small follow-ups
- [ ] Dev-mode extension zip download needs a prior `pnpm run build` /
      `prepare:assets` (Vite-era on-demand middleware died with the migration);
      `wxt dev` load-unpacked remains the primary dev workflow.

### Fixed 2026-09-02
- [x] **Legacy mock drift in io.tool / changeset.tool tests** — both files
      predated the VfsBackend refactor (read → `resolveVfsTarget().backend.readFile`,
      changeset → `getWorkspaceManager().getWorkspace()`); rewritten against
      current contracts. Batch `reads`/`paths` params and `binary_base64`
      responses are gone — single-path only, binaries rejected with run_python
      hint. Agent suite now 64 files / 658 tests, zero failures.

### Fixed 2026-09-10
- [x] **generate_image exempted from Plan-mode gate** (PRD v1.4, R2.3) —
      reclassified `write` → `read` in `agent-mode.ts` with a
      planModeDescription limiting writes to OPFS assets (same precedent as
      run_python/bash). Plan mode can now generate images directly; pinned by
      `agent/__tests__/agent-mode.image-gen.test.ts` (also guards that real
      write tools stay gated).
- [x] **Prompt doc reinforced** (R2.2) — `imageGenPromptDoc` now instructs
      same-turn tool invocation on image intent, no clarifying questions for
      simple requests, context-driven aspect-ratio choice, and Plan/Act
      availability.
- [x] **Image-gen quick chip shipped** (PRD v1.3, R2.1) — input-area chip
      pre-fills a natural-language prompt; decision "strict hide" implemented:
      gate reuses `isImageGenAvailable()` (tool-registration source of truth)
      and fails closed on any store exception. Dismissal persisted via
      `imageGenChipDismissed` in workspace preferences. New
      `AgentRichInputHandle.setText()` for programmatic prefill; i18n keys in
      4 locales. Tests: chip gate/prefill/dismiss (3) + setText contract (2).
- [x] **`/image` slash command path removed** (image-generation PRD v1.2, R1) —
      image generation now runs solely through the Agent `generate_image` tool.
      Removed: `runImageGeneration` (+ interface declaration), the `/image`
      branches in `regenerateUserMessage` / `editAndResendUserMessage`, the
      `handleSlashCommand` image branch, the slash-command registry entry, and
      command-only i18n keys (4 locales). Legacy `msg.images` base64
      rendering / download / export kept read-only. Typing `/image` now yields
      a one-time migration hint that is sent as a normal message.
- [x] **Legacy ESLint errors 82 → 0** (`eslint --quiet` clean in `web/`).
      Typical fixes: empty catches annotated, targeted `no-constant-condition`
      disables with rationale, conditional hooks flattened, non-hook `use*`
      predicates renamed, `Function` types replaced with concrete signatures.
- [x] **Typecheck clean** (`tsc --noEmit`) + skills-domain tests 34/34.

> Remaining known test debt: `store/__tests__/skills.store.test.ts` (2 of 12
> fail) — the tests predate the OPFS-era skills store: they mock the
> SQLite-era `storage.toggleSkill` path (real impl now routes `source: 'user'`
> through the skill manager) and don't mock `writeUserSkillMd`. Pre-existing
> since the skills OPFS migration; not part of this pass.

---

## 4. References

- Native Host extension IDs: `kdnnhmagmghdhfinoipgbcddnpmffbkp` (unpacked/dev),
  `canpcddlognjbengiodekfbbfnjafeml` (Chrome Web Store listing)
- Native host name: `com.creatorweave.nativehost`
- First POC: `experiment-native-host-e3d2221.patch`
- Config files: `~/.creatorweave/native-host-scopes.json`,
  `execpolicy.json`, `processes.json`, `logs/{id}.log`
