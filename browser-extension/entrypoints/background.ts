// ============================================================
// Background Service Worker
// ============================================================

import { discoverWebMCPToolsInCurrentWindow } from './webmcp/discovery'
import { invokeWebMCPTool } from './webmcp/invoke'
import {
  getHostAuthorizationMap,
  getGroupAuthorizationMap,
  setHostEnabled as setWebMCPHostEnabled,
  setGroupEnabled as setWebMCPGroupEnabled,
  annotateToolsWithHostAuthorization,
} from './webmcp/authorization'
import { streamPluginDownload } from './webmcp/plugin-download-transfer'
import type { WebMCPPluginDownloadPlan, WebMCPDiscoveredTool } from './webmcp/types'
import { ENABLED_RECIPES_STORAGE_KEY, findRecipeForLocation } from './webmcp/recipes'
import { registerTab, unregisterTab } from './webmcp/registry'
import { getRegistryEntries, entriesToDiscoveredTools } from './webmcp/registry'
import { buildSafeFullName } from './webmcp/tool-name'
import { getWebMCPNativeBridge } from './webmcp/native-bridge'
import { WEBMCP_TAB_REPORT_TYPE } from './webmcp/relay-protocol'
import {
  isSidePanelBindingId,
  isTrustedCreatorWeaveSenderUrl,
} from '@creatorweave/shared'
import { SidePanelBindingStore, type SidePanelBinding } from '../lib/side-panel-binding-store'
import { getCwWebappBaseUrl } from '../lib/webapp-origins'

// Config
const CONFIG = {
  TIMEOUT_MS: 15000,              // Request timeout in ms
  MAX_BODY_SIZE: 2 * 1024 * 1024, // Max response body size (2MB)
  SEARCH_MAX_RESULTS: 20,         // Max search results
  RENDER_TIMEOUT_MS: 30000,       // Hidden tab render timeout
  RENDER_SETTLE_MS: 2000,         // Wait after 'complete' for JS to settle
};

const completedPluginDownloads = new Map<string, { completedAt: number; savedPath?: string }>()

const SIDE_PANEL_BINDINGS_STORAGE_KEY = 'cw_side_panel_bindings_v1'
const sidePanelBindings = new SidePanelBindingStore({
  async get() {
    const stored = await chrome.storage.local.get(SIDE_PANEL_BINDINGS_STORAGE_KEY)
    return (stored[SIDE_PANEL_BINDINGS_STORAGE_KEY] ?? {}) as Record<string, SidePanelBinding>
  },
  async set(bindings) {
    await chrome.storage.local.set({ [SIDE_PANEL_BINDINGS_STORAGE_KEY]: bindings })
  },
})

function rememberSidePanelBinding(bindingId: string, tabId: number): void {
  void sidePanelBindings.remember(bindingId, tabId).catch(() => {})
}

async function resolveBoundSidePanelTab(senderUrl: string | undefined, bindingId: unknown): Promise<number | null> {
  if (!isTrustedCreatorWeaveSenderUrl(senderUrl) || !isSidePanelBindingId(bindingId)) return null
  const binding = await sidePanelBindings.resolve(bindingId).catch(() => null)
  if (!binding || !Number.isSafeInteger(binding.tabId)) return null

  try {
    await chrome.tabs.get(binding.tabId)
    return binding.tabId
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============================================================
// Utility functions
// ============================================================

/**
 * Fetch with timeout
 */
function fetchWithTimeout(url, options = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Request timeout'));
    }, options.timeout || CONFIG.TIMEOUT_MS);

    fetch(url, { ...options, signal: controller.signal })
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

/**
 * Extract real URL from DuckDuckGo redirect link
 */
function extractRealUrl(href) {
  if (!href) return '';
  const match = href.match(/uddg=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  return href;
}

// ============================================================
// web_search: Multi-provider search (DuckDuckGo / Baidu)
// ============================================================

/**
 * Region detection cache. Module-level only — MV3 service workers are
 * killed after ~30s idle, so this cache is per-session. That's fine:
 * re-detection runs once per SW lifecycle (a few searches in a row
 * share the cache; the next day starts fresh).
 */
let _cachedProvider = null; // null = not detected yet
let _cachedProviderAt = 0;
const PROVIDER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

/**
 * Detect the best search provider for the current user.
 * Strategy: timezone hint → connectivity test → cache result.
 */
async function detectProvider() {
  // Return cache if still valid
  if (_cachedProvider && (Date.now() - _cachedProviderAt) < PROVIDER_CACHE_TTL) {
    return _cachedProvider;
  }

  // Step 1: timezone hint
  let hint = 'duckduckgo';
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz === 'Asia/Shanghai' || tz === 'Asia/Urumqi' ||
        tz === 'Asia/Hong_Kong' || tz === 'Asia/Taipei' ||
        tz === 'Asia/Macau') {
      hint = 'baidu';
    }
  } catch {}

  // Step 2: connectivity test (3s timeout)
  // If DDG is reachable, always prefer it (works for both CN-vpn and overseas)
  const ddgReachable = await isDuckDuckGoReachable();

  let provider;
  if (ddgReachable) {
    provider = 'duckduckgo';
  } else {
    provider = 'baidu';
  }

  _cachedProvider = provider;
  _cachedProviderAt = Date.now();
  return provider;
}

/** Quick connectivity test for DuckDuckGo */
async function isDuckDuckGoReachable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch('https://html.duckduckgo.com/html/?q=test', {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

/** Search via DuckDuckGo HTML */
async function searchDuckDuckGo(query, limit) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url);
  const html = await resp.text();

  const results = [];
  const blocks = html.split(/class="result\b/);

  for (let i = 1; i < blocks.length && results.length < limit; i++) {
    const block = blocks[i];

    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]*)"/)
      || block.match(/href="([^"]*)"[^>]*class="result__a"/);
    const rawUrl = urlMatch ? extractRealUrl(urlMatch[1]) : '';

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    if (title && rawUrl) {
      results.push({ title, url: rawUrl, snippet });
    }
  }
  return results;
}

