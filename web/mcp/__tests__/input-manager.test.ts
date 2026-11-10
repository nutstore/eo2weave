import { describe, expect, it } from 'vitest'
import type { ApplicationElicitResult, ApplicationInputRequest } from '@modelcontextprotocol/ext-tasks/client'
import type { JsonValue } from '@modelcontextprotocol/ext-tasks/core'
import {
  isSensitiveMCPForm,
  mapSamplingMessages,
  stableJSON,
  validateElicitation,
} from '../input-manager'

function elicitation(
  params: Record<string, unknown> = {},
  kind: 'elicitation' | 'sampling' | 'roots' = 'elicitation'
): ApplicationInputRequest {
  return { kind, params } as unknown as ApplicationInputRequest
}

function elicitationWithSchema(schema: Record<string, unknown>): ApplicationInputRequest {
  return elicitation({ requestedSchema: schema })
}

function accept(content: Record<string, unknown>): ApplicationElicitResult {
  return { action: 'accept', content } as unknown as ApplicationElicitResult
}

describe('stableJSON', () => {
  it('ignores object key order', () => {
    expect(stableJSON({ a: 1, b: 2 })).toBe(stableJSON({ b: 2, a: 1 }))
  })

  it('drops undefined members instead of emitting them', () => {
    expect(stableJSON({ a: 1, b: undefined })).toBe(stableJSON({ a: 1 }))
  })

  it('walks nested objects and arrays', () => {
    expect(stableJSON({ outer: { b: [1, { d: 4, c: 3 }], a: 2 } })).toBe(
      '{"outer":{"a":2,"b":[1,{"c":3,"d":4}]}}'
    )
  })

  it('keeps primitive and null values distinguishable', () => {
    expect(stableJSON(null)).toBe('null')
    expect(stableJSON('1')).toBe('"1"')
    expect(stableJSON(1)).toBe('1')
    expect(stableJSON(false)).toBe('false')
  })
})

describe('isSensitiveMCPForm', () => {
  it('flags schemas that ask for secrets', () => {
    expect(
      isSensitiveMCPForm(
        elicitationWithSchema({
          type: 'object',
          properties: { password: { type: 'string', default: 'hunter2' } },
        })
      )
    ).toBe(true)
    expect(
      isSensitiveMCPForm(
        elicitationWithSchema({ type: 'object', properties: { apiKey: { type: 'string' } } })
      )
    ).toBe(true)
    expect(
      isSensitiveMCPForm(
        elicitationWithSchema({ type: 'object', properties: { token: { type: 'string' } } })
      )
    ).toBe(true)
  })

  it('does not flag an ordinary form', () => {
    expect(
      isSensitiveMCPForm(
        elicitationWithSchema({ type: 'object', properties: { city: { type: 'string' } } })
      )
    ).toBe(false)
  })

  it('only applies to elicitation requests', () => {
    expect(isSensitiveMCPForm(elicitation({ requestedSchema: { password: 'x' } }, 'roots'))).toBe(
      false
    )
  })
})

describe('validateElicitation', () => {
  const schema = {
    type: 'object',
    properties: { city: { type: 'string' }, size: { type: 'string', enum: ['s', 'm'] } },
    required: ['city'],
  }

  it('accepts a response that satisfies the schema', () => {
    expect(() =>
      validateElicitation(elicitationWithSchema(schema), accept({ city: 'Shanghai', size: 'm' }))
    ).not.toThrow()
  })

  it('rejects a missing required field and an out-of-enum value', () => {
    expect(() => validateElicitation(elicitationWithSchema(schema), accept({ size: 'm' }))).toThrow()
    expect(() =>
      validateElicitation(elicitationWithSchema(schema), accept({ city: 'Shanghai', size: 'xl' }))
    ).toThrow()
  })

  it('skips validation when the user declines or cancels', () => {
    // Nothing was submitted, so an incomplete payload must not block dismissal.
    expect(() =>
      validateElicitation(elicitationWithSchema(schema), { action: 'decline' })
    ).not.toThrow()
    expect(() =>
      validateElicitation(elicitationWithSchema(schema), { action: 'cancel' })
    ).not.toThrow()
  })

  it('skips validation for url-mode elicitation', () => {
    expect(() =>
      validateElicitation(
        elicitation({ requestedSchema: schema, mode: 'url' }),
        accept({ unrelated: true })
      )
    ).not.toThrow()
  })

  it('rejects an elicitation without a schema object', () => {
    expect(() =>
      validateElicitation(elicitation({ requestedSchema: 'nope' }), accept({ city: 'Shanghai' }))
    ).toThrow()
  })

  it('ignores non-elicitation requests', () => {
    expect(() =>
      validateElicitation(elicitation({ requestedSchema: 'nope' }, 'roots'), accept({}))
    ).not.toThrow()
  })
})

describe('mapSamplingMessages', () => {
  const userMessage = (...blocks: JsonValue[]): Record<string, JsonValue> => ({
    role: 'user',
    content: blocks,
  })

  it('maps text blocks and the system prompt into a chat request', () => {
    const request = mapSamplingMessages(
      {
        systemPrompt: 'be brief',
        messages: [userMessage({ type: 'text', text: 'hello' })],
      },
      false
    )

    expect(request.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])
  })

  it('requires explicit server-supplied messages', () => {
    expect(() => mapSamplingMessages({ messages: [] }, false)).toThrow(
      'Sampling requires explicit messages'
    )
    expect(() => mapSamplingMessages({}, false)).toThrow('Sampling requires explicit messages')
  })

  it('refuses stop sequences the selected provider cannot enforce', () => {
    expect(() =>
      mapSamplingMessages(
        { messages: [userMessage({ type: 'text', text: 'hi' })], stopSequences: ['\n\n'] },
        false
      )
    ).toThrow('stop sequences')
  })

  it('drops images when the provider has no vision support', () => {
    // Silently forwarding an image to a text-only provider would fail only at
    // encode time, so the block must be rejected here instead.
    expect(() =>
      mapSamplingMessages(
        {
          messages: [
            userMessage({
              type: 'text',
              text: 'describe',
            }),
          ],
        },
        false
      )
    ).not.toThrow()

    expect(() =>
      mapSamplingMessages(
        {
          messages: [
            userMessage(
              { type: 'text', text: 'describe' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' }
            ),
          ],
        },
        false
      )
    ).toThrow('cannot be represented')
  })

  it('keeps images for providers that support them', () => {
    const request = mapSamplingMessages(
      {
        messages: [
          userMessage(
            { type: 'text', text: 'describe' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' }
          ),
        ],
      },
      true
    )

    expect(request.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    })
  })

  it('round-trips a tool_use / tool_result pair into tool_calls and a tool message', () => {
    const request = mapSamplingMessages(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'checking' },
              { type: 'tool_use', id: 'call-1', name: 'lookup', input: { city: 'Shanghai' } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                toolUseId: 'call-1',
                content: [{ type: 'text', text: 'sunny' }],
              },
            ],
          },
        ],
      },
      false
    )

    expect(request.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'checking' }],
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"city":"Shanghai"}' },
        },
      ],
    })
    expect(request.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'lookup',
      content: [{ type: 'text', text: 'sunny' }],
    })
  })
})
