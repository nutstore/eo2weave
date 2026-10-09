import { TOOL_BINDINGS_SETUP } from '@creatorweave/shared/code-tool-bindings'
import { executeQuickJs, DEFAULT_LIMITS, type JsonValue, type RuntimeBindings } from '@creatorweave/quickjs-runtime'
import { parseWorkflow } from '@creatorweave/shared/webmcp-adapter'
import { createSchemaValidator, assertSchemaValue } from '@creatorweave/shared/webmcp-schema'
import { ADAPTER_TIMEOUT_MS } from '@creatorweave/shared/webmcp-adapter-protocol'

/** Compile workflow functions only inside the VM; schema validation stays in the host. */
export async function executeAdapterWorkflow(
  wasm: WebAssembly.Module,
  source: string,
  input: JsonValue,
  toolNames: string[],
  invoke: RuntimeBindings['functions'][string],
  signal: AbortSignal,
  target: { tabId: number; url: string } | null = null,
) {
  const { expression, contracts } = parseWorkflow(source)
  const validators = contracts.map((contract, index) => ({
    input: createSchemaValidator(contract.inputSchema, `Step ${index + 1} inputSchema`),
    output: createSchemaValidator(contract.outputSchema, `Step ${index + 1} outputSchema`),
  }))
  return executeQuickJs(wasm, {
    filename: 'webmcp-workflow.js',
    setup: TOOL_BINDINGS_SETUP,
    limits: { ...DEFAULT_LIMITS, timeoutMs: ADAPTER_TIMEOUT_MS, cpuTimeMs: 1_000 },
    code: `
      const steps = (${expression});
      const context = { input: workflowInput, state: {}, target: workflowTarget };
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        await validateStep(index, 'input', context.input);
        const inspection = await step.inspect(context);
        if (inspection?.status === 'blocked' && typeof inspection.message === 'string' && inspection.message.trim()) {
          return { status: 'blocked', step: index + 1, description: step.description, message: inspection.message };
        }
        if (inspection?.status !== 'ready') throw new Error('Step ' + (index + 1) + ': inspect must return ready or blocked with a message');
        const result = (await step.run(context)) ?? null;
        await validateStep(index, 'output', result);
        context.input = result;
      }
      return { status: 'completed', result: context.input };
    `,
  }, {
    globals: { workflowInput: input, workflowTarget: target, toolNames },
    functions: {
      invokeTool: async (args, callSignal) => {
        if (typeof args[0] !== 'string' || !toolNames.includes(args[0])) throw new Error(`Tool unavailable: ${args[0]}`)
        return invoke(args, callSignal)
      },
      validateStep: async ([index, phase, value], callSignal) => {
        callSignal.throwIfAborted()
        if (typeof index !== 'number' || !validators[index] || (phase !== 'input' && phase !== 'output')) throw new Error('Invalid workflow contract')
        assertSchemaValue(validators[index][phase], value, `Step ${index + 1} ${phase}`)
        return null
      },
      writeLog: async () => null,
    },
  }, signal)
}
