/**
 * Sync-to-Disk Tool — agent-initiated flush of pending OPFS changes to the
 * real disk, through the full authorization chain.
 *
 * This is the SAFE counterpart to what exec's auto-flush used to do silently
 * (removed in this PR — see exec.tool.ts): writing to the real disk is a
 * risk-bearing operation, so it must prompt via the policy engine.
 *
 * Guarantees (redesign doc §3.6, as amended by the "authorized deletions"
 * follow-up):
 *   - Policy level 'prompt' → ToolAuthModal every time unless the user picked
 *     "Always allow for this conversation". A flush that includes delete-type
 *     changes uses a DELETION-SPECIFIC description (lists the paths) and its
 *     own memory key (`sync-to-disk:delete`), so a plain write grant can
 *     never silently cover deletions — the modal IS the informed consent,
 *     and the user's approval is honored: deletions ARE applied.
 *   - forceOverwrite is FORCED to false and not exposed to the LLM; conflicting
 *     paths are skipped per-file and reported (second line of defense,
 *     independent from the modal).
 *   - Only this AUTHORIZED channel may apply delete-type changes. Unattended
 *     paths (run-level auto-apply) still exclude them (see
 *     pending-disk-eligibility.ts for the fork).
 *   - Snapshot pipeline is reused (createApprovedSnapshotForPaths → syncToDisk
 *     → markSnapshotAsSynced) so synced — and deleted — files stay
 *     rollback-able (the snapshot captures deleted files' before-content).
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import type { WorkspaceRuntime } from '@/opfs/workspace/workspace-runtime'
import { toolErrorJson, toolOkJson } from './tool-envelope'
import { authorize } from '../policy-engine'
import { partitionPathsByDiskEligibility } from '@/opfs/workspace/pending-disk-eligibility'
import { useConversationContextStore } from '@/store/conversation-context.store'

const TOOL_NAME = 'sync-to-disk'

/**
 * Cap on the structured file-change list sent to the authorization modal.
 * PendingChange objects are lightweight (no content), but a flush with
 * thousands of entries would bloat the modal payload for little UX gain —
 * the modal itself only renders the first 50 rows anyway.
 */
const AUTH_FILE_CHANGES_LIMIT = 200

export const syncToDiskDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description:
      'Write your pending changes (from write/edit/delete tools) to the real disk so that subsequent ' +
      'shell commands can see them. Use this when a command result depends on the latest file ' +
      'content. Requires user approval each time unless the user grants "always allow" for this ' +
      'conversation. PENDING DELETIONS ARE INCLUDED: the approval modal will explicitly list the ' +
      'files to be deleted (irreversible on disk, rollback-able via snapshots), and deletions use ' +
      'a separate "always allow" grant from regular writes. Never overwrites conflicting disk files. ' +
      'When the conversation applies changes manually ("manual apply" policy), every call asks the ' +
      'user — YOLO does not cover this tool in that mode; expect the changes to stay pending and ' +
      'tell the user to apply them if they prefer.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description:
            'Pending change paths to sync (defaults to ALL pending changes, including pending ' +
            'deletions). ' +
            'Examples: ["src/app.ts"] or ["creatorweave/src/a.ts", "creatorweave/src/b.ts"]. ' +
            'Multi-root paths include the root name prefix.',
          items: { type: 'string' },
        },
        summary: {
          type: 'string',
          description:
            'Short human-readable note about WHAT this sync delivers (e.g. "fix homepage ' +
            'redirect"). Appended to the snapshot title shown in the snapshot list, after the ' +
            'mechanical "sync-to-disk (N files)" prefix. Keep it under ~100 characters. ' +
            'Omit only when there is genuinely nothing meaningful to say.',
        },
      },
    },
  },
}

interface SyncToDiskOutcome {
  synced: string[]
  skippedConflicts: string[]
  failed: number
  excludedDeletions: Array<{ path: string; type: 'delete' | 'unknown' }>
  /** Paths in `synced` whose pending change was a deletion (authorized channel only). */
  appliedDeletions: string[]
  snapshotId?: string
}

