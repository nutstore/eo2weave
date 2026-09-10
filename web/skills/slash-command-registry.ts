/**
 * Slash Command Registry — 统一的命令注册中心
 *
 * 职责：
 * - 管理所有 slash 命令（内置命令 + skill 命令 + 未来扩展）
 * - 提供 get/filter API 给 UI 层消费
 * - 不依赖 TipTap / React / 任何 UI 框架
 *
 * 注册方：
 * - 内置命令（compact 等）：应用启动时直接注册
 * - Builtin skill 命令：skills-system 初始化后注册
 * - 未来：插件命令、用户自定义命令
 */

// ============================================================================
// Types
// ============================================================================

export interface SlashCommandItem {
  /** 命令 ID，如 'compact'、'brainstorm' */
  id: string
  /** 显示名称 */
  label: string
  /** 下拉菜单中的简短描述 */
  description: string
  /** 命令来源 */
  source: 'builtin' | 'skill' | 'plugin' | 'user'
  /** 可选的图标名（Lucide icon） */
  icon?: string
}

// ============================================================================
// Registry State
// ============================================================================

/** 所有已注册的命令（按注册顺序） */
const commands: SlashCommandItem[] = []

/** 按 ID 索引（用于去重和快速查找） */
const commandsById = new Map<string, SlashCommandItem>()

/**
 * 追踪所有 source='skill' 的命令 ID。
 * 用 Set 而不是靠 source 字段过滤，避免迭代中修改数组的潜在问题。
 */
const _skillCommandIds = new Set<string>()

// ============================================================================
// Registration API
// ============================================================================

/**
 * 注册一个 slash 命令。
 * 如果 id 已存在，静默跳过（不覆盖）。
 */
export function registerSlashCommand(item: SlashCommandItem): void {
  if (commandsById.has(item.id)) return
  commands.push(item)
  commandsById.set(item.id, item)
}

/**
 * 批量注册 slash 命令。
 */
export function registerSlashCommands(items: SlashCommandItem[]): void {
  for (const item of items) {
    registerSlashCommand(item)
  }
}

/**
 * 注册技能来源的 slash 命令，同时记录 ID 以便后续清理。
 * 如果 id 已存在，静默跳过（不覆盖）。
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
 * 注销一个 slash 命令。
 */
export function unregisterSlashCommand(id: string): boolean {
  if (!commandsById.has(id)) return false
  commandsById.delete(id)
  const idx = commands.findIndex((c) => c.id === id)
  if (idx >= 0) commands.splice(idx, 1)
  return true
}

/**
 * 清空所有命令（仅用于测试）。
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
 * 获取所有已注册的命令。
 */
export function getAllSlashCommands(): SlashCommandItem[] {
  return [...commands]
}

/**
 * 按 query 过滤命令（模糊匹配 id 或 label）。
 * 这是给 TipTap Suggestion 的 items 回调用的。
 */
export function searchSlashCommands(query: string): SlashCommandItem[] {
  const q = query.toLowerCase().trim()
  if (!q) return [...commands]
  return commands.filter(
    (cmd) => cmd.id.toLowerCase().includes(q) || cmd.label.toLowerCase().includes(q)
  )
}

/**
 * 按 ID 查找命令。
 */
export function getSlashCommand(id: string): SlashCommandItem | undefined {
  return commandsById.get(id)
}

/**
 * 按来源过滤命令。
 */
export function getSlashCommandsBySource(source: SlashCommandItem['source']): SlashCommandItem[] {
  return commands.filter((cmd) => cmd.source === source)
}

/**
 * 清除所有 skill 来源的命令（source='skill'）。
 * 由 SkillManager.syncSlashCommands() 调用，确保切换项目时旧项目的技能命令被移除。
 */
export function clearSkillCommands(): void {
  for (const id of _skillCommandIds) {
    commandsById.delete(id)
  }
  // 从数组末尾向前遍历，安全删除 skill 来源的命令
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i].source === 'skill') {
      commands.splice(i, 1)
    }
  }
  _skillCommandIds.clear()
}

/**
 * 已注册命令数量。
 */
export function getSlashCommandCount(): number {
  return commands.length
}

// ============================================================================
// Built-in Commands（应用级内置命令，启动时注册）
// ============================================================================

/**
 * 注册应用级内置 slash 命令。
 * 在应用启动时调用一次。
 */
export function registerBuiltinSlashCommands(): void {
  registerSlashCommand({
    id: 'compact',
    label: 'Compact',
    description: '压缩上下文，释放 token 空间',
    source: 'builtin',
  })
}
