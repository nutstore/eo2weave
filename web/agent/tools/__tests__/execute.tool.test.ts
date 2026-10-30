import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../tool-types'
import { pythonDefinition, pythonToolExecutor } from '../execute.tool'

const pythonExecuteMock = vi.fn()
const getActiveConversationMock = vi.fn()
const refreshPendingChangesMock = vi.fn()

vi.mock('@/python', () => ({
  pythonExecutor: {
    execute: (...args: unknown[]) => pythonExecuteMock(...args),
  },
}))

vi.mock('@/store/conversation-context.store', () => ({
  getActiveConversation: () => getActiveConversationMock(),
  useConversationContextStore: {
    getState: () => ({
      refreshPendingChanges: (...args: unknown[]) => refreshPendingChangesMock(...args),
    }),
  },
}))

// Secret-store + project-store mocks: loadRuntimeSecrets imports these
// dynamically. The getAllSecretNames mock records every call so the
// direct-mode test can assert that NO secret name is ever enumerated (and
// loadSecret would throw if it were reached with any name).
const getAllSecretNamesMock = vi.fn((_projectId?: string): Promise<never[]> =>
  Promise.resolve(['GLOBAL_API_KEY', 'PROJECT_TOKEN'] as never[])
)
const loadSecretMock = vi.fn((_projectId: string, _name: string): Promise<string | null> => {
  throw new Error('loadSecret must not be reached in direct mode')
})
vi.mock('@/security/secret-store', () => ({
  getAllSecretNames: (projectId?: string) => getAllSecretNamesMock(projectId),
  loadSecret: (projectId: string, name: string) => loadSecretMock(projectId, name),
}))
vi.mock('@/store/project.store', () => ({
  useProjectStore: {
    getState: () => ({ activeProjectId: 'host-project' }),
  },
}))

// OPFS mocks for executePython's workspace plumbing: a minimal workspace with
// empty dirs so the executor runs end-to-end and we can inspect the
// runtimeSecrets handed to the Python executor.
const emptyDirHandle = {
  values: () => (async function* () {})(),
}
const workspaceMock = {
  scanFilesWithCache: vi.fn(async () => new Map()),
  detectChanges: vi.fn(() => ({ changes: [] })),
  getFilesDir: vi.fn(async () => emptyDirHandle),
  getAssetsDir: vi.fn(async () => emptyDirHandle),
}
vi.mock('@/opfs', () => ({
  getWorkspaceManager: async () => ({
    getWorkspace: async () => workspaceMock,
  }),
}))

const context: ToolContext = {
  directoryHandle: null,
}

function parseError(result: string): { error: string } | null {
  try {
    const parsed = JSON.parse(result)
    // V2 envelope error: { ok: false, error: { code, message } }
    if (parsed && parsed.error && typeof parsed.error.message === 'string') {
      return { error: parsed.error.message }
    }
    // Legacy: { error: "string" }
    if (parsed && typeof parsed.error === 'string') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

describe('run_python tool', () => {
  it('exposes run_python tool name with python-only params', () => {
    expect(pythonDefinition.function.name).toBe('run_python')
    expect(pythonDefinition.function.parameters.properties.language).toBeUndefined()
    expect(pythonDefinition.function.parameters.required).toContain('code')
  })

  it('rejects execution when workspaceId is missing', async () => {
    getActiveConversationMock.mockResolvedValueOnce(null)

    const result = await pythonToolExecutor(
      {
        code: "print('hello')",
      },
      context
    )

    const error = parseError(result)
    expect(error).not.toBeNull()
    expect(error?.error).toBe('workspaceId is required but was not provided (caller bug)')
  })

  it('directMode injects NO secrets into the Python sandbox (not even global scope)', async () => {
    // Finding: in directMode loadRuntimeSecrets enumerated and loaded every
    // GLOBAL secret into the Pyodide worker. Standalone-chat code is
    // model-supplied and steerable by untrusted conversation/fetched content,
    // so any injected value is one pyfetch away from exfiltration; output
    // redaction cannot stop an outbound transfer. Direct mode must load
    // NOTHING — no project and no global secrets.
    pythonExecuteMock.mockResolvedValueOnce({ stdout: 'ok' })
    refreshPendingChangesMock.mockResolvedValueOnce(undefined)

    const result = await pythonToolExecutor(
      { code: "import os; print(os.getenv('GLOBAL_API_KEY'))" },
      { ...context, workspaceId: 'chat-1', directMode: true }
    )

    // The run itself succeeded...
    expect(parseError(result)).toBeNull()
    // ...but the sandbox received an EMPTY secret map.
    expect(pythonExecuteMock).toHaveBeenCalled()
    const call = pythonExecuteMock.mock.calls[0][0] as { runtimeSecrets: Record<string, string> }
    expect(call.runtimeSecrets).toEqual({})
    // No secret name was ever enumerated and no value was ever loaded.
    expect(getAllSecretNamesMock).not.toHaveBeenCalled()
    expect(loadSecretMock).not.toHaveBeenCalled()
  })

  it('non-direct runs still receive the configured secrets', async () => {
    // Guard the boundary from the other side: the direct-mode cut must not
    // silently disable secrets for ordinary project conversations.
    loadSecretMock.mockImplementation(async (_projectId: string, name: string) => `value-${name}`)
    pythonExecuteMock.mockResolvedValueOnce({ stdout: 'ok' })
    refreshPendingChangesMock.mockResolvedValueOnce(undefined)

    const result = await pythonToolExecutor(
      { code: "print('hello')" },
      { ...context, workspaceId: 'conv-1' }
    )

    expect(parseError(result)).toBeNull()
    expect(getAllSecretNamesMock).toHaveBeenCalledWith('host-project')
    // This is the SECOND execution in this file: the first (direct-mode) test
    // already invoked the executor, so index by the latest call, not call 0.
    const lastCall = pythonExecuteMock.mock.calls[pythonExecuteMock.mock.calls.length - 1][0] as {
      runtimeSecrets: Record<string, string>
    }
    expect(lastCall.runtimeSecrets).toEqual({
      GLOBAL_API_KEY: 'value-GLOBAL_API_KEY',
      PROJECT_TOKEN: 'value-PROJECT_TOKEN',
    })
  })
})
