import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import HardBreak from '@tiptap/extension-hard-break'
import History from '@tiptap/extension-history'
import Mention from '@tiptap/extension-mention'
import { FileMention, type FileMentionItem } from './FileMentionExtension'
import { SlashCommandExtension, type SlashCommandItem } from './SlashCommandExtension'
import { Plus, Trash2, Check, FileIcon, FolderIcon, Paperclip, X, ImageIcon, Loader2, FileText } from 'lucide-react'
import { useT } from '@/i18n'
import { useAssetStore } from '@/store/asset.store'
import { extractDroppedFiles } from '@/lib/dragdrop'
import { Lightbox } from './Lightbox'
import { MarkdownContent } from './MarkdownContent'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMentionCandidate {
  id: string
  name?: string
}

export interface AgentRichInputValue {
  text: string
  mentionedAgentIds: string[]
}

export interface AgentInfo {
  id: string
  name?: string
}

/** Imperative handle exposed by AgentRichInput via forwardRef */
export interface AgentRichInputHandle {
  focus: () => void
  /** Programmatically replace the editor content (e.g. quick-chip prefill). */
  setText: (text: string) => void
}

interface AgentRichInputProps {
  ariaLabel?: string
  placeholder: string
  disabled?: boolean
  resetToken?: number
  /** Initial text to populate the editor with (e.g. restored draft). */
  initialText?: string
  /** Called after initialText has been successfully injected into the editor. */
  onDraftRestored?: () => void
  agents: AgentMentionCandidate[]
  onSubmit: () => void
  onChange: (value: AgentRichInputValue) => void
  /** Async file search callback for # file mention. */
  onSearchFiles?: (query: string) => Promise<FileMentionItem[]>
  /** Called when IME composition starts/ends — lets the parent suppress search during composition. */
  onSetIsComposing?: (composing: boolean) => void
  /** Whether the agent is currently processing (running). */
  isProcessing?: boolean
  /** Called when user presses Escape while the agent is processing. */
  onCancel?: () => void
  // Agent selector props
  activeAgentId: string | null
  allAgents: AgentMentionCandidate[]
  onSetActiveAgent: (id: string) => Promise<void>
  onCreateAgent: (id: string) => Promise<AgentInfo | null>
  onDeleteAgent: (id: string) => Promise<boolean>
  /** Slash command callback (e.g. 'compact'). */
  onSlashCommand?: (command: string) => void
  /** Optional action rendered directly below the attachment button. */
  leadingAccessory?: ReactNode
}

// ---------------------------------------------------------------------------
// Suggestion dropdown – imperative handle so the Mention extension can
// drive keyboard navigation without extra React state wiring.
// ---------------------------------------------------------------------------

interface SuggestionDropdownHandle {
  onKeyDown: (event: KeyboardEvent) => boolean
}

interface SuggestionDropdownProps<T> {
  items: T[]
  getItemKey: (item: T) => string
  onSelect: (item: T) => void
  renderItem: (item: T, isSelected: boolean) => React.ReactNode
  width?: string // default 'w-72'
  selectedColor?: string // default 'bg-primary-50 text-primary-700 dark:bg-primary-100/40 dark:text-primary-700'
}

const SuggestionDropdown = forwardRef(
  function SuggestionDropdown<T>(
    {
      items,
      getItemKey,
      onSelect,
      renderItem,
      width = 'w-72',
      selectedColor = 'bg-primary-50 text-primary-700 dark:bg-primary-100/40 dark:text-primary-700',
    }: SuggestionDropdownProps<T>,
    ref: React.Ref<SuggestionDropdownHandle>,
  ) {
    const [selectedIndex, setSelectedIndex] = useState(0)
    const selectedRef = useRef(0)
    const scrollContainerRef = useRef<HTMLDivElement>(null)

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index]
        if (item) onSelect(item)
      },
      [items, onSelect],
    )

    useEffect(() => {
      setSelectedIndex(0)
      selectedRef.current = 0
    }, [items])

    // Scroll the selected item into view when navigating with arrow keys
    useEffect(() => {
      const container = scrollContainerRef.current
      if (!container) return
      const selectedEl = container.querySelector<HTMLElement>(
        `[data-idx="${selectedIndex}"]`
      )
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' })
      }
    }, [selectedIndex])

    useImperativeHandle(ref, () => ({
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === 'ArrowUp') {
          setSelectedIndex((idx) => {
            const next = Math.max(0, idx - 1)
            selectedRef.current = next
            return next
          })
          return true
        }
        if (event.key === 'ArrowDown') {
          setSelectedIndex((idx) => {
            const max = Math.max(items.length - 1, 0)
            const next = idx >= max ? max : idx + 1
            selectedRef.current = next
            return next
          })
          return true
        }
        if (event.key === 'Enter') {
          if (items.length === 0) return true // prevent accidental submit
          selectItem(selectedRef.current)
          return true
        }
        return false
      },
    }))

    if (items.length === 0) return null

    return (
      <div
        role="listbox"
        aria-label="Suggestions"
        className={`absolute bottom-full left-0 z-20 mb-2 ${width} overflow-hidden rounded-lg border border-neutral-200 bg-card shadow-lg dark:border-neutral-700 dark:bg-neutral-900`}
      >
        <div ref={scrollContainerRef} className="max-h-96 overflow-y-auto py-1">
          {items.map((item, idx) => {
            const selected = idx === selectedIndex
            return (
              <button
                key={getItemKey(item)}
                data-idx={idx}
                type="button"
                role="option"
                aria-selected={selected}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? selectedColor
                    : 'hover:bg-neutral-100 dark:text-foreground dark:hover:bg-neutral-800'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectItem(idx)
                }}
              >
                {renderItem(item, selected)}
              </button>
            )
          })}
        </div>
      </div>
    )
  },
) as <T>(
  props: SuggestionDropdownProps<T> & { ref?: React.Ref<SuggestionDropdownHandle> },
) => React.ReactElement | null

// ---------------------------------------------------------------------------
// Input history (terminal-style ↑/↓ navigation)
// ---------------------------------------------------------------------------

const INPUT_HISTORY_KEY = 'creatorweave:input-history'
const MAX_HISTORY = 50

function loadInputHistory(): string[] {
  try {
    const raw = localStorage.getItem(INPUT_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(-MAX_HISTORY) : []
  } catch {
    return []
  }
}

function saveInputHistory(history: string[]): void {
  try {
    localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY)))
  } catch {
    // ignore quota / serialization errors — history is best-effort
  }
}

