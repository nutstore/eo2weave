import { serializeError } from './errors'
export interface CommandInput { args: string[]; stdin: string }
export interface CommandResult { stdout: string; stderr: string; exitCode: number }
export interface BrowserRequest {
  command: string
  positionals: string[]
  options: Record<string, string | boolean>
  stdin: string
}

// Positionals deliberately follow Playwright CLI vocabulary; this is a separate API.
const commands: Record<string, { min: number; max: number; options?: string[] }> = {
  help: { min: 0, max: 0 }, open: { min: 0, max: 1, options: ['background', 'wait-until'] }, goto: { min: 1, max: 1, options: ['wait-until'] },
  close: { min: 0, max: 0 }, 'tab-list': { min: 0, max: 0 },
  'tab-new': { min: 0, max: 1, options: ['background', 'wait-until'] }, 'tab-select': { min: 1, max: 1 },
  'tab-close': { min: 0, max: 1 }, snapshot: { min: 0, max: 1, options: ['boxes'] },
  click: { min: 1, max: 2 }, dblclick: { min: 1, max: 2 },
  fill: { min: 1, max: 2 }, type: { min: 1, max: 2 },
  press: { min: 1, max: 1 }, keydown: { min: 1, max: 1 }, keyup: { min: 1, max: 1 },
  hover: { min: 1, max: 1 }, select: { min: 2, max: 20 },
  check: { min: 1, max: 1 }, uncheck: { min: 1, max: 1 }, drag: { min: 2, max: 2 },
  eval: { min: 0, max: 2 },
  screenshot: { min: 0, max: 1, options: ['full-page', 'format', 'quality'] },
  'go-back': { min: 0, max: 0, options: ['wait-until'] }, 'go-forward': { min: 0, max: 0, options: ['wait-until'] }, reload: { min: 0, max: 0, options: ['wait-until'] },
  mousemove: { min: 2, max: 2 }, mousedown: { min: 0, max: 1 }, mouseup: { min: 0, max: 1 },
  mousewheel: { min: 2, max: 2 },
  'dialog-accept': { min: 0, max: 1 }, 'dialog-dismiss': { min: 0, max: 0 },
  detach: { min: 0, max: 0 },
}
const flags = new Set(['background', 'boxes', 'full-page', 'help'])

export const browserManual = `browser <command> [arguments] [--tab=<id>] [--timeout=<ms>]
Browser primitives for Bash composition. Every non-empty stdout/stderr is one JSON value. Success: result on stdout, exit 0. Failure: {error:{name,message,details?}} on stderr, exit 1. No --json. Use -- before positional text starting with --.
Tabs: tab-list -> {tabs:[{tabId,url,title,active,windowId,selected}]}; tab-new [url] [--background] (alias open); tab-select <id>; tab-close [id] (alias close). IDs are stable Chrome IDs, not indices. Selection is remembered per workspace page. --tab overrides it for one call.
Navigation: goto <url>, reload, go-back, go-forward. --wait-until=load|domcontentloaded|commit (default load). Operations return their own result; compose snapshot or screenshot afterward when needed.
snapshot [ref|css] [--boxes] -> {tabId,url,title,snapshotId,tree,nodes}. Nodes have ref, role, name, parentElementId, childElementIds, locators and semantic properties. Use jq for search/filtering/depth/formatting, Bash redirection to save. Refs target exact observed DOM nodes; detached/expired refs fail. Capture again after navigation. CSS must match exactly one element, including open shadow roots.
click <ref|css> [left|right|middle], dblclick <ref|css> [button], hover <ref|css>, drag <start> <end>. Targeted actions wait for visibility, stability and required actionability up to the deadline.
fill <ref|css> [text] replaces; type <ref|css> [text] appends. Omitted text reads UTF-8 stdin, including empty input. select <ref|css> <value>..., check <ref|css>, uncheck <ref|css>.
press <key>, keydown <key>, keyup <key>: Enter, Tab, Escape, ControlOrMeta+A, etc. mousemove <x> <y>, mousedown [button], mouseup [button], mousewheel <dx> <dy>.
eval [function] [ref|css]: function source defaults to stdin; optional element is passed as its argument. Page globals, native fetch and async functions work; no Node or tools proxy. Returns {tabId,buffer}, with ordered [log]/[info]/[warn]/[error]/[result] entries. Exceptions fail with the buffer in error.details. Use eval for DOM/text reads, calculations and asynchronous page conditions. Compose browser commands in Bash.
screenshot [ref|css] [--full-page] [--format=png|jpeg] [--quality=0..100] -> {tabId,mimeType,encoding:"base64",data}. No files or image blocks. Element and --full-page are mutually exclusive.
dialog-accept [prompt], dialog-dismiss; detach releases debugger without closing the tab.
Timeout is an overall deadline including queueing (default 10000ms, max 30000ms). Web stop cancels running extension tasks; already completed actions cannot be undone. Dialog commands can run while a page command is waiting on a dialog.
Examples:
browser tab-list | jq '.tabs[] | select(.url | contains("example.com")) | .tabId'
browser snapshot | jq '.nodes[] | select(.role == "button")'
printf 'hello' | browser fill e12
browser click e12 && browser snapshot
browser eval '() => document.body.innerText' | jq -r '.buffer'
browser screenshot | jq -r '.data' > screenshot.base64`

