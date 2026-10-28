/**
 * Side-panel package opt-in — candidate matching.
 *
 * The opt-in prompt (issue #100) asks: "does the bound tab host a builtin
 * WebMCP package that is still disabled?". The answer comes from the PACKAGE
 * CATALOG (not the removed legacy recipes map): a builtin package matches the
 * tab when at least one of its tools' `urlRegex` matches the tab URL.
 *
 * This module is deliberately pure so both the background handler and the
 * unit tests can use it without a browser environment.
 */

import { matchesToolUrl } from '@creatorweave/shared/webmcp-url'
import type { WebMCPPackageEntry } from '@creatorweave/shared/webmcp-package-catalog'

export interface PackageOptInTool {
  name: string
  description: string
  /** True when the workflow only reads the page (no interaction/mutation). */
  readOnly: boolean
}

export interface PackageOptInCandidate {
  /** Package id (reverse-domain namespace) — also the manifest directory. */
  id: string
  directory: string
  description: string
  hostname: string
  /** Resolved activation: absence of config.json means disabled. */
  activation: 'enabled' | 'disabled'
  /** Tools whose urlRegex matches the tab URL. */
  tools: PackageOptInTool[]
}

/** Only builtin packages can be offered by the opt-in prompt. */
const BUILTIN_MOUNT = 'builtin-webmcp'

/**
 * Browser primitives that change the page (click, typing, key presses, …).
 * A workflow that only calls `browser.eval` / `browser.goto` is read-only
 * unless the evaluated source mutates the DOM.
 */
const MUTATING_BROWSER_COMMANDS = [
  'browser.click(',
  'browser.dblclick(',
  'browser.fill(',
  'browser.type(',
  'browser.press(',
  'browser.keydown(',
  'browser.keyup(',
  'browser.drag(',
  'browser.select(',
  'browser.check(',
  'browser.uncheck(',
  'browser.evalElement(',
]

/** DOM/storage mutations performed from evaluated page scripts. */
const MUTATING_DOM_PATTERNS = [
  '.click()',
  'dispatchEvent(',
  'innerHTML =',
  'outerHTML =',
  'textContent =',
  'localStorage.setItem',
  'sessionStorage.setItem',
]

/**
 * Conservative read-only detection from the workflow source. When in doubt
 * the tool is treated as a write tool — the badge must never claim "read only"
 * for a workflow that can change the site.
 */
export function toolIsReadOnly(source: string): boolean {
  if (typeof source !== 'string' || !source) return false
  if (MUTATING_BROWSER_COMMANDS.some(command => source.includes(command))) return false
  if (MUTATING_DOM_PATTERNS.some(pattern => source.includes(pattern))) return false
  return true
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * The package the opt-in prompt should offer. "Best" = most matching tools
 * (a site hosting two packages keeps the more specific one), ties broken by
 * package id for a stable result — BUT a DISABLED package always wins over
 * an enabled one: the prompt exists to offer disabled packages, so a more
 * popular enabled package on the same site must not shadow it.
 */
export function findPackageOptInCandidate(
  entries: WebMCPPackageEntry[],
  url: string,
): PackageOptInCandidate | null {
  if (!url) return null
  const hostname = hostnameOf(url)
  let best: PackageOptInCandidate | null = null
  for (const entry of entries) {
    if (entry.mount !== BUILTIN_MOUNT) continue
    const manifest = entry.package?.manifest
    if (!manifest) continue
    // A package with diagnostics cannot be enabled — never offer it.
    if (entry.diagnostics.some(error => !error.startsWith('config.json:'))) continue
    const sources = entry.package?.sources ?? {}
    const tools: PackageOptInTool[] = []
    for (const tool of manifest.tools) {
      let matches = false
      try {
        matches = matchesToolUrl(tool.urlRegex, url)
      } catch {
        matches = false
      }
      if (matches) {
        tools.push({
          name: tool.name,
          description: tool.description,
          readOnly: toolIsReadOnly(sources[tool.path] ?? ''),
        })
      }
    }
    if (tools.length === 0) continue
    const candidate: PackageOptInCandidate = {
      id: manifest.id,
      directory: entry.directory,
      description: manifest.description,
      hostname,
      activation: entry.activation === 'enabled' ? 'enabled' : 'disabled',
      tools,
    }
    if (!best) {
      best = candidate
      continue
    }
    const candidateDisabled = candidate.activation === 'disabled'
    const bestDisabled = best.activation === 'disabled'
    if (candidateDisabled !== bestDisabled) {
      // Disabled first: the prompt only exists to offer disabled packages.
      if (candidateDisabled) best = candidate
      continue
    }
    if (candidate.tools.length > best.tools.length) best = candidate
  }
  return best
}
