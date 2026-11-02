import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installAdapterBackground } from '../../../browser-extension/entrypoints/webmcp/adapter-background'
import { createAdapterService } from '../../../browser-extension/entrypoints/webmcp/adapter-service'

vi.mock('../../../browser-extension/entrypoints/webmcp/adapter-service', () => ({
  createAdapterService: vi.fn(),
}))
// The user-mount provider is backed by OPFS (unavailable in tests). Mocking
// the storage module lets the trusted-write test assert the write REACHES the
// provider (finding: "Trusted writes can still be denied" — `code !==
// 'EACCES'` also passes for EINVAL/EIO, i.e. a write the provider denied).
const adapterWriteFile = vi.hoisted(() => vi.fn(async () => undefined))
// Hoisted like `adapterWriteFile` so the readdir test can stub a KNOWN
// listing and assert an untrusted read SUCCEEDS (finding: "VFS listing
// rejection goes unnoticed").
const adapterReaddir = vi.hoisted(() => vi.fn(async () => [] as Array<{ name: string; kind: string }>))
vi.mock('../../../browser-extension/entrypoints/webmcp/provider-storage', () => ({
  // A PLAIN async function: `vi.resetAllMocks()` in beforeEach wipes
  // implementations set through vi.fn, which would make the provider
  // `undefined` mid-test.
  getAdapterStorage: async () => ({
    readOnly: false,
    stat: vi.fn(),
    readdir: adapterReaddir,
    readFile: vi.fn(),
    writeFile: adapterWriteFile,
    mkdir: vi.fn(),
    remove: vi.fn(),
  }),
}))

const onUpdated = vi.fn()
const onRemoved = vi.fn()
const onMessage = vi.fn()
const onStorageChanged = vi.fn()
const refresh = vi.fn(async () => {})
afterEach(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(createAdapterService).mockReturnValue({
    refresh,
  } as unknown as ReturnType<typeof createAdapterService>)
  vi.stubGlobal('chrome', {
    tabs: { onUpdated: { addListener: onUpdated }, onRemoved: { addListener: onRemoved } },
    storage: { onChanged: { addListener: onStorageChanged } },
    runtime: {
      id: 'test',
      getURL: (path: string) => 'chrome-extension://test' + path,
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: onMessage },
    },
  })
  installAdapterBackground({ runBrowser: async () => null })
})

it('does not cancel SW workflows on page navigation, refresh or target tab closure', () => {
  expect(onUpdated).not.toHaveBeenCalled()
  expect(onRemoved).not.toHaveBeenCalled()
  expect(refresh).toHaveBeenCalledOnce()
  expect(onMessage).toHaveBeenCalledOnce()
})

it('does not inject page authorization gates into workflow execution', () => {
  const dependencies = vi.mocked(createAdapterService).mock.calls[0][0]
  expect(dependencies).not.toHaveProperty('authorize')
})

it('blocks Web callers from the internal package configuration API', () => {
  const listener = onMessage.mock.calls[0][0]
  const respond = vi.fn()
  const accepted = listener(
    {
      type: 'webmcp_packages_set_config',
      mount: 'builtin-webmcp',
      directory: 'world.jmail.archive',
      config: { activation: 'enabled' },
    },
    { id: 'test', url: 'https://trusted-workspace.test' },
    respond
  )
  expect(accepted).toBe(false)
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'EACCES' }))
})

it.each([
  ['an ARRAY mount that stringifies to extension-skills', ['extension-skills']],
  ['a NUMBER mount', 0],
])('refuses a NON-STRING mount (%s) instead of letting it fall through to the writable provider', (_label, mount) => {
  // Round-3 finding "Sites bypass package consent": `String(['extension-skills'])`
  // passed the string-based allowlist, then the strict-equality dispatch fell
  // through to the writable `webmcp` provider — a hostile page could reach
  // package config writes that way.
  const listener = onMessage.mock.calls[0][0]
  const respond = vi.fn()
  listener(
    {
      type: 'webmcp_provider_call',
      mount,
      method: 'writeFile',
      path: 'com.hostile.pkg/config.json',
      content: btoa(JSON.stringify({ activation: 'enabled' })),
    },
    { id: 'test', url: 'https://evil.example/page' },
    respond,
  )
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'EINVAL' }))
})

it('routes the extension skill mount through the background transport', async () => {
  const listener = onMessage.mock.calls[0][0]
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    expect(
      listener(
        {
          type: 'webmcp_provider_call',
          mount: 'extension-skills',
          method: 'readFile',
          path: 'cw-webmcp-creator/SKILL.md',
        },
        { id: 'test' },
        resolve
      )
    ).toBe(true)
  })
  expect(result.ok).toBe(true)
  expect(atob(result.value as string)).toContain('name: cw-webmcp-creator')
})

/**
 * SECURITY (finding: "Websites bypass package consent"): the all-sites
 * content relay lets ANY page reach `webmcp_provider_call`, so a mutating
 * operation on the writable `webmcp` mount (e.g. writing `activation:
 * enabled` into an installed package's config.json) must require a trusted
 * CreatorWeave sender. Read operations stay open for the page-facing VFS.
 */
it('blocks MUTATING provider calls on the webmcp mount from untrusted pages', () => {
  const listener = onMessage.mock.calls[0][0]
  const respond = vi.fn()
  const accepted = listener(
    {
      type: 'webmcp_provider_call',
      mount: 'webmcp',
      method: 'writeFile',
      path: 'com.hostile.pkg/config.json',
      content: btoa(JSON.stringify({ activation: 'enabled' })),
    },
    { id: 'test', url: 'https://evil.example/page' },
    respond
  )
  expect(accepted).toBe(false)
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'EACCES' }))
})

