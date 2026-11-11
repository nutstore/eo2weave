/**
 * useConversationLogic — all store selectors, effects, and handlers
 * extracted from ConversationView.
 *
 * IMPORTANT: Streaming data (draftAssistant, streamingContent, etc.) is
 * NOT exposed from this hook. It is subscribed directly inside
 * ConversationMessages to prevent ConversationView from re-rendering
 * on every streaming token (~60fps).
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { assembleBuiltinCommandPrompt, matchesBuiltinCommand } from '@/skills/builtin-slash-exec'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAgentStore } from '@/store/agent.store'
import { useConversationStore } from '@/store/conversation.store'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { useSettingsStore } from '@/store/settings.store'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { useAgentsStore } from '@/store/agents.store'
import { useT } from '@/i18n'
import { createUserMessage } from '@/agent/message-types'
import type { Message } from '@/agent/message-types'
import { useAssetStore } from '@/store/asset.store'
import { useProjectStore } from '@/store/project.store'
import { removeAssetsFromOPFS, writePendingAssetsToOPFS } from '@/services/asset.service'
import { performOcr, isOcrCompatibleImage, fileToBase64 } from '@/services/ocr.service'
import { supportsImageInput } from '@/agent/llm/pi-ai-model-resolver'
import { isPotentiallyDynamicProviderType, getProviderConfig } from '@/agent/providers/types'
import { getGatewayCredentialStatus } from '@/agent/providers/llm-gateway-auth'
import { credentialRegistry } from '@/agent/providers/credential-state'
import { useInputDraftStore } from '@/store/input-draft.store'
import { VIRTUALIZATION_THRESHOLD } from '@/components/agent/virtualization-constants'
import { useActiveConversation } from './useActiveConversation'
import { useProjectAgentsInit } from '@/hooks/useProjectAgentsInit'

/** Stable empty array so mentionAgents selector returns same ref when unchanged */
export const EMPTY_MENTION_AGENTS: { id: string; name: string }[] = []

/**
 * Composer mention candidates, gated on the loaded catalog belonging to the
 * project the user is looking at. Exported pure so tests exercise the
 * production selection instead of a hand-copied duplicate that can drift.
 */
export function selectMentionAgents(
  s: { loadedProjectId: string | null; agents: { id: string; name: string }[] },
  activeProjectId: string | null
): { id: string; name: string }[] {
  if (s.loadedProjectId !== activeProjectId) return EMPTY_MENTION_AGENTS
  const filtered = s.agents
    .filter((agent) => agent.id !== 'default')
    .map((agent) => ({ id: agent.id, name: agent.name }))
  return filtered.length === 0 ? EMPTY_MENTION_AGENTS : filtered
}