/** Append a sent message to history (dedup consecutive duplicates). */
function appendToHistory(history: string[], text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return history
  const last = history[history.length - 1]
  if (last === trimmed) return history
  const next = [...history, trimmed].slice(-MAX_HISTORY)
  saveInputHistory(next)
  return next
}

// ---------------------------------------------------------------------------
// Helpers – extract plain text & mention IDs from editor document
// ---------------------------------------------------------------------------

/**
 * Walk the ProseMirror document and produce a plain-text string where each
 * mention node is rendered as `@<id>`.  This keeps the output compatible
 * with the downstream `extractFirstMentionedAgentId` / regex-based consumers.
 */
function getPlainText(editor: Editor): string {
  const { doc } = editor.state
  const lines: string[] = []
  let lineBuf = ''

  doc.descendants((node) => {
    if (node.isText) {
      lineBuf += node.text ?? ''
    } else if (node.type.name === 'mention') {
      const id = node.attrs.id ?? ''
      // Downstream regex `extractFirstMentionedAgentId` requires a space or
      // line-start before `@`.  Ensure we never produce bare `foo@bar`.
      if (id && lineBuf.length > 0 && !/[\s\n]$/.test(lineBuf)) {
        lineBuf += ' '
      }
      lineBuf += `@${id}`
    } else if (node.type.name === 'fileMention') {
      const path = node.attrs.path ?? ''
      if (path && lineBuf.length > 0 && !/[\s\n]$/.test(lineBuf)) {
        lineBuf += ' '
      }
      lineBuf += `#${path}`
    } else if (node.type.name === 'hardBreak') {
      lineBuf += '\n'
    } else if (node.type.isBlock && lineBuf) {
      lines.push(lineBuf)
      lineBuf = ''
    }
  })
  if (lineBuf) lines.push(lineBuf)
  return lines.join('\n')
}

function getMentionedAgentIds(editor: Editor): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'mention') {
      const id: string | undefined = node.attrs.id
      if (id && id !== 'default' && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
  })
  return ids
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// AgentRichInput
// ---------------------------------------------------------------------------

