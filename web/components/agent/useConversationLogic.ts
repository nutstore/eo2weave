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
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAgentStore } from '@/store/agent.store'
import { useConversationStore } from '@/store/conversation.store'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { useSettingsStore } from '@/store/settings.store'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { useProjectStore } from '@/store/project.store'
import { useAgentsStore } from '@/store/agents.store'
import { useT } from '@/i18n'
import { createUserMessage } from '@/agent/message-types'
import type { Message } from '@/agent/message-types'
import { useAssetStore } from '@/store/asset.store'
import { removeAssetsFromOPFS, writePendingAssetsToOPFS } from '@/services/asset.service'
import { performOcr, isOcrCompatibleImage } from '@/services/ocr.service'
import { supportsImageInput } from '@/agent/llm/pi-ai-model-resolver'
import { useInputDraftStore } from '@/store/input-draft.store'
import { useActiveConversation } from './useActiveConversation'

/** Stable empty array so mentionAgents selector returns same ref when unchanged */
const EMPTY_MENTION_AGENTS: { id: string; name: string }[] = []

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

  // ── Project store ──
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  // ── Agents store ──
  const isAgentsLoading = useAgentsStore((s) => s.isLoading)
  const isAgentsInitialized = useAgentsStore((s) => s.isInitialized)
  const allAgents = useAgentsStore((s) => s.agents)
  const activeAgentId = useAgentsStore((s) => s.activeAgentId)
  const setActiveAgent = useAgentsStore((s) => s.setActiveAgent)
  const createAgent = useAgentsStore((s) => s.createAgent)
  const deleteAgent = useAgentsStore((s) => s.deleteAgent)
  const mentionAgents = useAgentsStore(
    useShallow((s) => {
      const filtered = s.agents
        .filter((agent) => agent.id !== 'default')
        .map((agent) => ({ id: agent.id, name: agent.name }))
      return filtered.length === 0 ? EMPTY_MENTION_AGENTS : filtered
    })
  )

  // ── Active conversation — only select NON-streaming data ──
  // Streaming data is subscribed inside ConversationMessages directly.
  const active = useActiveConversation()
  const convId = active.convId
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // setMentionedAgentIds / setSelectedFiles are useState setters (stable refs).
    // Values are read via refs to avoid stale closures without re-triggering.
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
  useEffect(() => {
    if (!activeProjectId) return
    if (isAgentsLoading) return
    if (mentionAgents.length > 0 && isAgentsInitialized) return

    let cancelled = false
    ;(async () => {
      try {
        const { ProjectManager } = await import('@/opfs')
        const pm = await ProjectManager.create()
        const store = useAgentsStore.getState()
        store.setProjectManager(pm)
        await store.initialize(activeProjectId)
      } catch (error) {
        if (!cancelled) {
          console.warn('[ConversationView] Failed to initialize agents for mentions:', error)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeProjectId, isAgentsInitialized, isAgentsLoading, mentionAgents.length])

  // ── Smart auto-scroll (only scroll when user is already at the bottom) ──
  const activeMessagesLength = activeMessages.length

  // Scroll-to-bottom state is managed by ScrollToBottomButton component
  // to avoid re-rendering ConversationView (and AgentRichInput) on every scroll event.

  useEffect(() => {
    // Don't auto-scroll if user is browsing history above
    if (!isUserAtBottomRef.current) return
    const behavior: ScrollBehavior =
      activeMessagesLength > lastRenderedMessageCountRef.current ? 'smooth' : 'auto'
    lastRenderedMessageCountRef.current = activeMessagesLength
    // Use scrollTo on the scroll container directly instead of scrollIntoView.
    // scrollIntoView bubbles up through all scrollable ancestors and can
    // shift the layout container itself (pushing it out of the viewport),
    // especially when the scroll height is very large.
    const container = scrollContainerRef.current
    if (container) {
      if (behavior === 'auto') {
        container.scrollTop = container.scrollHeight
      } else {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
      }
    }
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
        if (msg.contentParts && msg.contentParts.length > 0) {
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
      if (!text.trim()) return

      // Read latest from store to avoid stale closures
      const {
        hasApiKey: hasKey,
        providerType: pType,
        modelName: mName,
        maxTokens: mTokens,
      } = useSettingsStore.getState()
      if (!hasKey) {
        toast.error(t('conversation.toast.noApiKey'))
        options?.onInputRejected?.(text)
        return
      }

      // Snapshot staged attachments SYNCHRONOUSLY, before any await. The
      // optimistic input clear (see handleSend) bumps resetToken, and the
      // editor's reset effect calls useAssetStore.clearAll() once React
      // commits — so by the time the awaits below resume, the pending-asset
      // store may already be empty. Keep the File references so a rejected
      // send can hand the files back to the input.
      const pendingSnapshot =
        options?.assets && options.assets.length > 0
          ? []
          : [...useAssetStore.getState().pendingAssets]
      /** Re-attach staged files if the optimistic clear already wiped them. */
      const restoreAssetsIfWiped = () => {
        if (pendingSnapshot.length === 0) return
        const { pendingAssets: current, addFiles } = useAssetStore.getState()
        if (current.length === 0) addFiles(pendingSnapshot.map((a) => a.file))
      }
      const rejectSend = () => {
        options?.onInputRejected?.(text)
        restoreAssetsIfWiped()
      }

      const { directoryHandle: dh } = useAgentStore.getState()
      let targetConvId = convIdRef.current
      const { createNew, setActive, updateMessages, runAgent } = useConversationStore.getState()
      if (!targetConvId) {
        const conv = createNew(text.slice(0, 30))
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
      // Optimization: only re-pull the full context when the upstream page has
      // actually changed. We read just the URL cheaply (capturePageUrl) and
      // compare against the most recent pageContext-bearing message in history.
      //   - URL unchanged → reuse null (history already has valid context)
      //   - URL changed / no prior context / compression dropped it → full pull
      // Null in normal (non-side-panel) mode. Shared by the direct-send and
      // queued-message paths below.
      let pageContext: Awaited<
        ReturnType<(typeof import('@/agent/workspace-assistant-context'))['capturePageContext']>
      > = null
      {
        // Page context is best-effort: a failing extension round-trip must not
        // abort the send (the input has already been cleared optimistically —
        // aborting here would silently drop the user's message).
        try {
          const { capturePageUrl, capturePageContext, shouldRefreshPageContext } =
            await import('@/agent/workspace-assistant-context')
          const currentUrl = await capturePageUrl()
          if (currentUrl) {
            // Side-panel mode + URL read OK → compare against history.
            const needRefresh = shouldRefreshPageContext(targetConv?.messages ?? [], currentUrl)
            if (needRefresh) {
              pageContext = await capturePageContext()
            }
          } else {
            // Either non-side-panel mode (capturePageContext returns null too) or
            // side-panel mode where URL read failed — fall back to a full capture.
            // In non-side-panel mode this is a cheap null return.
            pageContext = await capturePageContext()
          }
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
      let clearPendingAssets: (() => void) | undefined
      if (!assets || assets.length === 0) {
        const { clearAll } = useAssetStore.getState()
        if (pendingSnapshot.length > 0) {
          try {
            // Ensure workspace is ready for asset writes.
            const { useWorkspaceStore } = await import('@/store/workspace.store')
            const wsState = useWorkspaceStore.getState()
            if (wsState.activeWorkspaceId !== targetConvId) {
              await wsState.switchWorkspace(targetConvId)
            }

            assets = await writePendingAssetsToOPFS(
              pendingSnapshot.map((a) => ({ name: a.name, file: a.file }))
            )
            // Lazy OCR: only run OCR for non-vision models.
            const settingsState = useSettingsStore.getState()
            const hasVision = settingsState.modelName
              ? supportsImageInput(settingsState.modelName)
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
            wrotePendingAssets = true
            clearPendingAssets = clearAll
          } catch (err) {
            toast.error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`)
            // Don't send — user can retry. Hand the typed text and the staged
            // files back to the input (the optimistic clear already removed them).
            rejectSend()
            return
          }
        }
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
          clearPendingAssets?.()
          setInput('')
          setMentionedAgentIds([])
          setInputResetToken((v) => v + 1)
          useInputDraftStore.getState().clearDraft(targetConvId)
          setDraftTextToRestore(null)
          draftConvIdRef.current = null
        } else {
          // Keep staged files available for retry and remove the OPFS copies
          // that were only written in preparation for this failed enqueue.
          if (wrotePendingAssets && assets) {
            void removeAssetsFromOPFS(assets)
          }
          toast.error(t('conversation.toast.queueFull'))
          rejectSend()
        }
        return
      }

      const userMsg = createUserMessage(text, assets, pageContext ?? undefined)
      updateMessages(targetConvId, targetConv ? [...targetConv.messages, userMsg] : [userMsg])
      clearPendingAssets?.()
      setInput('')
      setMentionedAgentIds([])
      setInputResetToken((v) => v + 1)
      // Clear any draft for this conversation (message sent) and reset restore state
      useInputDraftStore.getState().clearDraft(targetConvId)
      setDraftTextToRestore(null)
      // User initiated send — always scroll to bottom
      isUserAtBottomRef.current = true
      draftConvIdRef.current = null

      await runAgent(targetConvId, pType, mName, mTokens, dh, options?.agentOverrideId ?? null)
    },
    [t]
  )

  const handleSlashCommand = useCallback(async (command: string, arg?: string) => {
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
    if (command === 'image') {
      let targetConvId = convIdRef.current
      if (!targetConvId) {
        const { createNew, setActive } = useConversationStore.getState()
        const conv = createNew('/image')
        targetConvId = conv.id
        await setActive(targetConvId)
      }
      // Parse --ar <ratio> from the argument (e.g. "/image --ar 16:9 熊猫")
      let prompt = arg!
      let aspectRatio: string | undefined
      const arMatch = prompt.match(/--ar\s+(\S+)/)
      if (arMatch) {
        aspectRatio = arMatch[1]
        prompt = prompt.replace(/--ar\s+\S+/, '').trim()
      }
      await useConversationStore
        .getState()
        .runImageGeneration(targetConvId, prompt, { aspectRatio })
    }
  }, [])

  const handleSend = useCallback(async () => {
    const inputTrimmed = inputRef.current.trim()
    const currentConvId = convIdRef.current
    const currentMentionedAgentIds = mentionedAgentIdsRef.current
    const { getSuggestedFollowUp, clearSuggestedFollowUp } = useConversationRuntimeStore.getState()

    // Slash command execution happens only when user explicitly sends.
    // Clear input BEFORE the async compact to avoid stale text visible during LLM call.
    if (inputTrimmed === '/compact') {
      setInput('')
      setMentionedAgentIds([])
      setInputResetToken((v) => v + 1)
      await handleSlashCommand('compact')
      return
    }

    // /image <prompt> — AI image generation
    if (inputTrimmed.startsWith('/image')) {
      const prompt = inputTrimmed.slice(6).trim()
      setInput('')
      setMentionedAgentIds([])
      setInputResetToken((v) => v + 1)
      if (!prompt) {
        toast.error(t('conversation.imageGen.emptyPrompt'))
        return
      }
      await handleSlashCommand('image', prompt)
      return
    }

    let textToSend = inputTrimmed
      ? inputRef.current
      : currentConvId
        ? getSuggestedFollowUp(currentConvId)
        : ''
    if (textToSend) {
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

  const handleEditAndResend = useCallback(
    (userMessageId: string, newContent: string) => {
      const currentConvId = convIdRef.current
      if (!currentConvId) return
      editAndResendUserMessage(currentConvId, userMessageId, newContent)
    },
    [editAndResendUserMessage]
  )

  const handleRegenerate: ((id: string) => void) | undefined = convId
    ? useCallback(
        (id: string) => regenerateUserMessage(convId, id),
        [convId, regenerateUserMessage]
      )
    : undefined

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
