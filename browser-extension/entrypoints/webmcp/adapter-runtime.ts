import { createExecution, action, condition, wait, sequence, selector, type Node, type Status } from '@creatorweave/behavior-tree'
import { withQuickJsSession, DEFAULT_LIMITS, type JsonValue } from '@creatorweave/quickjs-runtime'
import { parseWorkflow, type WorkflowTreeDescriptor } from '@creatorweave/shared/webmcp-adapter'
import { createSchemaValidator, assertSchemaValue } from '@creatorweave/shared/webmcp-schema'
import { ADAPTER_TIMEOUT_MS } from '@creatorweave/shared/webmcp-adapter-protocol'
import { parseBrowserCommand, type BrowserRequest } from '../../lib/bash-commands/browser/command'

export type BrowserCommand = (
  request: BrowserRequest,
  signal: AbortSignal,
) => Promise<JsonValue>

const BROWSER_BINDINGS_SETUP = `
globalThis.browser = (() => {
  const hostInvoke = invokeBrowser;
  const hostWriteLog = emitEvent;
  delete globalThis.invokeBrowser;
  delete globalThis.emitEvent;
  const formatLog = value => { if (typeof value === 'string') return value; try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } };
  globalThis.console = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...args) => { hostWriteLog({ level, message: args.map(formatLog).join(' ').slice(0, 2048) }); }])));
  const command = (name, positionals = [], options = {}, stdin = '') => hostInvoke(name, positionals, options, stdin);
  return Object.freeze({
    exec: command,
    run: command,
    open: (url, options = {}) => command('open', url == null ? [] : [url], options),
    goto: (url, options = {}) => command('goto', [url], options),
    close: (options = {}) => command('close', [], options),
    tab: Object.freeze({
      list: (options = {}) => command('tab-list', [], options),
      new: (url, options = {}) => command('tab-new', url == null ? [] : [url], options),
      select: (tabId, options = {}) => command('tab-select', [String(tabId)], options),
      close: (tabId, options = {}) => command('tab-close', tabId == null ? [] : [String(tabId)], options),
    }),
    snapshot: (target, options = {}) => command('snapshot', target == null ? [] : [target], options),
    click: (target, button, options = {}) => command('click', button == null ? [target] : [target, button], options),
    dblclick: (target, button, options = {}) => command('dblclick', button == null ? [target] : [target, button], options),
    fill: (target, value = '', options = {}) => command('fill', [target, value], options),
    type: (target, value = '', options = {}) => command('type', [target, value], options),
    press: (key, options = {}) => command('press', [key], options),
    keydown: (key, options = {}) => command('keydown', [key], options),
    keyup: (key, options = {}) => command('keyup', [key], options),
    hover: (target, options = {}) => command('hover', [target], options),
    select: (target, values, options = {}) => command('select', [target, ...(Array.isArray(values) ? values : [values])], options),
    check: (target, options = {}) => command('check', [target], options),
    uncheck: (target, options = {}) => command('uncheck', [target], options),
    drag: (start, end, options = {}) => command('drag', [start, end], options),
    eval: (source, options = {}) => command('eval', [source], options),
    evalElement: (source, target, options = {}) => command('eval', [source, target], options),
    webmcp: Object.freeze({
      list: (options = {}) => command('webmcp', ['list'], options),
      exec: (name, args = {}, options = {}) => command('webmcp', ['exec', name, JSON.stringify(args)], options),
    }),
    screenshot: (target, options = {}) => command('screenshot', target == null ? [] : [target], options),
    goBack: (options = {}) => command('go-back', [], options),
    goForward: (options = {}) => command('go-forward', [], options),
    reload: (options = {}) => command('reload', [], options),
    mouse: Object.freeze({
      move: (x, y, options = {}) => command('mousemove', [String(x), String(y)], options),
      down: (button, options = {}) => command('mousedown', button == null ? [] : [button], options),
      up: (button, options = {}) => command('mouseup', button == null ? [] : [button], options),
      wheel: (dx, dy, options = {}) => command('mousewheel', [String(dx), String(dy)], options),
    }),
    dialog: Object.freeze({
      accept: (prompt, options = {}) => command('dialog-accept', prompt == null ? [] : [prompt], options),
      dismiss: (options = {}) => command('dialog-dismiss', [], options),
    }),
    detach: (options = {}) => command('detach', [], options),
  });
})();
`

