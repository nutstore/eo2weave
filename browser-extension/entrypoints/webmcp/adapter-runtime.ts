import { createExecution, action, condition, wait, sequence, selector, type Node, type Status } from '@creatorweave/behavior-tree'
import { TOOL_BINDINGS_SETUP } from '@creatorweave/shared/code-tool-bindings'
import { withQuickJsSession, DEFAULT_LIMITS, type JsonValue, type RuntimeBindings, type QuickJsSession } from '@creatorweave/quickjs-runtime'
import { parseWorkflow, type WorkflowTreeDescriptor } from '@creatorweave/shared/webmcp-adapter'
import { createSchemaValidator, assertSchemaValue } from '@creatorweave/shared/webmcp-schema'
import { ADAPTER_TIMEOUT_MS } from '@creatorweave/shared/webmcp-adapter-protocol'

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
  toolNames: string[],
  invoke: RuntimeBindings['functions'][string],
  signal: AbortSignal,
  target: { tabId: number; url: string } | null = null,
) {
  const { expression, contract, tree } = parseWorkflow(source)
  const inputValidator = createSchemaValidator(contract.inputSchema, 'Workflow inputSchema')
  const outputValidator = createSchemaValidator(contract.outputSchema, 'Workflow outputSchema')
  return withQuickJsSession(wasm, {
    filename: 'webmcp-workflow.js',
    setup: TOOL_BINDINGS_SETUP,
    limits: { ...DEFAULT_LIMITS, timeoutMs: ADAPTER_TIMEOUT_MS, cpuTimeMs: 1_000 },
  }, {
    globals: { workflowInput: input, workflowTarget: target, toolNames },
    functions: {
      invokeTool: async (args, callSignal) => {
        if (typeof args[0] !== 'string' || !toolNames.includes(args[0])) throw new Error(`Tool unavailable: ${args[0]}`)
        return invoke(args, callSignal)
      },
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