export function useConversationLogic() {
  const t = useT()

  // ── Local UI state ──
  // Input text is stored in a ref to avoid re-rendering ConversationView on every keystroke.
  // Only a boolean `hasInput` state is kept to drive the send button's disabled state.
  const inputRef = useRef('')
  const [hasInput, setHasInput] = useState(false)
  // Mentioned agent IDs also live in a ref — they are only read inside stable callbacks.
  const mentionedAgentIdsRef = useRef<string[]>([])
  const setMentionedAgentIds = useCallback((ids: string[]) => {
    mentionedAgentIdsRef.current = ids
  }, [])
  const [inputResetToken, setInputResetToken] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)
  // ── Draft persistence (save/restore across workspace switches) ──
  const prevConvIdRef = useRef<string | null>(null)

  /**
   * setInput — updates the input ref and only triggers a re-render
   * when the empty↔non-empty boundary changes (to update send button state).
   */
  const setInput = useCallback((text: string) => {
    inputRef.current = text
    const next = text.trim().length > 0
    setHasInput((prev) => (prev !== next ? next : prev))
  }, [])

  // The draft text to inject into the editor when switching back to a workspace.
  // This is separate from `input` because Tiptap manages its own content.
  const [draftTextToRestore, setDraftTextToRestore] = useState<string | null>(null)
  // Track which convId the draft belongs to, so we can clear it after restore
  const draftConvIdRef = useRef<string | null>(null)

  // ── Agents store ──
  // (Project store's activeProjectId is no longer read here — agent
  //  initialisation moved to useProjectAgentsInit, which subscribes to
  //  it on its own.)
  const allAgents = useAgentsStore((s) => s.agents)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  // Only expose candidates once the loaded catalog belongs to the project the
  // user is actually looking at. While a switch is still initializing, the old
  // project's Agents must not stay selectable — picking one would insert a
  // mention the target-project routing rejects.
  const catalogMatchesProject = useAgentsStore((s) => s.loadedProjectId === activeProjectId)
  const projectActiveAgentId =
    catalogMatchesProject ? useAgentsStore((s) => s.activeAgentId) : null
  const setProjectActiveAgent = useAgentsStore((s) => s.setActiveAgent)
  const createAgent = useAgentsStore((s) => s.createAgent)
  const deleteAgent = useAgentsStore((s) => s.deleteAgent)
  const mentionAgents = useAgentsStore(
    useShallow((s) => selectMentionAgents(s, activeProjectId))
  )

  // ── Active conversation — only select NON-streaming data ──
  // Streaming data is subscribed inside ConversationMessages directly.
  const active = useActiveConversation()
  const convId = active.convId
  const conversationAgentId = useWorkspacePreferencesStore((s) => convId ? s.agentIdByWorkspace?.[convId] : undefined)
  const activeAgentId = conversationAgentId || projectActiveAgentId
  const setActiveAgent = useCallback(async (id: string) => {
    const projectId = useAgentsStore.getState().loadedProjectId
    await setProjectActiveAgent(id)
    const state = useAgentsStore.getState()
    if (convId && state.loadedProjectId === projectId && state.activeAgentId === id) {
      useWorkspacePreferencesStore.getState().setWorkspaceAgentId(convId, id)
    }
  }, [convId, setProjectActiveAgent])
  const activeMessages = active.messages
  const status = active.status
  // NOTE: active.draftAssistant and active.streamingState are intentionally
  // NOT destructured here. They change at ~60fps during streaming and would
  // cause ConversationView to re-render on every token.
  const conversationError = active.error
  const activeContextWindowUsage = active.contextWindowUsage

  // ── Conversation actions (stable refs from store) ──
  const deleteAgentLoop = useConversationStore((s) => s.deleteAgentLoop)
  const isConversationRunning = useConversationRuntimeStore((s) => s.isConversationRunning)
  const getSuggestedFollowUp = useConversationRuntimeStore((s) => s.getSuggestedFollowUp)
  const clearSuggestedFollowUp = useConversationRuntimeStore((s) => s.clearSuggestedFollowUp)
  const mountConversation = useConversationRuntimeStore((s) => s.mountConversation)
  const unmountConversation = useConversationRuntimeStore((s) => s.unmountConversation)
  const getQueueDepth = useConversationRuntimeStore((s) => s.getQueueDepth)
  const editAndResendUserMessage = useConversationStore((s) => s.editAndResendUserMessage)
  const regenerateUserMessage = useConversationStore((s) => s.regenerateUserMessage)

  // ── Settings store (fine-grained selectors to avoid cascade re-renders) ──
  const hasApiKey = useSettingsStore((s) => s.hasApiKey)
  const hasApiKeyLoaded = useSettingsStore((s) => s.hasApiKeyLoaded)
  const enableThinking = useSettingsStore((s) => s.enableThinking)
  const thinkingLevel = useSettingsStore((s) => s.thinkingLevel)
  const setEnableThinking = useSettingsStore((s) => s.setEnableThinking)
  const setThinkingLevel = useSettingsStore((s) => s.setThinkingLevel)

  // ── Workspace preferences store (fine-grained selectors) ──
  const agentMode = useWorkspacePreferencesStore((s) => s.agentMode)
  const setAgentMode = useWorkspacePreferencesStore((s) => s.setAgentMode)

  // ── Derived state ──
  const isRunning = convId ? isConversationRunning(convId) : false
  const isProcessing = isRunning
  const queueDepth = convId ? getQueueDepth(convId) : 0

  // ── Refs ──
  const lastRenderedMessageCountRef = useRef(0)

  // ── Mount / unmount tracking ──
  useEffect(() => {
    if (convId) mountConversation(convId)
    return () => {
      if (convId) unmountConversation(convId)
      // PR #142 review (Sourcery, High): a conversation switch now REMOUNTS
      // ConversationView (key={activeConversationId} in WorkspaceLayout), so
      // the [convId] draft effect below never runs its save branch — on a
      // fresh mount prevConvIdRef is null, so prevId === convId and the save
      // is skipped. Persist any typed-but-unsent draft HERE, on unmount, so
      // the text survives the remount and is restored (peekDraft) when the
      // user switches back. saveDraft treats empty content as "clear", which
      // matches the switch-path semantics for an emptied editor.
      //
      // PR #142 review round 2 (Sourcery, Medium): skip the save while the
      // editor has not yet consumed a pending draft restoration — at that
      // point inputRef holds the pre-restore EMPTY value, so writing it
      // would erase the stored draft before the editor's restore effect
      // ever runs.
      //
      // PR #142 review round 5 (Sourcery, Medium): the marker being set does
      // NOT always mean the editor still holds that pre-restore empty value.
      // restoreDraftIntoInput (rejected send) sets it while the input holds
      // live text awaiting editor restoration, and the stored draft is
      // already cleared at that point. peekDraft discriminates the two
      // windows: an INTACT stored draft means the pending restoration has
      // not been consumed yet (keep the round-2 skip); no stored draft
      // means inputRef holds live unsent content and skipping the save
      // loses it — persist it.
      if (convId) {
        const pendingRestoration = draftConvIdRef.current
          ? useInputDraftStore.getState().peekDraft(convId)
          : null
        if (!pendingRestoration) {
          useInputDraftStore.getState().saveDraft(convId, {
            text: inputRef.current,
            mentionedAgentIds: mentionedAgentIdsRef.current,
            selectedFiles: [],
          })
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId])

  // ── Draft save/restore on workspace switch ──
  useEffect(() => {
    const prevId = prevConvIdRef.current
    prevConvIdRef.current = convId

    // Save draft for the previous workspace (if there was one and it changed)
    if (prevId && prevId !== convId) {
      useInputDraftStore.getState().saveDraft(prevId, {
        text: inputRef.current,
        mentionedAgentIds: mentionedAgentIdsRef.current,
        selectedFiles: [],
      })
    }

    // Restore draft for the new workspace (if one exists)
    // Uses peekDraft (non-destructive) to survive React StrictMode double-mount
    if (convId) {
      useAssetStore.getState?.()?.switchConversation?.(convId)
      const draft = useInputDraftStore.getState().peekDraft(convId)
      if (draft) {
        setMentionedAgentIds(draft.mentionedAgentIds)
        setDraftTextToRestore(draft.text)
        draftConvIdRef.current = convId
      } else {
        setDraftTextToRestore(null)
        draftConvIdRef.current = null
      }
    } else {
      setDraftTextToRestore(null)
      draftConvIdRef.current = null
    }
    // setMentionedAgentIds / setSelectedFiles are useState setters (stable refs).
    // Values are read via refs to avoid stale closures without re-triggering.
  }, [convId])

  useEffect(() => () => {
    const store = useAssetStore.getState?.()
    if (store?.activeConversationId === convId) store.switchConversation?.(null)
  }, [convId])

  // Stable callback to clear draft after the editor has consumed it
  const onDraftRestored = useCallback(() => {
    const id = draftConvIdRef.current
    if (id) {
      useInputDraftStore.getState().clearDraft(id)
      draftConvIdRef.current = null
    }
    setDraftTextToRestore(null)
  }, [])

  /**
   * restoreDraftIntoInput — push `text` back into the editor for `convId`
   * without round-tripping through the persisted draft store.
   *
   * Used after a rejected send: the optimistic clear has already emptied the
   * editor and cleared this conversation's draft, so re-inject directly.
   * AgentRichInput's draft effect only fills EMPTY editors, which is exactly
   * what we want — if the user managed to type something new in the meantime,
   * their text wins and the rejected text is dropped (it also stays available
   * via ↑ input history).
   */
  const restoreDraftIntoInput = useCallback((convId: string | null, text: string, mentionedAgentIds: string[]) => {
    // Only touch the live input when the user is still on the target
    // conversation (convId may be null for a not-yet-created conversation —
    // restoring the live input is still correct in that case).
    if (convIdRef.current !== convId) return
    if (!text.trim()) return
    setInput(text)
    setMentionedAgentIds(mentionedAgentIds)
    draftConvIdRef.current = convId
    setDraftTextToRestore(text)
  }, [setInput, setMentionedAgentIds])

  // ── Initialize agents for mentions ──
  // (logic moved to useProjectAgentsInit so WelcomeScreen can share the
  //  same init flow — without it, the bare-URL AgentDropdown would render
  //  with an empty agent list even when the active project has agents.)
  useProjectAgentsInit()

  // ── Smart auto-scroll (only scroll when user is already at the bottom) ──
  const activeMessagesLength = activeMessages.length

  // PR #142 review (Sourcery, Medium): under virtual scrolling the message
  // list is rendered by react-virtuoso, which owns the scroll position via
  // followOutput. A native scrollTop write on the shared container races
  // Virtuoso's own tracking and can pull the windowed list off the real
  // bottom. When virtualization is active, defer auto-scrolling entirely —
  // followOutput already pins the view while at-bottom, and the Scroll-
  // to-bottom button covers the not-at-bottom case.
  const isVirtualizedScroll = activeMessagesLength > VIRTUALIZATION_THRESHOLD

  // Scroll-to-bottom state is managed by ScrollToBottomButton component
  // to avoid re-rendering ConversationView (and AgentRichInput) on every scroll event.

  useEffect(() => {
    // Compute append-vs-no-append FIRST, then keep the counter fresh even
    // when the native scroll is skipped (virtualized mode / user scrolled
    // up), so a later mode switch or scroll-back classifies the next append
    // correctly.
    const behavior: ScrollBehavior =
      activeMessagesLength > lastRenderedMessageCountRef.current ? 'smooth' : 'auto'
    lastRenderedMessageCountRef.current = activeMessagesLength
    // Virtualized mode: Virtuoso's followOutput owns the scroll position —
    // a native scrollTop write here would fight it (see comment above).
    if (isVirtualizedScroll) return
    // Don't auto-scroll if user is browsing history above
    if (!isUserAtBottomRef.current) return
    // Use scrollTo on the scroll container directly instead of scrollIntoView.
    // scrollIntoView bubbles up through all scrollable ancestors and can
    // shift the layout container itself (pushing it out of the viewport),
    // especially when the scroll height is very large.
    const container = scrollContainerRef.current
    if (!container) return
    if (behavior === 'auto') {
      container.scrollTop = container.scrollHeight
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
    }
    // The scroll target above is a snapshot taken at call time, but content
    // height usually keeps growing afterwards (attachment images decoding,
    // code highlighting, mermaid/KaTeX rendering, late font swaps). A smooth
    // scroll animates to the captured position, so it lands short of the real
    // bottom. Keep re-asserting the bottom via rAF until the height settles,
    // so the view stays pinned to the newest content.
    let raf = 0
    let lastHeight = container.scrollHeight
    let stableFrames = 0
    const settle = () => {
      // User scrolled up while we were settling — stop fighting them.
      if (!isUserAtBottomRef.current) return
      const h = container.scrollHeight
      if (h !== lastHeight) {
        lastHeight = h
        container.scrollTop = container.scrollHeight
        stableFrames = 0
      } else {
        stableFrames += 1
      }
      // Stop after ~10 stable frames (~160ms) without height changes.
      if (stableFrames < 10) raf = requestAnimationFrame(settle)
    }
    raf = requestAnimationFrame(settle)
    return () => cancelAnimationFrame(raf)
  }, [activeMessagesLength, status])

  // ── Tool results map ──
  // Value includes the raw content string AND optional contentParts
  // (for multimodal tool results like page_screenshot images).
  const buildToolResultsMap = useCallback((messages: Message[]) => {
    const map = new Map<string, string>()
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        // If the tool message has contentParts (e.g. screenshot images),
        // serialize the full message (content + contentParts) as JSON so
        // the renderer can extract the image.
        if (msg.displayContent) {
          map.set(msg.toolCallId, msg.displayContent)
        } else if (msg.contentParts && msg.contentParts.length > 0) {
          map.set(
            msg.toolCallId,
            JSON.stringify({
              _envelope: true,
              ok: true,
              contentParts: msg.contentParts,
              data: { note: msg.content?.slice(0, 200) },
            })
          )
        } else {
          map.set(msg.toolCallId, msg.content || '')
        }
      }
    }
    return map
  }, [])

  // Only committed tool results from messages.
  // Runtime tool results are merged inside ConversationMessages (subscribed directly).
  const toolResults = useMemo(
    () => buildToolResultsMap(activeMessages),
    [activeMessages, buildToolResultsMap]
  )

  // ── Follow-up suggestion ──
  const suggestedFollowUp = convId ? getSuggestedFollowUp(convId) : ''

  // ── Handlers ──
  // Refs for reading latest values inside stable callbacks
  const convIdRef = useRef(convId)
  convIdRef.current = convId

  const sendMessage = useCallback(
    async (
      text: string,
      options?: {
        agentOverrideId?: string | null
        assets?: import('@/types/asset').AssetMeta[]
        /** Called when the send was rejected and `text` was NOT delivered —
         *  lets the input UI restore what the user typed (optimistic clear). */
        onInputRejected?: (text: string) => void
      }
    ) => {
      // Attachment-only send (plan A): empty text is valid when staged
      // assets exist — they are written to OPFS and resolved below.
      const hasStagedAssets =
        (options?.assets && options.assets.length > 0) ||
        useAssetStore.getState().pendingAssets.length > 0
      if (!text.trim() && !hasStagedAssets) return

      // Read latest from store to avoid stale closures
      const {
        hasApiKey: hasKey,
        providerType: pType,
        modelName: mName,
        maxTokens: mTokens,
        modelCredentialStatus,
      } = useSettingsStore.getState()
      // An unregistered dynamic provider (#87 — codex-oauth whose extension
      // disappeared or whose auth was revoked) leaves the persisted
      // providerType in place but the registry has no config for it, so
      // sending would hit a dead route even though the stale virtual key
      // satisfies the hasKey check. Block it with the re-login toast —
      // same family as the expired gateway credential, but the registry
      // (not the credential) is what's missing.
      const providerUnregistered =
        !!pType && isPotentiallyDynamicProviderType(pType) && !getProviderConfig(pType)
      // Precedence (Sourcery round 5): the unregistered-provider guard wins
      // over the expired-credential toast — when the provider itself is
      // gone, the gateway re-login flow is the wrong guidance.
      // The gateway's status may be unknown while a session is being restored,
      // or newer than the generic key flag after a successful dispatch. Let
      // the dispatch resolver make the authoritative decision in both cases.
      const gatewayStatus = pType === 'llm-gateway' ? getGatewayCredentialStatus() : null
      const missingCredential = gatewayStatus
        ? gatewayStatus === 'missing' || gatewayStatus === 'expired'
        : !hasKey && credentialRegistry.getState(pType).kind !== 'temporary'
      if (providerUnregistered || missingCredential || modelCredentialStatus === 'expired' || !pType || !mName) {
        toast.error(
          providerUnregistered || gatewayStatus === 'missing'
            ? t('conversation.toast.providerReauthRequired')
            : modelCredentialStatus === 'expired' || gatewayStatus === 'expired'
              ? t('conversation.toast.gatewayReauthRequired')
              : !pType || !mName
                ? t('conversation.toast.noModel')
                : t('conversation.toast.noApiKey'),
        )
        options?.onInputRejected?.(text)
        return
      }

      // Capture the files belonging to this send before any async work.
      // Files added later belong to the next message.
      const pendingSnapshot =
        options?.assets && options.assets.length > 0
          ? []
          : [...useAssetStore.getState().pendingAssets]
      // Move only this send's snapshot out of the composer synchronously.
      // New attachments staged while writes are pending belong to the next send.
      for (const asset of pendingSnapshot) useAssetStore.getState().removeAsset(asset.id)
      let targetConvId = convIdRef.current
      const restoreSentAssets = () => {
        if (!pendingSnapshot.length) return
        const conversationState = useConversationStore.getState()
        if (targetConvId && !conversationState.conversations.some((conversation) => conversation.id === targetConvId)) return
        const assets = useAssetStore.getState()
        const scopeMatches = conversationState.activeConversationId === targetConvId && assets.activeConversationId === targetConvId
        assets.restoreAssets(pendingSnapshot, scopeMatches ? undefined : targetConvId ?? undefined)
      }
      const rejectSend = () => {
        options?.onInputRejected?.(text)
        restoreSentAssets()
      }

      const { directoryHandle: dh } = useAgentStore.getState()
      const { createNew, setActive, updateMessages, runAgent } = useConversationStore.getState()
      if (!targetConvId) {
        // Attachment-only first message: fall back to a filename-based title
        const titleSource =
          text.trim() ||
          options?.assets?.[0]?.name ||
          pendingSnapshot[0]?.name ||
          ''
        const conv = createNew(titleSource.slice(0, 30))
        targetConvId = conv.id
        setActive(targetConvId)
      }

      // Hoist the target-conversation lookup: both the page-context refresh
      // check below and the direct-send path at the bottom need it. Reading
      // state once keeps the two paths consistent (no race where the
      // conversation object changes between reads).
      const targetConv = useConversationStore
        .getState()
        .conversations.find((c) => c.id === targetConvId)

      // ── Page context capture (side-panel mode only) ────────────────────
      // Capture each user turn, including same-URL content changes. The context
      // journal deduplicates the captured state before model dispatch. Capture
      // is shared by direct-send and queued-message paths below.
      let pageContext: Awaited<
        ReturnType<(typeof import('@/agent/workspace-assistant-context'))['capturePageContext']>
      > = null
      {
        // Page context is best-effort: a failing extension round-trip must not
        // abort the send (the input has already been cleared optimistically —
        // aborting here would silently drop the user's message).
        try {
          const { capturePageContext } = await import('@/agent/workspace-assistant-context')
          // Same URL can have different content. The context journal deduplicates
          // the actual captured state at the next model request boundary.
          pageContext = await capturePageContext()
        } catch (err) {
          console.warn('[useConversationLogic] page-context capture failed; sending without it:', err)
        }
      }

      // ── Resolve pending assets (shared by both queue and direct-send paths) ──
      // When the user has attached files via the input box, we need to write them
      // to OPFS and resolve base64/OCR *before* deciding whether to queue or send.
      // Previously assets were only resolved in the direct-send path, so queued
      // messages silently lost their attachments.
      let assets = options?.assets
      let wrotePendingAssets = false
      if (!assets || assets.length === 0) {
        if (pendingSnapshot.length > 0) {
          try {
            // Ensure workspace is ready for asset writes.
            const { useWorkspaceStore } = await import('@/store/workspace.store')
            const wsState = useWorkspaceStore.getState()
            if (wsState.activeWorkspaceId !== targetConvId) {
              await wsState.switchWorkspace(targetConvId)
            }

            assets = await writePendingAssetsToOPFS(
              pendingSnapshot.map((a) => ({ name: a.name, file: a.file })), targetConvId,
            )
            wrotePendingAssets = true
            // Lazy OCR: only run OCR for non-vision models.
            const settingsState = useSettingsStore.getState()
            const hasVision = settingsState.modelName
              ? supportsImageInput(settingsState.modelName, settingsState.providerType || undefined)
              : false
            const imageAssetIndexes: number[] = []
            pendingSnapshot.forEach((a, idx) => {
              if (a.mimeType.startsWith('image/') && isOcrCompatibleImage(a.mimeType)) {
                imageAssetIndexes.push(idx)
              }
            })
            let ocrResults: Map<number, string> | null = null
            if (!hasVision && imageAssetIndexes.length > 0) {
              const id = toast.loading(`正在识别图片文字…`)
              try {
                const results = await Promise.all(
                  imageAssetIndexes.map(async (idx) => {
                    try {
                      const r = await performOcr(pendingSnapshot[idx].file)
                      return { idx, text: r.text }
                    } catch {
                      return { idx, text: '' }
                    }
                  })
                )
                ocrResults = new Map(results.map((r) => [r.idx, r.text]))
              } finally {
                toast.dismiss(id)
              }
            }
            // Detached image records no longer receive background store updates.
            // Resolve missing image payloads before the message is committed.
            await Promise.all(pendingSnapshot.map(async (asset) => {
              if (hasVision && asset.mimeType.startsWith('image/') && !asset.ocrBase64) {
                asset.ocrBase64 = await fileToBase64(asset.file)
              }
            }))
            assets = assets.map((assetMeta, idx) => {
              const pending = pendingSnapshot[idx]
              if (!pending) return assetMeta
              const carry: { ocrText?: string; ocrBase64?: string } = {}
              if (pending.ocrBase64) carry.ocrBase64 = pending.ocrBase64
              if (ocrResults && ocrResults.has(idx) && ocrResults.get(idx)) {
                carry.ocrText = ocrResults.get(idx)
              } else if (pending.ocrText) {
                carry.ocrText = pending.ocrText
              }
              return Object.keys(carry).length > 0 ? { ...assetMeta, ...carry } : assetMeta
            })
          } catch (err) {
            if (wrotePendingAssets && assets) void removeAssetsFromOPFS(assets, targetConvId)
            toast.error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`)
            // Don't send — user can retry. Hand the typed text and the staged
            // files back to the input (the optimistic clear already removed them).
            rejectSend()
            return
          }
        }
      }

      // ── Dispatch-time registry recheck (#87, Sourcery round 3) ──
      // The entry guard ran before several awaits (page-context capture,
      // asset writes, OCR). A dynamic provider can unregister inside that
      // window (extension disconnect, auth revocation). This recheck sits
      // BEFORE every commit — the user message append, the draft clear, the
      // staged-asset consumption, and queued-message enqueue all happen
      // below — so a rejected send leaves no half-committed turn for a
      // retry to duplicate.
      if (isPotentiallyDynamicProviderType(pType) && !getProviderConfig(pType)) {
        toast.error(t('conversation.toast.providerReauthRequired'))
        // Remove the OPFS copies that were only written in preparation for
        // this send; rejectSend hands the staged files and typed text back.
        if (wrotePendingAssets && assets) {
          void removeAssetsFromOPFS(assets, targetConvId)
        }
        rejectSend()
        return
      }

      if (useConversationRuntimeStore.getState().isConversationRunning(targetConvId)) {
        // Queue the message instead of rejecting it
        const result = useConversationRuntimeStore.getState().enqueueMessage(targetConvId, {
          text,
          assets: assets && assets.length > 0 ? assets : undefined,
          agentOverrideId: options?.agentOverrideId ?? null,
          enqueuedAt: Date.now(),
          pageContext: pageContext ?? undefined,
        })
        if (result.enqueued) {
          useInputDraftStore.getState().clearDraft(targetConvId)
          setDraftTextToRestore(null)
          draftConvIdRef.current = null
        } else {
          // Keep staged files available for retry and remove the OPFS copies
          // that were only written in preparation for this failed enqueue.
          if (wrotePendingAssets && assets) {
            void removeAssetsFromOPFS(assets, targetConvId)
          }
          toast.error(t('conversation.toast.queueFull'))
          rejectSend()
        }
        return
      }

      const userMsg = createUserMessage(text, assets, pageContext ?? undefined)
      updateMessages(targetConvId, targetConv ? [...targetConv.messages, userMsg] : [userMsg])
      // Clear any draft for this conversation (message sent) and reset restore state
      useInputDraftStore.getState().clearDraft(targetConvId)
      setDraftTextToRestore(null)
      // User initiated send — always scroll to bottom
      isUserAtBottomRef.current = true
      draftConvIdRef.current = null

      // (The dispatch-time registry recheck now runs BEFORE any commit —
      // message append, draft clear, asset consumption, queue enqueue — see
      // above. runAgent's own store-level guard is the final backstop for a
      // provider unregistering inside the remaining synchronous window.)

      await runAgent(targetConvId, pType, mName, mTokens, dh, options?.agentOverrideId ?? null)
    },
    [t]
  )

  const handleSlashCommand = useCallback(async (command: string) => {
    if (command === 'compact') {
      let targetConvId = convIdRef.current
      if (!targetConvId) {
        const { createNew, setActive } = useConversationStore.getState()
        const conv = createNew('/compact')
        targetConvId = conv.id
        await setActive(targetConvId)
      }
      await useConversationStore.getState().compactConversation(targetConvId)
    }
  }, [])

  const handleSend = useCallback(async () => {
    const inputTrimmed = inputRef.current.trim()
    const currentConvId = convIdRef.current
    const currentMentionedAgentIds = mentionedAgentIdsRef.current
    const { getSuggestedFollowUp, clearSuggestedFollowUp } = useConversationRuntimeStore.getState()

    // ── Provider pre-gate (Sourcery round 2) ──
    // Runs BEFORE any slash-command dispatch or optimistic input clear so a
    // rejected send leaves the typed command (e.g. /compact) and the editor
    // content intact — the user keeps what they typed while recovering.
    {
      const { providerType: pType } = useSettingsStore.getState()
      if (pType && isPotentiallyDynamicProviderType(pType) && !getProviderConfig(pType)) {
        toast.error(t('conversation.toast.providerReauthRequired'))
        return
      }
    }

    // P0 builtin light-operation pack (/summary /translate /explain /polish
    // /titles): assemble the prompt from template + page context, then fall
    // through to the STANDARD send pipeline as a normal user message — no
    // separate request channel, so quota/compaction/cache stay intact.
    if (matchesBuiltinCommand(inputTrimmed)) {
      setInput('')
      setMentionedAgentIds([])
      setInputResetToken((v) => v + 1)
      const assembled = await assembleBuiltinCommandPrompt(inputTrimmed)
      if (assembled === null) return // user-facing toast already shown
      // Overwrite the pending input with the assembled prompt and continue
      // into the normal send path below (textToSend = inputRef.current).
      setInput(assembled)
      inputRef.current = assembled
    }

    // Slash command execution happens only when user explicitly sends.
    // Clear input BEFORE the async compact to avoid stale text visible during LLM call.
    if (inputTrimmed === '/compact') {
      setInput('')
      setMentionedAgentIds([])
      setInputResetToken((v) => v + 1)
      await handleSlashCommand('compact')
      return
    }

    // Legacy /image command — image generation now runs through the agent
    // (generate_image tool). Show a one-time migration hint and keep the
    // input untouched; on later attempts the text falls through and is sent
    // as a normal message the agent can interpret.
    if (inputTrimmed === '/image' || inputTrimmed.startsWith('/image ')) {
      let hintShown = false
      try {
        hintShown = localStorage.getItem('image-command-migration-hint') === '1'
        if (!hintShown) localStorage.setItem('image-command-migration-hint', '1')
      } catch {
        // Storage unavailable (private mode etc.) — show the hint every time
      }
      if (!hintShown) {
        toast.info(t('conversation.imageGen.migrationHint'))
        return
      }
    }

    // Attachment-only send (plan A): empty text is valid when assets are
    // staged — sendMessage resolves them from the pendingAssets store.
    const hasStagedAssets = useAssetStore.getState().pendingAssets.length > 0
    const textToSend = inputTrimmed
      ? inputRef.current
      : currentConvId
        ? getSuggestedFollowUp(currentConvId)
        : ''
    const isAttachmentOnly = !inputTrimmed && hasStagedAssets
    if (textToSend || isAttachmentOnly) {
      // (The unregistered-provider pre-gate now runs at the top of handleSend,
      // before slash-command dispatch and the optimistic clear — Sourcery
      // round 2.)

      // ── Optimistic input clear ──
      // Clear the input BEFORE the async sendMessage pipeline runs. sendMessage
      // awaits page-context capture / asset writes / OCR before it reaches its
      // own setInput('') + resetToken bump — a window of tens of ms to seconds
      // during which the sent text kept hanging in the input. Worse, if the
      // user switched conversations inside that window, the switch-away draft
      // save persisted the stale text and the editor remount re-injected it:
      // "message sent, input still full".
      //
      // If sendMessage later REJECTS the send (no API key, upload failure,
      // queue full) it invokes onInputRejected and we restore everything:
      // typed text, mentions, and a persisted draft for that conversation.
      const sentText = textToSend
      const sentConvId = currentConvId
      const sentMentionedAgentIds = currentMentionedAgentIds
      setInput('')
      setMentionedAgentIds([])
      setInputResetToken((v) => v + 1)
      if (sentConvId) {
        useInputDraftStore.getState().clearDraft(sentConvId)
      }
      setDraftTextToRestore(null)
      draftConvIdRef.current = null

      const restoreInput = () => {
        // If the user is still on the same conversation (or it was never
        // created), put the text straight back into the live input. The
        // editor was already cleared by the reset-token bump, so re-inject
        // via draftTextToRestore — AgentRichInput's draft effect refills an
        // empty editor and then calls onDraftRestored to consume the state.
        // Otherwise persist a draft on the target conversation so the text
        // reappears when the user switches back.
        const targetId = sentConvId ?? convIdRef.current
        if (convIdRef.current === sentConvId) {
          restoreDraftIntoInput(targetId, sentText, sentMentionedAgentIds)
        } else if (targetId && sentText.trim()) {
          useInputDraftStore.getState().saveDraft(targetId, {
            text: sentText,
            mentionedAgentIds: sentMentionedAgentIds,
            selectedFiles: [],
          })
        }
      }

      // Assets are resolved inside sendMessage (from options or pendingAssets store)
      void sendMessage(textToSend, {
        agentOverrideId: inputTrimmed ? (currentMentionedAgentIds[0] ?? null) : null,
        onInputRejected: restoreInput,
      })
      if (!inputTrimmed && currentConvId) clearSuggestedFollowUp(currentConvId)
    }
  }, [handleSlashCommand, restoreDraftIntoInput, sendMessage, setInput, setMentionedAgentIds])

  const handleCancel = useCallback(() => {
    const currentConvId = convIdRef.current
    if (currentConvId) useConversationStore.getState().cancelAgent(currentConvId)
  }, [])
  const handleDeleteAgentLoop = useCallback(
    (messageId: string) => {
      const currentConvId = convIdRef.current
      if (!currentConvId) return
      if (deleteAgentLoop(currentConvId, messageId))
        toast.success(t('conversation.toast.deletedTurn'))
    },
    [deleteAgentLoop, t]
  )

  // ── Unregistered dynamic provider guard (#87, Sourcery round 5) ──
  // regenerate / edit-and-resend call the conversation-store actions
  // directly, which run the persisted provider without the checks
  // sendMessage has — a rejected provider would hit a dead route instead
  // of showing the re-login guidance. Returns true when the guard blocked
  // the attempt (caller must abort).
  const blockIfProviderUnregistered = useCallback((): boolean => {
    const { providerType: pType } = useSettingsStore.getState()
    if (!pType || !isPotentiallyDynamicProviderType(pType)) return false
    if (getProviderConfig(pType)) return false
    toast.error(t('conversation.toast.providerReauthRequired'))
    return true
  }, [t])

  const handleEditAndResend = useCallback(
    (userMessageId: string, newContent: string) => {
      if (blockIfProviderUnregistered()) return
      const currentConvId = convIdRef.current
      if (!currentConvId) return
      editAndResendUserMessage(currentConvId, userMessageId, newContent)
    },
    [editAndResendUserMessage, blockIfProviderUnregistered]
  )

  // Always call unconditionally (rules-of-hooks); when convId is absent the
  // callback degrades to a no-op, matching the old conditional hook contract
  // (undefined) observed by consumers — they only invoke it with a message id.
  const handleRegenerate = useCallback(
    (id: string) => {
      if (blockIfProviderUnregistered()) return
      const currentConvId = convId
      if (!currentConvId) return
      regenerateUserMessage(currentConvId, id)
    },
    [convId, regenerateUserMessage, blockIfProviderUnregistered]
  )

  return {
    // Local UI state
    hasInput,
    setInput,
    setMentionedAgentIds,
    inputResetToken,
    messagesEndRef,
    scrollContainerRef,
    isUserAtBottomRef,
    draftTextToRestore,
    onDraftRestored,
    // Agent store
    allAgents,
    activeAgentId,
    setActiveAgent,
    createAgent,
    deleteAgent,
    mentionAgents,
    // Conversation state (NO streaming data — that's subscribed in ConversationMessages)
    convId,
    activeMessages,
    conversationError,
    activeContextWindowUsage,
    isProcessing,
    isRunning,
    status,
    suggestedFollowUp,
    toolResults,
    queueDepth,
    // Settings
    hasApiKey,
    hasApiKeyLoaded,
    enableThinking,
    thinkingLevel,
    setEnableThinking,
    setThinkingLevel,
    // Workspace preferences
    agentMode,
    setAgentMode,
    // Handlers
    sendMessage,
    handleSend,
    handleCancel,
    handleSlashCommand,
    handleDeleteAgentLoop,
    handleEditAndResend,
    handleRegenerate,
    regenerateUserMessage,
    clearSuggestedFollowUp,
    // Store refs (for ErrorBoundary reset)
    useConversationStore,
    useConversationRuntimeStore,
  }
}

export type ConversationLogic = ReturnType<typeof useConversationLogic>
