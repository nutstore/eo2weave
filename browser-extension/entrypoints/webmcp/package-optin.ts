/**
 * Side-panel package opt-in — candidate matching.
 *
 * The opt-in prompt (issue #100) asks: "does the bound tab host a WebMCP
 * package that is still disabled?". The answer comes from the PACKAGE
 * CATALOG (not the removed legacy recipes map): a package (builtin or
 * registry-installed external) matches the tab when at least one of its
 * tools' `urlRegex` matches the tab URL.
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
  /** Which mount hosts the package (`builtin-webmcp` or `webmcp`). */
  mount: string
  description: string
  hostname: string
  /** Resolved activation: absence of config.json means disabled. */
  activation: 'enabled' | 'disabled'
  /** Tools whose urlRegex matches the tab URL. */
  tools: PackageOptInTool[]
}

/**
 * Mounts eligible for the opt-in prompt. Tier 1 (issue #117) opens the probe
 * to EXTERNAL packages: a package installed from a registry into the custom
 * `/external/webmcp/` mount gets the same on-site "enable?" prompt as a
 * builtin. Both mounts hold declarative workflow packages behind the same
 * consent-token protocol, so there is no security reason to treat them
 * differently — the old builtin-only filter just predated the installer.
 */
const OPT_IN_MOUNTS = new Set(['builtin-webmcp', 'webmcp'])

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

/**
 * Navigation with an explicit target is a page READ, not a page write
 * (finding: "Read-only tools are labeled writable"): `browser.goto` loads a
 * URL in the tab the workflow targets — the same effect as the user typing
 * the address — and does not touch the DOM of the page being read.
 */
const NON_MUTATING_BROWSER_COMMANDS = ['browser.goto(']

/** Stored workflow sources are tiny; a cap keeps this linear and cheap. */
const READ_ONLY_SOURCE_MAX_LENGTH = 20_000

/**
 * Generic mutation markers checked against the WHOLE workflow source,
 * including inside `browser.eval` payloads (finding: "Mutating tools labeled
 * read-only" — the old fixed list missed unlisted write operations). Three
 * scans: (1) property assignment (`.x =`) — the classic page-write shape,
 * (2) method calls outside a read-only allowlist, (3) storage / cookie /
 * network-send primitives. A pure `browser.eval("() => document.title")`
 * read matches none of them and stays read-only; anything not provably
 * clean falls to write.
 */
const READ_ONLY_CALL_ALLOWLIST =
  'getElementById|querySelector|querySelectorAll|closest|matches|getAttribute|hasAttribute|contains|innerText|textContent|title|tagName|nodeType|dataset|toString|toJSON|trim|split|join|slice|substring|replace|toLowerCase|toUpperCase|includes|indexOf|startsWith|endsWith|charAt|at|find|filter|map|forEach|some|every|reduce|keys|values|entries|isArray|from|of|stringify|parse|test|exec|match|matchAll|replaceAll|padStart|padEnd|repeat|concat|flat|flatMap|sort|reverse|has|get|set|delete|clear|add|then|catch|finally|json|text|blob|arrayBuffer|reload|decodeURIComponent|encodeURIComponent|eval|inputSchema|outputSchema|tree|run|result|type|name|description|tools|sources|manifest|version|id|path|urlRegex|send|wait|poll|call|dispose|abort|throwIfAborted|removeEventListener|addEventListener|resolve|reject|randomUUID|now|error|message|body|clone|headers|status|ok|statusText|formData'

const MUTATION_MARKER_PATTERN = new RegExp(
  `\\.\\s*[A-Za-z_$][\\w$]*\\s*=[^=>]` +
    `|\\.\\s*(?!${READ_ONLY_CALL_ALLOWLIST}\\b)[A-Za-z_$][\\w$]*\\s*\\(` +
    `|document\\.cookie|localStorage|sessionStorage|indexedDB|\\bcaches\\b|fetch\\s*\\(|XMLHttpRequest|WebSocket|postMessage\\s*\\(|navigator\\.clipboard`,
)

/**
 * Internal workflow-state writes (`state.result = …`, optionally nested,
 * e.g. `state.foo.bar = …` or `state["x"] = …`): the `state` object is the
 * workflow's OWN output channel, not page state (finding: "Read-only tools
 * are labeled writable") — writing it never touches the page. Stripped
 * before the marker scan so the generic property-assignment rule cannot
 * misread it as a page write.
 */
const INTERNAL_STATE_WRITE = /\bstate(?:\.[\w$]+|\[[^\]]*\])*\s*=[^=>]/g

/**
 * Conservative read-only detection from the workflow source. Read-only is a
 * POSITIVE verdict (finding: "Mutating tools labeled read-only"): absence of
 * ONE known pattern is not proof, so the marker scan above covers structural
 * DOM mutation, storage, network sends and generic property assignment. A
 * tool is labelled read-only only when its auditable source survives the
 * whole scan; unknown code, missing source and oversized sources are write.
 */
export function toolIsReadOnly(source: string): boolean {
  if (typeof source !== 'string' || !source) return false
  if (source.length > READ_ONLY_SOURCE_MAX_LENGTH) return false
  // Direct interaction-capable browser commands always disqualify.
  if (MUTATING_BROWSER_COMMANDS.some(command => source.includes(command))) return false
  // `browser.goto` navigation with an explicit target is a read, not a write
  // (finding: "Read-only tools are labeled writable") — remove it so the
  // generic unlisted-call scan cannot flag it as an unknown mutating call.
  const withoutNavigation = NON_MUTATING_BROWSER_COMMANDS.reduce(
    (text, command) => text.split(command).join(''),
    source,
  )
  // Internal `state.* =` writes are the workflow's own output channel; strip
  // them so the generic property-assignment rule cannot flag them.
  const scanned = withoutNavigation.replace(INTERNAL_STATE_WRITE, '')
  if (MUTATION_MARKER_PATTERN.test(scanned)) return false
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
 * All packages hosting this URL, best first (finding: "Dismissal
 * hides other package prompts" — a site can host SEVERAL packages, and a
 * dismissed best match must not shadow its siblings). Both builtin and
 * external (registry-installed) packages qualify (issue #117 Tier 1).
 * Order: disabled before enabled (the prompt exists to offer disabled
 * packages), then by matching tool count, then id for stability.
 */
export function findPackageOptInCandidates(
  entries: WebMCPPackageEntry[],
  url: string,
): PackageOptInCandidate[] {
  if (!url) return []
  const hostname = hostnameOf(url)
  const candidates: PackageOptInCandidate[] = []
  for (const entry of entries) {
    if (!OPT_IN_MOUNTS.has(entry.mount)) continue
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
    candidates.push({
      id: manifest.id,
      directory: entry.directory,
      mount: entry.mount,
      description: manifest.description,
      hostname,
      activation: entry.activation === 'enabled' ? 'enabled' : 'disabled',
      tools,
    })
  }
  return candidates.sort((a, b) => {
    const aDisabled = a.activation === 'disabled' ? 0 : 1
    const bDisabled = b.activation === 'disabled' ? 0 : 1
    if (aDisabled !== bDisabled) return aDisabled - bDisabled
    if (a.tools.length !== b.tools.length) return b.tools.length - a.tools.length
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * The package the opt-in prompt should offer: the first of
 * `findPackageOptInCandidates` — a DISABLED package always wins over an
 * enabled one, then the most matching tools, id as the stable tiebreaker.
 */
export function findPackageOptInCandidate(
  entries: WebMCPPackageEntry[],
  url: string,
): PackageOptInCandidate | null {
  return findPackageOptInCandidates(entries, url)[0] ?? null
}