function browserRequest(args: JsonValue[]): BrowserRequest {
  const [name, positionals, options, stdin] = args
  if (typeof name !== 'string' || !Array.isArray(positionals) || positionals.some(value => typeof value !== 'string') ||
    (stdin !== undefined && typeof stdin !== 'string'))
    throw new Error('Invalid browser command')
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options)))
    throw new Error('Browser options must be an object')
  const cliArgs = [name]
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value === true) cliArgs.push(`--${key}`)
    else if (typeof value === 'string' || typeof value === 'number') cliArgs.push(`--${key}=${value}`)
    else throw new Error(`Invalid browser option: ${key}`)
  }
  cliArgs.push('--', ...positionals.map(String))
  return parseBrowserCommand({ args: cliArgs, stdin: typeof stdin === 'string' ? stdin : '' })
}

/** Scheduling belongs to the host; guest code has no timers. */
function nextTick(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, 25)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Only leaf callback results cross the VM boundary; context stays in the guest. */
function bindTree(
  tree: WorkflowTreeDescriptor,
  call: (tree: WorkflowTreeDescriptor & { id: string }, name: string, timeoutMs?: number) => Promise<JsonValue>,
): Node<null> {
  switch (tree.type) {
    case 'sequence': return sequence(...tree.children.map(child => bindTree(child, call)))
    case 'selector': return selector(...tree.children.map(child => bindTree(child, call)))
    case 'action': return action(async () => await call(tree, 'workflowRun') as Status)
    case 'condition': return condition(async () => await call(tree, 'workflowInspect') as boolean)
    case 'wait': {
      let startedAt: number | undefined
      return wait(async () => {
        startedAt ??= performance.now()
        const remaining = tree.timeoutMs === undefined ? undefined : Math.max(0, tree.timeoutMs - (performance.now() - startedAt))
        return await call(tree, 'workflowInspect', remaining) as boolean
      }, tree)
    }
  }
}

type NodeDiagnostic = {
  path: string
  type: WorkflowTreeDescriptor['type']
  description?: string
  elapsedMs: number
  reason: string
  lastObservation?: string
}

type WorkflowLog = { level: 'log' | 'info' | 'warn' | 'error'; message: string }