/** Fetch Baidu search results HTML (raw, unparsed) */
async function fetchBaiduHtml(query, limit) {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Math.min(limit * 2, 20)}`;
  // No spoofed User-Agent: the extension's own identity is used. Baidu serves
  // /s results fine without a browser UA (verified), and an honest UA avoids
  // impersonation concerns in store review. Note: in MV3 service workers the
  // User-Agent header is browser-controlled anyway and custom values are
  // ignored by fetch (it's a forbidden header) — kept here only as Accept/A-L.
  const resp = await fetchWithTimeout(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  const html = await resp.text();
  return html;
}

/**
 * Search one provider without substituting another provider. Explicit callers
 * rely on this strict behavior to preserve source provenance.
 */
async function searchSingleProvider(query, limit, provider) {
  try {
    if (provider === 'baidu') {
      const html = await fetchBaiduHtml(query, limit);
      // format: 'html' tells injected.content to DOMParser this payload.
      return { ok: true, html, provider: 'baidu', format: 'html', limit };
    }

    const results = await searchDuckDuckGo(query, limit);
    return { ok: true, results, provider: 'duckduckgo' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      results: [],
      provider,
      suggestedProvider: provider === 'baidu' ? 'duckduckgo' : 'baidu',
      reason,
      error: `${provider} is unavailable. Try ${provider === 'baidu' ? 'duckduckgo' : 'baidu'}.`,
    };
  }
}

/**
 * Automatic selection may use the alternate provider. Baidu's result count is
 * only available in the injected MAIN-world parser, so an HTML response carries
 * enough metadata for that layer to perform the final retry when needed.
 */
async function searchAuto(query, limit, primary) {
  const first = await searchSingleProvider(query, limit, primary);
  const attempts = [];

  if (first.ok && primary === 'baidu') {
    return {
      ...first,
      requestedProvider: primary,
      fallback: false,
      attempts: [{ provider: 'baidu', ok: true }],
      auto: true,
    };
  }

  if (first.ok && first.results.length > 0) {
    return {
      ...first,
      requestedProvider: primary,
      fallback: false,
      attempts: [{ provider: 'duckduckgo', ok: true, resultCount: first.results.length }],
      auto: true,
    };
  }

  attempts.push({
    provider: primary,
    ok: false,
    reason: first.ok ? '0 results' : first.reason || 'unavailable',
  });
  const alternate = primary === 'baidu' ? 'duckduckgo' : 'baidu';
  const second = await searchSingleProvider(query, limit, alternate);

  if (!second.ok) {
    attempts.push({ provider: alternate, ok: false, reason: second.reason || 'unavailable' });
    return {
      ok: false,
      results: [],
      error: 'All search providers exhausted',
      requestedProvider: primary,
      attempts,
    };
  }

  if (alternate === 'duckduckgo' && second.results.length === 0) {
    attempts.push({ provider: alternate, ok: false, reason: '0 results' });
    return {
      ok: false,
      results: [],
      error: 'All search providers returned no results',
      requestedProvider: primary,
      attempts,
    };
  }

  attempts.push({ provider: alternate, ok: true, ...(alternate === 'duckduckgo' ? { resultCount: second.results.length } : {}) });
  return {
    ...second,
    requestedProvider: primary,
    fallback: true,
    attempts,
    auto: true,
  };
}

async function handleSearch(message) {
  const { query, count = 10 } = message;
  const limit = Math.min(count, CONFIG.SEARCH_MAX_RESULTS);
  const isAuto = !message.provider || message.provider === 'auto';

  if (!isAuto) {
    const response = await searchSingleProvider(query, limit, message.provider);
    return {
      ...response,
      requestedProvider: message.provider,
      fallback: false,
      auto: false,
    };
  }

  return searchAuto(query, limit, await detectProvider());
}

// ============================================================
// web_fetch: Fetch URL content (raw HTTP)
// ============================================================

async function handleFetch(message) {
  const { url, method = 'GET', headers = {}, body = null, extract = 'raw' } = message;

  // Validate URL
  try {
    new URL(url);
  } catch {
    return { ok: false, status: 0, error: 'Invalid URL' };
  }

  try {
    const resp = await fetchWithTimeout(url, { method, headers, body });
    const status = resp.status;
    const respHeaders = {};
    resp.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });

    let responseBody = await resp.text();
    let truncated = false;

    // Size limit
    if (responseBody.length > CONFIG.MAX_BODY_SIZE) {
      responseBody = responseBody.substring(0, CONFIG.MAX_BODY_SIZE);
      truncated = true;
    }

    // Content extraction
    if (extract === 'text') {
      responseBody = responseBody
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const result = {
      ok: resp.ok,
      status,
      headers: respHeaders,
      body: responseBody,
      // Final URL after redirects — the authoritative base for resolving
      // relative links in the body (consumed by htmlToMarkdown in
      // injected.content.ts). Using the requested URL instead would break
      // pages that redirected somewhere else (different origin/path).
      finalUrl: resp.url || url,
    };
    if (truncated) result.truncated = true;
    return result;

  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// ============================================================
// web_fetch_render: Fetch URL via hidden tab (full JS rendering)
// Creates a hidden browser tab, waits for the page to fully
// render (including JS execution), extracts the DOM, then
// closes the tab. Returns the rendered HTML.
// ============================================================

async function handleFetchRender(message) {
  const { url } = message;

  // Validate URL
  try {
    const parsed = new URL(url);
    // Only allow http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, status: 0, error: 'Only http/https URLs are supported for render mode' };
    }
  } catch {
    return { ok: false, status: 0, error: 'Invalid URL' };
  }

  let tab = null;

  try {
    // Create a hidden (inactive) tab
    tab = await chrome.tabs.create({
      url,
      active: false,
    });

    // Wait for the tab to finish loading, with timeout
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        // Resolve anyway — we'll try to extract what we have
        resolve();
      }, CONFIG.RENDER_TIMEOUT_MS);

      function listener(tabId, info) {
        if (tabId !== tab.id) return;
        if (info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      }

      chrome.tabs.onUpdated.addListener(listener);
    });

    // Extra settle time for JS frameworks to finish rendering
    await new Promise(r => setTimeout(r, CONFIG.RENDER_SETTLE_MS));

    // Extract rendered HTML from the tab
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Get the full rendered DOM
        const html = document.documentElement.outerHTML;

        // Also try to get the page title and meta description
        const title = document.title || '';
        const metaDesc = document.querySelector('meta[name="description"]')?.content || '';

        // The rendered document's actual URL (after HTTP redirects and JS
        // navigation) — used as the base for resolving relative links so the
        // Markdown pipeline pins them to the fetched page, not the app origin.
        const finalUrl = location.href;

        return { html, title, metaDesc, finalUrl };
      },
    });

    // Close the tab
    await chrome.tabs.remove(tab.id);
    tab = null;

    const data = result?.result;
    if (!data || !data.html) {
      return { ok: false, status: 0, error: 'Failed to extract rendered DOM' };
    }

    let responseBody = data.html;
    let truncated = false;

    // Size limit
    if (responseBody.length > CONFIG.MAX_BODY_SIZE) {
      responseBody = responseBody.substring(0, CONFIG.MAX_BODY_SIZE);
      truncated = true;
    }

    const response = {
      ok: true,
      status: 200,
      headers: {
        'content-type': 'text/html',
        'x-render-mode': 'tab',
        ...(data.title ? { 'x-page-title': data.title } : {}),
        ...(data.metaDesc ? { 'x-meta-description': data.metaDesc } : {}),
      },
      body: responseBody,
      rendered: true,
      finalUrl: data.finalUrl || url,
    };
    if (truncated) response.truncated = true;
    return response;

  } catch (err) {
    // Clean up tab on error
    if (tab) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
    return { ok: false, status: 0, error: `Render failed: ${err.message}` };
  }
}

// ============================================================
// Codex auth + proxy (minimal version)
//
// FEATURE FLAG: the whole block below is guarded by __CW_CODEX_OAUTH__
// (build-time define, see wxt.config.ts). In the Chrome Web Store build
// (CW_CODEX_OAUTH=0) every OpenAI endpoint / client_id / UA string is
// treeshaken out of the bundle — no OpenAI code ships at all.
// ============================================================

declare const __CW_CODEX_OAUTH__: boolean;
const CODEX_OAUTH_ENABLED: boolean = __CW_CODEX_OAUTH__;

// Module-level holder for the Codex block's exports. The block below keeps
// its original `if (CODEX_OAUTH_ENABLED) {}` scoping (store build: block is
// folded away, CODEX stays null, no OpenAI strings ship). Dev build (no
// minify): the block RUNS and populates CODEX, so call sites inside
// defineBackground can access the helpers via CODEX.xxx — fixing the
// ReferenceError where bare names leaked across the block boundary.
interface CodexTokensLike { access_token?: string | null; refresh_token?: string; [k: string]: unknown }
interface CodexBlockExports {
  getCodexTokens(): Promise<CodexTokensLike | null>;
  decodeJwtPayload(token: string): Record<string, any> | null;
  refreshCodexAccessToken(tokens: CodexTokensLike): Promise<CodexTokensLike>;
  saveCodexTokens(tokens: unknown): Promise<void>;
  getPendingCodexAuth(): Promise<Record<string, any> | null>;
  savePendingCodexAuth(data: unknown): Promise<void>;
  clearPendingCodexAuth(): Promise<void>;
  pollCodexAuthOnce(deviceAuthId: string, userCode: string): Promise<Record<string, any>>;
  parseJsonSafe(resp: Response): Promise<{ text: string; json: any }>;
  codexHeaders(tokens: CodexTokensLike): Record<string, string>;
  getCodexResetCredits(tokens: CodexTokensLike): Promise<unknown>;
  consumeCodexResetCredit(tokens: CodexTokensLike, creditId: string): Promise<unknown>;
  DEVICEAUTH_USERCODE_URL: string;
  DEVICE_VERIFY_URL: string;
  CODEX_CLIENT_ID: string;
  CODEX_AUTH_POLL_ALARM: string;
  CODEX_RESPONSES_URL: string;
  TOKEN_REFRESH_MARGIN_MS: number;
  CODEX_DEFAULT_MODELS: unknown;
}
let CODEX = null as null | CodexBlockExports;

// The entire Codex block below is wrapped in `if (CODEX_OAUTH_ENABLED) {}`.
// This is what makes the store build (CW_CODEX_OAUTH=0) actually DROP the
// code: esbuild folds `if (false) { ... }` at block level and eliminates the
// whole scope — every OpenAI URL / client_id / UA string vanishes from the
// bundle. (A bare top-level `const FLAG && ...` guard is NOT enough: the
// helper functions and their string constants stay module-scope and survive
// tree-shaking — verified by grepping the first store build.)
// All call sites outside this block already check CODEX_OAUTH_ENABLED before
// referencing these helpers, so the internal block scoping is safe.
if (CODEX_OAUTH_ENABLED) {

const DEVICEAUTH_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICEAUTH_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_BACKEND_API_URL = 'https://chatgpt.com/backend-api';
const CODEX_RESET_CREDITS_URL = `${CODEX_BACKEND_API_URL}/wham/rate-limit-reset-credits`;
const CODEX_RESET_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`;
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const CODEX_PENDING_AUTH_KEY = 'codex_pending_auth';
const CODEX_AUTH_POLL_ALARM = 'codex_auth_poll_alarm';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

const CODEX_DEFAULT_MODELS = [
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 1000000, capabilities: ['code', 'reasoning', 'vision'] },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 400000, capabilities: ['code', 'reasoning', 'vision'] },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1000000, capabilities: ['code', 'reasoning', 'vision'] },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 258000, capabilities: ['code', 'reasoning', 'vision'] },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 258000, capabilities: ['code', 'reasoning', 'vision'] },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 258000, capabilities: ['code', 'reasoning', 'vision'] },
];


async function saveCodexTokens(tokens: any) {
  await chrome.storage.local.set({ codex_tokens: tokens, codex_token_saved_at: Date.now() });
}

async function getCodexTokens() {
  const { codex_tokens } = await chrome.storage.local.get('codex_tokens');
  return codex_tokens || null;
}

async function savePendingCodexAuth(data: any) {
  await chrome.storage.local.set({ [CODEX_PENDING_AUTH_KEY]: data });
}

async function getPendingCodexAuth() {
  const got = await chrome.storage.local.get(CODEX_PENDING_AUTH_KEY);
  return got?.[CODEX_PENDING_AUTH_KEY] || null;
}

async function clearPendingCodexAuth() {
  await chrome.storage.local.remove(CODEX_PENDING_AUTH_KEY);
  await chrome.alarms.clear(CODEX_AUTH_POLL_ALARM);
}

function decodeJwtPayload(token: string): any {
  try {
    const [, payload] = String(token || '').split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function codexHeaders(accessToken: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
    'User-Agent': 'codex_cli_rs/0.0.0 (CreatorWeave Extension)',
    originator: 'codex_cli_rs',
    ...extraHeaders,
  };

  const payload = decodeJwtPayload(accessToken);
  const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;

  return headers;
}

async function parseJsonSafe(resp: Response) {
  const text = await resp.text();
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

async function refreshCodexAccessToken(tokens: any) {
  if (!tokens?.refresh_token) {
    throw new Error('Missing refresh_token');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: String(tokens.refresh_token),
    client_id: CODEX_CLIENT_ID,
  });

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const parsed = await parseJsonSafe(resp);
  if (!resp.ok || !parsed?.json?.access_token) {
    throw new Error(`Refresh failed (${resp.status}): ${JSON.stringify(parsed.json || parsed.text)}`);
  }

  const merged = {
    ...tokens,
    ...parsed.json,
    refresh_token: parsed.json.refresh_token || tokens.refresh_token,
  };
  await saveCodexTokens(merged);
  return merged;
}

type CodexResetCreditsResponse = {
  credits?: Array<{
    id?: string;
    status?: string;
    reset_type?: string;
    granted_at?: string;
    expires_at?: string;
    title?: string;
  }>;
  available_count?: number;
};

async function codexBackendJsonRequest<T>(
  url: string,
  tokens: any,
  init: RequestInit = {},
): Promise<T> {
  const request = (accessToken: string) => fetch(url, {
    ...init,
    headers: {
      ...codexHeaders(accessToken, {
        accept: 'application/json',
        ...(init.headers as Record<string, string> || {}),
      }),
    },
  });

  let response = await request(tokens.access_token);
  if (response.status === 401 && tokens.refresh_token) {
    tokens = await refreshCodexAccessToken(tokens);
    response = await request(tokens.access_token);
  }

  const { text, json } = await parseJsonSafe(response);
  if (!response.ok) {
    throw new Error(`Codex request failed (${response.status}): ${JSON.stringify(json || text)}`);
  }
  return (json ?? {}) as T;
}

async function getCodexResetCredits(tokens: any): Promise<CodexResetCreditsResponse> {
  return codexBackendJsonRequest<CodexResetCreditsResponse>(CODEX_RESET_CREDITS_URL, tokens);
}

async function consumeCodexResetCredit(tokens: any, creditId: string) {
  const redeemRequestId = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return codexBackendJsonRequest<{ code?: string; windows_reset?: number; credit?: unknown }>(
    CODEX_RESET_CONSUME_URL,
    tokens,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId }),
    },
  );
}

