'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useProjectStore } from '@/store/project.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useConversationStore } from '@/store/conversation.store'
import { chatPath } from '@/lib/route-paths'

/** Bounded wait for switchWorkspace (see Step 2 below for why). */
const SWITCH_WAIT_TIMEOUT_MS = 30_000

/** Bounded wait for the host-project activation in Step 0 — same stall class
 * as switchWorkspace (setActiveProject can hang on OPFS/SQLite init without
 * rejecting), so it gets the same bound and the same recoverable redirect. */
const HOST_ACTIVATION_TIMEOUT_MS = SWITCH_WAIT_TIMEOUT_MS

/**
 * useWorkspaceRouteSyncStandalone — URL → store sync for /chats/:chatId.
 *
 * The standalone-chats sibling of useWorkspaceRouteSync: the workspace ↔
 * conversation 1:1 binding and the switchWorkspace/setActive choreography are
 * IDENTICAL — only the route shape differs (no :projectId segment, and the
 * not-found fallback is the chats home, not /projects).
 *
 * Deviations from the project version:
 * - Project context is ensured, not switched: workspace rows are NOT NULL
 *   project_id, so when the user lands directly on /chats (activeProjectId
 *   still empty — it is URL-driven), the first available project is bound
 *   silently as the workspace host. This never surfaces in the UI — the
 *   chats space shows no project semantics.
 * - A chatId that resolves to a non-direct conversation redirects to /chats
 *   (standalone chats never surface project conversations).
 *
 * Liveness model: `newestChatIdRef` tracks the newest route target the hook
 * has seen, assigned BEFORE the loading guards (so a route whose effect
 * early-returns still updates it) and blanked on cleanup (so a route left
 * entirely cannot be repaired toward). Every await inside the sync is
 * followed by a liveness re-check against that ref — a continuation whose
 * target was superseded mid-flight discards itself instead of committing.
 *
 * One exception to that blanking: `destinationChatIdRef` is retained across
 * cleanup and exists solely for the late host-activation repair (Step 0) —
 * a timed-out activation keeps running inside the store and its eventual
 * commit lands even after the route was left, so the destination's last
 * selection must stay recoverable.
 */
