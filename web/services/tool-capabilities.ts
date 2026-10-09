/** Public workspace capabilities are explicit; new Agent control tools are private by default. */
const PUBLIC_WORKSPACE_TOOLS = new Set([
  'run_code', 'read', 'ls', 'search', 'write', 'edit', 'delete', 'read_image', 'ocr',
  'run_python', 'bash', 'exec', 'processes', 'sync-to-opfs', 'sync-to-disk',
  'snapshot_status', 'snapshot_diff', 'snapshot_log', 'snapshot_show', 'snapshot_restore',
  'detect_conflicts', 'create_checkpoint', 'rollback_checkpoint',
  'read_skill', 'read_skill_resource', 'search_skills', 'generate_image', 'web_search', 'web_fetch',
  'search_tools', 'call_tool', 'get_page_tools',
  'page_snapshot', 'page_text_content', 'page_find_elements', 'page_synthesize_locators',
  'page_click', 'page_fill', 'page_type', 'page_scroll', 'page_evaluate', 'page_screenshot',
])

export function isPublicWorkspaceTool(name: string): boolean {
  return PUBLIC_WORKSPACE_TOOLS.has(name)
}
