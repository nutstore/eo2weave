import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { relayMCPNetwork } from '../../lib/mcp-network'

/**
 * The relay is the privileged fetch: the background handler validates exactly
 * one URL (`assertValidMcpEndpointUrl`) and then hands the request here. These
 * tests pin the property that makes that validation sufficient — a redirect
 * can never move the request to a host that was not validated.
 */

type Frame = { type?: string; data?: unknown }

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  )
}

function collect(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
  legacyPayload: Record<string, unknown> = {}
) {
  const request = {
    url,
    ...init,
    // A stale page or extension build may still send `redirect`; the relay must
    // ignore it rather than honour it.
    ...legacyPayload,
  } as unknown as Parameters<typeof relayMCPNetwork>[1]
  return new Promise<Frame[]>((resolve) => {
    const frames: Frame[] = []
    relayMCPNetwork(
      {
        postMessage: (message: unknown) => {
          const frame = message as Frame
          frames.push(frame)
          if (frame.type === 'done' || frame.type === 'error') resolve(frames)
        },
        disconnect: () => {},
        onDisconnect: { addListener: () => {} },
        onMessage: { addListener: () => {} },
      },
      request
    )
    setTimeout(() => resolve(frames), 2000)
  })
}

describe('relayMCPNetwork', () => {
  let target: Server
  let redirector: Server
  let targetPort = 0
  let redirectorPort = 0
  let targetHits = 0

  beforeAll(async () => {
    target = createServer((_req, res) => {
      targetHits += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('INTERNAL-ONLY-BODY')
    })
    targetPort = await listen(target)

    redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/internal` })
      res.end()
    })
    redirectorPort = await listen(redirector)
  })

  afterAll(() => {
    target.close()
    redirector.close()
  })

  it('refuses to follow a redirect, including when the caller asks for it', async () => {
    targetHits = 0

    const frames = await collect(`http://127.0.0.1:${redirectorPort}/start`, {}, { redirect: 'follow' })

    expect(targetHits).toBe(0)
    expect(frames.at(-1)?.type).toBe('error')
  })

  it('still streams a direct request', async () => {
    targetHits = 0

    const frames = await collect(`http://127.0.0.1:${targetPort}/mcp`)

    expect(targetHits).toBe(1)
    // response_start frame, then the body bytes, then done.
    expect(frames.map((frame) => frame.type)).toEqual(['chunk', 'chunk', 'done'])
    expect((frames[0].data as { type?: string }).type).toBe('response_start')
  })
})