export function parseBrowserCommand({ args, stdin }: CommandInput): BrowserRequest {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string') || typeof stdin !== 'string') {
    throw new TypeError('Expected string args and stdin')
  }
  const positionals: string[] = []
  const options: Record<string, string | boolean> = Object.create(null)
  let literal = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--' && !literal) { literal = true; continue }
    if (!literal && arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=')
      if (key in options) throw new Error(`Duplicate option --${key}`)
      if (flags.has(key)) {
        if (rest.length) throw new Error(`--${key} takes no value`)
        options[key] = true
      } else {
        const value = rest.length ? rest.join('=') : args[++i]
        if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`)
        options[key] = value
      }
    } else positionals.push(arg)
  }
  const command = options.help ? 'help' : positionals.shift() ?? 'help'
  if (options.help) return { command, positionals: [], options: {}, stdin }
  const spec = commands[command]
  if (!spec) throw new Error(`Unknown browser command: ${command}. Use browser help.`)
  if (positionals.length < spec.min || positionals.length > spec.max) throw new Error(`Invalid arguments for ${command}. Use browser help.`)
  for (const key of Object.keys(options)) {
    if (!['tab', 'timeout', ...(spec.options ?? [])].includes(key)) throw new Error(`Unknown option --${key} for ${command}`)
  }
  for (const key of ['tab', 'timeout']) {
    if (key in options && (!/^\d+$/.test(String(options[key])) || !Number.isSafeInteger(Number(options[key])) || Number(options[key]) <= 0)) {
      throw new Error(`--${key} must be a positive integer`)
    }
  }
  if (Number(options.timeout ?? 10000) > 30000) throw new Error('--timeout must be at most 30000 ms')
  if (options['wait-until'] !== undefined && !['load', 'domcontentloaded', 'commit'].includes(String(options['wait-until']))) throw new Error('--wait-until must be load, domcontentloaded or commit')
  return { command, positionals, options, stdin }
}

export async function invokeBrowserCommand(input: CommandInput, run: (request: BrowserRequest) => Promise<unknown>): Promise<CommandResult> {
  try {
    const request = parseBrowserCommand(input)
    const value = request.command === 'help' ? { name: 'browser', manual: browserManual } : await run(request)
    return { stdout: JSON.stringify(value ?? null) + '\n', stderr: '', exitCode: 0 }
  } catch (error) {
    return { stdout: '', stderr: JSON.stringify({ error: serializeError(error) }) + '\n', exitCode: 1 }
  }
}
