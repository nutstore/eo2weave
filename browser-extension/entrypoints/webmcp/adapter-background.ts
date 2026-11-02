import { normalizeProviderPath } from '@creatorweave/fs-provider'
import { getExtensionSkillStorage } from './skill-resources'
import { isTrustedCreatorWeaveSenderUrl } from '@creatorweave/shared'
import { validateAdapterDirectory } from './adapter-validation'
import { getWebMCPMounts, readEnabledWebMCPPackages } from './package-repository'
import { getBuiltinStorage, BUILTIN_CONFIG_STORAGE_KEY } from './builtin-storage'
import { USER_PACKAGE_CONFIG_SENTINEL_PREFIX } from './package-optin-handler'
import { createPackageManagement } from './package-management'
import { getAdapterStorage } from './provider-storage'
import { createProviderHandler } from './provider-handler'
import { createAdapterService } from './adapter-service'
import { isRecord } from '@creatorweave/shared/webmcp-adapter-protocol'
import {
  bridgeAcquirePackageLock,
  bridgeHeartbeatPackageLock,
  bridgeReleasePackageLock,
} from './package-lock'
import type { BrowserRequest } from '../../lib/bash-commands/browser/command'

interface AdapterBackgroundOptions {
  runBrowser(owner: string, request: BrowserRequest, signal: AbortSignal): Promise<unknown>
}

