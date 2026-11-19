/**
 * Trusted Source Store — ONE global switch: "trust external tools by default".
 *
 * 2026-09-02 history (two rounds of user feedback, then a deliberate
 * simplification):
 * 1. Per-call approval prompts for already-authorized sources (WebMCP pages
 *    enabled in the extension popup, hand-entered MCP servers) were annoying.
 * 2. A per-source "always trust" list was added, then a global default-trust
 *    switch — but combining them (default + per-source overrides) made the
 *    per-site switch confusing ("the per-site trust toggle just doesn't work anymore").
 * 3. Final model: ONLY the global switch. When ON (the default), tools from
 *    every discovered MCP server / WebMCP page run without the approval
 *    modal in plan AND act mode. When OFF, every call prompts again.
 *
 * Hard invariant kept across every iteration: authorization is driven by the
 * CALL's side effects only — `untrustedContentHint` is deliberately NOT a
 * trust criterion here. It describes the tool's RETURN channel, which is
 * handled by output isolation (wrapUntrustedContent), the tool-catalog
 * untrusted-content warning (injected into the model's tool list), and the
 * downstream write gates (sync-to-disk/exec/page-write keep their own human
 * approval). Forbidden tools are still denied first (enforced in
 * policy-engine). Only settings UI mutates this store; the LLM has no tool
 * that touches it.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ToolSourceKind = 'webmcp' | 'mcp'

interface TrustedSourceState {
  /**
   * Trust every discovered external source without per-call approval
   * prompts. ON by default (2026-09-02 user decision).
   */
  defaultTrustExternal: boolean

  setDefaultTrustExternal: (on: boolean) => void
}

export const useTrustedSourceStore = create<TrustedSourceState>()(
  persist(
    (set) => ({
      defaultTrustExternal: true,

      setDefaultTrustExternal: (on) => set({ defaultTrustExternal: on }),
    }),
    {
      name: 'creatorweave-trusted-source-store',
      // Only the global switch is meaningful now. Older releases persisted a
      // per-source list — partialize keeps that stale data out of storage.
      partialize: (state) => ({ defaultTrustExternal: state.defaultTrustExternal }),
    }
  )
)

/**
 * Engine-facing read: is this tool's origin trusted?
 *
 * `kind` / `sourceId` identify the origin (WebMCP hostname / MCP serverId).
 * They are part of the signature so the call sites in external-tool-bridge
 * stay future-proof, but under the global-only model the origin itself does
 * not affect the answer.
 *
 * Deliberately NOT consulted here: `untrustedContentHint`. It is a RETURN-
 * channel signal (content may contain prompt injection), not a call-side
 * side-effect signal — gating the call on it neither reduced injection risk
 * (approving still delivered the content to the model) nor stayed usable
 * (denying made the tool permanently unusable). Untrusted RETURN values are
 * contained by output isolation + the downstream write gates instead.
 */
export function isToolSourceTrusted(
  _kind: ToolSourceKind,
  _sourceId: string | null | undefined
): boolean {
  return useTrustedSourceStore.getState().defaultTrustExternal
}
