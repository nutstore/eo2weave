// @vitest-environment node
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { Linter } = require('eslint')
const rule = require('../no-reentrant-gateway-credential-lock.js')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lockImport =
  "import { withGatewayCredentialLock as lock } from '@/agent/providers/gateway-credential-lock';"

function lint(code: string, filename = 'agent/providers/example.ts') {
  const linter = new Linter()
  linter.defineParser('typescript', require('@typescript-eslint/parser'))
  linter.defineRule('credential-lock', rule)
  return linter.verify(
    code,
    {
      parser: 'typescript',
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
      rules: { 'credential-lock': 'error' },
    },
    { filename: path.join(root, filename), allowInlineConfig: false }
  )
}

function rejects(code: string, offender: string, filename?: string) {
  const messages = lint(code, filename)
  expect(messages).toHaveLength(1)
  expect(messages[0].message).toContain(offender)
  expect(messages[0].message).toContain('before')
  expect(messages[0].fatal).not.toBe(true)
}

describe('gateway credential commit boundary', () => {
  it.each([
    'await lock(async () => {})',
    'return lock(async () => {})',
    'return lock(async () => {}).catch(console.error)',
    'await Promise.all([lock(async () => {})])',
    'const pending = lock(async () => {}); await pending',
  ])('rejects blocking nested acquisition: %s', (body) => {
    rejects(`${lockImport} lock(async () => { ${body} });`, 'withGatewayCredentialLock')
  })

  it('checks referenced named callbacks', () => {
    rejects(
      `${lockImport} async function commit() { await lock(async () => {}); } lock(commit);`,
      'withGatewayCredentialLock'
    )
  })

  it('checks purpose-named Locked operations', () => {
    rejects(
      `${lockImport} const commitLocked = async () => { await lock(async () => {}); };`,
      'withGatewayCredentialLock'
    )
  })

  it.each([
    'resolveGatewayDispatchCredential',
    'getValidAccessToken',
    'isGatewayAccessTokenCurrent',
    'hasStoredSession',
    'refreshAccessTokenWithStatus',
    'refreshAccessTokenWithStatusImpl',
    'forceRefreshAccessToken',
    'logoutGateway',
    'invalidateGatewayAccessToken',
    'loadStoredTokensWithFallback',
    'clearStoredTokens',
    'inspectPriorSession',
    'withGatewayRefreshLock',
  ])('rejects auth entry %s including aliases', (entry) => {
    rejects(
      `${lockImport} import { ${entry} as resolve } from './llm-gateway-auth'; lock(async () => { await resolve(); });`,
      entry
    )
  })

  it.each([
    'clearStoredTokens',
    'resolveGatewayDispatchCredential',
    'refreshAccessTokenWithStatusImpl',
  ])('checks owning auth private function %s', (entry) => {
    rejects(
      `${lockImport} async function ${entry}() {} lock(async () => { await ${entry}(); });`,
      entry,
      'agent/providers/llm-gateway-auth.ts'
    )
  })

  it.each([
    'prepareGatewayModels',
    'updateGatewayModels',
    'fetchGatewayRateLimits',
    'getValidAccessToken',
    'logoutGateway',
  ])('checks provider exports and auth re-exports: %s', (entry) => {
    rejects(
      `${lockImport} import { ${entry} as prepare } from './llm-gateway-provider'; lock(async () => { await prepare(); });`,
      entry
    )
  })

  it.each(['applyGatewayLoginTokens', 'applyGatewayLoginTokensInner'])(
    'checks login entry %s',
    (entry) => {
      rejects(
        `${lockImport} import { ${entry} } from '@/lib/gateway-login'; lock(async () => { await ${entry}(); });`,
        entry
      )
    }
  )

  it.each([
    ['agent/providers/llm-gateway-provider.ts', 'prepareGatewayModels'],
    ['lib/gateway-login.ts', 'applyGatewayLoginTokensInner'],
  ])('checks owning module entry in %s', (filename, entry) => {
    rejects(
      `${lockImport} async function ${entry}() {} lock(async () => { await ${entry}(); });`,
      entry,
      filename
    )
  })

  it('checks inline preparation callbacks inside a commit', () => {
    rejects(
      `${lockImport} import { getValidAccessToken } from './llm-gateway-auth'; lock(async () => { await runBoundedFencedKeyStoreMutation(async () => getValidAccessToken()); });`,
      'getValidAccessToken'
    )
  })

  it('checks dispatch resolver', () => {
    rejects(
      `${lockImport} import { resolveDispatchApiKey } from './gateway-dispatch-key'; lock(async () => { await resolveDispatchApiKey(); });`,
      'resolveDispatchApiKey'
    )
  })

  it('checks namespace imports and lock aliases', () => {
    rejects(
      `import * as locks from './gateway-credential-lock'; import * as auth from './llm-gateway-auth'; locks.withGatewayCredentialLock(async () => { await auth.getValidAccessToken(); });`,
      'getValidAccessToken'
    )
  })

  it('checks ordinary dynamic destructured imports', () => {
    rejects(
      `${lockImport} async function run() { const { getValidAccessToken: resolve } = await import('./llm-gateway-auth'); await lock(async () => { await resolve(); }); }`,
      'getValidAccessToken'
    )
  })

  it('checks a dynamic namespace import inside a callback', () => {
    rejects(
      `${lockImport} lock(async () => { const auth = await import('./llm-gateway-auth'); await auth.getValidAccessToken(); });`,
      'getValidAccessToken'
    )
  })

  it('checks credential registry resolution', () => {
    rejects(
      `${lockImport} import { credentialRegistry as registry } from './credential-state'; lock(async () => { await registry.resolve('llm-gateway'); });`,
      'credentialRegistry.resolve'
    )
  })

  it.each([
    'const settings = useSettingsStore.getState(); await settings.checkHasApiKey();',
    'await useSettingsStore.getState().checkHasApiKey();',
    'const { checkHasApiKey: check } = useSettingsStore.getState(); await check();',
  ])('checks settings resolution: %s', (body) => {
    rejects(
      `${lockImport} import { useSettingsStore } from '@/store/settings.store'; lock(async () => { ${body} });`,
      'checkHasApiKey'
    )
  })

  it('still checks explicitly queued callbacks', () => {
    rejects(
      `${lockImport} import { getValidAccessToken } from './llm-gateway-auth'; lock(async () => { void lock(async () => { await getValidAccessToken(); }).catch(console.error); });`,
      'getValidAccessToken'
    )
  })

  it.each([
    `${lockImport} await Promise.all([lock(async () => {}), lock(async () => {})]); await lock(async () => {});`,
    `${lockImport} import { hasStoredTokens, persistDeviceLoginTokens, saveStoredTokens } from './llm-gateway-auth'; lock(async () => { hasStoredTokens(); persistDeviceLoginTokens(); saveStoredTokens(); });`,
    `${lockImport} lock(async () => { void lock(async function backupLocked() {}).catch(console.error); });`,
    `${lockImport} import { getValidAccessToken } from './llm-gateway-auth'; const token = await getValidAccessToken(); lock(async () => { console.log(token); });`,
    `${lockImport} import { getValidAccessToken } from './unrelated'; lock(async () => { await getValidAccessToken(); });`,
    `${lockImport} function getValidAccessToken() {} lock(async () => { getValidAccessToken(); });`,
    `${lockImport} import { getValidAccessToken } from './llm-gateway-auth'; lock(async () => { const getValidAccessToken = () => {}; getValidAccessToken(); });`,
    `${lockImport} lock(async () => { const lock = async (callback) => callback(); await lock(async () => {}); });`,
    `${lockImport} lock(async () => { const credentialRegistry = { resolve() {} }; credentialRegistry.resolve(); const settings = { checkHasApiKey() {} }; settings.checkHasApiKey(); });`,
  ])('allows normal independent commits and safe local operations: %s', (code) => {
    expect(lint(code)).toEqual([])
  })

  it('does not mistake a shadow of an owning private function', () => {
    expect(
      lint(
        `${lockImport} async function clearStoredTokens() {} lock(async () => { const clearStoredTokens = () => {}; clearStoredTokens(); });`,
        'agent/providers/llm-gateway-auth.ts'
      )
    ).toEqual([])
  })

  it.each([
    'agent/providers/llm-gateway-auth.ts',
    'agent/providers/gateway-credential-lock.ts',
    'agent/providers/llm-gateway-provider.ts',
    'lib/gateway-login.ts',
    'components/settings/ProviderManager.tsx',
  ])('accepts actual commit boundaries in %s', (filename) => {
    expect(lint(readFileSync(path.join(root, filename), 'utf8'), filename)).toEqual([])
  })
})