/**
 * Shared flush implementation (also used by exec's post-execution hint path —
 * actually NOT: exec no longer flushes; this helper is exclusive to this tool).
 * Mirrors the snapshot pipeline of autoApplyCompletedRunChanges.
 */
async function flushPendingToDisk(
  runtime: WorkspaceRuntime,
  requestedPaths: string[] | undefined,
  includeDeletions: boolean,
  summary?: string,
): Promise<SyncToDiskOutcome> {
  const outcome: SyncToDiskOutcome = {
    synced: [],
    skippedConflicts: [],
    failed: 0,
    excludedDeletions: [],
    appliedDeletions: [],
  }

  // Filter the requested paths (or all pending) to the disk-eligible set
  // BEFORE passing onlyPaths to syncToDisk (§3.9 constraint 8). On this
  // authorized channel deletions pass through when the user approved a flush
  // containing them; the shared eligibility rule (pending-disk-eligibility.ts)
  // keeps run-level auto-apply deletion-free.
  const requestedSet = requestedPaths?.length ? new Set(requestedPaths) : null
  const allPending = runtime.getPendingChanges()
  const candidatePaths = requestedSet
    ? allPending.filter((c) => requestedSet.has(c.path)).map((c) => c.path)
    : allPending.map((c) => c.path)
  const { eligible, excluded } = partitionPathsByDiskEligibility(
    candidatePaths,
    allPending,
    { includeDeletions },
  )
  for (const e of excluded) {
    // Report deletions always; report not-pending paths only when the caller
    // explicitly asked for them (unrequested extras are just noise).
    if (e.reason === 'delete' || requestedSet?.has(e.path)) {
      outcome.excludedDeletions.push({
        path: e.path,
        type: e.reason === 'delete' ? 'delete' : 'unknown',
      })
    }
  }

  if (eligible.length === 0) {
    return outcome
  }

  // Snapshot FIRST (before/after contents for diff + rollback), mirroring
  // autoApplyCompletedRunChanges.
  //
  // Snapshot title: keep the predictable "sync-to-disk (N files)" prefix — it
  // is the mechanism marker that makes sync-created snapshots recognizable
  // and grep-able in the list (repo-level fallback would otherwise be the
  // generic "Saved N file modifications"). The optional AI summary is APPENDED
  // (not substituted) so the title also says WHAT the sync delivers. Clamped
  // to a sane length; whitespace-only input degrades to the bare prefix.
  const titlePrefix = `sync-to-disk (${eligible.length} file${eligible.length === 1 ? '' : 's'})`
  const trimmedSummary = summary?.trim().slice(0, 160)
  const snapshot = await runtime.createApprovedSnapshotForPaths(
    eligible,
    trimmedSummary ? `${titlePrefix}: ${trimmedSummary}` : titlePrefix,
    null,
    null,
  )

  // Tool layer FORCES forceOverwrite: false — the parameter is not exposed.
  const result = await runtime.syncToDisk(null, eligible, false)

  if (result.conflicts.length > 0) {
    // Per-file conflicts are skipped (workspace-pending.ts semantics); the
    // snapshot remains as a record but conflicting files stay pending for the
    // manual review flow.
    outcome.skippedConflicts = result.conflicts.map((c) => c.path)
  }
  if (result.failed > 0) {
    outcome.failed = result.failed
  }
  const conflictSet = new Set(outcome.skippedConflicts)
  outcome.synced = eligible.filter((p) => !conflictSet.has(p))

  // Deletions that actually reached the disk on this authorized flush.
  const pendingByPath = new Map(allPending.map((c) => [c.path, c]))
  outcome.appliedDeletions = outcome.synced.filter(
    (p) => pendingByPath.get(p)?.type === 'delete',
  )

  if (snapshot && outcome.synced.length > 0) {
    await runtime.markSnapshotAsSynced(snapshot.snapshotId)
  }
  outcome.snapshotId = snapshot?.snapshotId
  return outcome
}

