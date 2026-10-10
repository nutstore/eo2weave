import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../tool-types'
import { readImageDefinition, readImageExecutor } from '../read-image.tool'

const resolveVfsTargetMock = vi.fn()
const fileToBase64Mock = vi.fn()
const performOcrMock = vi.fn()
const isOcrCompatibleImageMock = vi.fn()

vi.mock('../vfs-resolver', () => ({
  resolveVfsTarget: (...args: unknown[]) => resolveVfsTargetMock(...args),
}))
vi.mock('../agent-file-protection', () => ({
  isSubagentPermissionDenied: () => false,
  SUBAGENT_PERMISSION_DENIED: 'SUBAGENT_PERMISSION_DENIED',
}))
vi.mock('@/services/ocr.service', () => ({
  fileToBase64: (...args: unknown[]) => fileToBase64Mock(...args),
  performOcr: (...args: unknown[]) => performOcrMock(...args),
  isOcrCompatibleImage: (...args: unknown[]) => isOcrCompatibleImageMock(...args),
}))

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    directoryHandle: null,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    provider: { getModel: () => ({ input: ['text', 'image'] }) } as never,
    ...overrides,
  }
}

function mockImageTarget() {
  resolveVfsTargetMock.mockResolvedValue({
    kind: 'workspace',
    path: 'photos/chart.png',
    backend: {
      readFile: vi.fn().mockResolvedValue({
        content: new Uint8Array([137, 80, 78, 71]),
        mimeType: 'image/png',
      }),
    },
  })
}

describe('read_image tool', () => {
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 1,
      height: 1,
      close: vi.fn(),
    }))

    resolveVfsTargetMock.mockReset()
    fileToBase64Mock.mockReset()
    performOcrMock.mockReset()
    isOcrCompatibleImageMock.mockReset()
    isOcrCompatibleImageMock.mockReturnValue(true)
    fileToBase64Mock.mockResolvedValue('iVBORw0KGgo=')
    performOcrMock.mockResolvedValue({
      text: 'recognized text',
      base64Data: 'aW1hZ2U=',
      mimeType: 'image/png',
      status: 'done',
    })
    mockImageTarget()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('declares path as the only required input', () => {
    expect(readImageDefinition.function.parameters.required).toEqual(['path'])
  })

  it('returns portable JSON without a provider or conversation callback', async () => {
    const context = makeContext({provider: undefined})
    const result = JSON.parse(await readImageExecutor({path:'photos/chart.png'}, context))
    expect(result.data).toEqual({type:'image',path:'photos/chart.png',data:'iVBORw0KGgo=',mimeType:'image/png',width:1,height:1})
    expect(performOcrMock).not.toHaveBeenCalled()
    expect(context).not.toHaveProperty('onReadImageSuccess')
  })
  it('returns the same data for a text-only model without automatic OCR', async () => {
    const result = JSON.parse(await readImageExecutor({path:'photos/chart.png'}, makeContext({provider:{getModel:()=>({input:['text']})} as never})))
    expect(result.data.type).toBe('image')
    expect(performOcrMock).not.toHaveBeenCalled()
  })
  it('honors cancellation without producing output', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = JSON.parse(await readImageExecutor({path:'photos/chart.png'}, makeContext({abortSignal:controller.signal})))
    expect(result.ok).toBe(false)
    expect(fileToBase64Mock).not.toHaveBeenCalled()
  })
  it('rejects an oversized source before decoding or encoding', async () => {
    resolveVfsTargetMock.mockResolvedValueOnce({
      kind: 'workspace',
      path: 'photos/huge.png',
      backend: {
        readFile: vi.fn().mockResolvedValue({
          content: new Uint8Array(10 * 1024 * 1024 + 1),
          mimeType: 'image/png',
        }),
      },
    })
    const raw = await readImageExecutor({ path: 'photos/huge.png' }, makeContext())
    const result = JSON.parse(raw)

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('image_too_large')
    expect(fileToBase64Mock).not.toHaveBeenCalled()
    expect(performOcrMock).not.toHaveBeenCalled()
  })

  it('rejects an image whose decoded dimensions exceed the pixel limit', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 5_000,
      height: 5_000,
      close: vi.fn(),
    }))
    const raw = await readImageExecutor({ path: 'photos/chart.png' }, makeContext())
    const result = JSON.parse(raw)

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('image_dimensions_too_large')
  })

  it('rejects non-image files before decoding', async () => {
    isOcrCompatibleImageMock.mockReturnValueOnce(false)
    resolveVfsTargetMock.mockResolvedValueOnce({
      kind: 'workspace',
      path: 'notes.txt',
      backend: {
        readFile: vi.fn().mockResolvedValue({
          content: new Uint8Array([1]),
          mimeType: 'text/plain',
        }),
      },
    })
    const raw = await readImageExecutor({ path: 'notes.txt' }, makeContext())
    const result = JSON.parse(raw)

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('not_an_image')
  })
})