it.each(['mkdir', 'remove'] as const)('blocks %s on the webmcp mount from untrusted pages too', method => {
  const listener = onMessage.mock.calls[0][0]
  const respond = vi.fn()
  listener(
    { type: 'webmcp_provider_call', mount: 'webmcp', method, path: 'com.hostile.pkg' },
    { id: 'test', url: 'https://evil.example/page' },
    respond
  )
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'EACCES' }))
})

it('lets a TRUSTED page mutate the webmcp mount (reads stay open for everyone)', async () => {
  const listener = onMessage.mock.calls[0][0]
  // Read from an untrusted page: allowed (the page-facing VFS renders the
  // file tree from reads). Finding: "VFS listing rejection goes unnoticed" —
  // `code !== 'EACCES'` also passed when the read failed with EINVAL, i.e.
  // the gate never proved untrusted READS still succeed. The storage mock
  // below returns a KNOWN directory listing, so this asserts the readdir
  // actually SUCCEEDED with those entries (ok:true + entries), not merely
  // that the gate let it through.
  const knownEntries = [
    { name: 'com.discord.main', kind: 'directory' },
    { name: 'com.example.pkg', kind: 'directory' },
  ]
  vi.mocked(adapterReaddir).mockResolvedValueOnce(knownEntries)
  const readResult = await new Promise<Record<string, unknown>>((resolve) => {
    listener(
      { type: 'webmcp_provider_call', mount: 'webmcp', method: 'readdir', path: '' },
      { id: 'test', url: 'https://evil.example/page' },
      resolve
    )
  })
  expect(readResult).toEqual({ ok: true, value: knownEntries })
  expect(adapterReaddir).toHaveBeenCalledWith('')
  // Write from a trusted app origin: allowed past the sender gate (the
  // settings installer writes the DISABLED default config). An
  // `activation: "enabled"` payload is separately refused by the consent
  // layer below — enabling is exclusively the opt-in flow's job.
  // Finding: "Trusted writes can still be denied" — `code !== 'EACCES'`
  // also passes for EINVAL/EROFS/EIO, i.e. a write the gate let through but
  // the provider DENIED. The storage module mock at the top of the file lets
  // this test assert the write REACHES the provider and succeeds.
  const writeResult = await new Promise<Record<string, unknown>>((resolve) => {
    listener(
      {
        type: 'webmcp_provider_call',
        mount: 'webmcp',
        method: 'writeFile',
        path: 'com.discord.main/config.json',
        content: btoa(JSON.stringify({ activation: 'disabled' })),
      },
      { id: 'test', url: 'http://localhost:5173/projects' },
      resolve
    )
  })
  expect(writeResult).toEqual({ ok: true, value: null })
  expect(adapterWriteFile).toHaveBeenCalledWith('com.discord.main/config.json', expect.any(Uint8Array))
  // The consent layer still refuses an ACTIVATION write even from a trusted
  // page — enabling is exclusively the opt-in flow's job.
  const activateResult = await new Promise<Record<string, unknown>>((resolve) => {
    listener(
      {
        type: 'webmcp_provider_call',
        mount: 'webmcp',
        method: 'writeFile',
        path: 'com.discord.main/config.json',
        content: btoa(JSON.stringify({ activation: 'enabled' })),
      },
      { id: 'test', url: 'http://localhost:5173/projects' },
      resolve
    )
  })
  expect(activateResult).toEqual(expect.objectContaining({ ok: false, code: 'EACCES' }))
  vi.restoreAllMocks()
})

/**
 * SECURITY (round-2 finding: "Websites can read package files"): the
 * all-sites content relay lets ANY page reach `webmcp_provider_call`, and
 * the provider returns file BYTES — an untrusted page could pull installed
 * package sources and configs straight off the mount. `readdir`/`stat` stay
 * open for the VFS tree (names only); `readFile` bytes require a trusted
 * CreatorWeave sender.
 */
it('blocks readFile on the webmcp mount from untrusted pages', async () => {
  const listener = onMessage.mock.calls[0][0]
  const respond = vi.fn()
  listener(
    { type: 'webmcp_provider_call', mount: 'webmcp', method: 'readFile', path: 'com.discord.main/workflows/read.js' },
    { id: 'test', url: 'https://evil.example/page' },
    respond
  )
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'EACCES' }))
})

/**
 * A user-mount package (registry install) keeps its activation config in the
 * extension's OPFS, which has no storage.onChanged hook. The opt-in enable
 * path announces the change through a chrome.storage.local sentinel; the
 * background must react to it, otherwise the newly enabled tools never
 * register and a removed package's routes stay invokable.
 */
it('refreshes the catalog when a USER package activation sentinel changes', async () => {
  const listener = onStorageChanged.mock.calls[0][0] as (changes: Record<string, unknown>, area: string) => void
  expect(refresh).toHaveBeenCalledTimes(1)

  listener({ 'webmcp_user_package_config_com.discord.main': { newValue: 1 } }, 'local')
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))

  // An unrelated storage change must NOT trigger a refresh.
  listener({ 'some_other_key': { newValue: 1 } }, 'local')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(refresh).toHaveBeenCalledTimes(2)
})
