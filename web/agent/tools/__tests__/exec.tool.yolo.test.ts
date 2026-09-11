/**
 * exec × YOLO mode tests.
 *
 * YOLO (conversation-scoped) must skip exec's prompt-level approval modal:
 *   - prompt-decision commands run without the auth modal
 *   - background processes skip their forced prompt too
 *   - forbidden commands stay blocked (checked BEFORE the yolo branch)
 *   - yolo never leaks across conversations (workspaceId scoping)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../tool-types'
import { execDefinition, execExecutor } from '../exec.tool'
import { useYoloModeStore } from '@/store/yolo-mode.store'

const { requestMock, checkPolicyMock, nativeHostCallMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  checkPolicyMock: vi.fn(),
  nativeHostCallMock: vi.fn(),
}))

vi.mock('@/store/tool-auth.store', () => ({
  useToolAuthStore: {
    getState: () => ({ request: requestMock }),
  },
}))

vi.mock('@/lib/native-host-probe', () => ({
  isNativeHostReachable: () => true,
  probeNativeHost: async () => true,
}))

vi.mock('@/sqlite/repositories/project-root.repository', () => ({
  getProjectRootRepository: () => ({
    findByProject: async () => [
      { backend: 'native-host', name: 'proj', scopeId: 'scope-1', isDefault: true },
    ],
  }),
}))

vi.mock('@/opfs', () => ({
  getWorkspaceManager: async () => ({
    getWorkspace: async () => null, // no workspace → no stale-disk notice
  }),
}))

const CONV_A = 'conv-a'
const CONV_B = 'conv-b'

function makeContext(workspaceId: string): ToolContext {
  return { directoryHandle: null, workspaceId, projectId: 'proj-1' }
}

function parseEnvelope(result: string): any {
  return JSON.parse(result)
}

beforeEach(() => {
  useYoloModeStore.setState({ yoloByConversation: {} })
  requestMock.mockReset()
  checkPolicyMock.mockReset()
  nativeHostCallMock.mockReset()
  ;(window as any).__agentWeb = {
    nativeHostCheckPolicy: checkPolicyMock,
    nativeHostCall: nativeHostCallMock,
  }
})

afterEach(() => {
  delete (window as any).__agentWeb
})

describe('exec × yolo mode', () => {
  it('exposes the exec tool', () => {
    expect(execDefinition.function.name).toBe('exec')
  })

  it('skips the approval modal when yolo is on for this conversation', async () => {
    useYoloModeStore.getState().setYolo(CONV_A, true)
    checkPolicyMock.mockResolvedValueOnce({ ok: true, decision: 'prompt' })
    nativeHostCallMock.mockResolvedValueOnce({
      ok: true, exit_code: 0, stdout: 'ran', stderr: '', truncated: false,
    })

    const result = await execExecutor(
      { command: ['pnpm', 'run', 'typecheck'] },
      makeContext(CONV_A),
    )
    const parsed = parseEnvelope(result)

    expect(parsed.ok).toBe(true)
    expect(requestMock).not.toHaveBeenCalled()
    expect(checkPolicyMock).toHaveBeenCalledWith(['pnpm', 'run', 'typecheck'])
    expect(nativeHostCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'exec_sync', scope_id: 'scope-1' }),
    )
  })

  it('still prompts when yolo is off (normal act mode)', async () => {
    checkPolicyMock.mockResolvedValueOnce({ ok: true, decision: 'prompt' })
    requestMock.mockResolvedValueOnce({ approved: true, remembered: false })
    nativeHostCallMock.mockResolvedValueOnce({
      ok: true, exit_code: 0, stdout: 'ran', stderr: '', truncated: false,
    })

    const result = await execExecutor(
      { command: ['pnpm', 'run', 'build'] },
      makeContext(CONV_A),
    )
    const parsed = parseEnvelope(result)

    expect(parsed.ok).toBe(true)
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'exec', memoryKey: null }),
    )
  })

  it('never leaks the grant across conversations', async () => {
    useYoloModeStore.getState().setYolo(CONV_A, true)
    checkPolicyMock.mockResolvedValueOnce({ ok: true, decision: 'prompt' })
    requestMock.mockResolvedValueOnce({ approved: true, remembered: false })
    nativeHostCallMock.mockResolvedValueOnce({
      ok: true, exit_code: 0, stdout: 'ran', stderr: '', truncated: false,
    })

    const result = await execExecutor(
      { command: ['pnpm', 'run', 'build'] },
      makeContext(CONV_B), // yolo is only on for CONV_A
    )
    const parsed = parseEnvelope(result)

    expect(parsed.ok).toBe(true)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('blocks forbidden commands even when yolo is on', async () => {
    useYoloModeStore.getState().setYolo(CONV_A, true)
    checkPolicyMock.mockResolvedValueOnce({ ok: true, decision: 'forbidden' })

    const result = await execExecutor(
      { command: ['sudo', 'rm', '-rf', '/'] },
      makeContext(CONV_A),
    )
    const parsed = parseEnvelope(result)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('forbidden')
    expect(requestMock).not.toHaveBeenCalled()
    expect(nativeHostCallMock).not.toHaveBeenCalled()
  })

  it('skips the forced background-process prompt when yolo is on', async () => {
    useYoloModeStore.getState().setYolo(CONV_A, true)
    // background:true forces decision 'prompt' in normal modes; policy says auto
    checkPolicyMock.mockResolvedValueOnce({ ok: true, decision: 'auto' })
    nativeHostCallMock.mockImplementation(async (payload: any) => {
      if (payload.action === 'exec_start') {
        return { ok: true, process_id: 'p1' }
      }
      if (payload.action === 'exec_status') {
        return { ok: true, state: 'running', port_ready: true, port: 5173 }
      }
      if (payload.action === 'exec_logs') {
        return { ok: true, data: btoa('listening on http://localhost:5173') }
      }
      return { ok: false, error: `unexpected action ${payload.action}` }
    })

    const result = await execExecutor(
      { command: ['pnpm', 'dev'], background: true, name: 'web', port: 5173 },
      makeContext(CONV_A),
    )
    const parsed = parseEnvelope(result)

    expect(parsed.ok).toBe(true)
    expect(parsed.data.background).toBe(true)
    expect(parsed.data.state).toBe('ready')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('prompts for background processes when yolo is off', async () => {
    checkPolicyMock.mockResolvedValueOnce({ ok: true, decision: 'auto' })
    requestMock.mockResolvedValueOnce({ approved: true, remembered: false })
    nativeHostCallMock.mockImplementation(async (payload: any) => {
      if (payload.action === 'exec_start') {
        return { ok: true, process_id: 'p1' }
      }
      if (payload.action === 'exec_status') {
        return { ok: true, state: 'running', port_ready: true, port: 5173 }
      }
      if (payload.action === 'exec_logs') {
        return { ok: true, data: btoa('listening on http://localhost:5173') }
      }
      return { ok: false, error: `unexpected action ${payload.action}` }
    })

    const result = await execExecutor(
      { command: ['pnpm', 'dev'], background: true, name: 'web', port: 5173 },
      makeContext(CONV_A),
    )
    const parsed = parseEnvelope(result)

    expect(parsed.ok).toBe(true)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })
})