async function pollCodexAuthOnce(deviceAuthId: string, userCode: string) {
  const resp = await fetch(DEVICEAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      device_auth_id: deviceAuthId,
      user_code: userCode,
    }),
  });
  const { text, json } = await parseJsonSafe(resp);

  if (!resp.ok) {
    const code = json?.error || json?.error_code || 'unknown';
    if (code === 'authorization_pending' || code === 'slow_down') {
      return { ok: true, done: false, pending: true, code };
    }
    return { ok: false, status: resp.status, error: json || text };
  }

  if (!json?.authorization_code || !json?.code_verifier) {
    return { ok: false, error: 'Missing authorization_code/code_verifier in deviceauth response' };
  }

  const oauthBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code: json.authorization_code,
    code_verifier: json.code_verifier,
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
  });

  const oauthResp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: oauthBody,
  });
  const oauthParsed = await parseJsonSafe(oauthResp);
  if (!oauthResp.ok) {
    return { ok: false, status: oauthResp.status, error: oauthParsed.json || oauthParsed.text };
  }

  await saveCodexTokens(oauthParsed.json);
  await clearPendingCodexAuth();
  return { ok: true, done: true };
}

// Populate the module-level holder so defineBackground call sites can reach
// these block-scoped helpers. Runs only when CODEX_OAUTH_ENABLED (dev/prod
// internal builds); the store build folds the whole block away.
CODEX = {
  getCodexTokens,
  decodeJwtPayload,
  refreshCodexAccessToken,
  saveCodexTokens,
  getPendingCodexAuth,
  savePendingCodexAuth,
  clearPendingCodexAuth,
  pollCodexAuthOnce,
  parseJsonSafe,
  codexHeaders,
  getCodexResetCredits,
  consumeCodexResetCredit,
  DEVICEAUTH_USERCODE_URL,
  DEVICE_VERIFY_URL,
  CODEX_CLIENT_ID,
  CODEX_AUTH_POLL_ALARM,
  CODEX_RESPONSES_URL,
  TOKEN_REFRESH_MARGIN_MS,
  CODEX_DEFAULT_MODELS,
};

}

// ============================================================
// Message listener
// ============================================================