export const syncToDiskExecutor: ToolExecutor = async (args, context) => {
  const requestedPaths = Array.isArray(args.paths)
    ? (args.paths as unknown[]).map((p) => String(p ?? '').trim()).filter(Boolean)
    : undefined

  // Resolve workspace runtime (same pattern as sync-opfs).
  let runtime: WorkspaceRuntime | null = null
  try {
    if (context.workspaceId) {
      const { getWorkspaceManager } = await import('@/opfs')
      const manager = await getWorkspaceManager()
      runtime = (await manager.getWorkspace(context.workspaceId)) ?? null
    }
  } catch {
    runtime = null
  }
  if (!runtime) {
    return toolErrorJson(
      TOOL_NAME,
      'no_workspace',
      'No active workspace available for sync-to-disk.',
      {
        // Redesign §3.6: guide the agent toward the user-side recovery flow
        // instead of a dead end — directory access is granted by the USER.
        hint:
          'No directory is authorized for this conversation yet. Ask the user to authorize a ' +
          'local folder for this conversation first (folder authorization happens through the ' +
          'directory access prompt), then retry sync-to-disk.',
      },
    )
  }

  // Pre-compute scope for the authorization modal BEFORE prompting.
  const pending = runtime.getPendingChanges()
  const requestedSet = requestedPaths?.length ? new Set(requestedPaths) : null
  const eligibleCount = pending.filter(
    (c) =>
      (c.type === 'create' || c.type === 'modify') &&
      (!requestedSet || requestedSet.has(c.path)),
  ).length
  const deletionPaths = pending
    .filter((c) => c.type === 'delete' && (!requestedSet || requestedSet.has(c.path)))
    .map((c) => c.path)

  if (eligibleCount === 0 && deletionPaths.length === 0 && pending.length === 0) {
    return toolOkJson(TOOL_NAME, {
      synced: [],
      message: 'No pending changes to sync.',
    })
  }

  // --- Authorization (prompt level). Regular writes and deletions use
  // DIFFERENT memory keys and descriptions: the modal for a deletion-bearing
  // flush explicitly lists the doomed paths, and "always allow" for writes
  // never covers deletions (and vice versa) — each grant is informed.
  //
  // "手动应用变更" (per-workspace auto-apply OFF) is a promise the user made to
  // themselves: THEY apply pending changes. A mid-run flush must therefore
  // stay interactive — no YOLO, no standing "always allow" grant, no
  // trusted-source shortcut (policy-engine's manual-apply gate). Read the
  // policy for THIS conversation here (workspaceId === conversation id) so a
  // run in another workspace cannot alter this decision; if the preferences
  // are unavailable, fall back to the strict reading (always ask).
  let manualApply = true
  try {
    const { isManualApplyPolicy } = await import('@/store/workspace-preferences.store')
    manualApply = isManualApplyPolicy(context.workspaceId)
  } catch (error) {
    // Strict fallback, but never silent: a broken module graph would otherwise
    // degrade every flush to "always ask" with no trace explaining why.
    console.warn('[sync-to-disk] manual-apply policy unavailable; requiring approval:', error)
    manualApply = true
  }
  const includeDeletions = deletionPaths.length > 0
  // Structured list for the modal: every eligible change (create/modify AND
  // delete) mapped to FileChange shape so ToolAuthModal can render a
  // clickable list (click → diff preview). FileChange.type uses 'add' for
  // creations; PendingChange.type uses 'create'.
  const eligibleFileChanges = pending
    .filter((c) => !requestedSet || requestedSet.has(c.path))
    .slice(0, AUTH_FILE_CHANGES_LIMIT)
    .map((c) => ({
      type: (c.type === 'create' ? 'add' : c.type) as 'add' | 'modify' | 'delete',
      path: c.path,
      deleteMode: c.deleteMode,
    }))
  const auth = await authorize({
    toolName: TOOL_NAME,
    args: { count: eligibleCount, deletes: deletionPaths },
    fileChanges: eligibleFileChanges,
    conversationId: context.workspaceId,
    signal: context.abortSignal,
    manualApply,
  })
  if (auth.decision === 'deny') {
    return toolErrorJson(TOOL_NAME, 'AUTH_DENIED_BY_USER', auth.reason, {
      retryable: false,
      // Under the manual-apply policy the denial is not a hiccup: the user owns
      // the apply step, so point the agent at the real next action instead of
      // letting it retry the same flush.
      hint: manualApply
        ? 'This conversation applies changes manually: the pending changes stay in the review panel for the user to apply. Do not retry the flush; continue with work that does not depend on disk state, or tell the user which files are waiting to be applied.'
        : undefined,
    })
  }
  // Stale-approval guard (executor layer).
  if (context.abortSignal?.aborted) {
    return toolErrorJson(
      TOOL_NAME,
      'AUTH_STALE_APPROVAL',
      'Approval arrived after the run was aborted; not syncing.',
      { retryable: false },
    )
  }

  try {
    const outcome = await flushPendingToDisk(
      runtime,
      requestedPaths?.length ? requestedPaths : undefined,
      includeDeletions,
      typeof args.summary === 'string' ? args.summary : undefined,
    )

    // Refresh the change-review panel (left-side pending list) so synced
    // files disappear immediately — otherwise the UI keeps showing stale
    // entries until some other action triggers a refresh.
    try {
      await useConversationContextStore.getState().refreshPendingChanges(true)
    } catch {
      // Non-fatal: the next refresh cycle will reconcile the list.
    }

    const deletedPending = outcome.excludedDeletions.filter((e) => e.type === 'delete')
    const hints: string[] = []
    if (outcome.appliedDeletions.length > 0) {
      hints.push(
        `${outcome.appliedDeletions.length} deletion(s) were applied to the real disk as part of ` +
          `this authorized sync: ${outcome.appliedDeletions.join(', ')}`,
      )
    }
    if (deletedPending.length > 0) {
      hints.push(
        `${deletedPending.length} delete-type change(s) were NOT synced — deletions require the ` +
          `user's explicit approval of a deletion-bearing flush: ${deletedPending.map((d) => d.path).join(', ')}`,
      )
    }
    if (outcome.skippedConflicts.length > 0) {
      hints.push(
        `${outcome.skippedConflicts.length} path(s) skipped — the disk version changed since the ` +
          `baseline (no force overwrite): ${outcome.skippedConflicts.join(', ')}`,
      )
    }
    if (outcome.failed > 0) {
      hints.push(`${outcome.failed} path(s) failed to write.`)
    }

    return toolOkJson(
      TOOL_NAME,
      {
        synced: outcome.synced,
        synced_count: outcome.synced.length,
        skipped_conflicts: outcome.skippedConflicts,
        excluded_deletions: deletedPending.map((d) => d.path),
        applied_deletions: outcome.appliedDeletions,
        snapshot_id: outcome.snapshotId,
      },
      // Success envelopes have no hint field — advisory notes ride in meta
      // so the LLM still sees the deletions/conflicts explanation.
      { meta: hints.length > 0 ? { hint: hints.join(' ') } : undefined },
    )
  } catch (err) {
    return toolErrorJson(
      TOOL_NAME,
      'sync_failed',
      `Failed to sync pending changes to disk: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true },
    )
  }
}

export const syncToDiskPromptDoc: ToolPromptDoc = {
  category: 'file-ops',
  section: '### File Sync (OPFS → disk)',
  lines: [
    '- `sync-to-disk(paths?, summary?)` - Write your pending changes to the real disk (requires user approval each time unless remembered). Use BEFORE running a shell command whose result depends on the latest file content. Includes pending DELETIONS: the approval modal lists the files to be deleted, and approving applies them (rollback-able via snapshots). Deletions carry their own "always allow" grant, separate from regular writes. Never overwrites conflicting disk files. ALWAYS pass `summary` with a short note about what the changes deliver (e.g. "fix homepage redirect") — it becomes the snapshot title users see in the snapshot list. When the user applies changes manually (the default), every call asks again even in YOLO mode — if the user declines, leave the changes pending.',
  ],
}