/** SW owns BT progress; a scoped QuickJS session owns user functions and business state. */
export async function executeAdapterWorkflow(
  wasm: WebAssembly.Module,
  source: string,
  input: JsonValue,
  runBrowser: BrowserCommand,
  signal: AbortSignal,
  target: { tabId: number; url: string } | null = null,
) {
  const { expression, contract, tree } = parseWorkflow(source)
  const inputValidator = createSchemaValidator(contract.inputSchema, 'Workflow inputSchema')
  const outputValidator = createSchemaValidator(contract.outputSchema, 'Workflow outputSchema')
  const logs: WorkflowLog[] = []
  let logCount = 0
  let activeNode: string | undefined
  let failedNode: NodeDiagnostic | undefined
  let lastNode: NodeDiagnostic | undefined
  const observations = new Map<string, string>()
  const started = new Map<string, number>()
  const descriptors = new Map<string, { tree: WorkflowTreeDescriptor; path: string }>()
  const indexTree = (node: WorkflowTreeDescriptor, key = 'root', path = 'tree') => {
    descriptors.set(key, { tree: node, path })
    if ('children' in node) node.children.forEach((child, i) => indexTree(child, `${key}/${i}`, `${path}.children[${i}]`))
  }
  indexTree(tree)
  const diagnostic = (node: WorkflowTreeDescriptor, path: string, elapsedMs: number, reason: string): NodeDiagnostic => ({
    path, type: node.type, elapsedMs: Math.max(0, Math.round(elapsedMs)), reason,
    ...(node.description ? { description: node.description } : {}),
    ...(observations.has(path) ? { lastObservation: observations.get(path)! } : {}),
  })
  const outcome = await withQuickJsSession(wasm, {
    filename: 'webmcp-workflow.js',
    setup: BROWSER_BINDINGS_SETUP,
    limits: { ...DEFAULT_LIMITS, timeoutMs: ADAPTER_TIMEOUT_MS, cpuTimeMs: 1_000 },
  }, {
    globals: { workflowInput: input, workflowTarget: target },
    functions: {
      invokeBrowser: async (args, callSignal) => {
        const node = activeNode
        callSignal.throwIfAborted()
        const value = await runBrowser(browserRequest(args), callSignal)
        if (node) observations.set(node, JSON.stringify(value).slice(0, 2048))
        return value
      },
    },
    onEvent: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !['log', 'info', 'warn', 'error'].includes(String(value.level)) || typeof value.message !== 'string') return
      const entry: WorkflowLog = { level: value.level as WorkflowLog['level'], message: value.message.slice(0, 2048) }
      logs.push(entry)
      if (logs.length > 100) logs.shift()
      // Log retention/output is bounded independently of browser-call budgets.
      if (logCount++ < 100) console[entry.level]('[WebMCP adapter]', entry.message)
    },
  }, signal, async (session): Promise<JsonValue> => {
    assertSchemaValue(inputValidator, input, 'Workflow input')
    await session.evaluate(`
      const workflow = (${expression});
      const context = { input: workflowInput, state: {}, target: workflowTarget };
      const nodes = new Map();
      function register(node, id) {
        nodes.set(id, node);
        if (node.children) node.children.forEach((child, index) => register(child, id + '.children[' + index + ']'));
      }
      register(workflow.tree, 'tree');
      globalThis.workflowRun = id => nodes.get(id).run(context);
      globalThis.workflowInspect = id => nodes.get(id).inspect(context);
      globalThis.workflowResult = async () => (await workflow.result(context)) ?? null;
    `)
    const call: Parameters<typeof bindTree>[1] = async (node, name, timeoutMs) => {
      const start = started.get(node.id) ?? performance.now()
      started.set(node.id, start)
      activeNode = node.id
      failedNode = undefined
      try {
        return await session.call(name, [node.id], timeoutMs === undefined ? undefined : { timeoutMs })
      } catch (error) {
        failedNode = diagnostic(node, node.id, performance.now() - start, 'exception')
        throw error
      } finally {
        lastNode = diagnostic(node, node.id, performance.now() - start, 'exception')
        activeNode = undefined
      }
    }
    const execution = createExecution(bindTree(tree, call), null, {
      now: () => performance.now(),
      onTransition: event => {
        if (event.status !== 'failure') return
        const { tree: node, path } = descriptors.get(event.path)!
        // Retain the cause, not each ancestor propagating the same failure.
        if ('children' in node && node.children.length > 0) return
        const reason = node.type === 'wait' ? 'wait_timeout' : node.type === 'condition' ? 'condition_false' : node.type === 'action' ? 'action_failure' : 'empty_selector'
        failedNode = diagnostic(node, path, event.elapsedMs, reason)
      },
    })
    let status: Status
    do {
      status = await execution.tick()
      if (status === 'running') await nextTick(session.signal)
    } while (status === 'running')
    if (status === 'failure') return { status, diagnostics: { ...(failedNode ? { node: failedNode } : {}), logs } }
    // Errors in result/schema validation must not be attributed to the last leaf.
    failedNode = undefined
    lastNode = undefined
    const result = await session.call('workflowResult')
    assertSchemaValue(outputValidator, result, 'Workflow output')
    return { status, result }
  })
  if (!outcome.ok) {
    const node = failedNode ?? lastNode
    const code = outcome.error.code === 'JS_CALL_TIMEOUT' ? 'JS_WAIT_TIMEOUT' : outcome.error.code
    return { ...outcome, error: {
      ...outcome.error, code,
      ...(node || logs.length ? { diagnostics: { ...(node ? { node: { ...node, reason: code } } : {}), logs } } : {}),
    } }
  }
  return outcome
}