export default defineBackground(() => {
  if (!CODEX_OAUTH_ENABLED) {
    // Store build: Codex OAuth stripped. Alarm listener below still registers
    // the non-Codex branches (schedule triggers), so keep going — only the
    // Codex-specific proactive refresh and auth-poll branches are skipped.
  }
  // ── Proactive token refresh: check on startup and every 5 minutes ──
  const CODEX_TOKEN_REFRESH_ALARM = 'codex_token_refresh_alarm';

  async function proactiveRefreshIfNeeded() {
    try {
      const tokens = await CODEX!.getCodexTokens();
      if (!tokens?.access_token) return;

      const payload = CODEX!.decodeJwtPayload(tokens.access_token);
      if (!payload?.exp) return; // can't determine expiry, skip

      const expiresAt = payload.exp * 1000; // JWT exp is in seconds
      const now = Date.now();

      if (now >= expiresAt - CODEX!.TOKEN_REFRESH_MARGIN_MS) {
        // Token is expired or about to expire — try refresh
        if (tokens.refresh_token) {
          try {
            await CODEX!.refreshCodexAccessToken(tokens);
          } catch (err) {
            console.warn('[Codex] Proactive refresh failed:', err instanceof Error ? err.message : err);
            // Clear tokens if refresh fails and token is already expired
            if (now >= expiresAt) {
              await CODEX!.saveCodexTokens({ ...tokens, access_token: null });
            }
          }
        }
      }
    } catch {
      // Silently ignore
    }
  }

  // Check on service worker startup
  if (CODEX_OAUTH_ENABLED) proactiveRefreshIfNeeded();

  // Schedule periodic checks (every 5 minutes)
  if (CODEX_OAUTH_ENABLED) chrome.alarms.create(CODEX_TOKEN_REFRESH_ALARM, { periodInMinutes: 5 });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (CODEX_OAUTH_ENABLED && alarm.name === CODEX_TOKEN_REFRESH_ALARM) {
      await proactiveRefreshIfNeeded();
      return;
    }

    // Schedule alarm — forward trigger to the active CreatorWeave tab
    if (alarm.name.startsWith('sched_')) {
      const scheduleId = alarm.name.slice(6) // strip 'sched_' prefix
      await forwardScheduleTrigger(scheduleId)
      return
    }

    if (!CODEX_OAUTH_ENABLED || alarm.name !== CODEX!.CODEX_AUTH_POLL_ALARM) return;
    try {
      const pending = await CODEX!.getPendingCodexAuth();
      if (!pending) {
        await chrome.alarms.clear(CODEX!.CODEX_AUTH_POLL_ALARM);
        return;
      }
      if (!pending.expires_at || pending.expires_at <= Date.now()) {
        await CODEX!.clearPendingCodexAuth();
        return;
      }
      await CODEX!.pollCodexAuthOnce(pending.device_auth_id, pending.user_code);
    } catch {
      // keep alarm for next retry
    }
  });

  // ── Schedule Alarm Handler ──────────────────────────────────────────────
  // When a schedule alarm fires, we forward the trigger to the active CreatorWeave tab.
  // The extension cannot access OPFS directly, so it delegates to the page.

  // Track the active CreatorWeave tab ID (updated on tab activation)
  let _creatorWeaveTabId: number | null = null

  // Per-tab side panel state is tracked via chrome.sidePanel.getOptions()
  // (the single source of truth) instead of a local Set — see toggle handler
  // below for the rationale (no onClosed event exists for chrome.sidePanel).

  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId)
      if (tab?.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        _creatorWeaveTabId = tab.id
      }
    } catch {
      // ignore
    }
  })

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
      _creatorWeaveTabId = tabId
    }
  })

  // Track which tabs have the side panel open. Used by the toggle
  // handler to decide open vs close — MUST be synchronous (async
  // getOptions would break the user gesture call stack for open()).
  // Cleaned up on tab close. Best-effort: Chrome has no onClosed event
  // for the X button, so a manual close via X may leave a stale entry
  // (harmless — next click closes, then the one after opens).
  const _sidePanelTabs = new Set<number>()

  chrome.tabs.onRemoved.addListener((tabId) => {
    _sidePanelTabs.delete(tabId)
    // Tab closed → its WebMCP registry entry is stale; drop it so the
    // popup/discover snapshot never lists tools from dead tabs.
    unregisterTab(tabId).catch(() => {})
  })

  /**
   * Forward a schedule trigger to the CreatorWeave page.
   * Returns true if forwarded successfully, false if no active tab.
   */
  async function forwardScheduleTrigger(scheduleId: string): Promise<boolean> {
    if (!_creatorWeaveTabId) {
      // Try to find a CreatorWeave tab
      try {
        const tabs = await chrome.tabs.query({ url: ['*://*/*'] })
        const cwTab = tabs.find(t => t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
        if (cwTab?.id) {
          _creatorWeaveTabId = cwTab.id
        } else {
          return false
        }
      } catch {
        return false
      }
    }

    try {
      await chrome.tabs.sendMessage(_creatorWeaveTabId, {
        type: 'cw_schedule_run',
        scheduleId,
      })
      return true
    } catch {
      // Tab may be closed or not responding
      _creatorWeaveTabId = null
      return false
    }
  }

  /**
   * Show a desktop notification for schedule events.
   */
  async function showScheduleNotification(options: {
    title: string
    body: string
    scheduleId?: string
  }): Promise<void> {
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: '/icon.png',
        title: options.title,
        message: options.body,
        priority: 1,
      })
    } catch {
      // notifications may not be available
    }
  }

  // ── Agent completion notifications ────────────────────────────────────────
  // The Web SW's showNotification cannot focus a tab (Web SWs lack tab
  // privileges), so agent-loop-complete notifications route through the
  // extension background instead: chrome.notifications + onClicked →
  // chrome.tabs.update(tabId, { active: true }) refocuses the CreatorWeave tab.

  /** sender tab ids of pending agent notifications, keyed by notification id */
  const _agentNotifTabs = new Map<string, number>()

  /** Show an agent-completion notification that focuses the sender tab on click. */
  async function showAgentNotification(options: {
    title: string
    body: string
    conversationId?: string
    tabId?: number
  }): Promise<void> {
    try {
      const notifId = `agent-${Date.now()}`
      if (typeof options.tabId === 'number') {
        _agentNotifTabs.set(notifId, options.tabId)
      }
      await chrome.notifications.create(notifId, {
        type: 'basic',
        iconUrl: '/icon.png',
        title: options.title,
        message: options.body,
        priority: 1,
        requireInteraction: false,
      })
    } catch {
      // notifications may not be available
    }
  }

  // ── WebMCP native bridge (Codex / external agents) ──────────────────────
  // Long-lived connectNative port keeping the cw-native-host daemon alive.
  // Relay requests are answered via invokeWebMCPTool + registry (per-host /
  // per-group authorization enforced there, same as in-app invocations).
  const webmcpNativeBridge = getWebMCPNativeBridge({
    invokeTool: async (request) => {
      // fullToolName alone cannot route — invokeWebMCPTool matches the
      // registry / route cache by (groupKey, fullToolName). Resolve the
      // groupKey from the live registry before invoking.
      const entries = await getRegistryEntries()
      for (const entry of entries) {
        for (const tool of entry.tools) {
          if (buildSafeFullName(entry.hostname, tool.name) === request.fullToolName) {
            return invokeWebMCPTool({
              groupKey: entry.groupKey,
              fullToolName: request.fullToolName,
              args: request.args,
            })
          }
        }
      }
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_NAME',
        error: `No open tab exposes tool: ${request.fullToolName}`,
      }
    },
    listTools: async (): Promise<WebMCPDiscoveredTool[]> => {
      // Bridge has no window context — list tools from ALL windows.
      // Fallback scan: tabs opened BEFORE the extension (re)loaded have no
      // content script and never report to the registry (registry-silent).
      // The popup's discover path probes them; the bridge must too, or a
      // freshly-enabled bridge shows an empty tool list until every page is
      // manually refreshed. discoverWebMCPToolsInCurrentWindow(undefined)
      // merges registry data + probes silent tabs across ALL windows.
      const discovery = await discoverWebMCPToolsInCurrentWindow(undefined)
      const tools: WebMCPDiscoveredTool[] = discovery.ok ? discovery.tools : entriesToDiscoveredTools(await getRegistryEntries())
      // Authorization filter: disabled hosts/groups must not exist for
      // external agents either (mirrors webmcp_discover_tools policy).
      const [hostMap, groupMap] = await Promise.all([
        getHostAuthorizationMap(),
        getGroupAuthorizationMap(),
      ])
      const annotated = annotateToolsWithHostAuthorization(tools, hostMap, groupMap)
      return annotated.filter(
        (tool: WebMCPDiscoveredTool & { hostEnabled?: boolean; groupEnabled?: boolean }) =>
          tool.hostEnabled !== false && tool.groupEnabled !== false,
      )
    },
  })
  // MV3 SW restart: re-launch the daemon if the user had it enabled.
  void webmcpNativeBridge.resumeIfEnabled()

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Only claim OUR message types — an unconditional `return true` would
    // keep the sendResponse channel open for unrelated messages and race
    // the main listener above.
    if (message?.type !== 'webmcp_bridge_get_status' && message?.type !== 'webmcp_bridge_set_enabled') {
      return false
    }
    (async () => {
      if (message?.type === 'webmcp_bridge_get_status') {
        const enabled = await webmcpNativeBridge.isEnabled()
        sendResponse({ ok: true, enabled, status: webmcpNativeBridge.getStatus() })
        return
      }
      if (message?.type === 'webmcp_bridge_set_enabled') {
        try {
          await webmcpNativeBridge.setEnabled(message.enabled === true)
          const enabled = await webmcpNativeBridge.isEnabled()
          sendResponse({ ok: true, enabled, status: webmcpNativeBridge.getStatus() })
        } catch (err: any) {
          sendResponse({ ok: false, error: String(err?.message || err) })
        }
        return
      }
    })().catch(() => {
      sendResponse({ ok: false, error: 'webmcp bridge handler failed' })
    })
    return true // async sendResponse
  })

  chrome.notifications.onClicked.addListener((notifId) => {
    const tabId = _agentNotifTabs.get(notifId)
    if (tabId === undefined) return // not an agent notification
    _agentNotifTabs.delete(notifId)
    chrome.tabs.update(tabId, { active: true }).catch(() => {
      // Tab may be closed — ignore
    })
    // Also raise the tab's window (tab activation alone may not unminimize).
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.windowId) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }).catch(() => {})
  })

  chrome.notifications.onClosed.addListener((notifId) => {
    _agentNotifTabs.delete(notifId)
  })

  // ── Side panel open (shared: floating page button toggle + popup CTA) ──
  // Synchronous on purpose: chrome.sidePanel.open() must be called within
  // the user-gesture call stack of the triggering onMessage handler.
  function openSidePanelForTab(tabId: number, pageUrl: string): void {
    const bindingId = crypto.randomUUID()
    rememberSidePanelBinding(bindingId, tabId)

    const params = new URLSearchParams()
    params.set('source', 'side_panel')
    params.set('binding', bindingId)
    if (pageUrl) {
      try {
        params.set('origin', new URL(pageUrl).origin)
      } catch {}
    }

    // Site (.cn/.com) is chosen at runtime by browser language; dev builds
    // target the local Vite server (handled inside getCwWebappBaseUrl).
    const cwBase = getCwWebappBaseUrl()
    // Next.js App Router owns pathname routing. Put launch metadata in the
    // real query string rather than the fragment: `/#/?…` is not a route in
    // Next, and its root-page redirect can win the startup race before the
    // side-panel routing handler consumes the metadata.
    const cwUrl = `${cwBase}/?${params.toString()}`
    // eslint-disable-next-line no-console
    console.log('[CreatorWeave][bg] opening side panel', {
      tabId,
      pageUrl,
      cwUrl,
    })

    // setOptions must run BEFORE open; do NOT await (preserves user gesture).
    // Pattern from Chrome's official sample + the user-gesture thread:
    // https://groups.google.com/a/chromium.org/g/chromium-extensions/c/S2bR12jOCKA
    chrome.sidePanel.setOptions({
      tabId,
      path: cwUrl,
      enabled: true,
    })

    chrome.sidePanel.open({ tabId }).then(() => {
      _sidePanelTabs.add(tabId)
    }).catch((err: any) => {
      console.warn(
        '[CreatorWeave] Side panel open failed, falling back to new tab:',
        err,
      )
      chrome.tabs.create({ url: `${cwBase}/#/` }).catch(() => {})
    })
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // The dedicated bridge listener (registered above) owns these types —
    // answering here would race it and close the channel early.
    if (message?.type === 'webmcp_bridge_get_status' || message?.type === 'webmcp_bridge_set_enabled') {
      return false
    }

    // ── Side Panel: toggle open/close on user click ──
    // Per Chrome's official sample, chrome.sidePanel.open() can be called
    // from background's onMessage when triggered by a content script click.
    // Must use tabId (not windowId) for the gesture to work.
    //
    // Triggered by side-panel-button.content.ts (which runs on <all_urls>)
    // when the user clicks the "唤起怡氧知知" floating button on any page.
    // Toggles: if the side panel is currently open for this tab, close it
    // (via setOptions { enabled: false }); otherwise open it.
    //
    // URL params carry only the initial routing metadata. The web app stores
    // that transient state in sessionStorage and removes it from the URL.
    // The extension owns target selection through an opaque binding. The web
    // app stores that binding in sessionStorage after cleaning the URL.
    // Page context (URL/title/selected text/business fields) is fetched
    // live per LLM call via the pull-based bridge — see
    // `requestBoundPageContext` handler below.
    if (message.type === 'cw_side_panel_toggle') {
      const tabId = _sender?.tab?.id
      if (typeof tabId !== 'number') return false

      // ── Toggle close ──
      // Check _sidePanelTabs synchronously to preserve the user gesture
      // call stack. This is a best-effort local Set — it can desync if
      // the user closes the panel via Chrome's built-in X (there's no
      // onClosed event). But trading occasional desync for reliable
      // open() is the right call: a failed close is a no-op, while a
      // failed open loses the side panel entirely.
      if (_sidePanelTabs.has(tabId)) {
        chrome.sidePanel.setOptions({ tabId, enabled: false })
        _sidePanelTabs.delete(tabId)
        // eslint-disable-next-line no-console
        console.log('[CreatorWeave][bg] side panel closed (toggle)', { tabId })
        return false
      }

      // ── Toggle open ──
      openSidePanelForTab(tabId, typeof message.url === 'string' ? message.url : '')
      return false
    }

    // ── Side panel: binding registration, from the popup CTA ──
    // The popup calls chrome.sidePanel.open() DIRECTLY (in its own click
    // handler) because the user gesture required by open() does NOT survive
    // the popup → background message hop (it does for the floating button's
    // content-script click → background hop, which is the documented special
    // case this listener was built for). The popup still needs the binding
    // registered here (storage) and the tab marked as panel-open so the
    // floating button's toggle semantics stay correct.
    // Fire-and-forget from the popup: storage.local writes settle in ~ms,
    // while the panel's web app resolves the binding much later (at the
    // first page-context pull), so the race window is negligible.
    if (message.type === 'cw_side_panel_register_binding') {
      const bindingId = message.bindingId
      const tabId = message.tabId
      if (typeof bindingId !== 'string' || typeof tabId !== 'number') {
        sendResponse({ ok: false, error: 'missing bindingId or tabId' })
        return false
      }
      rememberSidePanelBinding(bindingId, tabId)
      _sidePanelTabs.add(tabId)
      sendResponse({ ok: true })
      return false
    }

    (async () => {
      try {
        if (message.type === 'extension_get_version') {
          try {
            const manifest = chrome.runtime.getManifest()
            sendResponse({ ok: true, version: manifest.version })
          } catch (err: any) {
            sendResponse({ ok: false, error: err?.message || String(err) })
          }
          return
        }

        if (message.type === 'web_search') {
          sendResponse(await handleSearch(message));
          return;
        }

        if (message.type === 'web_fetch') {
          sendResponse(await handleFetch(message));
          return;
        }

        if (message.type === 'web_fetch_render') {
          sendResponse(await handleFetchRender(message));
          return;
        }

        // ── Workspace Assistant: pull page context from upstream tab ──
        //
        // CreatorWeave side panel sends {type:'requestBoundPageContext'}.
        // We execute in the upstream tab's MAIN world and combine two sources:
        //   - __cwUpstreamPage.{getUrl,getTitle,getSelectedText}   ← OUR content script
        //     (upstream-page.content.ts), present on ALL URLs (matches
        //     <all_urls>). Reads generic page metadata directly. Fresh at
        //     every call (no URL-params snapshot). This is what we own.
        //   - __sidePanelContextProvider.getContext()   ← OPTIONAL upstream
        //     provider (per docs/developer/guides/side-panel-context-provider.md).
        //     Yields business-specific fields (page_type, public_id, etc.).
        //     We don't parse its shape.
        //
        // Return shape: { url, title, selectedText, providerContext } | null
        // The split makes responsibility clear: url/title/selectedText are
        // "what we recorded", providerContext is "what the upstream site told us".
        if (message.type === 'requestBoundPageContext') {
          const targetTabId = await resolveBoundSidePanelTab(_sender?.url, message.binding)
          if (targetTabId === null) {
            sendResponse(null)
            return
          }
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              world: 'MAIN',
              func: async () => {
                const w = window as unknown as {
                  __cwUpstreamPage?: {
                    getUrl?: () => unknown
                    getTitle?: () => unknown
                    getSelectedText?: () => unknown
                  }
                  __sidePanelContextProvider?: {
                    getContext?: () => unknown
                  }
                }

                // Our content script: URL / title / selected text.
                // Fall back to window.location / document / window.getSelection
                // if our content script didn't run (defensive against
                // races or future extensions).
                let url: string | null = null
                let title: string | null = null
                let selectedText: string | null = null
                const upstream = w.__cwUpstreamPage
                if (upstream) {
                  try {
                    const u = upstream.getUrl?.()
                    if (typeof u === 'string' && u) url = u
                  } catch {}
                  try {
                    const t = upstream.getTitle?.()
                    if (typeof t === 'string' && t) title = t
                  } catch {}
                  try {
                    const s = upstream.getSelectedText?.()
                    if (typeof s === 'string') selectedText = s
                  } catch {}
                }
                if (!url) url = window.location.href
                if (!title) title = document.title
                if (selectedText == null) {
                  try {
                    const sel = window.getSelection?.()
                    selectedText = sel ? sel.toString().trim() : ''
                  } catch {
                    selectedText = ''
                  }
                }

                // Upstream provider: business-specific context (optional).
                // Await the result so executeScript returns a resolved
                // plain value — NOT a Promise (executeScript uses
                // structured clone, which cannot serialize Promise).
                let providerContext: unknown = null
                const provider = w.__sidePanelContextProvider
                if (provider && typeof provider.getContext === 'function') {
                  try {
                    const ctx = provider.getContext()
                    providerContext = ctx && typeof (ctx as Promise<unknown>).then === 'function'
                      ? await (ctx as Promise<unknown>).catch(() => null)
                      : ctx ?? null
                  } catch {
                    providerContext = null
                  }
                }

                return { url, title, selectedText, providerContext }
              },
            })
            const result = Array.isArray(results) ? results[0]?.result : null
            // Attach the bound tab's id so the web app can scope WebMCP tool
            // groups to THIS tab (same-hostname tabs in different apps —
            // e.g. jmail.world / vs /messages — expose disjoint toolsets;
            // hostname-only filtering would merge them).
            const payload =
              result && typeof result === 'object'
                ? { ...(result as Record<string, unknown>), tabId: targetTabId }
                : result ?? null
            sendResponse(payload)
          } catch (err: any) {
            console.warn('[Background] requestBoundPageContext failed:', err?.message || err)
            sendResponse(null)
          }
          return
        }

        // ── Page Action Runner ─────────────────────────────────────────
        // CreatorWeave side panel sends
        //   { type: 'runBoundPageAction', action }
        // where `action` is a page-interaction primitive (snapshot /
        // click / fill / type / scroll / find_elements / text_content /
        // evaluate) defined in page-action-runner.content.ts.
        //
        // We execute in the upstream tab's MAIN world, where
        // `window.__cwPageAction.run(action)` is injected by our
        // page-action-runner content script.
        //
        // The extension boundary restricts this bridge to CreatorWeave's
        // trusted side-panel origin and extension-owned binding, preventing
        // untrusted webpages from invoking MAIN-world page actions. The agent
        // layer remains responsible for UI confirmation of write actions.
        if (message.type === 'runBoundPageAction') {
          const targetTabId = await resolveBoundSidePanelTab(_sender?.url, message.binding)
          if (targetTabId === null) {
            sendResponse({
              ok: false,
              errorCode: 'UNAUTHORIZED_TARGET',
              error: 'Page actions require a valid side-panel binding.',
            })
            return
          }

          const sidePanelOptions = await chrome.sidePanel.getOptions({ tabId: targetTabId })
          if (!sidePanelOptions.enabled) {
            sendResponse({
              ok: false,
              errorCode: 'UNAUTHORIZED_TARGET',
              error: 'Page actions require an open side panel for the target tab.',
            })
            return
          }

          const action = message.action
          if (!action || typeof action !== 'object') {
            sendResponse({ ok: false, errorCode: 'INVALID_REQUEST', error: 'runBoundPageAction requires { action: object }' })
            return
          }
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              world: 'MAIN',
              func: async (a: unknown) => {
                const w = window as unknown as {
                  __cwPageAction?: { ready: boolean; run: (a: unknown) => Promise<unknown> }
                }
                const runner = w.__cwPageAction
                if (!runner?.ready || typeof runner.run !== 'function') {
                  return {
                    ok: false,
                    errorCode: 'RUNNER_NOT_READY',
                    error: 'Page action runner not injected in this tab. The page-action-runner content script may not have loaded (extension reload, restricted URL, or injection race).',
                  }
                }
                try {
                  return await runner.run(a)
                } catch (err: any) {
                  return {
                    ok: false,
                    errorCode: 'RUNNER_ERROR',
                    error: err?.message || String(err),
                  }
                }
              },
              args: [action],
            })
            const result = Array.isArray(results) ? results[0]?.result : null
            sendResponse(result ?? { ok: false, errorCode: 'NO_RESULT', error: 'executeScript returned no result' })
          } catch (err: any) {
            // Common causes: tab gone, restricted URL (chrome://, web store),
            // host permission missing. Surface as structured error.
            sendResponse({
              ok: false,
              errorCode: 'EXECUTE_SCRIPT_FAILED',
              error: err?.message || String(err),
            })
          }
          return
        }

        // ── Capture Visible Tab ───────────────────────────────────────
        // Captures the visible area of the upstream tab as a PNG/JPEG data URL.
        // Uses chrome.tabs.captureVisibleTab (no debugger permission needed,
        // no yellow debug bar). Only captures the current viewport — for
        // full-page capture, the agent should scroll + capture multiple times.
        if (message.type === 'captureBoundTab') {
          const targetTabId = await resolveBoundSidePanelTab(_sender?.url, message.binding)
          if (targetTabId === null) {
            sendResponse({ ok: false, errorCode: 'UNAUTHORIZED_TARGET', error: 'Missing or invalid side-panel binding.' })
            return
          }
          const sidePanelOptions = await chrome.sidePanel.getOptions({ tabId: targetTabId })
          if (!sidePanelOptions.enabled) {
            sendResponse({
              ok: false,
              errorCode: 'UNAUTHORIZED_TARGET',
              error: 'Screenshots require an open side panel for the target tab.',
            })
            return
          }

          const format = message.format === 'jpeg' ? 'jpeg' : 'png'
          const quality = typeof message.quality === 'number' ? Math.max(0, Math.min(100, message.quality)) : undefined
          try {
            // Find the window that owns the target tab
            const tab = await chrome.tabs.get(targetTabId)
            if (!tab.active) {
              sendResponse({ ok: false, errorCode: 'TARGET_NOT_VISIBLE', error: 'The side-panel tab is not the visible tab in its window.' })
              return
            }
            const windowId = tab.windowId
            const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
              format,
              ...(quality !== undefined ? { quality } : {}),
            })
            sendResponse({ ok: true, dataUrl, format })
          } catch (err: any) {
            sendResponse({
              ok: false,
              errorCode: 'CAPTURE_FAILED',
              error: err?.message || String(err),
            })
          }
          return
        }

        if (message.type === 'webmcp_recipe_get_status') {
          // ── Recipe opt-in prompt: status probe (side panel → upstream tab) ──
          // CreatorWeave's side panel asks whether the BOUND upstream tab
          // hosts a built-in recipe (jmail.world archive / JMessage) the
          // user has not enabled yet. Powers the one-time opt-in modal:
          // "this site can expose MCP tools — enable injection?".
          //
          // Security: same boundary as the other bound-tab handlers — the
          // sender must be a trusted CreatorWeave origin AND the binding
          // must resolve to a real tab. Only recipe METADATA (id / display
          // name / description / glyph / tool count) crosses the bridge;
          // tool schemas and page content never do.
          const targetTabId = await resolveBoundSidePanelTab(_sender?.url, message.binding)
          if (targetTabId === null) {
            sendResponse({ ok: false, errorCode: 'UNAUTHORIZED_TARGET', error: 'Missing or invalid side-panel binding.' })
            return
          }
          try {
            const tab = await chrome.tabs.get(targetTabId)
            const tabUrl = (() => {
              try { return new URL(tab.url || '') } catch { return null }
            })()
            // Path-scoped lookup: jmail.world hosts two recipes (archive at
            // / vs JMessage at /messages); only the one matching the CURRENT
            // path is the opt-in candidate.
            const recipe = tabUrl ? findRecipeForLocation(tabUrl.hostname, tabUrl.pathname) : undefined
            if (!recipe) {
              sendResponse({ ok: true, applicable: false })
              return
            }
            const stored = await chrome.storage.local.get(ENABLED_RECIPES_STORAGE_KEY)
            const enabledMap = (stored?.[ENABLED_RECIPES_STORAGE_KEY] || {}) as Record<string, unknown>
            sendResponse({
              ok: true,
              applicable: true,
              recipe: {
                id: recipe.id,
                displayName: recipe.displayName,
                description: recipe.description,
                glyph: recipe.glyph,
                hostname: recipe.hostname,
                toolCount: recipe.tools.length,
              },
              enabled: enabledMap[recipe.id] != null && enabledMap[recipe.id] !== false,
            })
          } catch (err: any) {
            sendResponse({ ok: false, errorCode: 'STATUS_FAILED', error: err?.message || String(err) })
          }
          return
        }

        if (message.type === 'webmcp_recipe_enable') {
          // ── Recipe opt-in: enable + reload the upstream page ──
          // The user just approved the modal. Writes the SAME storage map the
          // recipes.html management page writes (single source of truth), then
          // reloads the bound tab so the recipe injector + agent content
          // scripts are guaranteed present — this also covers the stale-page
          // case where the upstream tab predates the extension install/update
          // (content scripts absent, activation alone could never reach it).
          const targetTabId = await resolveBoundSidePanelTab(_sender?.url, message.binding)
          if (targetTabId === null) {
            sendResponse({ ok: false, errorCode: 'UNAUTHORIZED_TARGET', error: 'Missing or invalid side-panel binding.' })
            return
          }
          const recipeId = typeof message.recipeId === 'string' ? message.recipeId : ''
          if (!recipeId) {
            sendResponse({ ok: false, errorCode: 'INVALID_REQUEST', error: 'recipeId is required' })
            return
          }
          try {
            // Re-derive the recipe from the LIVE tab URL — never trust the
            // web-app-supplied recipeId alone. This proves the id matches
            // what is actually hosted in the bound tab before flipping
            // storage (a malicious/buggy panel cannot arm an arbitrary
            // recipe on an unrelated site).
            const tab = await chrome.tabs.get(targetTabId)
            const tabUrl = (() => {
              try { return new URL(tab.url || '') } catch { return null }
            })()
            const recipe = tabUrl ? findRecipeForLocation(tabUrl.hostname, tabUrl.pathname) : undefined
            if (!recipe || recipe.id !== recipeId) {
              sendResponse({ ok: false, errorCode: 'RECIPE_MISMATCH', error: 'Recipe does not match the bound tab location.' })
              return
            }
            const stored = await chrome.storage.local.get(ENABLED_RECIPES_STORAGE_KEY)
            const enabledMap = (stored?.[ENABLED_RECIPES_STORAGE_KEY] || {}) as Record<string, unknown>
            if (!enabledMap[recipeId]) {
              enabledMap[recipeId] = { enabledAt: Date.now() }
              await chrome.storage.local.set({ [ENABLED_RECIPES_STORAGE_KEY]: enabledMap })
            }
            // storage.onChanged activates injection in ALREADY-loaded pages;
            // the reload guarantees it for pages whose content scripts were
            // never injected (pre-install / stale document).
            await chrome.tabs.reload(targetTabId)
            sendResponse({ ok: true, recipeId, hostname: recipe.hostname, reloaded: true })
          } catch (err: any) {
            sendResponse({ ok: false, errorCode: 'ENABLE_FAILED', error: err?.message || String(err) })
          }
          return
        }

        if (message.type === 'mcp_proxy_fetch') {
          const { url, method = 'POST', headers = {}, body = null, timeoutMs } = message;
          try {
            const resp = await fetchWithTimeout(url, {
              method,
              headers,
              body,
              timeout: typeof timeoutMs === 'number' ? timeoutMs : CONFIG.TIMEOUT_MS,
            });
            const text = await resp.text();
            const responseHeaders = {};
            resp.headers.forEach((value, key) => {
              responseHeaders[key] = value;
            });
            sendResponse({ ok: resp.ok, status: resp.status, statusText: resp.statusText, headers: responseHeaders, text });
          } catch (err: any) {
            sendResponse({ ok: false, status: 0, error: err?.message || String(err) });
          }
          return;
        }

        // ── WebMCP registry feed (static content scripts) ──
        // Handled by the dedicated webmcp_bridge listener registered below —
        // returning here would synchronously sendResponse("Unknown message
        // type") and close the channel before the async handler can reply
        // (symptom: bridge toggle won't turn on, no visible error).
        if (message.type === 'webmcp_bridge_get_status' || message.type === 'webmcp_bridge_set_enabled') {
          return;
        }

        // Tab reports arrive from webmcp.content.ts (ISOLATED relay) with
        // the browser-verified sender.tab. Identity (tabId/hostname/title/
        // url/windowId) comes ONLY from _sender — the page payload carries
        // nothing but the validated tool list, so a hostile page cannot
        // forge reports about other tabs. Empty toolset → unregister.
        if (message.type === WEBMCP_TAB_REPORT_TYPE) {
          const tab = _sender?.tab;
          if (!tab || typeof tab.id !== 'number' || typeof tab.url !== 'string') {
            sendResponse({ ok: false, error: 'webmcp_tab_report requires a tab sender' });
            return;
          }
          let hostname = '';
          try {
            const parsed = new URL(tab.url);
            hostname = parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : '';
          } catch {
            hostname = '';
          }
          if (!hostname) {
            sendResponse({ ok: false, error: 'webmcp_tab_report sender is not an http(s) tab' });
            return;
          }
          const tools = Array.isArray(message.tools) ? message.tools : [];
          try {
            // Empty toolset → registerTab keeps the tab in the "seen" set
            // (so legacy probe skips it) while removing any stale entry.
            // unregisterTab is reserved for tab-close cleanup.
            await registerTab({
              tabId: tab.id,
              hostname,
              tabTitle: tab.title || '',
              tabUrl: tab.url,
              windowId: tab.windowId,
              apiMode: typeof message.apiMode === 'string' ? message.apiMode : undefined,
              tools,
            });
            sendResponse({ ok: true });
          } catch (err: any) {
            sendResponse({ ok: false, error: err?.message || String(err) });
          }
          return;
        }

        if (message.type === 'webmcp_discover_tools') {
          // Window scoping: a web page sender is scoped to ITS window via
          // sender.tab.windowId. The popup (no sender.tab) must scope itself
          // explicitly — it passes options.windowId from its own
          // chrome.windows.getCurrent(). Without this the popup's discover
          // returned a CROSS-WINDOW global list (“ghost” sites from other
          // windows). Only trusted extension-internal senders may override.
          const isExtensionInternalSender = !_sender?.tab;
          const senderWindowId = _sender?.tab?.windowId
            ?? (isExtensionInternalSender && typeof message?.options?.windowId === 'number'
              ? message.options.windowId
              : undefined);
          const response = await discoverWebMCPToolsInCurrentWindow(senderWindowId);
          // Authorization is enforced at DISCOVERY time: tools from disabled
          // hosts/groups are filtered out entirely — a disabled site simply
          // does not exist for consumers. Unauthorized metadata (names,
          // schemas, source tabs) must not leak to pages either.
          // The popup is exempt: it needs the full picture to let the user
          // re-enable hidden sites, so it passes includeDisabled.
          if (response.ok) {
            const [hostMap, groupMap] = await Promise.all([
              getHostAuthorizationMap(),
              getGroupAuthorizationMap(),
            ]);
            const annotated = annotateToolsWithHostAuthorization(
              response.tools || [],
              hostMap,
              groupMap
            );
            // includeDisabled is honored ONLY for extension-internal senders
            // (popup/background pages have no sender.tab). Messages relayed
            // from web pages always carry sender.tab — even if a page forges
            // the flag, it is ignored here. Disabled tools must not exist
            // for web content.
            const isExtensionInternal = !_sender?.tab;
            const includeDisabled = isExtensionInternal && message?.options?.includeDisabled === true;
            (response as any).tools = includeDisabled
              ? annotated
              : annotated.filter((tool: any) => tool.hostEnabled !== false && tool.groupEnabled !== false);
          }
          sendResponse(response);
          return;
        }

        if (message.type === 'webmcp_get_host_authorization') {
          const [hostMap, groupMap] = await Promise.all([
            getHostAuthorizationMap(),
            getGroupAuthorizationMap(),
          ]);
          sendResponse({ ok: true, enabledByHost: hostMap, enabledByGroup: groupMap });
          return;
        }

        if (message.type === 'webmcp_set_host_enabled') {
          const hostname = typeof message.hostname === 'string' ? message.hostname : '';
          const enabled = message.enabled === true;
          if (!hostname) {
            sendResponse({ ok: false, error: 'hostname is required' });
            return;
          }
          try {
            const map = await setWebMCPHostEnabled(hostname, enabled);
            sendResponse({ ok: true, enabledByHost: map });
          } catch (err: any) {
            sendResponse({ ok: false, error: err?.message || String(err) });
          }
          return;
        }

        if (message.type === 'webmcp_set_group_enabled') {
          const groupKey = typeof message.groupKey === 'string' ? message.groupKey : '';
          const enabled = message.enabled === true;
          if (!groupKey) {
            sendResponse({ ok: false, error: 'groupKey is required' });
            return;
          }
          try {
            const map = await setWebMCPGroupEnabled(groupKey, enabled);
            sendResponse({ ok: true, enabledByGroup: map });
          } catch (err: any) {
            sendResponse({ ok: false, error: err?.message || String(err) });
          }
          return;
        }

        if (message.type === 'webmcp_invoke_tool') {
          sendResponse(await invokeWebMCPTool(message));
          return;
        }

        if (message.type === 'webmcp_plugin_download_finalize') {
          const transferId = typeof message.transferId === 'string' ? message.transferId : ''
          const savedPath = typeof message.savedPath === 'string' ? message.savedPath : ''
          if (!transferId) {
            sendResponse({ ok: false, error: 'Missing transferId for plugin download finalize' });
            return;
          }

          const existing = completedPluginDownloads.get(transferId)
          completedPluginDownloads.set(transferId, {
            completedAt: existing?.completedAt || Date.now(),
            savedPath: savedPath || existing?.savedPath,
          })

          await sleep(3000)
          sendResponse({ ok: true, transferId, savedPath: savedPath || existing?.savedPath })
          completedPluginDownloads.delete(transferId)
          return;
        }

        if (CODEX_OAUTH_ENABLED && message.type === 'codex_auth_start') {
          const resp = await fetch(CODEX!.DEVICEAUTH_USERCODE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_id: CODEX!.CODEX_CLIENT_ID }),
          });
          const { text, json } = await CODEX!.parseJsonSafe(resp);
          if (!resp.ok) {
            sendResponse({ ok: false, status: resp.status, error: json || text });
            return;
          }

          const data = {
            ...json,
            verification_uri: CODEX!.DEVICE_VERIFY_URL,
            verification_uri_complete: CODEX!.DEVICE_VERIFY_URL,
          };

          await CODEX!.savePendingCodexAuth({
            user_code: data.user_code,
            device_auth_id: data.device_auth_id,
            verification_uri: data.verification_uri,
            verification_uri_complete: data.verification_uri_complete,
            expires_at: Date.now() + (data.expires_in || 900) * 1000,
            interval: data.interval || 5,
          });

          await chrome.alarms.create(CODEX!.CODEX_AUTH_POLL_ALARM, { periodInMinutes: 1 });

          sendResponse({ ok: true, data });
          return;
        }

        if (CODEX_OAUTH_ENABLED && message.type === 'codex_auth_poll') {
          let deviceAuthId = message.deviceAuthId;
          let userCode = message.userCode;

          if (!deviceAuthId || !userCode) {
            const pending = await CODEX!.getPendingCodexAuth();
            deviceAuthId = pending?.device_auth_id;
            userCode = pending?.user_code;
          }

          if (!deviceAuthId || !userCode) {
            sendResponse({ ok: false, error: 'Missing device auth context, please start login again' });
            return;
          }

          const result = await CODEX!.pollCodexAuthOnce(deviceAuthId, userCode);
          sendResponse(result);
          return;
        }

        if (CODEX_OAUTH_ENABLED && message.type === 'codex_get_status') {
          const tokens = await CODEX!.getCodexTokens();
          const pending = await CODEX!.getPendingCodexAuth();
          let authState: string = 'idle';
          let authorized = false;

          if (tokens?.access_token) {
            // Check if access token is actually still valid (JWT exp)
            const payload = CODEX!.decodeJwtPayload(tokens.access_token);
            const expiresAt = payload?.exp ? payload.exp * 1000 : 0;
            const now = Date.now();

            if (expiresAt && now >= expiresAt - CODEX!.TOKEN_REFRESH_MARGIN_MS) {
              // Token expired or about to expire — try proactive refresh
              if (tokens.refresh_token) {
                try {
                  await CODEX!.refreshCodexAccessToken(tokens);
                  authState = 'authorized';
                  authorized = true;
                } catch {
                  // Refresh failed — token is expired
                  authState = 'expired';
                }
              } else {
                authState = 'expired';
              }
            } else {
              // Token still valid
              authState = 'authorized';
              authorized = true;
            }
          } else if (pending && pending.expires_at && pending.expires_at > Date.now()) {
            authState = 'pending';
          } else if (pending) {
            // Remove expired/orphaned device-code state so the popup cannot
            // keep polling an old login attempt forever.
            await CODEX!.clearPendingCodexAuth();
            if (tokens && !tokens.access_token) authState = 'expired';
          } else if (tokens && !tokens.access_token) {
            authState = 'expired';
          }

          sendResponse({
            ok: true,
            data: {
              authorized,
              authState,
              models: CODEX!.CODEX_DEFAULT_MODELS,
              updatedAt: tokens ? await chrome.storage.local.get('codex_token_saved_at').then(r => r.codex_token_saved_at || null) : null,
            },
          });
          return;
        }

        if (CODEX_OAUTH_ENABLED && message.type === 'codex_get_usage') {
          const { codex_usage } = await chrome.storage.local.get('codex_usage');
          sendResponse({ ok: true, data: codex_usage || null });
          return;
        }

        if (CODEX_OAUTH_ENABLED && message.type === 'codex_get_reset_credits') {
          const tokens = await CODEX!.getCodexTokens();
          if (!tokens?.access_token) {
            sendResponse({ ok: false, errorCode: 'NOT_AUTHORIZED', status: 0, message: 'Not authorized. Please complete device code login first.' });
            return;
          }
          try {
            const data = await CODEX!.getCodexResetCredits(tokens);
            sendResponse({ ok: true, data });
          } catch (err: any) {
            sendResponse({ ok: false, errorCode: 'RESET_CREDITS_UNAVAILABLE', status: 502, message: String(err?.message || err) });
          }
          return;
        }

        if (CODEX_OAUTH_ENABLED && message.type === 'codex_consume_reset_credit') {
          const tokens = await CODEX!.getCodexTokens();
          const creditId = typeof message.creditId === 'string' ? message.creditId : '';
          if (!tokens?.access_token) {
            sendResponse({ ok: false, errorCode: 'NOT_AUTHORIZED', status: 0, message: 'Not authorized. Please complete device code login first.' });
            return;
          }
          if (!creditId) {
            sendResponse({ ok: false, errorCode: 'MISSING_CREDIT_ID', status: 400, message: 'Missing reset credit id.' });
            return;
          }
          try {
            const data = await CODEX!.consumeCodexResetCredit(tokens, creditId);
            sendResponse({ ok: true, data });
          } catch (err: any) {
            sendResponse({ ok: false, errorCode: 'RESET_CREDIT_CONSUME_FAILED', status: 502, message: String(err?.message || err) });
          }
          return;
        }

        if (CODEX_OAUTH_ENABLED && message.type === 'codex_proxy_fetch') {
          let tokens = await CODEX!.getCodexTokens();
          if (!tokens?.access_token) {
            sendResponse({ ok: false, errorCode: 'NOT_AUTHORIZED', status: 0, message: 'Not authorized. Please complete device code login first.' });
            return;
          }

          const requestUrl = message.url || CODEX!.CODEX_RESPONSES_URL;
          const requestInit: RequestInit = {
            method: message.method || 'POST',
            body: message.body ? JSON.stringify(message.body) : undefined,
          };

          let resp = await fetch(requestUrl, {
            ...requestInit,
            headers: CODEX!.codexHeaders(tokens.access_token, message.headers || {}),
          });

          if (resp.status === 401 && tokens?.refresh_token) {
            try {
              tokens = await CODEX!.refreshCodexAccessToken(tokens);
              resp = await fetch(requestUrl, {
                ...requestInit,
                headers: CODEX!.codexHeaders(tokens.access_token, message.headers || {}),
              });
            } catch (refreshErr) {
              sendResponse({ ok: false, errorCode: 'REAUTH_REQUIRED', status: 401, message: 'Token refresh failed. Please re-authorize in the extension popup.' });
              return;
            }
          }

          const text = await resp.text();
          sendResponse({ ok: resp.ok, status: resp.status, text });
          return;
        }

        // ── Schedule triggers ─────────────────────────────────────────────

        // NOTE: cw_side_panel_toggle is handled synchronously above
        // (before the async block) to preserve user gesture context for
        // chrome.sidePanel.open().

        if (message.type === 'cw_schedule_register_alarm') {
          // CreatorWeave page asks us to set an alarm for a schedule
          const { scheduleId, nextRunTime } = message as { scheduleId: string; nextRunTime: number }
          if (!scheduleId || typeof nextRunTime !== 'number') {
            sendResponse({ ok: false, error: 'Missing scheduleId or nextRunTime' })
            return
          }
          try {
            const alarmName = `sched_${scheduleId}`
            const delaySeconds = Math.max(1, Math.round((nextRunTime - Date.now()) / 1000))
            await chrome.alarms.create(alarmName, { delayInMinutes: delaySeconds / 60 })
            sendResponse({ ok: true, alarmName })
          } catch (err: any) {
            sendResponse({ ok: false, error: err?.message || String(err) })
          }
          return
        }

        if (message.type === 'cw_schedule_clear_alarm') {
          // CreatorWeave page asks us to clear an alarm for a schedule
          const { scheduleId } = message as { scheduleId: string }
          if (!scheduleId) {
            sendResponse({ ok: false, error: 'Missing scheduleId' })
            return
          }
          try {
            await chrome.alarms.delete(`sched_${scheduleId}`)
            sendResponse({ ok: true })
          } catch (err: any) {
            sendResponse({ ok: false, error: err?.message || String(err) })
          }
          return
        }

        if (message.type === 'cw_schedule_show_notification') {
          // CreatorWeave page asks us to show a desktop notification
          const { title, body } = message as { title: string; body: string }
          await showScheduleNotification({ title, body })
          sendResponse({ ok: true })
          return
        }

        if (message.type === 'cw_agent_show_notification') {
          // Agent-loop-complete notification — clicking it refocuses the
          // sender tab (see showAgentNotification above for rationale).
          const { title, body, conversationId } = message as {
            title: string
            body: string
            conversationId?: string
          }
          await showAgentNotification({
            title,
            body,
            conversationId,
            tabId: _sender?.tab?.id,
          })
          sendResponse({ ok: true })
          return
        }

        if (message.type === 'cw_schedule_disable_notification') {
          // CreatorWeave notifies us that a schedule was disabled (e.g., bound conversation deleted)
          const { scheduleId, reason } = message as { scheduleId: string; reason?: string }
          if (scheduleId) {
            try {
              await chrome.alarms.delete(`sched_${scheduleId}`)
            } catch { /* ignore */ }
          }
          await showScheduleNotification({
            title: '定时任务已暂停',
            body: reason ? `原因：${reason}` : '定时任务已被禁用',
          })
          sendResponse({ ok: true })
          return
        }

        if (message.type === 'native_host_call') {
          // SECURITY: native-host actions include direct disk writes
          // (write_file/delete_file), command execution (exec_sync/exec_start)
          // and exec-policy rewriting (set_execpolicy). This channel MUST NOT
          // be reachable from arbitrary web pages: injected.content.ts runs on
          // <all_urls>, so any page could otherwise relay privileged calls to
          // the host binary (e.g. flip execpolicy to allow-all) with no user
          // confirmation. Same trust boundary as resolveBoundSidePanelTab.
          // Allowed senders: the EO2Weave web app origins, plus the
          // extension's own pages (popup / side panel), whose sender.url is
          // chrome-extension://<own id>/....
          // NOTE: sender.id is NOT sufficient on its own — content-script
          // relays carry the extension id too; the sender URL is the
          // page-level trust anchor (browser-verified, not forgeable).
          const senderUrl = _sender?.url ?? ''
          const isExtensionOwnPage =
            senderUrl.startsWith('chrome-extension://') && _sender?.id === chrome.runtime.id
          if (!isExtensionOwnPage && !isTrustedCreatorWeaveSenderUrl(senderUrl)) {
            sendResponse({
              ok: false,
              errorCode: 'UNAUTHORIZED_SENDER',
              error: `native_host_call from untrusted sender: ${senderUrl || '(no url)'}`,
            })
            return
          }
          // Native Host: disk file I/O via Chrome Native Messaging
          // content.ts relays page payload fields at the top level
          // ({ type, ...payload }). Keep the nested-payload fallback for
          // direct/legacy callers, but never lose the current action field.
          const nestedPayload = message.payload as Record<string, any> | undefined
          const action = (message.action ?? nestedPayload?.action) as string
          const allowedActions = new Set([
            'ping', 'list_scopes', 'pick_folder', 'remove_scope',
            'stat_file', 'list_dir', 'read_file', 'read_file_at',
            'write_file', 'write_file_at', 'delete_file',
            'check_policy', 'exec_sync',
            'get_execpolicy', 'set_execpolicy',
            // Background process management
            'exec_start', 'exec_logs', 'exec_status', 'exec_stop', 'exec_list',
          ])
          if (!action || !allowedActions.has(action)) {
            sendResponse({ ok: false, error: `action not allowed: ${action || '(empty)'}` })
            return
          }
          try {
            const { type: _type, __agentWebBridge: _bridge, id: _id, payload: _payload, ...topLevelPayload } = message as Record<string, any>
            const nativePayload = message.action !== undefined ? topLevelPayload : nestedPayload
            const actionName = typeof nativePayload?.action === 'string' ? nativePayload.action : ''
            const configuredExecTimeoutSeconds =
              typeof nativePayload?.timeout === 'number' && nativePayload.timeout > 0
                ? nativePayload.timeout
                : 120
            // File operations should fail promptly when the host is broken,
            // but exec_sync and pick_folder are deliberately long-running:
            // the former has its own command timeout and the latter waits for
            // an explicit user choice. A single 20-second timeout for every
            // action incorrectly labels healthy work as a host failure.
            const NATIVE_HOST_TIMEOUT_MS = actionName === 'exec_sync'
              ? Math.max(20_000, configuredExecTimeoutSeconds * 1_000 + 5_000)
              : actionName === 'pick_folder'
                ? 5 * 60_000
                : 20_000
            const sendNativeMessageWithTimeout = () => new Promise<any>((resolve, reject) => {
              let settled = false
              const timer = setTimeout(() => {
                if (settled) return
                settled = true
                const timeoutError = new Error(`Native host did not respond within ${NATIVE_HOST_TIMEOUT_MS / 1000}s`)
                ;(timeoutError as Error & { code?: string }).code = 'NATIVE_HOST_TIMEOUT'
                reject(timeoutError)
              }, NATIVE_HOST_TIMEOUT_MS)
              chrome.runtime.sendNativeMessage(
                'com.creatorweave.nativehost',
                nativePayload,
                (response: any) => {
                  if (settled) return
                  settled = true
                  clearTimeout(timer)
                  const runtimeError = chrome.runtime.lastError
                  if (runtimeError) {
                    reject(new Error(String(runtimeError.message || runtimeError)))
                    return
                  }
                  resolve(response ?? { ok: false, error: 'Empty response from native host' })
                }
              )
            })
            const response = await sendNativeMessageWithTimeout()
            sendResponse(response)
          } catch (err: any) {
            sendResponse({
              ok: false,
              error: String(err?.message || err),
              errorCode: err?.code === 'NATIVE_HOST_TIMEOUT' ? 'NATIVE_HOST_TIMEOUT' : 'NATIVE_HOST_ERROR',
            })
          }
          return
        }

        sendResponse({ ok: false, error: `Unknown message type: ${String(message?.type || '')}` });
      } catch (err: any) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();

    return true;
  });

  // ── Port-based streaming bridge for Codex, page-outside MCP, and plugin download flows ──
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'agent_bridge_stream') return;

    port.onMessage.addListener((message) => {
      if (message.type === 'webmcp_plugin_download_stream') {
        (async () => {
          const plan = message.plan as WebMCPPluginDownloadPlan | undefined
          if (!plan?.transferId || !plan.downloadUrl || !plan.savePath || !plan.fileName) {
            port.postMessage({
              type: 'error',
              errorCode: 'INVALID_PLUGIN_DOWNLOAD_PLAN',
              message: 'Missing transferId/downloadUrl/savePath/fileName for plugin download stream',
            })
            port.disconnect()
            return
          }

          let streamEndedWithError = false
          const safePost = (payload: Record<string, unknown>) => {
            try {
              port.postMessage(payload)
              return true
            } catch {
              return false
            }
          }
          await streamPluginDownload(plan, (frame) => {
            if (frame.type === 'end') {
              completedPluginDownloads.set(plan.transferId, { completedAt: Date.now() })
            }
            const sent = safePost({ type: 'chunk', data: frame })
            if (!sent) return
            if (frame.type === 'error') {
              streamEndedWithError = true
              safePost({ type: 'done' })
              try { port.disconnect() } catch {}
            }
          })

          if (!streamEndedWithError) {
            safePost({ type: 'done' })
            try { port.disconnect() } catch {}
          }
        })()
        return
      }

      if (message.type === 'mcp_proxy_fetch_stream') {
        (async () => {
          const { url, method = 'POST', headers = {}, body = null, timeoutMs } = message;
          const streamTimeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 2 * 60 * 1000;
          let timeoutId = setTimeout(() => {
            port.postMessage({ type: 'error', errorCode: 'NETWORK_ERROR', message: `MCP stream request timed out (${Math.round(streamTimeoutMs / 1000)}s)` });
            try { port.disconnect(); } catch {}
          }, streamTimeoutMs);

          try {
            const resp = await fetchWithTimeout(url, {
              method,
              headers,
              body,
              timeout: streamTimeoutMs,
            });

            const responseHeaders = {};
            resp.headers.forEach((value, key) => {
              responseHeaders[key] = value;
            });

            port.postMessage({
              type: 'chunk',
              data: {
                type: 'response_start',
                status: resp.status,
                statusText: resp.statusText,
                headers: responseHeaders,
              },
            });

            if (!resp.ok) {
              clearTimeout(timeoutId);
              const errText = await resp.text();
              port.postMessage({ type: 'error', errorCode: 'UPSTREAM_ERROR', status: resp.status, message: errText || resp.statusText });
              port.disconnect();
              return;
            }

            const reader = resp.body?.getReader();
            if (!reader) {
              clearTimeout(timeoutId);
              port.postMessage({ type: 'error', errorCode: 'NO_RESPONSE_BODY', message: 'No response body for MCP stream' });
              port.disconnect();
              return;
            }

            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              port.postMessage({ type: 'chunk', data: { type: 'chunk', data: chunk } });
            }

            const remaining = decoder.decode();
            if (remaining) {
              port.postMessage({ type: 'chunk', data: { type: 'chunk', data: remaining } });
            }

            port.postMessage({ type: 'done' });
            clearTimeout(timeoutId);
            port.disconnect();
          } catch (err: any) {
            clearTimeout(timeoutId);
            port.postMessage({ type: 'error', errorCode: 'NETWORK_ERROR', message: String(err?.message || err) });
            port.disconnect();
          }
        })();
        return;
      }

      if (!CODEX_OAUTH_ENABLED || message.type !== 'codex_proxy_fetch_stream') return;

      (async () => {
        const CODEX_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
        const CODEX_HARD_TIMEOUT_MS = 30 * 60 * 1000;
        const abortController = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let hardTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        let disconnected = false;

        const clearStreamTimeouts = () => {
          if (idleTimeoutId !== null) {
            clearTimeout(idleTimeoutId);
            idleTimeoutId = null;
          }
          if (hardTimeoutId !== null) {
            clearTimeout(hardTimeoutId);
            hardTimeoutId = null;
          }
        };

        const abortUpstream = (reason: Error) => {
          if (!abortController.signal.aborted) abortController.abort(reason);
          if (reader) void reader.cancel(reason).catch(() => {});
        };

        const safePost = (payload: Record<string, unknown>): boolean => {
          if (disconnected) return false;
          try {
            port.postMessage(payload);
            return true;
          } catch {
            disconnected = true;
            return false;
          }
        };

        const disconnectPort = () => {
          if (disconnected) return;
          try {
            port.disconnect();
          } catch {}
        };

        const stopWithoutReply = (reason: Error) => {
          if (settled) return;
          settled = true;
          clearStreamTimeouts();
          abortUpstream(reason);
          disconnectPort();
        };

        const failStream = (errorCode: string, message: string, status?: number) => {
          if (settled) return;
          settled = true;
          clearStreamTimeouts();
          abortUpstream(new Error(message));
          safePost({ type: 'error', errorCode, ...(status === undefined ? {} : { status }), message });
          disconnectPort();
        };

        const finishStream = () => {
          if (settled) return;
          settled = true;
          clearStreamTimeouts();
          safePost({ type: 'done' });
          disconnectPort();
        };

        const armIdleTimeout = () => {
          if (settled) return;
          if (idleTimeoutId !== null) clearTimeout(idleTimeoutId);
          idleTimeoutId = setTimeout(() => {
            failStream('STREAM_IDLE_TIMEOUT', 'Codex stream received no data for 10 minutes');
          }, CODEX_IDLE_TIMEOUT_MS);
        };

        port.onDisconnect.addListener(() => {
          disconnected = true;
          stopWithoutReply(new Error('Codex stream client disconnected'));
        });
        port.onMessage.addListener((controlMessage: { type?: string }) => {
          if (controlMessage?.type === 'cancel') {
            stopWithoutReply(new Error('Codex stream cancelled'));
          }
        });

        // The hard deadline is immutable; only the idle timeout is refreshed.
        armIdleTimeout();
        hardTimeoutId = setTimeout(() => {
          failStream('STREAM_HARD_TIMEOUT', 'Codex stream exceeded the 30-minute hard timeout');
        }, CODEX_HARD_TIMEOUT_MS);

        try {
          let tokens = await CODEX!.getCodexTokens();
          if (!tokens?.access_token) {
            failStream('NOT_AUTHORIZED', 'Not authorized. Please complete device code login first.');
            return;
          }

          const requestUrl = message.url || CODEX!.CODEX_RESPONSES_URL;
          const body = { ...(message.body || {}), stream: true };
          const fetchOptions = (accessToken: string): RequestInit => ({
            method: 'POST',
            body: JSON.stringify(body),
            headers: CODEX!.codexHeaders(accessToken, message.headers || {}),
            signal: abortController.signal,
          });

          let resp = await fetch(requestUrl, fetchOptions(tokens.access_token));

          // Auto-refresh on 401
          if (resp.status === 401 && tokens?.refresh_token) {
            try {
              await resp.body?.cancel();
              tokens = await CODEX!.refreshCodexAccessToken(tokens);
              if (settled) return;
              if (!tokens.access_token) {
                failStream('REAUTH_REQUIRED', 'Token refresh returned no access token. Please re-authorize in the extension popup.', 401);
                return;
              }
              resp = await fetch(requestUrl, fetchOptions(tokens.access_token));
            } catch (refreshErr) {
              if (!settled) {
                failStream('REAUTH_REQUIRED', 'Token refresh failed. Please re-authorize in the extension popup.', 401);
              }
              return;
            }
          }

          if (!resp.ok) {
            const errText = await resp.text();
            let errorCode = 'UPSTREAM_ERROR';
            if (resp.status === 400) errorCode = 'UPSTREAM_BAD_REQUEST';
            else if (resp.status === 429) errorCode = 'UPSTREAM_RATE_LIMITED';
            else if (resp.status >= 500) errorCode = 'UPSTREAM_SERVER_ERROR';
            failStream(errorCode, errText || resp.statusText, resp.status);
            return;
          }

          // Extract rate-limit headers before streaming body
          const rateLimitHeaders: Record<string, string> = {};
          const X_CODEX_PREFIXES = ['x-codex-primary', 'x-codex-secondary', 'x-codex-credits', 'x-codex-active-limit', 'x-codex-plan-type', 'x-codex-code-review', 'x-codex-review', 'x-code-review'];
          resp.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (X_CODEX_PREFIXES.some(p => lower.startsWith(p))) {
              rateLimitHeaders[lower] = value;
            }
          });
          if (Object.keys(rateLimitHeaders).length > 0) {
            // Save to storage for popup to read
            chrome.storage.local.set({
              codex_usage: {
                headers: rateLimitHeaders,
                updatedAt: Date.now(),
              },
            });
          }

          // Stream SSE chunks through the port. Every upstream chunk refreshes
          // the 10-minute idle timer; the 30-minute hard timer never moves.
          if (!resp.body) {
            failStream('NO_RESPONSE_BODY', 'No response body for Codex stream');
            return;
          }
          reader = resp.body.getReader();
          const decoder = new TextDecoder();

          while (!settled) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdleTimeout();
            const chunk = decoder.decode(value, { stream: true });
            if (chunk && !safePost({ type: 'chunk', data: chunk })) {
              stopWithoutReply(new Error('Codex stream client disconnected'));
              return;
            }
          }

          if (settled) return;

          // Flush remaining bytes
          const remaining = decoder.decode();
          if (remaining && !safePost({ type: 'chunk', data: remaining })) {
            stopWithoutReply(new Error('Codex stream client disconnected'));
            return;
          }

          finishStream();
        } catch (err: any) {
          if (settled || abortController.signal.aborted) return;
          failStream('NETWORK_ERROR', String(err?.message || err));
        }
      })();
    });
  });
});
