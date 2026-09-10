/**
 * ConversationView - pure conversation display and interaction.
 *
 * Components & logic are split into:
 *   - useConversationLogic  — store selectors, effects, handlers
 *   - useInitialMessage     — initial message send-on-mount
 *   - ConversationMessages   — message turn rendering
 *   - ConversationEmptyState — empty conversation placeholder
 *   - AgentDropdown          — agent selector dropdown
 *   - ThinkingDropdown       — thinking mode toggle
 *   - ContextUsageBar        — context window usage display
 */

import { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react'
import { Send, StopCircle, AlertTriangle, RefreshCw, WifiOff, KeyRound, ImageIcon, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/i18n'
import { ErrorBoundary } from '@/components/error/ErrorBoundary'
import { AgentRichInput, type AgentRichInputHandle } from './AgentRichInput'
import { ImageGenQuickChip } from './ImageGenQuickChip'
import { AgentModeSelect } from './AgentModeSelect'
import { RunEndPolicySelect } from './RunEndPolicySelect'
import { useConversationLogic } from './useConversationLogic'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { useSettingsStore } from '@/store/settings.store'
import { useExtensionStore } from '@/store/extension.store'
import type { FileMentionItem } from './FileMentionExtension'
import { useInitialMessage } from './useInitialMessage'
import { ConversationMessages } from './ConversationMessages'
import type { ConversationMessagesHandle } from './ConversationMessages'
import { ConversationUsageBar } from './ConversationUsageBar'
import { ConversationEmptyState } from './ConversationEmptyState'
import { AgentDropdown } from './AgentDropdown'
import { ThinkingDropdown } from './ThinkingDropdown'
import { ContextUsageBar } from './ContextUsageBar'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { MessageNavBar } from './MessageNavBar'
import { AssetsPopover } from './AssetsPopover'
import { ProcessesPopover } from './ProcessesPopover'
import { ConversationActionContext } from './ConversationActionContext'
import { supportsImageInput } from '@/agent/llm/pi-ai-model-resolver'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@creatorweave/ui'
import { captureTab, isPageActionAvailable } from '@/agent/tools/page-action-bridge'
import { useAssetStore } from '@/store/asset.store'
import { PageScreenshotCropDialog } from './PageScreenshotCropDialog'
import { FlowCanvasPanel } from './FlowCanvasPanel'

const VisionCapabilityIndicator = memo(function VisionCapabilityIndicator({
  modelName,
  canCapture,
  isCapturing,
  onCapture,
}: {
  modelName: string
  canCapture: boolean
  isCapturing: boolean
  onCapture: () => void
}) {
  const t = useT()
  const supportsVision = supportsImageInput(modelName)
  const label = !supportsVision
    ? t('agent.vision.unsupported')
    : canCapture
      ? t('agent.vision.capture')
      : t('agent.vision.supported')

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <button
              type="button"
              aria-label={label}
              disabled={!canCapture || isCapturing}
              onClick={onCapture}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                !supportsVision
                  ? 'bg-neutral-50 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-600'
                  : 'bg-primary-50 text-primary-600 dark:bg-primary-50/40 dark:text-primary-700'
              }`}
            >
              {isCapturing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})

/**
 * Memoized usage bar — the outer flex column re-renders while its scroll
 * container stays untouched, so without memo every scroll-follower update
 * would re-aggregate usage for the whole conversation.
 */
const ConversationUsageBarMemo = memo(ConversationUsageBar)

/** Send / Cancel button — memoized to only re-render when its specific props change */
const SendCancelButton = memo(function SendCancelButton({
  isProcessing,
  isSendDisabled,
  onSend,
  onCancel,
  sendTitle,
  cancelTitle,
}: {
  isProcessing: boolean
  isSendDisabled: boolean
  onSend: () => void
  onCancel: () => void
  sendTitle: string
  cancelTitle: string
}) {
  // When processing and send is disabled (no input), show only cancel
  if (isProcessing && isSendDisabled) {
    return (
      <button
        type="button"
        onClick={onCancel}
        className="absolute bottom-4 right-4 rounded-xl bg-red-600 p-2 text-white shadow-sm transition-colors hover:bg-red-700"
        title={cancelTitle}
      >
        <StopCircle className="h-4 w-4" />
      </button>
    )
  }
  // When processing but user has typed text, show both send (queue) and cancel
  if (isProcessing && !isSendDisabled) {
    return (
      <>
        <button
          type="button"
          onClick={onSend}
          className="absolute bottom-4 right-4 rounded-xl bg-primary-600 p-2 text-white shadow-sm transition-colors hover:bg-primary-700"
          title={sendTitle}
        >
          <Send className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="absolute bottom-4 right-14 rounded-xl bg-red-600 p-2 text-white shadow-sm transition-colors hover:bg-red-700"
          title={cancelTitle}
        >
          <StopCircle className="h-4 w-4" />
        </button>
      </>
    )
  }
  return (
    <button
      type="button"
      onClick={onSend}
      disabled={isSendDisabled}
      className="absolute bottom-4 right-4 rounded-xl bg-primary-600 p-2 text-white shadow-sm transition-colors hover:bg-primary-700 disabled:opacity-30 disabled:hover:bg-primary-600"
      title={sendTitle}
    >
      <Send className="h-4 w-4" />
    </button>
  )
})

interface ConversationViewProps {
  initialMessage?: string | null
  onInitialMessageConsumed?: () => void
  disabled?: boolean
  /** Open the file preview drawer with a pre-loaded blob (from AssetsPopover) */
  onPreviewAsset?: (fileName: string, blob: Blob) => void
}

export function ConversationView({
  initialMessage,
  onInitialMessageConsumed,
  disabled = false,
  onPreviewAsset,
}: ConversationViewProps) {
  const t = useT()
  const autoApplyOnRunComplete = useWorkspacePreferencesStore((s) => s.autoApplyOnRunComplete)
  const setAutoApplyOnRunComplete = useWorkspacePreferencesStore((s) => s.setAutoApplyOnRunComplete)
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null)
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false)
  const conversationMessagesRef = useRef<ConversationMessagesHandle>(null)
  const richInputRef = useRef<AgentRichInputHandle>(null)
  const modelName = useSettingsStore((s) => s.modelName)

  const logic = useConversationLogic()
  const {
    hasInput, setInput, setMentionedAgentIds, inputResetToken, messagesEndRef, scrollContainerRef,
    isUserAtBottomRef,
    draftTextToRestore, onDraftRestored,
    allAgents, activeAgentId, setActiveAgent, createAgent, deleteAgent, mentionAgents,
    convId, activeMessages,
    conversationError, activeContextWindowUsage,
    isProcessing, status, suggestedFollowUp, toolResults,
    hasApiKey, enableThinking, thinkingLevel, setEnableThinking, setThinkingLevel,
    agentMode, setAgentMode,
    sendMessage, handleSend, handleCancel,
    handleDeleteAgentLoop, handleEditAndResend, handleRegenerate,
    queueDepth,
  } = logic

  // ── Retry handler for error banner: send "继续" to start a new loop ──
  const handleRetry = useCallback(() => {
    if (!convId) return
    sendMessage('继续')
  }, [convId, sendMessage])

  const supportsVision = supportsImageInput(modelName)
  const canCaptureScreenshot = supportsVision && isPageActionAvailable()

  const handleCaptureScreenshot = useCallback(async () => {
    if (!canCaptureScreenshot || isCapturingScreenshot) return
    setIsCapturingScreenshot(true)
    try {
      const result = await captureTab('png')
      if (!result.ok || !result.dataUrl) {
        throw new Error(result.error || t('agent.pageScreenshot.captureFailed'))
      }
      setScreenshotDataUrl(result.dataUrl)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('agent.pageScreenshot.captureFailed'))
    } finally {
      setIsCapturingScreenshot(false)
    }
  }, [canCaptureScreenshot, isCapturingScreenshot, t])

  const handleScreenshotConfirm = useCallback((file: File) => {
    useAssetStore.getState().addFiles([file])
    setScreenshotDataUrl(null)
    richInputRef.current?.focus()
  }, [])

  // ── File search for # file mention ──
  // isComposing ref is toggled by AgentRichInput via onSetIsComposing callback
  const isComposingRef = useRef(false)
  const searchReqIdRef = useRef(0)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchFiles = useCallback(
    async (query: string): Promise<FileMentionItem[]> => {
      // Guard: skip search while IME is composing (pinyin letters should not trigger search)
      if (isComposingRef.current) return []
      const normalizedQuery = query.trim().toLowerCase()
      // Monotonic request ID — lets us discard stale results
      const reqId = ++searchReqIdRef.current

      const scoreItem = (path: string, name: string, isDirectory: boolean, q: string) => {
        const lowerPath = path.toLowerCase()
        const lowerName = name.toLowerCase()
        const firstSegment = lowerPath.split(/[\\/]/)[0] ?? ''
        const qLower = q.toLowerCase()
        const depth = lowerPath.split(/[\\/]/).length
        if (!qLower) {
          return [isDirectory ? 0 : 1, depth, lowerPath.length]
        }
        if (lowerName === qLower) return [0, depth, lowerPath.length]
        if (firstSegment === qLower) return [0.2, depth, lowerPath.length]
        if (lowerName.startsWith(qLower)) return [1, depth, lowerPath.length]
        if (firstSegment.startsWith(qLower)) return [1.2, depth, lowerPath.length]
        if (lowerPath.endsWith(`/${qLower}`) || lowerPath.endsWith(qLower)) return [2, depth, lowerPath.length]
        if (lowerName.includes(qLower)) return [3, depth, lowerPath.length]
        if (lowerPath.includes(qLower)) return [4, depth, lowerPath.length]
        return [100, depth, lowerPath.length]
      }

      const compareItems = (a: FileMentionItem, b: FileMentionItem, q: string) => {
        const sa = scoreItem(a.path, a.name, !!a.isDirectory, q)
        const sb = scoreItem(b.path, b.name, !!b.isDirectory, q)
        if (sa[0] !== sb[0]) return sa[0] - sb[0]
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        if (sa[1] !== sb[1]) return sa[1] - sb[1]
        if (sa[2] !== sb[2]) return sa[2] - sb[2]
        return a.path.localeCompare(b.path)
      }

      const toItems = (paths: string[]): FileMentionItem[] =>
        paths.map((p) => {
          const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
          const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : undefined
          const isDirectory = !name.includes('.')
          return { path: p, name, extension: ext, isDirectory }
        })

      try {
        // Use the shared local file path cache from folder-access.store.
        const { useFolderAccessStore } = await import('@/store/folder-access.store')
        let allPaths = await useFolderAccessStore.getState().ensureFilePaths()

        if (reqId !== searchReqIdRef.current) return []

        // Merge OPFS cachedPaths for pending files not yet on disk
        const { useOPFSStore } = await import('@/store/opfs.store')
        const opfsCached = useOPFSStore.getState().cachedPaths
        if (opfsCached.length > 0) {
          const existing = new Set(allPaths)
          const mergedPaths = [...allPaths]
          for (const p of opfsCached) {
            if (!existing.has(p)) mergedPaths.push(p)
          }
          allPaths = mergedPaths
        }

        if (reqId !== searchReqIdRef.current) return []

        if (!normalizedQuery) {
          return toItems(allPaths)
            .sort((a, b) => compareItems(a, b, normalizedQuery))
            .slice(0, 10)
        }

        const rootMatches = toItems(allPaths)
          .filter((item) => item.path.toLowerCase().split(/[\\/]/)[0] === normalizedQuery)
          .sort((a, b) => compareItems(a, b, normalizedQuery))
          .slice(0, 3)

        if (rootMatches.length > 0) {
          const rest = toItems(allPaths)
            .filter((item) => !rootMatches.some((m) => m.path === item.path))
            .filter((item) => item.path.toLowerCase().includes(normalizedQuery) || item.name.toLowerCase().includes(normalizedQuery))
            .sort((a, b) => compareItems(a, b, normalizedQuery))
            .slice(0, 7)
          return [...rootMatches, ...rest].slice(0, 10)
        }

        return toItems(allPaths)
          .filter((item) => item.path.toLowerCase().includes(normalizedQuery) || item.name.toLowerCase().includes(normalizedQuery))
          .sort((a, b) => compareItems(a, b, normalizedQuery))
          .slice(0, 10)
      } catch (err) {
        console.warn('[handleSearchFiles] error:', err)
        return []
      }
    },
    [],
  )

  /** Debounced wrapper — 200ms delay to avoid hammering search on every keystroke. */
  const debouncedSearchFiles = useCallback(
    (query: string): Promise<FileMentionItem[]> => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }
      return new Promise<FileMentionItem[]>((resolve) => {
        searchTimerRef.current = setTimeout(() => {
          handleSearchFiles(query).then(resolve)
        }, 200)
      })
    },
    [handleSearchFiles],
  )

  const setIsComposing = useCallback(
    (v: boolean) => { isComposingRef.current = v },
    [],
  )

  // ── Stable onChange for AgentRichInput ──
  const handleInputChange = useCallback(
    ({ text, mentionedAgentIds: ids }: { text: string; mentionedAgentIds: string[] }) => {
      setInput(text)
      setMentionedAgentIds(ids)
    },
    [setInput, setMentionedAgentIds],
  )

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [])

  // ── Initial message handling ──
  useInitialMessage({
    initialMessage,
    convId,
    isRunning: logic.isRunning,
    sendMessage: logic.sendMessage,
    onConsumed: onInitialMessageConsumed,
  })

  // ── Auto-focus input on a fresh (empty) conversation ──
  // So clicking "new conversation" drops you straight into typing. Only focuses
  // empty conversations — never steals focus when switching back to an existing
  // thread that has a body of messages.
  useEffect(() => {
    if (!convId) return
    if (activeMessages.length > 0) return
    // Defer to next frame so the TipTap editor has mounted and can accept focus.
    const raf = requestAnimationFrame(() => richInputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [convId, activeMessages.length])

  // ── Image quick chip: pre-fill an example prompt into the editor ──
  const handleChipPrefill = useCallback((text: string) => {
    richInputRef.current?.setText(text)
  }, [])

  // ── Stable error handler for ErrorBoundary ──
  const handleErrorBoundaryError = useCallback(
    (error: Error) => {
      console.error('[ConversationView] Error:', error)
      if (convId) {
        useConversationRuntimeStore.getState().resetConversationState(convId)
      }
    },
    [convId],
  )

  // ── Re-focus input after sending ──
  const handleSendAndFocus = useCallback(async () => {
    await handleSend()
    // Defer focus to next frame so the editor has cleared its content
    requestAnimationFrame(() => richInputRef.current?.focus())
  }, [handleSend])

  // Memoize the context value to avoid unnecessary re-renders
  const actionContextValue = useMemo(() => ({ setInput, sendMessage: logic.sendMessage }), [setInput, logic.sendMessage])

  return (
    <ConversationActionContext.Provider value={actionContextValue}>
    <ErrorBoundary
      onError={handleErrorBoundaryError}
    >
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-white dark:bg-neutral-950">
        {/* Cumulative token usage across all turns — rendered OUTSIDE the scroll
            container (NOT sticky inside it). Sticky inside the scroller only
            works while its parent block is in view; under virtual scrolling the
            bar lived in Virtuoso's Header and scrolled away with the content.
            Mounting it as a fixed row above the scroller keeps it pinned for
            both render paths. It is conditionally rendered (returns null when a
            conversation has no usage yet) and memoized so long-conversation
            streaming does not re-render it on every token. */}
        {activeMessages.length > 0 && <ConversationUsageBarMemo messages={activeMessages} />}

        {/* Messages area */}
        <div className="relative min-h-0 flex-1">
          <div ref={scrollContainerRef} className="custom-scrollbar absolute inset-0 overflow-y-auto">
          {activeMessages.length === 0 && !isProcessing ? (
            <ConversationEmptyState />
          ) : (
            <ConversationMessages
              ref={conversationMessagesRef}
              activeMessages={activeMessages}
              toolResults={toolResults}
              isProcessing={isProcessing}
              status={status}
              onDeleteAgentLoop={handleDeleteAgentLoop}
              onEditAndResend={handleEditAndResend}
              onRegenerate={handleRegenerate}
              onCancel={handleCancel}
              messagesEndRef={messagesEndRef}
              isUserAtBottomRef={isUserAtBottomRef}
              conversationId={convId}
              mentionAgents={mentionAgents}
              onSearchFiles={debouncedSearchFiles}
              onPreviewAsset={onPreviewAsset}
            />
          )}
        </div>

        {/* Scroll-to-bottom floating button — isolated component to avoid re-rendering ConversationView on scroll */}
        <ScrollToBottomButton
          scrollContainerRef={scrollContainerRef}
          messagesEndRef={messagesEndRef}
          isUserAtBottomRef={isUserAtBottomRef}
          convId={convId ?? undefined}
        />

        {/* Assets popover — small trigger button, expands to show workspace assets */}
        <AssetsPopover convId={convId ?? undefined} onPreviewAsset={onPreviewAsset} />

        {/* Background processes popover — dev servers etc started via exec */}
        <ProcessesPopover />

        {/* Message navigation dots */}
        {activeMessages.length > 1 && (
          <MessageNavBar
            messagesHandle={conversationMessagesRef}
            scrollContainerRef={scrollContainerRef}
            messageCount={activeMessages.length}
          />
        )}

      </div>

        {conversationError && (
          <ConversationErrorBanner error={conversationError} onRetry={handleRetry} />
        )}

        {/* Flow canvas panel — overlay, opened from the TopBar workflow button */}
        <FlowCanvasPanel conversationId={convId} />

        {/* Input area */}
        <div className="shrink-0 border-t border-neutral-200 bg-white px-2 py-2 dark:border-neutral-700 dark:bg-neutral-900 sm:px-4 sm:py-3">
          <div className="mx-auto flex max-w-3xl flex-col">
            {/* Quick chip — shares the generate_image availability gate, so it
                only ever promises what the current provider can deliver. */}
            <ImageGenQuickChip onPrefill={handleChipPrefill} />
            <div className="relative">
              <AgentRichInput
                ref={richInputRef}
                key={convId ?? 'new'}
                placeholder={
                  suggestedFollowUp ||
                  (isProcessing
                    ? t('conversation.input.placeholderQueuing')
                    : hasApiKey
                      ? t('conversation.input.placeholder')
                      : t('conversation.input.placeholderNoKey'))
                }
                ariaLabel={t('conversation.input.ariaLabel')}
                disabled={!hasApiKey || disabled}
                resetToken={inputResetToken}
                initialText={draftTextToRestore ?? undefined}
                onDraftRestored={onDraftRestored}
                agents={mentionAgents}
                onSearchFiles={debouncedSearchFiles}
                onSetIsComposing={setIsComposing}
                isProcessing={isProcessing}
                onCancel={handleCancel}
                activeAgentId={activeAgentId}
                allAgents={allAgents}
                onSetActiveAgent={setActiveAgent}
                onCreateAgent={createAgent}
                onDeleteAgent={deleteAgent}
                onChange={handleInputChange}
                onSubmit={handleSendAndFocus}
                onSlashCommand={logic.handleSlashCommand}
                leadingAccessory={(
                  <VisionCapabilityIndicator
                    modelName={modelName}
                    canCapture={canCaptureScreenshot}
                    isCapturing={isCapturingScreenshot}
                    onCapture={() => void handleCaptureScreenshot()}
                  />
                )}
              />
              <SendCancelButton
                isProcessing={isProcessing}
                isSendDisabled={(!hasInput && !suggestedFollowUp) || !hasApiKey || disabled}
                onSend={handleSendAndFocus}
                onCancel={handleCancel}
                sendTitle={t('conversation.buttons.send')}
                cancelTitle={t('conversation.buttons.stop')}
              />
              {isProcessing && queueDepth > 0 && (!hasInput && !suggestedFollowUp) && (
                <span className="absolute bottom-4 right-14 rounded-full bg-primary-100 px-2 py-0.5 text-xs font-medium text-primary-700 dark:bg-primary-100/30 dark:text-primary-700">
                  {t('conversation.queue.badge', { count: queueDepth })}
                </span>
              )}
            </div>
          </div>

          {/* Compact toolbar row */}
          <div className="mx-auto mt-1.5 flex max-w-3xl flex-col gap-1.5 sm:mt-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2 pt-0.5 sm:flex-nowrap sm:pt-0">
              <AgentDropdown
                allAgents={allAgents}
                activeAgentId={activeAgentId}
                setActiveAgent={setActiveAgent}
                deleteAgent={deleteAgent}
              />
              <ThinkingDropdown
                enableThinking={enableThinking}
                thinkingLevel={thinkingLevel}
                setEnableThinking={setEnableThinking}
                setThinkingLevel={setThinkingLevel}
              />
              <AgentModeSelect mode={agentMode} onModeChange={setAgentMode} />
              <RunEndPolicySelect
                runEndPolicy={autoApplyOnRunComplete ? 'auto' : 'manual'}
                onRunEndPolicyChange={(policy) => setAutoApplyOnRunComplete(policy === 'auto')}
                disabled={disabled}
              />
            </div>
            <div className="flex items-center gap-2 self-start sm:self-auto">
              <ContextUsageBar contextWindowUsage={activeContextWindowUsage} isProcessing={isProcessing} />
            </div>
          </div>
        </div>
      </div>

      {screenshotDataUrl && (
        <PageScreenshotCropDialog
          imageDataUrl={screenshotDataUrl}
          onConfirm={handleScreenshotConfirm}
          onCancel={() => setScreenshotDataUrl(null)}
        />
      )}

    </ErrorBoundary>
    </ConversationActionContext.Provider>
  )
}

// =============================================================================
// CodexErrorBanner — detects codex-oauth error codes and shows actionable UI
// =============================================================================

const CODEX_ERROR_PATTERNS: Array<{
  codes: string[]
  icon: typeof AlertTriangle
  color: 'red' | 'amber' | 'blue'
  getTitleKey: () => string
  getDescriptionKey: () => string
  action?: { labelKey: string; onClick: (store: ReturnType<typeof useExtensionStore.getState>) => void }
}> = [
  {
    codes: ['NOT_AUTHORIZED', 'REAUTH_REQUIRED'],
    icon: KeyRound,
    color: 'amber',
    getTitleKey: () => 'conversation.codex.error.authRequired',
    getDescriptionKey: () => 'conversation.codex.error.authRequiredDesc',
    action: {
      labelKey: 'conversation.codex.error.openExtension',
      onClick: (store) => store.openInstallGuide?.(),
    },
  },
  {
    codes: ['EXTENSION_UNAVAILABLE'],
    icon: WifiOff,
    color: 'amber',
    getTitleKey: () => 'conversation.codex.error.extensionRequired',
    getDescriptionKey: () => 'conversation.codex.error.extensionRequiredDesc',
    action: {
      labelKey: 'conversation.codex.error.installExtension',
      onClick: (store) => store.openInstallGuide?.(),
    },
  },
  {
    codes: ['UPSTREAM_RATE_LIMITED'],
    icon: RefreshCw,
    color: 'blue',
    getTitleKey: () => 'conversation.codex.error.rateLimited',
    getDescriptionKey: () => 'conversation.codex.error.rateLimitedDesc',
  },
  {
    codes: ['NETWORK_ERROR'],
    icon: WifiOff,
    color: 'red',
    getTitleKey: () => 'conversation.codex.error.networkError',
    getDescriptionKey: () => 'conversation.codex.error.networkErrorDesc',
  },
]

function parseErrorCode(errorMessage: string): string | null {
  // Error messages from the streaming bridge have format "[ERROR_CODE] message"
  const bracketMatch = errorMessage.match(/^\[([A-Z_]+)\]/)
  if (bracketMatch) return bracketMatch[1]

  // Exact-match known codes (no fuzzy matching — too many false positives)
  const exactMatch = [
    'EXTENSION_UNAVAILABLE', 'NOT_AUTHORIZED', 'REAUTH_REQUIRED',
    'UPSTREAM_RATE_LIMITED', 'UPSTREAM_SERVER_ERROR',
  ].find((code) => errorMessage.startsWith(code))
  if (exactMatch) return exactMatch

  return null
}

const colorClasses = {
  red: {
    border: 'border-red-200 dark:border-red-900/40',
    bg: 'bg-red-50 dark:bg-red-950/30',
    text: 'text-red-700 dark:text-red-300',
    mutedText: 'text-red-600 dark:text-red-400',
    icon: 'text-red-500 dark:text-red-400',
  },
  amber: {
    border: 'border-amber-200 dark:border-amber-800',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    text: 'text-amber-800 dark:text-amber-200',
    mutedText: 'text-amber-600 dark:text-amber-400',
    icon: 'text-amber-500 dark:text-amber-400',
  },
  blue: {
    border: 'border-blue-200 dark:border-blue-800',
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    text: 'text-blue-800 dark:text-blue-200',
    mutedText: 'text-blue-600 dark:text-blue-400',
    icon: 'text-blue-500 dark:text-blue-400',
  },
}

/**
 * Error banner — shows Codex-specific actionable UI when the current provider
 * is codex-oauth and the error matches a known code.  For all other providers
 * (or unrecognised errors), falls back to a generic red bar.
 */
const ConversationErrorBanner = memo(function ConversationErrorBanner({
  error,
  onRetry,
}: {
  error: string
  onRetry?: () => void
}) {
  const t = useT()
  const providerType = useSettingsStore((s) => s.providerType)
  const isCodex = (providerType as string) === 'codex-oauth'

  const store = useExtensionStore.getState()

  // Only match Codex patterns when the active provider is codex-oauth
  const errorCode = isCodex ? parseErrorCode(error) : null
  const pattern = errorCode
    ? CODEX_ERROR_PATTERNS.find((p) => p.codes.includes(errorCode))
    : null

  // Fallback: generic error banner
  if (!pattern) {
    return (
      <div className="border-t border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500 dark:text-red-400" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t('conversation.error.requestFailed')}</p>
              <p className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all pr-1 text-red-600 dark:text-red-400">
                {error}
              </p>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700"
                >
                  <RefreshCw className="h-3 w-3" />
                  {t('conversation.error.retry')} →
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const Icon = pattern.icon
  const colors = colorClasses[pattern.color]

  return (
    <div className={`border-t ${colors.border} ${colors.bg} px-4 py-3 text-sm`}>
      <div className="mx-auto max-w-3xl">
        <div className="flex items-start gap-2.5">
          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${colors.icon}`} />
          <div className="min-w-0 flex-1">
            <p className={`font-medium ${colors.text}`}>
              {t(pattern.getTitleKey())}
            </p>
            <p className={`mt-0.5 ${colors.mutedText}`}>
              {t(pattern.getDescriptionKey())}
            </p>
            {pattern.action && (
              <button
                type="button"
                onClick={() => pattern.action!.onClick(store)}
                className={`mt-2 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors ${
                  pattern.color === 'amber'
                    ? 'bg-amber-600 hover:bg-amber-700'
                    : pattern.color === 'blue'
                      ? 'bg-blue-600 hover:bg-blue-700'
                      : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {t(pattern.action.labelKey)} →
              </button>
            )}
            {!pattern.action && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-neutral-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800"
              >
                <RefreshCw className="h-3 w-3" />
                {t('conversation.error.retry')} →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
