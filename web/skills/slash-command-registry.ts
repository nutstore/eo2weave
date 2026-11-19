/**
 * Slash Command Registry — unified command registry
 *
 * Responsibilities:
 * - Manage every slash command (builtin + skill + future extensions)
 * - Expose get/filter APIs for the UI layer to consume
 * - No dependency on TipTap / React / any UI framework
 *
 * Registrants:
 * - Builtin commands (compact, etc.): registered directly at app startup
 * - Builtin skill commands: registered after the skills system initializes
 * - Future: plugin commands and user-defined commands
 */

// ============================================================================
// Types
// ============================================================================

export interface SlashCommandItem {
  /** Command ID, e.g. 'compact', 'brainstorm' */
  id: string
  /** Display name (builtin commands store an i18n key; the UI layer translates it) */
  label: string
  /** Short description shown in the dropdown (builtin commands store an i18n key; the UI layer translates it) */
  description: string
  /**
   * Optional localized descriptions keyed by locale (from
   * `description.<locale>:` in the skill's SKILL.md). Resolved at RENDER time
   * by {@link resolveSlashCommandDescription}, so switching the UI language
   * does not require re-registering commands.
   */
  descriptionI18n?: Record<string, string>
  /** Command source — builtin and skill commands are grouped separately in the menu */
  source: 'builtin' | 'skill' | 'plugin' | 'user'
  /** Optional icon name (Lucide icon) */
  icon?: string
  /** Whether a builtin command accepts arguments (e.g. /translate <lang>); the UI uses it for the placeholder hint */
  takesArg?: boolean
}

/**
 * Description to show for a command in the active locale.
 *
 * Exact locale (`zh-CN`) wins, then its language prefix (`zh-CN` → `zh`),
 * then the base description. Builtin commands keep their i18n-key behaviour —
 * callers translate those with `t()` instead.
 */
export function resolveSlashCommandDescription(
  item: Pick<SlashCommandItem, 'description' | 'descriptionI18n'>,
  locale: string,
): string {
  const i18n = item.descriptionI18n
  if (!i18n || locale === 'en-US') return item.description
  const exact = i18n[locale]
  if (exact) return exact
  const language = locale.split('-')[0]
  return (language && i18n[language]) || item.description
}

// ============================================================================
// Registry State
// ============================================================================

/** All registered commands (in registration order) */
const commands: SlashCommandItem[] = []

/** Indexed by ID (for dedup and fast lookup) */
const commandsById = new Map<string, SlashCommandItem>()

/**
 * Tracks the IDs of every command with source='skill'.
 * A Set instead of filtering on the source field, which avoids mutating the array mid-iteration.
 */
const _skillCommandIds = new Set<string>()

// ============================================================================
// Registration API
// ============================================================================

/**
 * Register a slash command.
 * If the id already exists, skip silently (no overwrite).
 */
export function registerSlashCommand(item: SlashCommandItem): void {
  if (commandsById.has(item.id)) return
  commands.push(item)
  commandsById.set(item.id, item)
}

/**
 * Register slash commands in bulk.
 */
export function registerSlashCommands(items: SlashCommandItem[]): void {
  for (const item of items) {
    registerSlashCommand(item)
  }
}

/**
 * Register a skill-sourced slash command and record its ID for later cleanup.
 * If the id already exists, skip silently (no overwrite).
 */
export function registerSkillCommands(items: SlashCommandItem[]): void {
  for (const item of items) {
    if (commandsById.has(item.id)) continue
    _skillCommandIds.add(item.id)
    commands.push(item)
    commandsById.set(item.id, item)
  }
}

/**
 * Unregister a slash command.
 */
export function unregisterSlashCommand(id: string): boolean {
  if (!commandsById.has(id)) return false
  commandsById.delete(id)
  const idx = commands.findIndex((c) => c.id === id)
  if (idx >= 0) commands.splice(idx, 1)
  return true
}

/**
 * Clear all commands (test-only).
 */
export function clearSlashCommands(): void {
  commands.length = 0
  commandsById.clear()
  _skillCommandIds.clear()
}

// ============================================================================
// Query API
// ============================================================================

/**
 * Get every registered command.
 */
export function getAllSlashCommands(): SlashCommandItem[] {
  return [...commands]
}

/**
 * Filter commands by query (fuzzy match on id or label).
 * Backs the items callback of the TipTap Suggestion plugin.
 */
export function searchSlashCommands(query: string): SlashCommandItem[] {
  const q = query.toLowerCase().trim()
  if (!q) return [...commands]
  return commands.filter(
    (cmd) => cmd.id.toLowerCase().includes(q) || cmd.label.toLowerCase().includes(q)
  )
}

/**
 * Look up a command by ID.
 */
export function getSlashCommand(id: string): SlashCommandItem | undefined {
  return commandsById.get(id)
}

/**
 * Filter commands by source.
 */
export function getSlashCommandsBySource(source: SlashCommandItem['source']): SlashCommandItem[] {
  return commands.filter((cmd) => cmd.source === source)
}

/**
 * Remove every skill-sourced command (source='skill').
 * Called by SkillManager.syncSlashCommands() so switching projects drops the previous project's skill commands.
 */
export function clearSkillCommands(): void {
  for (const id of _skillCommandIds) {
    commandsById.delete(id)
  }
  // Walk backwards from the end of the array so removing skill-sourced commands stays safe
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i].source === 'skill') {
      commands.splice(i, 1)
    }
  }
  _skillCommandIds.clear()
}

/**
 * Number of registered commands.
 */
export function getSlashCommandCount(): number {
  return commands.length
}

// ============================================================================
// Built-in Commands (app-level builtin commands, registered at startup)
// ============================================================================

/**
 * Register the app-level builtin slash commands.
 * Called once at app startup.
 */
export function registerBuiltinSlashCommands(): void {
  registerSlashCommand({
    id: 'compact',
    // Store the lowercase i18n key suffix; the dropdown resolves the localized description.
    label: 'compact',
    description: 'compact',
    source: 'builtin',
  })
  // P0 builtin light-operation pack (summary/translate/explain/polish/titles)
  // — labels are i18n keys resolved by the dropdown at render time.
  import('./builtin-slash-commands').then(({ registerBuiltinCommandPack }) =>
    registerBuiltinCommandPack(),
  ).catch(() => {
    // Never let the pack registration break startup (compact still works).
  })
}