export function installAdapterBackground({ runBrowser }: AdapterBackgroundOptions) {
  let wasm: Promise<WebAssembly.Module> | undefined
  const service = createAdapterService({
    readPackages: readEnabledWebMCPPackages,
    runBrowser,
    loadWasm: () => wasm ??= fetch(chrome.runtime.getURL('/assets/quickjs/quickjs.wasm'))
      .then(async response => {
        if (!response.ok) throw new Error(`QuickJS WASM unavailable: ${response.status}`)
        return WebAssembly.compile(await response.arrayBuffer())
      }).catch(error => { wasm = undefined; throw error }),
    changed: () => {
      void chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.filter(tab => tab.id !== undefined)
        .map(tab => chrome.tabs.sendMessage(tab.id!, { type: 'webmcp_adapter_changed' })))).catch(() => {})
    },
  })
  const notifyManagement = () => {
    void chrome.runtime.sendMessage({ type: 'webmcp_packages_changed' }).catch(() => {})
    // Extension pages poll this via runtime message; WEB-APP tabs (settings
    // package-registry section) cannot receive runtime broadcasts, so also
    // push into every tab — the webmcp.content relay turns it into a window
    // event the section listens for (finding: "Activation badge stays
    // stale": enabling through the side panel must update an open settings
    // page without a remount).
    void chrome.tabs.query({}).then(tabs => Promise.allSettled(
      tabs.filter(tab => tab.id !== undefined).map(tab =>
        chrome.tabs.sendMessage(tab.id!, { type: 'webmcp_packages_changed' })),
    )).catch(() => {})
  }
  const refresh = async () => {
    try { await service.refresh() } finally { notifyManagement() }
  }
  void refresh().catch(error => console.warn('[WebMCP adapters] Catalog refresh failed:', error))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    // Builtin overrides live in chrome.storage.local.
    if (changes[BUILTIN_CONFIG_STORAGE_KEY]) {
      void refresh().catch(error => console.warn('[WebMCP adapters] Catalog refresh failed:', error))
      return
    }
    // USER-mount packages (registry installs) keep their config.json in the
    // extension's OPFS, which has no storage.onChanged hook. The opt-in
    // enable path bounces a sentinel key through chrome.storage.local for
    // exactly that reason — this listener is the other half of that
    // handshake. Without it a newly enabled external package would keep
    // its tools unregistered until an unrelated refresh.
    for (const key of Object.keys(changes)) {
      if (key.startsWith(USER_PACKAGE_CONFIG_SENTINEL_PREFIX)) {
        void refresh().catch(error => console.warn('[WebMCP adapters] Catalog refresh failed:', error))
        return
      }
    }
  })
  const providerCall = createProviderHandler(getAdapterStorage, refresh)
  const builtinCall = createProviderHandler(getBuiltinStorage, refresh)
  const skillCall = createProviderHandler(getExtensionSkillStorage, async () => {})
  const manage = createPackageManagement(providerCall, refresh)
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isRecord(message) || typeof message.type !== 'string') return false
    if (message.type === 'webmcp_adapter_validate') {
      if (sender.id !== chrome.runtime.id || !isTrustedCreatorWeaveSenderUrl(sender.url)) {
        respond({ ok: false, error: 'Adapter validation requires a trusted CreatorWeave page' })
        return false
      }
      void getWebMCPMounts().then(mounts => validateAdapterDirectory(message.directory, mounts))
        .then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      return true
    }
    if (message.type === 'webmcp_provider_call') {
      if (sender.id !== chrome.runtime.id) { respond({ ok: false, code: 'EACCES', error: 'Untrusted storage caller' }); return false }
      // SECURITY (round 3 finding: "Sites bypass package consent"):
      // `mount` must be a STRING. `String(['extension-skills'])` equals the
      // allowed name, so an array passed every string-based check below and
      // then fell through the `===` DISPATCH here to the writable `webmcp`
      // provider — one validated mount value must drive both the
      // authorization checks and the dispatch.
      // An omitted mount means the writable `webmcp` mount (the original
      // dispatch default) — apply the default BEFORE validating, so callers
      // relying on it are not rejected with EINVAL (finding: "Omitted mount
      // is rejected"). Non-string values other than `undefined` stay
      // rejected: `String(['extension-skills'])` equals the allowed name,
      // which would let an array slip past validation into the writable
      // dispatch (round-3 finding: "Sites bypass package consent").
      const mount = message.mount === undefined ? 'webmcp' : message.mount
      if (typeof mount !== 'string' || !['webmcp', 'builtin-webmcp', 'extension-skills'].includes(mount)) { respond({ ok: false, code: 'EINVAL', error: 'Unknown mount' }); return false }
      // SECURITY (finding: "Websites bypass package consent"): the
      // all-sites content relay forwards `webmcp_provider_call` from ANY
      // page, so a hostile page could reach the writable `webmcp` mount
      // and write `activation: enabled` into an installed package's
      // config.json — activating tools without the #102 consent flow.
      // MUTATING operations (writeFile/mkdir/remove) on the package mount
      // therefore require a trusted CreatorWeave sender (the web app
      // origins + loopback dev, the same check the
      // `webmcp_adapter_validate` branch above applies). READ operations
      // stay open: the page-facing VFS needs them to render the file tree —
      // EXCEPT `readFile` on the package mount itself (round-2 finding:
      // "Websites can read package files"): bytes of installed packages are
      // not page content, and an untrusted page able to list directories
      // could pull package sources and configs straight off the mount.
      // `stat`/`readdir` stay open so the VFS tree still renders (names
      // only); file BYTES require a trusted sender.
      // One validated mount value drives ALL checks and the dispatch below.
      const mutating = ['writeFile', 'mkdir', 'remove'].includes(String(message.method))
      const untrusted = !isTrustedCreatorWeaveSenderUrl(sender.url)
      if (
        mount === 'webmcp' &&
        (mutating || String(message.method) === 'readFile') &&
        untrusted
      ) {
        respond({ ok: false, code: 'EACCES', error: mutating
          ? 'Mutating the WebMCP package mount requires a trusted CreatorWeave page'
          : 'Reading package files requires a trusted CreatorWeave page' })
        return false
      }
      // Second layer of the same finding: even a TRUSTED page must not arm a
      // package through the raw provider transport — enabling happens
      // EXCLUSIVELY through the #102 opt-in consent flow (token-bound,
      // tab-bound, fingerprint-checked in the background) and through the
      // extension management page (`webmcp_packages_set_config`, which is
      // routed through the background's own in-process handler, never this
      // message branch). The settings installer only writes the DISABLED
      // default config, so rejecting an `activation: "enabled"` config.json
      // write here blocks no legitimate caller. The path check uses the
      // NORMALIZED form: raw paths like `pkg/config.json/` (trailing slash)
      // or `pkg/./config.json` normalize to the same file the handler will
      // write, and checking the raw string let those shapes bypass the
      // guard (finding: "Trailing slash bypasses activation guard").
      if (
        mount === 'webmcp' &&
        String(message.method) === 'writeFile' &&
        typeof message.path === 'string'
      ) {
        let normalizedPath = ''
        try {
          normalizedPath = normalizeProviderPath(message.path)
        } catch {
          respond({ ok: false, code: 'EINVAL', error: 'Invalid storage path' })
          return false
        }
        if (
          (normalizedPath === 'config.json' || normalizedPath.endsWith('/config.json')) &&
          typeof message.content === 'string'
        ) {
          try {
            const parsed = JSON.parse(atob(message.content)) as { activation?: unknown }
            if (parsed && parsed.activation === 'enabled') {
              respond({ ok: false, code: 'EACCES', error: 'Package activation requires the opt-in consent flow' })
              return false
            }
          } catch {
            // Not valid JSON — not an activation write; the catalog validates
            // config files when it reads them.
          }
        }
      }
      void (mount === 'extension-skills' ? skillCall : mount === 'builtin-webmcp' ? builtinCall : providerCall)(message).then(respond)
      return true
    }
    if (message.type === 'webmcp_package_lock') {
      // Cross-context package-transaction lock (SECURITY finding: concurrent
      // installs/uninstalls from the settings tab and the background
      // corrupt the package directory). TRUSTED PAGES ONLY: the lock is a
      // coordination primitive for CreatorWeave surfaces, never for the
      // sites the user visits — a hostile page must not be able to pin a
      // package lock (DoS) or release someone else's lease. The owner token
      // is an unguessable UUID minted background-side, so only the acquirer
      // can heartbeat or release.
      if (sender.id !== chrome.runtime.id || !isTrustedCreatorWeaveSenderUrl(sender.url)) {
        respond({ ok: false, code: 'EACCES', error: 'Package locking requires a trusted CreatorWeave page' })
        return false
      }
      const packageId = typeof message.packageId === 'string' ? message.packageId : ''
      const action = typeof message.action === 'string' ? message.action : ''
      const owner = typeof message.owner === 'string' ? message.owner : ''
      if (!packageId || packageId.includes('/')) { respond({ ok: false, code: 'EINVAL', error: 'Invalid package id' }); return false }
      if (action === 'acquire') {
        const timeoutMs = typeof message.timeoutMs === 'number' && Number.isFinite(message.timeoutMs) ? Math.min(Math.max(message.timeoutMs, 0), 60_000) : undefined
        // A rejecting acquire must still send a response — an unhandled
        // rejection leaves the page's `sendResponse` promise pending until
        // the message channel closes, so the caller times out instead of
        // failing fast (finding: "Rejected lock acquire never responds").
        void bridgeAcquirePackageLock(packageId, timeoutMs).then(respond, (error: unknown) => respond({ ok: false, code: 'ELOCK', error: error instanceof Error ? error.message : String(error) }))
        return true
      }
      if (!owner) { respond({ ok: false, code: 'EINVAL', error: 'Missing lock owner' }); return false }
      if (action === 'heartbeat') {
        void bridgeHeartbeatPackageLock(packageId, owner).then(respond, (error: unknown) => respond({ ok: false, code: 'ELOCK', error: error instanceof Error ? error.message : String(error) }))
        return true
      }
      if (action === 'release') {
        void bridgeReleasePackageLock(packageId, owner).then(respond, (error: unknown) => respond({ ok: false, code: 'ELOCK', error: error instanceof Error ? error.message : String(error) }))
        return true
      }
      respond({ ok: false, code: 'EINVAL', error: 'Unknown lock action' })
      return false
    }
    if (message.type === 'webmcp_packages_changed_notify') {
      // The settings page (through the provider bridge) finished an install
      // or uninstall of an EXTERNAL package (finding: "Uninstall leaves
      // tools registered") — the catalog must be re-read or the removed
      // package's tools stay registered (or a new install's tools stay
      // unregistered) until an unrelated refresh. TRUSTED PAGES ONLY: the
      // refresh itself is harmless, but gating keeps the message namespace
      // consistent with the other package operations above.
      if (sender.id !== chrome.runtime.id || !isTrustedCreatorWeaveSenderUrl(sender.url)) {
        respond({ ok: false, code: 'EACCES', error: 'Package change notification requires a trusted CreatorWeave page' })
        return false
      }
      void refresh().then(() => respond({ ok: true }), () => respond({ ok: false }))
      return true
    }
    if (message.type.startsWith('webmcp_packages_')) {
      if (message.type === 'webmcp_packages_changed') return false
      const allowed = [chrome.runtime.getURL('/recipes.html'), chrome.runtime.getURL('/popup.html')]
      const senderUrl = (sender.url || '').split(/[?#]/)[0]
      if (sender.id !== chrome.runtime.id || !allowed.includes(senderUrl) ||
        (message.type !== 'webmcp_packages_list' && senderUrl !== allowed[0])) {
        respond({ ok: false, code: 'EACCES', error: 'Package management requires the extension management page' })
        return false
      }
      void manage(message).then(respond)
      return true
    }
    if (!message.type.startsWith('webmcp_adapter_')) return false
    if (sender.id !== chrome.runtime.id) return false
    if (message.type === 'webmcp_adapter_invoke') {
      void service.invoke(sender, message).then(respond)
      return true
    }
    try {
      if (message.type === 'webmcp_adapter_catalog') respond({ ok: true, tools: service.catalog(sender) })
      else if (message.type === 'webmcp_adapter_cancel') { service.cancel(sender, message.requestId); respond({ ok: true }) }
      else respond({ ok: false })
    } catch (error) { respond({ ok: false, error: String(error) }) }
    return false
  })
  return service
}
