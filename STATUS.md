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

---

## 4. References

- Native Host extension IDs: `kdnnhmagmghdhfinoipgbcddnpmffbkp` (unpacked/dev),
  `canpcddlognjbengiodekfbbfnjafeml` (Chrome Web Store listing)
- Native host name: `com.creatorweave.nativehost`
- First POC: `experiment-native-host-e3d2221.patch`
- Config files: `~/.creatorweave/native-host-scopes.json`,
  `execpolicy.json`, `processes.json`, `logs/{id}.log`
