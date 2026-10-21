// @vitest-environment node
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// WXT supplies these ambient types in the extension. This Node test imports
// that module from the web project without depending on a separate Vite client.
declare global {
  interface ImportMetaEnv {
    MODE: string
    readonly VITE_CW_DEV_WEBAPP_ORIGIN?: string
  }
  interface ImportMeta { readonly env: ImportMetaEnv }
}

vi.mock('wxt', () => ({ defineConfig: (config: unknown) => config }))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('extension development origin override', () => {
  beforeEach(() => {
    vi.stubEnv('MODE', 'development')
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN'] })
  })

  async function origin(override?: string) {
    vi.stubEnv('VITE_CW_DEV_WEBAPP_ORIGIN', override)
    return await import('../../../browser-extension/lib/webapp-origins')
  }

  it.each(['http://localhost:5174', 'http://127.0.0.1:5175/app?test=1'])('accepts a local HTTP override %s', async (value) => {
    const module = await origin(value)
    expect(module.getCwWebappBaseUrl()).toBe(new URL(value).origin)
  })

  it.each([undefined, '', 'broken', 'https://localhost:5174', 'http://example.com:5174', 'http://localhost.evil.test:5174'])('falls back for an unsupported override %s', async (value) => {
    const module = await origin(value)
    expect(module.getCwWebappBaseUrl()).toBe(module.CW_WEBAPP_ORIGIN_DEV)
  })

  it.each(['zh-CN', 'en-US'])('ignores the override in production for %s', async (language) => {
    vi.stubEnv('MODE', 'production')
    vi.stubGlobal('navigator', { language, languages: [language] })
    const module = await origin('http://localhost:5174')
    expect(module.getCwWebappBaseUrl()).toBe(language === 'zh-CN' ? module.CW_WEBAPP_ORIGIN_CN : module.CW_WEBAPP_ORIGIN_COM)
  })
})

describe('extension build locale processing', () => {
  it.each([
    ['development', true], ['development', false],
    ['production', true], ['production', false],
  ] as const)('keeps mode-specific names and OAuth stripping (%s, OAuth=%s)', async (mode, oauth) => {
    vi.stubEnv('CW_CODEX_OAUTH', oauth ? '1' : '0')
    vi.stubEnv('CW_STORE_BUILD', '0')
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 10, 12, 34, 56))
    const messages = {
      extensionName: { message: 'EO2Weave' },
      extensionNameDev: { message: 'EO2Weave Dev' },
      codexLogin: { message: 'Codex login' },
      extensionDescription: { message: 'Creator workspace' },
    }
    const { default: config } = await import('../../../browser-extension/wxt.config')
    // Patch the actual Node fs object used by WXT's CommonJS require, after
    // importing the config so module loading still reads real source files.
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readdirSync').mockReturnValue(['en', 'zh_CN'] as unknown as ReturnType<typeof fs.readdirSync>)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(messages))
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    type BuildConfig = {
      hooks: { 'build:done': (context: { config: { mode: string } }) => void }
      manifest: (env: { mode: string }) => { name: string; permissions: string[] }
    }
    const build = config as unknown as BuildConfig
    build.hooks['build:done']({ config: { mode } })
    expect(build.manifest({ mode }).name).toBe(mode === 'development' ? '__MSG_extensionNameDev__' : '__MSG_extensionName__')
    expect(build.manifest({ mode }).permissions).toEqual(expect.arrayContaining(['scripting', 'tabs', 'storage', 'sidePanel']))
    if (mode === 'production' && oauth) {
      expect(write).not.toHaveBeenCalled()
      return
    }
    expect(write).toHaveBeenCalledTimes(2)
    for (const [, serialized] of write.mock.calls) {
      const output = JSON.parse(String(serialized))
      expect(output.extensionName.message).toBe('EO2Weave')
      expect(output.extensionDescription.message).toBe('Creator workspace')
      if (mode === 'development') expect(output.extensionNameDev.message).toBe('EO2Weave Dev 12:34:56')
      else expect(output.extensionNameDev).toBeUndefined()
      if (oauth) expect(output.codexLogin).toEqual(messages.codexLogin)
      else expect(output.codexLogin).toBeUndefined()
    }
  })
})
