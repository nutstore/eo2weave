// @vitest-environment node
import { beforeAll, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { executeAdapterWorkflow } from '../../../browser-extension/entrypoints/webmcp/adapter-runtime'
import { builtinResources } from '../../../browser-extension/entrypoints/webmcp/builtin-resources'
import type { JsonValue } from '@creatorweave/quickjs-runtime'

// Regression guard for the Sourcery "workflow faults look like closed tabs"
// finding: the eval wrapper the workflows run NEVER rejects for a page-side
// error (the evaluationFunction catches it and returns
// { ok: false, message, exception }), so the only rejections that can reach
// the workflows' browser.eval catch are host-side failures — tab closed,
// navigation, or deadline. Every catch block must therefore map a rejection
// carrying a source marker to EVAL_FAILED (a live tab with an internal eval
// fault) and every other rejection to TAB_UNAVAILABLE, in ALL EIGHT
// workflows. A catch block that keeps mapping every rejection to
// TAB_UNAVAILABLE fails the marker check.
let wasm: WebAssembly.Module
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const runtimeRequire = createRequire(require.resolve('@creatorweave/quickjs-runtime/package.json'))
  wasm = await WebAssembly.compile(await readFile(runtimeRequire.resolve('quickjs-wasi/quickjs.wasm')))
})

const sources: Record<string, string> = {}
const marker = '__eo2EvalSourceMarker__'
beforeAll(async () => {
  const prefix = 'com.discord.main/'
  for (const tool of [
    'workflows/add_reaction.js',
    'workflows/remove_reaction.js',
    'workflows/read_messages.js',
    'workflows/send_message.js',
    'workflows/list_guilds.js',
    'workflows/list_channels.js',
    'workflows/get_user_profile.js',
    'workflows/search_messages.js',
  ]) {
    sources[tool] = builtinResources[prefix + tool]
  }
})

const WORKFLOWS = Object.keys(sources)

it('every eval catch distinguishes an eval-source fault from an unavailable tab (all eight workflows)', async () => {
  // Behavioral: a rejection carrying the source marker (thrown where the
  // real host would throw for a page-side or runtime fault) must surface
  // as EVAL_FAILED — the tab answered, so TAB_UNAVAILABLE would mislead
  // the caller into reopening a tab that is fine.
  for (const path of WORKFLOWS) {
    const source = sources[path]
    const markerError: any = new Error(`${marker}: page-side workflow exception`)
    markerError.name = marker
    const result = await executeAdapterWorkflow(
      wasm,
      source,
      minimalInputFor(path),
      async () => {
        throw markerError
      },
      new AbortController().signal,
      { tabId: 9, url: 'https://discord.com/channels/@me' },
    )
    expect(result.ok, path).toBe(true)
    const body = (result as { ok: true; value: { status: string; result?: { error_code?: string } } }).value
    expect(body.status, path).toBe('error')
    expect(body.result?.error_code, path).toBe('EVAL_FAILED')
    expect(String(body.result && (body.result as any).message), path).toContain(marker)
  }
})

it('every eval catch still reports a dead tab as TAB_UNAVAILABLE (all eight workflows)', async () => {
  for (const path of WORKFLOWS) {
    const source = sources[path]
    const result = await executeAdapterWorkflow(
      wasm,
      source,
      minimalInputFor(path),
      async () => {
        throw new Error('Target tab closed')
      },
      new AbortController().signal,
      { tabId: 9, url: 'https://discord.com/channels/@me' },
    )
    expect(result.ok, path).toBe(true)
    const body = (result as { ok: true; value: { status: string; result?: { error_code?: string } } }).value
    expect(body.status, path).toBe('error')
    expect(body.result?.error_code, path).toBe('TAB_UNAVAILABLE')
    expect(String(body.result && (body.result as any).message), path).toContain('Target tab closed')
  }
})

const minimalInputFor = (path: string): JsonValue => {
  switch (path) {
    case 'workflows/send_message.js':
      return { channel: 'c', content: 'x' }
    case 'workflows/add_reaction.js':
    case 'workflows/remove_reaction.js':
      return { channel: 'c', message_id: 'm', emoji: '👍' }
    case 'workflows/list_channels.js':
      return { guild_id: 'g' }
    case 'workflows/get_user_profile.js':
      return { user_id: 'u' }
    case 'workflows/search_messages.js':
      return { guild_id: 'g', content: 'q' }
    default:
      return {}
  }
}
