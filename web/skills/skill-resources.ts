/**
 * Skill Resources - 资源文件处理模块
 *
 * Handles scanning, storing, and formatting of skill resource files
 * from references/, scripts/, and assets/ directories.
 */

import type { SkillResource, ResourceType } from './skill-types'
import { RESOURCE_LIMITS } from './skill-types'

// ============================================================================
// Resource Type Detection
// ============================================================================

// Pre-built whitelist of known text file extensions (from 'text-extensions' package).
// Using a whitelist is safer than a binary blacklist — anything not listed is treated as binary.
const TEXT_EXTENSIONS = new Set([
  'ada', 'adb', 'ads', 'applescript', 'as', 'asc', 'ascii', 'asm', 'asp', 'aspx',
  'atom', 'bas', 'bash', 'bat', 'bbcolors', 'bib', 'bison', 'c', 'c++', 'capnp',
  'cbl', 'cc', 'cfc', 'cfm', 'clj', 'cljs', 'cls', 'cmake', 'cmd', 'cnf', 'cob',
  'coffee', 'conf', 'cpp', 'cr', 'crt', 'cs', 'cson', 'css', 'csv', 'cxx', 'd',
  'dart', 'diff', 'dtd', 'el', 'elm', 'emacs', 'eml', 'ent', 'erb', 'erl', 'ex',
  'exs', 'f', 'f90', 'fish', 'for', 'fs', 'ftl', 'gemspec', 'gitattributes',
  'gitconfig', 'gitignore', 'go', 'gql', 'gradle', 'graphql', 'groovy', 'gvimrc',
  'h', 'haml', 'hpp', 'hs', 'htm', 'html', 'hx', 'iced', 'iml', 'inc', 'info',
  'ini', 'ino', 'inputrc', 'j2', 'jade', 'java', 'js', 'json', 'json5', 'jsonl',
  'jsp', 'jsx', 'kt', 'latex', 'less', 'lhs', 'lisp', 'log', 'ls', 'lua', 'm',
  'mak', 'man', 'markdown', 'md', 'mdown', 'mdx', 'meson', 'mjs', 'mk', 'ml',
  'mli', 'mm', 'mtx', 'mustache', 'nfo', 'nix', 'njk', 'numpy', 'obj', 'objc',
  'odin', 'org', 'p12', 'patch', 'php', 'pkg', 'pl', 'plantuml', 'pm', 'po',
  'postcss', 'pp', 'properties', 'proto', 'ps1', 'psd1', 'psm1', 'pug', 'purs',
  'py', 'pyx', 'r', 'rabl', 'rake', 'rb', 'rdoc', 'rkt', 'rlib', 'ron', 'rs',
  'rst', 'rx', 'sass', 'scala', 'scm', 'scss', 'sh', 'sln', 'sls', 'sml', 'soy',
  'sql', 'srt', 'sty', 'sub', 'sublime-build', 'sublime-commands', 'sublime-completions',
  'sublime-keymap', 'sublime-macro', 'sublime-menu', 'sublime-project',
  'sublime-settings', 'sublime-snippet', 'svg', 'swift', 'tcl', 'tex', 'tf',
  'tfvars', 'toml', 'tpl', 'travis', 'ts', 'tsx', 'ttl', 'twig', 'txt', 'v',
  'vala', 'vapi', 'vash', 'vb', 'vbs', 'vhd', 'vhdl', 'vim', 'vimrc', 'vm',
  'vue', 'webmanifest', 'wsgi', 'x-html', 'x-java', 'x-js', 'x-latex', 'x-markdown',
  'x-objc', 'x-php', 'x-ruby', 'x-rust', 'x-sh', 'x-yaml', 'xml', 'xsd', 'xsl',
  'yaml', 'yaml-tmlanguage', 'yml', 'zig', 'zsh',
])

/** Check if a file is a text file (safe to read as UTF-8 string) */
export function isTextFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.has(ext)
}

/** Get resource type from directory name */
export function getResourceType(dirName: string): ResourceType {
  if (dirName === 'references') return 'reference'
  if (dirName === 'scripts') return 'script'
  return 'asset'
}

/** Get MIME type from filename */
export function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const mimeTypes: Record<string, string> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    text: 'text/plain',
    py: 'text/x-python',
    python: 'text/x-python',
    js: 'text/javascript',
    javascript: 'text/javascript',
    ts: 'text/typescript',
    typescript: 'text/typescript',
    sh: 'text/x-shellscript',
    bash: 'text/x-shellscript',
    json: 'application/json',
    yaml: 'text/x-yaml',
    yml: 'text/x-yaml',
    xml: 'text/xml',
    html: 'text/html',
    css: 'text/css',
    scss: 'text/x-scss',
    less: 'text/x-less',
  }
  return mimeTypes[ext] || 'text/plain'
}

// ============================================================================
// Resource Formatting
// ============================================================================

/** Format resource list for read_skill output */
export function formatResourceList(resources: SkillResource[]): string {
  if (resources.length === 0) return ''

  // Group by resource type
  const byType = new Map<ResourceType, SkillResource[]>()
  for (const r of resources) {
    if (!byType.has(r.resourceType)) {
      byType.set(r.resourceType, [])
    }
    byType.get(r.resourceType)!.push(r)
  }

  let output = '\n\nAvailable Resources:\n'
  for (const [type, items] of byType.entries()) {
    output += `\n#### ${type}\n`
    for (const item of items) {
      output += `- ${item.resourcePath} (${item.size} bytes)\n`
    }
  }
  output += '\nUse read_skill_resource to load any resource.'

  return output
}

// ============================================================================
// Resource Size Formatting
// ============================================================================

/**
 * Format file size in human-readable format.
 *
 * NOTE (issue #14): intentionally kept local, not switched to the canonical
 * `formatSize` in `@/lib/utils` — this variant renders whole-byte values as
 * "N bytes" (canonical: "N B") and only supports up to MB. Callers rely on
 * the "bytes" spelling in resource-limit messages.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ============================================================================
// Resource Validation
// ============================================================================

/** Check if resource file size is within limits */
export function isResourceSizeValid(size: number): boolean {
  return size <= RESOURCE_LIMITS.MAX_FILE_SIZE
}

/** Check if resource count is within limits */
export function isResourceCountValid(count: number): boolean {
  return count <= RESOURCE_LIMITS.MAX_RESOURCES_PER_SKILL
}

/** Check if total size is within limits */
export function isTotalSizeValid(totalSize: number): boolean {
  return totalSize <= RESOURCE_LIMITS.MAX_TOTAL_SIZE
}

/** Get resource validation error message */
export function getResourceValidationError(
  type: 'size' | 'count' | 'total',
  actual: number,
  limit: number
): string {
  const formattedLimit = formatSize(limit)
  const formattedActual = formatSize(actual)

  switch (type) {
    case 'size':
      return `Resource file too large: ${formattedActual} (max: ${formattedLimit})`
    case 'count':
      return `Too many resource files: ${actual} (max: ${limit})`
    case 'total':
      return `Total resources too large: ${formattedActual} (max: ${formattedLimit})`
  }
}

// ============================================================================
// Resource ID Generation
// ============================================================================

/** Generate resource ID from skill ID and resource path */
export function generateResourceId(skillId: string, resourcePath: string): string {
  return `${skillId}:${resourcePath}`
}

/** Parse resource ID into components */
export function parseResourceId(id: string): { skillId: string; resourcePath: string } | null {
  const colonIndex = id.indexOf(':')
  if (colonIndex <= 0) return null

  return {
    skillId: id.slice(0, colonIndex),
    resourcePath: id.slice(colonIndex + 1),
  }
}