export function useWorkspaceRouteSyncStandalone(chatId: string) {
  const router = useRouter()
  const initialized = useProjectStore((s) => s.initialized)
  const projectLoading = useProjectStore((s) => s.isLoading)
  // Re-run when the conversation store finishes loading: a cold link to
  // /chats/:id can land before loadFromDB resolves, and without this
  // dependency the sync never retries (leaving the chat inactive).
  const conversationsLoaded = useConversationStore((s) => s.loaded)
  const newestChatIdRef = useRef<string>('')
  // Retained across cleanup (unlike newestChatIdRef): the late host-activation
  // repair (Step 0) must be able to re-assert the destination's selection even
  // after the route was left, because the timed-out activation still commits.
  const destinationChatIdRef = useRef<string>('')

  useEffect(() => {
    newestChatIdRef.current = chatId
    destinationChatIdRef.current = chatId
    if (!chatId) return
    if (!initialized || projectLoading) return

    /**
     * One full URL → store sync for `target`: ensure the project host,
     * validate the conversation, switch the workspace, activate the chat.
     * Used by BOTH the normal route run and the stale-completion repair, so
     * a repair activates the newest chat through exactly the same
     * workspace-switching path as normal route sync — never a bare
     * setActive that would leave the workspace and conversation stores
     * pointing at different chats.
     *
     * Liveness: after every await the target is re-checked against
     * `newestChatIdRef`; a superseded continuation stops touching stores.
     * The exception is the late host-activation repair (`retainTarget`),
     * which validates against `destinationChatIdRef` — retained across
     * cleanup — because its activation commits late inside the store even
     * after the route is left (see the Step 0 catch block).
     * Redirects fire only from the normal route run (`allowRedirect`) — the
     * repair never redirects, because its target may itself be superseded
     * and the newest route's own sync owns navigation.
     */
    const runSync = async (
      target: string,
      allowRedirect: boolean,
      retainTarget = false,
    ): Promise<void> => {
      const liveRef = () => (retainTarget ? destinationChatIdRef : newestChatIdRef)
      const isLive = () => liveRef().current === target

      // Step 0: ensure a project host exists. Landing on /chats directly
      // skips the /projects route sync, so activeProjectId may still be ''.
      const projectState = useProjectStore.getState()
      if (!projectState.activeProjectId) {
        const fallback =
          projectState.projects.find((p) => p.status !== 'archived') ?? projectState.projects[0]
        if (!fallback) {
          // Degenerate state (every project deleted): the chats home still
          // renders, but an individual chat has no workspace host.
          console.warn('[chatsSync] no project available as workspace host, redirecting to /chats')
          if (allowRedirect && isLive()) router.replace('/chats')
          return
        }
        // setActiveProject can stall without rejecting (e.g. SQLite/OPFS
        // unresponsive during init), same stall class as switchWorkspace in
        // Step 2 — bound the wait and take the same recoverable /chats
        // redirect on timeout instead of pinning the route behind its
        // loading gate indefinitely.
        // Captured BEFORE the race: on a timeout the race rejects, but the
        // activation keeps running inside the store and its eventual commit
        // lands even after this handler has bailed (see the catch below).
        let activation: Promise<boolean> | null = null
        let switched: boolean
        try {
          activation = projectState.setActiveProject(fallback.id)
          switched = await Promise.race([
            activation,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`setActiveProject timed out for ${fallback.id}`)),
                HOST_ACTIVATION_TIMEOUT_MS,
              ),
            ),
          ])
        } catch (error) {
          if (allowRedirect && isLive()) {
            console.warn('[chatsSync] host-project activation failed, redirecting to /chats', {
              fallback: fallback.id,
              error,
            })
            router.replace('/chats')
          }
          // The underlying activation cannot be cancelled and may still commit
          // its store changes AFTER this navigation — a late commit would
          // silently repoint the page the user moved to. Observe the abandoned
          // promise and re-run the full sync on settlement — but ONLY when the
          // activation actually SUCCEEDED (fulfilled true, even if after the
          // timeout). A rejected (or false-returning) activation committed
          // nothing, so there is no late commit to repair: running the sync
          // anyway would re-activate the abandoned chat from nothing. The
          // fulfilled value is the success flag — not control flow.
          // - a live navigation to another chat re-syncs the newest target
          //   (upstream repair, newestChatIdRef);
          // - a route left entirely re-syncs the retained destination id —
          //   destinationChatIdRef is deliberately NOT blanked on cleanup
          //   because the late commit still lands, and newestChatIdRef is
          //   blanked so it cannot carry this repair.
          if (activation) {
            void activation
              .then((activated) => {
                if (!activated) return
                const newest = newestChatIdRef.current
                const destination = destinationChatIdRef.current
                if (newest && newest !== target && !isLive()) {
                  void runSync(newest, false)
                } else if (!newest && destination) {
                  void runSync(destination, false, true)
                }
              })
              .catch(() => {})
          }
          return
        }
        if (!switched) {
          if (allowRedirect && isLive()) router.replace('/chats')
          return
        }
        if (!isLive()) return
      }

      // Step 1: the conversation must exist and be standalone (kind='direct').
      const convState = useConversationStore.getState()
      if (!convState.loaded) return
      const conversation = convState.conversations.find((c) => c.id === target)
      if (!conversation || conversation.kind !== 'direct') {
        console.warn('[chatsSync] standalone chat not found or not direct, redirecting to /chats', {
          chatId: target,
          found: !!conversation,
        })
        if (allowRedirect && isLive()) router.replace('/chats')
        return
      }

      if (!isLive()) return

      // Step 2: switch workspace (OPFS/SQLite state). switchWorkspace
      // lazy-creates the workspace record on first visit, same as the
      // /projects route. The workspace store serializes concurrent switches
      // internally; the liveness re-check after the await drops stale
      // completions so a slow switch to chat A never lands after the user
      // has already moved on to chat B. The wait is BOUNDED: switchWorkspace
      // can stall without rejecting (e.g. SQLite/OPFS unresponsive) — an
      // unbounded await would keep the route pinned on the previous chat's
      // stores under the new URL. On timeout the sync bails to the same
      // recoverable /chats redirect used for a rejected switch, instead of
      // showing stale chat A under chat B's URL indefinitely.
      const ctxState = useConversationContextStore.getState()
      if (ctxState.activeWorkspaceId !== target) {
        let pendingSwitch: Promise<void> | null = null
        try {
          pendingSwitch = ctxState.switchWorkspace(target)
          await Promise.race([
            pendingSwitch,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`switchWorkspace timed out for ${target}`)), SWITCH_WAIT_TIMEOUT_MS)
            ),
          ])
        } catch (error) {
          if (allowRedirect && isLive()) {
            console.warn('[chatsSync] switchWorkspace failed, redirecting to /chats', { target, error })
            router.replace('/chats')
          }
          // Same late-commit class as Step 0: the abandoned switch cannot be
          // cancelled and its completion may land on the page the user moved
          // to. Watch it and re-run the full sync for the newest target once
          // it settles — but ONLY on FULFILLMENT: a rejected switch committed
          // nothing, so there is no late commit to repair (the repair would
          // otherwise fire on the failure path too, re-syncing a chat the
          // failed switch never reached).
          if (pendingSwitch) {
            void pendingSwitch
              .then(() => {
                const newest = newestChatIdRef.current
                if (newest && newest !== target && !isLive()) {
                  void runSync(newest, false)
                }
              })
              .catch(() => {})
          }
          return
        }
        if (!isLive()) return
      } else {
        await ctxState.refreshPendingChanges(true)
        if (!isLive()) return
      }

      // Step 3: activate the conversation (loads messages). The liveness
      // re-check cannot undo a commit that already landed inside the store,
      // so a stale completion is repaired by the caller below — through
      // this same full-sync path, never a bare setActive.
      // Re-checked immediately before the store mutation: the awaits above
      // may have been superseded (or the route left) while this continuation
      // sat in the microtask queue.
      if (!isLive()) return
      if (useConversationStore.getState().activeConversationId !== target) {
        await useConversationStore.getState().setActive(target)
      }
    }

    const syncFromRoute = async () => {
      await runSync(chatId, true)

      // Stale-completion repair. If this run's target was superseded while
      // its awaits were in flight, the store may hold a conversation this
      // run's setActive committed internally (the store commits before the
      // hook regains control). Re-run the FULL sync for the newest route
      // target — workspace switch included, so conversation and workspace
      // stores always move together. The loop re-checks the ref after every
      // pass: if navigation advanced again mid-repair, the repair follows
      // the newer target instead of an older one winning (each pass runs
      // the full workspace+activation choreography for its target, and a
      // superseded pass's own liveness checks stop it mid-flight). An empty
      // ref (route left entirely) ends the repair. `repaired` starts at the
      // target this run just completed, so a clean run performs no extra
      // pass.
      let repaired: string | null = chatId
      for (;;) {
        const target = newestChatIdRef.current
        if (!target || target === repaired) return
        await runSync(target, false)
        repaired = target
      }
    }

    void syncFromRoute()

    return () => {
      // The route no longer points at a chat (unmount or a next route whose
      // effect early-returned): a stale setActive completion must NOT repair
      // toward the old target — there is no newest route that re-asserts a
      // choice, so the repair would re-activate a chat the user left. (A
      // next route's effect body re-assigns the ref synchronously right
      // after this cleanup, so a live navigation never observes the blank.)
      newestChatIdRef.current = ''
      // NOTE: destinationChatIdRef is deliberately NOT blanked here — it
      // backs the late host-activation repair (Step 0), which must still
      // re-assert the destination's selection after the route is left,
      // because the timed-out activation commits late inside the store.
      // Conversation-target repairs keep using newestChatIdRef, which IS
      // blanked (an abandoned chat must never be re-activated by its own
      // late completion).
    }
  }, [chatId, router, initialized, projectLoading, conversationsLoaded])
}

/**
 * Resolve the canonical URL for a standalone chat id (used by list rows and
 * creation handlers so every entry shares one URL builder).
 */
export function standaloneChatHref(chatId: string): string {
  return chatPath(chatId)
}