export const AgentRichInput = forwardRef<AgentRichInputHandle, AgentRichInputProps>(function AgentRichInput({
  ariaLabel,
  placeholder,
  disabled = false,
  resetToken = 0,
  initialText,
  onDraftRestored,
  agents,
  onSubmit,
  onChange,
  onSearchFiles,
  onSetIsComposing,
  isProcessing,
  onCancel,
  activeAgentId,
  allAgents,
  onSetActiveAgent,
  onCreateAgent,
  onDeleteAgent,
  onSlashCommand,
  leadingAccessory,
}: AgentRichInputProps, ref) {
  const t = useT()
  const [isFocused, setIsFocused] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  // Markdown preview: rendered in a Lightbox (children mode) when the user
  // clicks a .md attachment chip before sending.
  const [mdPreviewContent, setMdPreviewContent] = useState<{ name: string; text: string } | null>(null)
  const [mdPreviewLoading, setMdPreviewLoading] = useState(false)
  // Agent selector state
  const [showAgentSelector, setShowAgentSelector] = useState(false)
  const [isCreatingAgent, setIsCreatingAgent] = useState(false)
  const [newAgentInput, setNewAgentInput] = useState('')
  const [agentSelection, setAgentSelection] = useState(0)
  const [isDragOver, setIsDragOver] = useState(false)
  /** True while dropped folders are being expanded into files. */
  const [isExtractingDropped, setIsExtractingDropped] = useState(false)

  // ---- Input history navigation (↑/↓) ------------------------------------
  const [inputHistory, setInputHistory] = useState<string[]>(() => loadInputHistory())
  const inputHistoryRef = useRef(inputHistory)
  useEffect(() => { inputHistoryRef.current = inputHistory }, [inputHistory])
  /** null = not navigating history; otherwise an index into inputHistory. */
  const navIndexRef = useRef<number | null>(null)
  /** True while we are programmatically setting editor content (history nav) —
   *  used to avoid resetting navIndex in onUpdate for programmatic changes. */
  const isProgrammaticUpdateRef = useRef(false)

  // Asset upload state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingAssets = useAssetStore((s) => s.pendingAssets)
  const addFiles = useAssetStore((s) => s.addFiles)
  const removeAsset = useAssetStore((s) => s.removeAsset)

  // Handle files from file picker or drag-drop
  const handleFiles = useCallback(
    (fileList: FileList | File[]) => {
      const files = Array.from(fileList)
      if (files.length > 0) addFiles(files)
    },
    [addFiles],
  )

  /**
   * Open a modal preview of a pending markdown attachment.
   * Reads the file text, then renders it via MarkdownContent inside the
   * shared Lightbox (children mode) — mirroring the image lightbox flow.
   */
  const handlePreviewMarkdown = useCallback(async (asset: { file: File; name: string }) => {
    setMdPreviewLoading(true)
    try {
      const text = await asset.file.text()
      setMdPreviewContent({ name: asset.name, text })
    } catch {
      // best-effort — ignore read errors
    } finally {
      setMdPreviewLoading(false)
    }
  }, [])

  // Suggestion state – driven by tiptap Mention/Suggestion
  const [suggestionItems, setSuggestionItems] = useState<AgentMentionCandidate[]>([])
  const [suggestionCommand, setSuggestionCommand] = useState<((item: { id: string }) => void) | null>(null)
  const suggestionDropdownRef = useRef<SuggestionDropdownHandle>(null)
  // Refs for accessing latest suggestion state inside editorProps.handleKeyDown (avoids stale closures)
  const suggestionItemsRef = useRef<AgentMentionCandidate[]>([])
  const suggestionCommandRef = useRef<((item: { id: string }) => void) | null>(null)
  useEffect(() => { suggestionItemsRef.current = suggestionItems }, [suggestionItems])
  useEffect(() => { suggestionCommandRef.current = suggestionCommand }, [suggestionCommand])

  // File suggestion state – driven by tiptap FileMention/Suggestion
  const [fileSuggestionItems, setFileSuggestionItems] = useState<FileMentionItem[]>([])
  const [fileSuggestionCommand, setFileSuggestionCommand] = useState<((item: FileMentionItem) => void) | null>(null)
  const fileSuggestionDropdownRef = useRef<SuggestionDropdownHandle>(null)
  // Refs for accessing latest state inside the tiptap suggestion callback (avoids stale closures)
  const fileSuggestionItemsRef = useRef<FileMentionItem[]>([])
  const fileSuggestionCommandRef = useRef<((item: FileMentionItem) => void) | null>(null)
  useEffect(() => { fileSuggestionItemsRef.current = fileSuggestionItems }, [fileSuggestionItems])
  useEffect(() => { fileSuggestionCommandRef.current = fileSuggestionCommand }, [fileSuggestionCommand])
  const fileSuggestionRangeRef = useRef<{ from: number; to: number } | null>(null)
  const fileSuggestionEditorRef = useRef<Editor | null>(null)

  // Slash command suggestion state – driven by tiptap SlashCommandExtension Suggestion
  const [slashSuggestionItems, setSlashSuggestionItems] = useState<SlashCommandItem[]>([])
  const [slashSuggestionCommand, setSlashSuggestionCommand] = useState<((item: SlashCommandItem) => void) | null>(null)
  const slashSuggestionDropdownRef = useRef<SuggestionDropdownHandle>(null)
  const slashSuggestionItemsRef = useRef<SlashCommandItem[]>([])
  useEffect(() => { slashSuggestionItemsRef.current = slashSuggestionItems }, [slashSuggestionItems])

  const disabledRef = useRef(disabled)
  const onSubmitRef = useRef(onSubmit)
  const onChangeRef = useRef(onChange)
  const showAgentSelectorRef = useRef(showAgentSelector)
  const agentSelectionRef = useRef(agentSelection)
  const allAgentsRef = useRef(allAgents)
  const agentsRef = useRef(agents)
  const isProcessingRef = useRef(isProcessing)
  const onCancelRef = useRef(onCancel)
  const onSlashCommandRef = useRef(onSlashCommand)
  const editorRef = useRef<Editor | null>(null)

  // ---- emit value --------------------------------------------------------
  const emitValue = useCallback(
    (editor: Editor) => {
      const text = getPlainText(editor)
      const mentionedAgentIds = getMentionedAgentIds(editor)
      onChangeRef.current({ text, mentionedAgentIds })
    },
    [],
  )

  // ---- ref sync ----------------------------------------------------------
  useEffect(() => { disabledRef.current = disabled }, [disabled])
  useEffect(() => { onSubmitRef.current = onSubmit }, [onSubmit])
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { agentsRef.current = agents }, [agents])
  useEffect(() => { isProcessingRef.current = isProcessing }, [isProcessing])
  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])
  useEffect(() => { onSlashCommandRef.current = onSlashCommand }, [onSlashCommand])
  useEffect(() => { showAgentSelectorRef.current = showAgentSelector }, [showAgentSelector])
  useEffect(() => { agentSelectionRef.current = agentSelection }, [agentSelection])
  useEffect(() => { allAgentsRef.current = allAgents }, [allAgents])

  // ---- editor -------------------------------------------------------------
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      History,
      Mention.configure({
        HTMLAttributes: {
          class:
            'inline-flex items-center rounded px-1.5 py-0.5 bg-primary-100 text-primary-800 text-sm font-medium dark:bg-primary-100/60 dark:text-primary-700',
        },
        suggestion: {
          char: '@',
          items: ({ query }) => {
            const q = query.toLowerCase().trim()
            return agentsRef.current
              .filter((a) => a.id !== 'default')
              .filter((a) => {
                if (!q) return true
                const haystack = `${a.id} ${a.name || ''}`.toLowerCase()
                return haystack.includes(q)
              })
              .slice(0, 8)
          },
          render: () => {
            return {
              onStart: (props) => {
                setSuggestionItems(props.items as AgentMentionCandidate[])
                setSuggestionCommand(() => props.command)
              },
              onUpdate: (props) => {
                setSuggestionItems(props.items as AgentMentionCandidate[])
                setSuggestionCommand(() => props.command)
              },
              onKeyDown: (props) => {
                if (props.event.key === 'Escape') {
                  setSuggestionItems([])
                  setSuggestionCommand(null)
                  return true
                }
                return suggestionDropdownRef.current?.onKeyDown(props.event) ?? false
              },
              onExit: () => {
                setSuggestionItems([])
                setSuggestionCommand(null)
              },
            }
          },
          command: ({ editor: e, range, props }) => {
            // Insert the mention node at the @trigger range.
            // We explicitly add a trailing space so the user can keep typing
            // after the mention without the cursor sticking to the chip.
            e
              .chain()
              .focus()
              .insertContentAt(range, [
                {
                  type: 'mention',
                  attrs: { id: props.id },
                },
                {
                  type: 'text',
                  text: ' ',
                },
              ])
              .run()
          },
        },
      }),
      ...(onSearchFiles
        ? [
            FileMention.configure({
              onSearch: onSearchFiles,
              render: () => {
                // Track selection index locally so Enter works even when
                // the React dropdown hasn't rendered yet (async items).
                let activeIdx = 0
                /** Select a file/dir: replace the `#query` trigger with a fileMention node. */
                const selectFile = (item: FileMentionItem) => {
                  const range = fileSuggestionRangeRef.current
                  const editorInstance = fileSuggestionEditorRef.current
                  if (range && editorInstance) {
                    editorInstance
                      .chain()
                      .focus()
                      .insertContentAt(range, [
                        {
                          type: 'fileMention',
                          attrs: {
                            path: item.path,
                            name: item.name,
                            extension: item.extension ?? '',
                          },
                        },
                        { type: 'text', text: ' ' },
                      ])
                      .run()
                  }
                  // Clear suggestion state
                  setFileSuggestionItems([])
                  setFileSuggestionCommand(null)
                  fileSuggestionItemsRef.current = []
                  fileSuggestionCommandRef.current = null
                  fileSuggestionRangeRef.current = null
                  fileSuggestionEditorRef.current = null
                }

                return {
                  onStart: async (props) => {
                    // items() is async → props.items may be an unresolved Promise
                    const items = await (props.items as Promise<FileMentionItem[]> | FileMentionItem[])
                    setFileSuggestionItems(items as FileMentionItem[])
                    // Save a wrapped command that selects file without inserting inline node
                    setFileSuggestionCommand(() => selectFile)
                    // Sync refs immediately (before next React render) for onKeyDown access
                    fileSuggestionItemsRef.current = items as FileMentionItem[]
                    fileSuggestionCommandRef.current = selectFile
                    activeIdx = 0
                    fileSuggestionRangeRef.current = props.range
                    fileSuggestionEditorRef.current = props.editor
                  },
                  onUpdate: async (props) => {
                    const items = await (props.items as Promise<FileMentionItem[]> | FileMentionItem[])
                    setFileSuggestionItems(items as FileMentionItem[])
                    setFileSuggestionCommand(() => selectFile)
                    fileSuggestionItemsRef.current = items as FileMentionItem[]
                    fileSuggestionCommandRef.current = selectFile
                    activeIdx = 0
                    fileSuggestionRangeRef.current = props.range
                    fileSuggestionEditorRef.current = props.editor
                  },
                  onKeyDown: (props) => {
                    if (props.event.key === 'Escape') {
                      setFileSuggestionItems([])
                      setFileSuggestionCommand(null)
                      fileSuggestionItemsRef.current = []
                      fileSuggestionCommandRef.current = null
                      return true
                    }
                    // Try delegating to the rendered dropdown first.
                    const dropdownResult = fileSuggestionDropdownRef.current?.onKeyDown(props.event)
                    if (dropdownResult) return true

                    // Fallback: if the dropdown ref is not yet mounted but we
                    // have items, handle navigation / selection ourselves so
                    // that Enter never accidentally submits the message.
                    const items = fileSuggestionItemsRef.current
                    if (items.length === 0) return false

                    if (props.event.key === 'ArrowUp') {
                      activeIdx = Math.max(0, activeIdx - 1)
                      return true
                    }
                    if (props.event.key === 'ArrowDown') {
                      activeIdx = Math.min(items.length - 1, activeIdx + 1)
                      return true
                    }
                    if (props.event.key === 'Enter') {
                      const item = items[activeIdx]
                      if (item) {
                        const cmd = fileSuggestionCommandRef.current
                        if (cmd) cmd(item)
                      }
                      return true // always consume Enter to prevent submit
                    }
                    return false
                  },
                  onExit: () => {
                    setFileSuggestionItems([])
                    setFileSuggestionCommand(null)
                    fileSuggestionItemsRef.current = []
                    fileSuggestionCommandRef.current = null
                  },
                }
              }
            }),
          ]
        : []),
      // Slash command extension — '/' trigger for commands like /compact
      SlashCommandExtension.configure({
        onSelect: (item: SlashCommandItem) => {
          // Only echo selected command into input.
          // Actual execution happens when user explicitly sends the message.
          const ed = editorRef.current
          if (!ed) return
          // command() already deleted the '/' trigger, doc is now empty.
          // Insert command text + trailing space (space breaks Suggestion match → onExit fires).
          ed.commands.insertContent(`/${item.id} `)
          emitValue(ed)
        },
        render: () => ({
          onStart: (props: any) => {
            setSlashSuggestionItems(props.items as SlashCommandItem[])
            setSlashSuggestionCommand(() => props.command)
          },
          onUpdate: (props: any) => {
            setSlashSuggestionItems(props.items as SlashCommandItem[])
            setSlashSuggestionCommand(() => props.command)
          },
          onKeyDown: (props: any) => {
            if (props.event.key === 'Escape') {
              setSlashSuggestionItems([])
              setSlashSuggestionCommand(null)
              return true
            }
            return slashSuggestionDropdownRef.current?.onKeyDown(props.event) ?? false
          },
          onExit: () => {
            setSlashSuggestionItems([])
            setSlashSuggestionCommand(null)
          },
        }),
      }),
    ],
    editorProps: {
      attributes: {
        'aria-label': ariaLabel || placeholder,
        class:
          'min-h-[44px] max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 outline-none',
      },
      handlePaste: (_view, event, _slice) => {
        // Intercept clipboard images and add them as pending assets
        // (same flow as drag-drop / file picker).
        const files: File[] = []
        if (event.clipboardData && event.clipboardData.items) {
          for (let i = 0; i < event.clipboardData.items.length; i++) {
            const item = event.clipboardData.items[i]
            if (item.kind === 'file') {
              const file = item.getAsFile()
              if (file) {
                // Generate a meaningful filename for clipboard images
                // (browsers often give empty or generic names like "image.png")
                const isImage = file.type.startsWith('image/')
                const name = file.name && file.name !== ''
                  ? file.name
                  : isImage
                    ? `clipboard-${Date.now()}.${file.type.split('/')[1] || 'png'}`
                    : `clipboard-${Date.now()}.${file.name?.split('.').pop() || 'bin'}`
                // Wrap with corrected name if needed
                files.push(file.name === name ? file : new File([file], name, { type: file.type }))
              }
            }
          }
        }
        if (files.length > 0) {
          addFiles(files)
          // Prevent default paste behaviour for file items so the editor
          // doesn't try to insert raw data or leave a blank line.
          return true
        }

        // Large-text paste: if the pasted plain text exceeds the threshold,
        // automatically convert it to a .txt file attachment instead of
        // inserting it into the editor (which would be slow and hard to edit).
        const PASTE_TEXT_THRESHOLD = 10_000 // characters
        const pastedText = event.clipboardData?.getData('text/plain') ?? ''
        if (pastedText.length > PASTE_TEXT_THRESHOLD) {
          event.preventDefault()
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const fileName = `pasted-text-${timestamp}.txt`
          const textFile = new File([pastedText], fileName, { type: 'text/plain' })
          addFiles([textFile])
          // Insert a brief note so the user and AI know text was auto-attached
          const ed = editor // editor is in closure from useEditor
          if (ed) {
            const lineCount = pastedText.split('\n').length
            const charCount = pastedText.length
            ed.commands.insertContent(
              `[Pasted text (${lineCount} lines, ${charCount.toLocaleString()} chars) attached as ${fileName}]`,
            )
            emitValue(ed)
          }
          return true
        }

        // Let TipTap handle normal text/HTML paste
        return false
      },
      handleKeyDown: (_view, event) => {
        if (disabledRef.current) return false
        if (event.isComposing) return false

        // Escape — cancel agent if processing; otherwise two-step clear:
        //   1st Esc selects all (visual cue), 2nd Esc clears.
        // When a suggestion popup (@-mention or #-fileMention) is open, the
        // Suggestion plugin should handle Escape to dismiss the popup. Since
        // editorProps.handleKeyDown runs BEFORE the Suggestion plugin, we must
        // return false when a popup is open so the plugin can handle it.
        if (event.key === 'Escape') {
          // Let suggestion popups dismiss first
          const hasAgentSuggestion = suggestionItemsRef.current.length > 0
          const hasFileSuggestion = fileSuggestionItemsRef.current.length > 0
          const hasSlashSuggestion = slashSuggestionItemsRef.current.length > 0
          if (hasAgentSuggestion || hasFileSuggestion || hasSlashSuggestion) {
            return false // delegate to suggestion plugin's onKeyDown
          }
          if (isProcessingRef.current) {
            event.preventDefault()
            onCancelRef.current?.()
            return true
          }
          // Not processing — two-step clear to prevent accidental loss:
          //   1st Esc → select all (visual highlight, content intact)
          //   2nd Esc → actually clear (only when everything is selected)
          // If the user deselects in between (mouse click, arrow key, …) the
          // next Esc re-selects instead of clearing — safe by construction.
          const ed = editor // editor is in closure from useEditor
          if (ed && !ed.isEmpty) {
            event.preventDefault()
            const { from, to } = ed.state.selection
            const isAllSelected = from === 0 && to === ed.state.doc.content.size
            if (isAllSelected) {
              ed.commands.clearContent()
              // clearContent can leave a selection highlight on the now-empty
              // document — collapse caret to start for a clean state.
              ed.commands.focus('start')
              emitValue(ed)
            } else {
              ed.commands.selectAll()
            }
            return true
          }
          return false
        }

        // ArrowUp / ArrowDown — terminal-style input history navigation.
        // Fires only when no suggestion popup is open (those are guarded
        // above or handled earlier by the suggestion plugin) and only at the
        // document boundaries (top for ↑, bottom for ↓).
        if (event.key === 'ArrowUp' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          // Defer to suggestion popups (@-mention / #-fileMention / slash cmd)
          // when one is open — they need arrow keys for dropdown navigation.
          if (
            suggestionItemsRef.current.length > 0 ||
            fileSuggestionItemsRef.current.length > 0 ||
            slashSuggestionItemsRef.current.length > 0
          ) {
            return false
          }
          const history = inputHistoryRef.current
          if (history.length === 0) return false
          // Guard: navigate when caret is at the document start. In ProseMirror
          // an empty `<p></p>` places the caret at pos 1 (inside the first
          // paragraph), so we treat from <= 1 as "at the top".
          const ed = editor
          if (ed && ed.state.selection.empty && ed.state.selection.from <= 1) {
            event.preventDefault()
            const nextIdx = navIndexRef.current === null
              ? history.length - 1
              : Math.max(0, navIndexRef.current - 1)
            navIndexRef.current = nextIdx
            isProgrammaticUpdateRef.current = true
            ed.commands.setContent(history[nextIdx])
            ed.commands.focus('end')
            // clearContent/setContent run their transactions synchronously in
            // TipTap, so by the next tick the onUpdate guard can be cleared.
            isProgrammaticUpdateRef.current = false
            emitValue(ed)
            return true
          }
          return false
        }
        if (event.key === 'ArrowDown' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          if (
            suggestionItemsRef.current.length > 0 ||
            fileSuggestionItemsRef.current.length > 0 ||
            slashSuggestionItemsRef.current.length > 0
          ) {
            return false
          }
          const ed = editor
          // Only navigate when active and caret at the end of the doc.
          // doc.content.size counts the closing tag of the last block, so the
          // real caret-at-end position is size - 1.
          const docEnd = ed ? ed.state.doc.content.size : 0
          if (
            navIndexRef.current !== null &&
            ed &&
            ed.state.selection.empty &&
            ed.state.selection.from >= docEnd - 1
          ) {
            event.preventDefault()
            const nextIdx = navIndexRef.current + 1
            const history = inputHistoryRef.current
            isProgrammaticUpdateRef.current = true
            if (nextIdx >= history.length) {
              // Stepped past the newest entry — clear to a blank input.
              navIndexRef.current = null
              ed.commands.clearContent()
              ed.commands.focus('end')
            } else {
              navIndexRef.current = nextIdx
              ed.commands.setContent(history[nextIdx])
              ed.commands.focus('end')
            }
            isProgrammaticUpdateRef.current = false
            emitValue(ed)
            return true
          }
          return false
        }

        // Enter (without Shift) submits the message.
        // Suggestion handles its own Enter, so this only fires when the
        // suggestion popup is closed.
        if (event.key === 'Enter' && !event.shiftKey) {
          // Guard: if the agent-mention (@) suggestion popup is showing, block submit.
          // Same issue as file-mention: Suggestion plugin's onKeyDown runs AFTER
          // editorProps.handleKeyDown in ProseMirror, so we must intercept here.
          const agentItems = suggestionItemsRef.current
          if (agentItems.length > 0) {
            const handled = suggestionDropdownRef.current?.onKeyDown(event) ?? false
            if (handled) return true
            // Fallback: select first item directly
            const cmd = suggestionCommandRef.current
            if (cmd) {
              cmd(agentItems[0])
              return true
            }
          }
          // Guard: if the file-mention suggestion popup is showing, block submit.
          // The Suggestion plugin's onKeyDown runs AFTER editorProps.handleKeyDown
          // in ProseMirror, so it never gets a chance to handle Enter.  We must
          // intercept here and delegate to the dropdown's own key handler.
          const fileItems = fileSuggestionItemsRef.current
          if (fileItems.length > 0) {
            // Let the dropdown handle Enter (select current item)
            const handled = fileSuggestionDropdownRef.current?.onKeyDown(event) ?? false
            if (handled) return true
            // Fallback: select first item directly
            const cmd = fileSuggestionCommandRef.current
            if (cmd) {
              cmd(fileItems[0])
              return true
            }
          }
          // Guard: if the slash command suggestion popup is showing, block submit.
          const slashItems = slashSuggestionItemsRef.current
          if (slashItems.length > 0) {
            const handled = slashSuggestionDropdownRef.current?.onKeyDown(event) ?? false
            if (handled) return true
          }
          event.preventDefault()
          onSubmitRef.current()
          return true
        }
        return false
      },
    },
    onCreate: ({ editor: created }) => {
      emitValue(created)
    },
    onUpdate: ({ editor: updated }) => {
      // Reset history navigation when the user edits the content themselves
      // (typing / deleting / pasting). Programmatic setContent during history
      // navigation sets isProgrammaticUpdateRef to skip this reset.
      if (!isProgrammaticUpdateRef.current) {
        navIndexRef.current = null
      }
      emitValue(updated)
    },
    onFocus: () => setIsFocused(true),
    onBlur: () => setIsFocused(false),
  })

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
    editorRef.current = editor
  }, [disabled, editor])

  // ── Imperative handle: focus + programmatic text injection ──
  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus(),
    // setContent + emitValue keep the logic-layer input state (hasInput/send
    // button) in sync — same contract as the draft-restore effect below.
    setText: (text: string) => {
      if (!editor || editor.isDestroyed) return
      // setContent replaces the whole document — intentional for chip prefill
      // (we do not merge with existing user text).
      editor.commands.setContent(text)
      editor.commands.focus('end')
      emitValue(editor)
    },
  }), [editor, emitValue])

  // ── Clear editor on resetToken change (message sent) ──
  // IMPORTANT: this must NOT run when the editor instance is first created.
  // With `immediatelyRender: false` the editor arrives after mount, so the
  // effect's first run sees the initial token — that is editor readiness, NOT
  // a send-reset. Gating on an actual token change (vs. initial token) fixes
  // two silent asset-loss bugs:
  //   1. Draft → conversation transition (?new=1 first send): the input
  //      remounts under key={convId}; the old code's first run would
  //      clearAll() the GLOBAL pending-asset store before sendMessage read
  //      it, dropping the staged attachments from the draft input.
  //   2. Plain conversation switches: key={convId} remount → editor rebuild
  //      → same first-run clearAll(), wiping staged-but-unsent attachments.
  // StrictMode note: comparing against the token the editor was created with
  // (not a "first run" flag) keeps the guard immune to double-invoked
  // effects — a double run sees an unchanged token on the second pass.
  const editorInitialTokenRef = useRef<number | null>(null)
  useEffect(() => {
    if (!editor) return
    if (editorInitialTokenRef.current === null) {
      // Editor just became available — record the token it was created with.
      editorInitialTokenRef.current = resetToken
      return
    }
    if (resetToken === editorInitialTokenRef.current) return
    // Token changed since the editor instance was created → real send-reset.
    // Capture the message being sent into the input history BEFORE clearing.
    if (!editor.isEmpty) {
      const sent = getPlainText(editor)
      if (sent.trim()) {
        setInputHistory((prev) => appendToHistory(prev, sent))
      }
    }
    // Reset history navigation state for the next (empty) input.
    navIndexRef.current = null
    editor.commands.clearContent()
    // Clear pending asset uploads when input resets (message sent)
    useAssetStore.getState().clearAll()
    emitValue(editor)
  }, [editor, emitValue, resetToken])

  // ── Restore initial text (draft) into editor ──
  // When key={convId} changes, a new editor is created. This effect injects
  // the draft text on first render. After injection, onDraftRestored clears
  // the draft so it won't be re-injected if the user manually clears the editor.
  useEffect(() => {
    if (!editor || !initialText) return
    // Only inject when editor is empty — prevents re-injection if user manually
    // clears the editor and the effect re-runs (e.g. initialText changes).
    if (editor.isEmpty) {
      editor.commands.setContent(initialText)
      emitValue(editor)
      onDraftRestored?.()
    }
  }, [editor, initialText, emitValue, onDraftRestored])

  // ---- IME composition tracking -------------------------------------------
  // Notifies parent (ConversationView) so it can suppress file search
  // during composition — prevents pinyin letters from triggering searches.
  useEffect(() => {
    if (!editor || !onSetIsComposing) return
    const el = editor.view.dom as HTMLElement

    const start = () => onSetIsComposing(true)
    const end = () => onSetIsComposing(false)

    el.addEventListener('compositionstart', start)
    el.addEventListener('compositionend', end)
    return () => {
      el.removeEventListener('compositionstart', start)
      el.removeEventListener('compositionend', end)
    }
  }, [editor, onSetIsComposing])

  const [agentCreateError, setAgentCreateError] = useState(false)

  // ---- Agent selector handlers -------------------------------------------
  const handleCreateAgent = useCallback(async () => {
    const id = newAgentInput.trim()
    if (!id) return
    setAgentCreateError(false)
    const created = await onCreateAgent(id)
    if (!created) {
      setAgentCreateError(true)
      return
    }
    await onSetActiveAgent(created.id)
    setNewAgentInput('')
    setIsCreatingAgent(false)
    setShowAgentSelector(false)
  }, [newAgentInput, onCreateAgent, onSetActiveAgent])

  const handleDeleteAgent = useCallback(
    async (agentId: string, e: React.MouseEvent) => {
      e.stopPropagation()
      if (agentId === 'default') return
      if (!window.confirm(`Delete agent "${agentId}"?`)) return
      const success = await onDeleteAgent(agentId)
      if (success) {
        const newAgents = allAgentsRef.current.filter((a) => a.id !== agentId)
        if (agentSelectionRef.current >= newAgents.length) {
          setAgentSelection(Math.max(0, newAgents.length - 1))
        }
      }
    },
    [onDeleteAgent],
  )

  const handleSelectAgent = useCallback(
    async (agentId: string) => {
      await onSetActiveAgent(agentId)
      setShowAgentSelector(false)
    },
    [onSetActiveAgent],
  )

  // Keyboard navigation for agent selector
  useEffect(() => {
    if (!showAgentSelector) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const currentAgents = allAgentsRef.current
      const currentSelection = agentSelectionRef.current

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAgentSelection((idx) => {
          const max = Math.max(currentAgents.length - 1, 0)
          return idx >= max ? max : idx + 1
        })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAgentSelection((idx) => Math.max(0, idx - 1))
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setShowAgentSelector(false)
        setIsCreatingAgent(false)
      } else if (e.key === 'Enter' && !isCreatingAgent) {
        e.preventDefault()
        const agent = currentAgents[currentSelection]
        if (agent) {
          void handleSelectAgent(agent.id)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showAgentSelector, isCreatingAgent, handleSelectAgent])

  // Click outside to close agent selector
  useEffect(() => {
    if (!showAgentSelector) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.agent-selector-dropdown') && !target.closest('.agent-selector-button')) {
        setShowAgentSelector(false)
        setIsCreatingAgent(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showAgentSelector])

  const isEmpty = editor ? editor.isEmpty : true
  const showSuggestion = !disabled && suggestionItems.length > 0 && !!suggestionCommand
  const showFileSuggestion = !disabled && fileSuggestionItems.length > 0 && !!fileSuggestionCommand
  const showSlashSuggestion = !disabled && slashSuggestionItems.length > 0 && !!slashSuggestionCommand

  // Drag-drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!disabled) {
      setIsDragOver(true)
      // Preload OCR worker when user drags a file over (so it's ready when dropped)
      import('@/services/ocr.service').then(({ preloadOcrWorker }) => preloadOcrWorker()).catch(() => {})
    }
  }, [disabled])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      if (disabled) return
      // Folders cannot be read via dataTransfer.files (the browser only hands
      // over an empty placeholder). extractDroppedFiles snapshots FileSystem
      // handles synchronously and expands directories into their files.
      setIsExtractingDropped(true)
      extractDroppedFiles(e.dataTransfer)
        .then(({ files, truncated }) => {
          if (files.length > 0) handleFiles(files)
          if (truncated) {
            console.warn('[AgentRichInput] dropped folder had more than 200 files; only the first 200 were attached')
          }
        })
        .catch((err) => {
          console.error('[AgentRichInput] failed to extract dropped files', err)
        })
        .finally(() => setIsExtractingDropped(false))
    },
    [disabled, handleFiles],
  )

  return (
    <div
      className="relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay — stays visible (with spinner) while dropped folders
          are being expanded into files. */}
      {(isDragOver || isExtractingDropped) && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary-500 bg-primary-50/80 dark:bg-primary-100/30"
        >
          <div className="flex flex-col items-center gap-1 text-primary-600 dark:text-primary-700">
            {isExtractingDropped ? <Loader2 className="h-8 w-8 animate-spin" /> : <Paperclip className="h-8 w-8" />}
            <span className="text-sm font-medium">
              {isExtractingDropped ? t('conversation.input.extractingFolder') : t('conversation.input.dropFilesHere')}
            </span>
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleFiles(e.target.files)
            // Reset so the same file can be selected again
            e.target.value = ''
          }
        }}
      />
      <div className="focus-within:border-primary-500 focus-within:ring-primary-500/20 min-h-[88px] w-full rounded-xl border border-neutral-300 bg-card pl-11 pr-14 py-4 text-sm shadow-sm transition-all hover:border-primary-300 focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-offset-1 dark:border-neutral-600 dark:bg-neutral-900 dark:hover:border-primary-700 dark:focus-within:bg-neutral-900 dark:focus-within:border-primary-500">
        {editor && (
          <>
            <EditorContent editor={editor} />

            {/* Pending asset uploads preview */}
            {pendingAssets.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {pendingAssets.map((asset) => {
                  const isMarkdown = /\.(md|markdown)$/i.test(asset.name) || asset.mimeType === 'text/markdown'
                  return (
                  <div
                    key={asset.id}
                    className="group relative flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-800"
                  >
                    {asset.previewUrl ? (
                      <img
                        src={asset.previewUrl}
                        alt={asset.name}
                        role="button"
                        tabIndex={0}
                        className="h-8 w-8 rounded object-cover cursor-zoom-in"
                        onClick={() => setLightboxSrc(asset.previewUrl ?? null)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setLightboxSrc(asset.previewUrl ?? null)
                          }
                        }}
                      />
                    ) : isMarkdown ? (
                      <div
                        role="button"
                        tabIndex={0}
                        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded bg-primary-50 text-primary-600 transition-colors hover:bg-primary-100 dark:bg-primary-900/30 dark:text-primary-400 dark:hover:bg-primary-900/50"
                        onClick={() => handlePreviewMarkdown(asset)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            handlePreviewMarkdown(asset)
                          }
                        }}
                        title={t('conversation.input.previewMarkdown')}
                      >
                        {mdPreviewLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <FileText className="h-4 w-4" />
                        )}
                      </div>
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-neutral-200 dark:bg-neutral-700">
                        <ImageIcon className="h-4 w-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <div className="max-w-[140px] truncate text-xs font-medium text-neutral-600 dark:text-neutral-300">
                          {asset.name}
                        </div>
                        {/* OCR status indicator */}
                        {(asset.ocrStatus === 'loading' || asset.ocrStatus === 'processing') && (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary-500" />
                        )}
                      </div>
                      <div className="text-[10px] text-neutral-500 dark:text-neutral-400">
                        {formatFileSize(asset.size)}
                        {asset.ocrStatus === 'done' && asset.ocrText && ` · ${t('conversation.input.ocrSuccess')}`}
                        {asset.ocrStatus === 'failed' && ` · ${t('conversation.input.ocrFailed')}`}
                        {asset.ocrStatus === 'timeout' && ` · ${t('conversation.input.ocrTimeout')}`}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 opacity-60 transition-opacity hover:bg-neutral-200 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 dark:hover:bg-neutral-600"
                      onClick={() => removeAsset(asset.id)}
                      aria-label={`Remove ${asset.name}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  )
                })}
              </div>
            )}
          </>
        )}
        {!isFocused && isEmpty && (
          // Full hints shown when input is empty and unfocused
          // Pin both edges so the absolute box covers the parent input's width
          // (and lets the hint chips track along with it on resize) instead of
          // sizing to shrink-to-fit content. Chips wrap to a second line on
          // narrow screens via `flex-wrap` + `gap-y-1`; labels stay short
          // (just describe the action — kbd chip shows the keypress) so they
          // fit comfortably even when wrapping.
          <div className="pointer-events-none absolute inset-x-0 top-4 px-11">
            <div className="truncate text-sm text-muted">
              {placeholder}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] leading-none text-muted">
              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                <kbd className="shrink-0 rounded border border-neutral-200 bg-neutral-100 px-1 py-px font-mono text-[10px] dark:border-neutral-700 dark:bg-neutral-800">#</kbd>
                <span>{t('conversation.input.hints.fileMention')}</span>
              </span>
              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                <kbd className="shrink-0 rounded border border-neutral-200 bg-neutral-100 px-1 py-px font-mono text-[10px] dark:border-neutral-700 dark:bg-neutral-800">@</kbd>
                <span>{t('conversation.input.hints.agentMention')}</span>
              </span>
              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                <kbd className="shrink-0 rounded border border-neutral-200 bg-neutral-100 px-1 py-px font-mono text-[10px] dark:border-neutral-700 dark:bg-neutral-800">/</kbd>
                <span>{t('conversation.input.hints.slashCommand')}</span>
              </span>
            </div>
          </div>
        )}

        {/* Persistent shortcut hints — always visible at bottom of input */}
        {(isFocused || !isEmpty) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-1.5 flex justify-center">
            <span className="text-[9px] text-neutral-400 dark:text-neutral-500">
              {t('conversation.input.hints.shortcutsHint')}
            </span>
          </div>
        )}

        {/* Upload attachment button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="absolute left-3 top-4 rounded-lg p-1.5 transition-colors hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          title={t('conversation.input.attachFiles')}
        >
          <Paperclip className="h-4 w-4" />
        </button>
        {leadingAccessory && (
          <div className="absolute left-3 top-12 z-10">
            {leadingAccessory}
          </div>
        )}
      </div>

      {/* Agent selector dropdown - expands downward */}
      {showAgentSelector && (
        <div className="agent-selector-dropdown absolute top-full left-0 z-20 mt-1 w-60 overflow-hidden rounded-lg border border-neutral-200 bg-card shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <div className="max-h-[280px] overflow-y-auto py-1">
            {allAgents.map((agent, idx) => {
              const isActive = agent.id === activeAgentId
              const selected = idx === agentSelection
              return (
                <div
                  key={agent.id}
                  className={`flex items-center gap-2 px-3 py-2 ${
                    selected
                      ? 'bg-primary-50 dark:bg-primary-100/40'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void handleSelectAgent(agent.id)}
                    className="flex flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1"
                  >
                    <span
                      className={`text-sm font-medium ${
                        isActive
                          ? 'text-primary-700 dark:text-primary-700'
                          : 'dark:text-foreground'
                      }`}
                    >
                      @{agent.id}
                    </span>
                    {agent.name && agent.name !== agent.id && (
                      <span className="truncate text-xs text-neutral-400 dark:text-neutral-400">
                        {agent.name}
                      </span>
                    )}
                  </button>
                  {isActive && (
                    <Check className="h-3.5 w-3.5 text-primary-600 dark:text-primary-500" />
                  )}
                  {agent.id !== 'default' && (
                    <button
                      type="button"
                      onClick={(e) => void handleDeleteAgent(agent.id, e)}
                      className="rounded p-1.5 hover:bg-neutral-200 hover:text-red-600 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1"
                      title={`Delete ${agent.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Create new agent row */}
          <div className="border-t border-neutral-200 dark:border-neutral-700">
            {isCreatingAgent ? (
              <div className="flex items-center gap-1.5 px-3 py-2">
                <input
                  value={newAgentInput}
                  onChange={(e) => setNewAgentInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleCreateAgent()
                    } else if (e.key === 'Escape') {
                      setIsCreatingAgent(false)
                      setNewAgentInput('')
                    }
                  }}
                  placeholder={t('conversation.input.agentIdPlaceholder')}
                  autoFocus
                  className="h-7 flex-1 rounded border border-neutral-300 bg-card px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-neutral-600 dark:bg-neutral-800"
                />
                <button
                  type="button"
                  onClick={() => void handleCreateAgent()}
                  disabled={!newAgentInput.trim()}
                  className="rounded bg-primary-600 px-2 py-1 text-xs text-white hover:bg-primary-700 disabled:opacity-40"
                >
                  {t('conversation.input.createAgent')}
                </button>
                {agentCreateError && (
                  <span className="text-[10px] text-danger">{t('conversation.input.agentCreateFailed')}</span>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsCreatingAgent(true)}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-neutral-100 text-neutral-400 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{t('agent.createNew')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Mention suggestions dropdown – rendered by tiptap suggestion plugin */}
      {showSuggestion && suggestionCommand && (
        <SuggestionDropdown<AgentMentionCandidate>
          ref={suggestionDropdownRef}
          items={suggestionItems}
          getItemKey={(c) => c.id}
          onSelect={(c) => suggestionCommand?.({ id: c.id })}
          renderItem={(candidate, _selected) => (
            <>
              <span className="font-medium">@{candidate.id}</span>
              {candidate.name && candidate.name !== candidate.id && (
                <span className="truncate pl-3 text-xs text-neutral-400 dark:text-neutral-400">
                  {candidate.name}
                </span>
              )}
            </>
          )}
        />
      )}

      {/* File suggestions dropdown – rendered by tiptap fileMention suggestion plugin */}
      {showFileSuggestion && fileSuggestionCommand && (
        <SuggestionDropdown<FileMentionItem>
          ref={fileSuggestionDropdownRef}
          items={fileSuggestionItems}
          getItemKey={(f) => f.path}
          onSelect={(f) => fileSuggestionCommand?.(f)}
          width="w-[26rem]"
          selectedColor="bg-primary-50 text-primary-700 dark:bg-primary-100/40 dark:text-primary-700"
          renderItem={(file, _selected) => (
            <>
              <span className="mt-0.5 shrink-0 text-neutral-500 dark:text-neutral-500">
                {file.isDirectory ? (
                  <FolderIcon className="h-3.5 w-3.5" />
                ) : (
                  <FileIcon className="h-3.5 w-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium leading-5">{file.name}</div>
                <div className="truncate text-[11px] leading-4 text-neutral-500 dark:text-neutral-500">
                  {file.path}{file.isDirectory ? '/' : ''}
                </div>
              </div>
              {!file.isDirectory && file.extension && (
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] dark:bg-neutral-800 text-neutral-400 dark:text-neutral-400">
                  .{file.extension}
                </span>
              )}
            </>
          )}
        />
      )}

      {/* Slash command suggestions dropdown – rendered by tiptap SlashCommandExtension */}
      {showSlashSuggestion && slashSuggestionCommand && (
        <SuggestionDropdown<SlashCommandItem>
          ref={slashSuggestionDropdownRef}
          items={slashSuggestionItems}
          getItemKey={(cmd) => cmd.id}
          onSelect={(cmd) => slashSuggestionCommand?.(cmd)}
          width="w-auto"
          renderItem={(cmd, _selected) => (
            <span className="text-neutral-700 dark:text-neutral-300">
              /{cmd.id}
              <span className="ml-2 text-neutral-500 dark:text-neutral-500">
                {cmd.description}
              </span>
            </span>
          )}
        />
      )}

      {/* Lightbox overlay for click-to-enlarge images */}
      {lightboxSrc && (
        <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

      {/* Markdown preview overlay for .md attachments (before send) */}
      {mdPreviewContent && (
        <Lightbox onClose={() => setMdPreviewContent(null)}>
          <div className="flex h-[90vh] w-[min(90vw,860px)] flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-neutral-900">
            <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-700">
              <span className="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">
                {mdPreviewContent.name}
              </span>
              <button
                type="button"
                onClick={() => setMdPreviewContent(null)}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto px-6 py-4 text-sm leading-relaxed text-neutral-800 dark:text-neutral-100">
              <MarkdownContent content={mdPreviewContent.text} allowHtml />
            </div>
          </div>
        </Lightbox>
      )}
    </div>
  )
})
