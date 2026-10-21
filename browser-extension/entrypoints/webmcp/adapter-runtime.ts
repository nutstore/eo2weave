import { createExecution, action, condition, wait, sequence, selector, type Node, type Status } from '@creatorweave/behavior-tree'
import { withQuickJsSession, DEFAULT_LIMITS, type JsonValue, type QuickJsSession } from '@creatorweave/quickjs-runtime'
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
  const hostWriteLog = writeLog;
  delete globalThis.invokeBrowser;
  delete globalThis.writeLog;
  const formatLog = value => { if (typeof value === 'string') return value; try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } };
  globalThis.console = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error'].map(name => [name, (...args) => { void hostWriteLog(args.map(formatLog).join(' ')); }])));
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
function bindTree(tree: WorkflowTreeDescriptor, session: QuickJsSession): Node<null> {
  switch (tree.type) {
    case 'sequence': return sequence(...tree.children.map(child => bindTree(child, session)))
    case 'selector': return selector(...tree.children.map(child => bindTree(child, session)))
    case 'action': return action(async () => await session.call('workflowRun', [tree.id]) as Status)
    case 'condition': return condition(async () => await session.call('workflowInspect', [tree.id]) as boolean)
    case 'wait': return wait(async () => await session.call('workflowInspect', [tree.id]) as boolean, tree)
  }
}

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
  return withQuickJsSession(wasm, {
    filename: 'webmcp-workflow.js',
    setup: BROWSER_BINDINGS_SETUP,
    limits: { ...DEFAULT_LIMITS, timeoutMs: ADAPTER_TIMEOUT_MS, cpuTimeMs: 1_000 },
  }, {
    globals: { workflowInput: input, workflowTarget: target },
    functions: {
      invokeBrowser: async (args, callSignal) => runBrowser(browserRequest(args), callSignal),
      writeLog: async () => null,
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
    const execution = createExecution(bindTree(tree, session), null)
    let status: Status
    do {
      status = await execution.tick()
      if (status === 'running') await nextTick(session.signal)
    } while (status === 'running')
    if (status === 'failure') return { status }
    const result = await session.call('workflowResult')
    assertSchemaValue(outputValidator, result, 'Workflow output')
    return { status, result }
  })
}
