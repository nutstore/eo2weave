// ============================================================
// Injected Content Script (MAIN world) — Page-side API
// Runs directly in the page's JS context via world: 'MAIN'.
// Sets up window.__agentWeb and communicates with the
// ISOLATED-world relay via window.postMessage.
//
// Readability processing happens here (MAIN world) because
// it needs DOMParser which is only available in page context,
// not in the background service worker.
// ============================================================

import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'

// Build-time Codex OAuth feature flag (see wxt.config.ts). Store builds
// (CW_CODEX_OAUTH=0) fold the guards below and treeshake the bridge names.
declare const __CW_CODEX_OAUTH__: boolean;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  world: 'MAIN',

  main() {
    type PendingRequest = {
      resolve: (value: any) => void
      timeoutId: number
      invalidatedTimerId: number | null
    }

    type BridgeRuntimeState = {
      dispose?: () => void
    }

    // If a newer copy of this script was injected, tear down old listeners/state first.
    const existingState = (window as any).__agentWebBridgeState as BridgeRuntimeState | undefined
    if (existingState?.dispose) {
      try {
        existingState.dispose()
      } catch {
        // ignore stale cleanup errors
      }
    }

    let _requestId = 0;
    const INVALIDATED_FALLTHROUGH_WAIT_MS = 200

    // Pending request promises, keyed by id
    const _pending = new Map<string, PendingRequest>();

    // ── Pending stream callbacks, keyed by id ──
    const _streaming = new Map<string, {
      onChunk: (data: unknown) => void
      onDone: () => void
      onError: (errorCode: string, message: string) => void
    }>();

    const clearPending = (id: string): PendingRequest | null => {
      const pending = _pending.get(id)
      if (!pending) return null
      _pending.delete(id)
      clearTimeout(pending.timeoutId)
      if (pending.invalidatedTimerId !== null) {
        clearTimeout(pending.invalidatedTimerId)
      }
      return pending
    }

    const isExtensionContextInvalidatedResponse = (response: any): boolean => {
      if (!response || response.ok !== false) return false
      const code = typeof response.errorCode === 'string' ? response.errorCode : ''
      const message = typeof response.error === 'string' ? response.error : ''
      return (
        code === 'EXTENSION_CONTEXT_INVALIDATED' ||
        message.toLowerCase().includes('extension context invalidated')
      )
    }

    // Listen for responses from the ISOLATED-world relay
    const onBridgeMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__agentWebBridge !== true) return;

      // ── Regular response ──
      if (data.__agentWebResponse === true) {
        const pending = _pending.get(data.id);
        if (pending) {
          if (isExtensionContextInvalidatedResponse(data.response)) {
            // Multiple content-script contexts may race to answer.
            // Give any healthy context a short chance to return a non-invalidated response first.
            if (pending.invalidatedTimerId === null) {
              pending.invalidatedTimerId = window.setTimeout(() => {
                const finalized = clearPending(data.id)
                if (finalized) {
                  finalized.resolve(data.response)
                }
              }, INVALIDATED_FALLTHROUGH_WAIT_MS)
            }
            return
          }

          const finalized = clearPending(data.id)
          if (finalized) {
            finalized.resolve(data.response)
          }
        }
        return;
      }

      // ── Streaming chunk/event ──
      if (data.__agentWebStream === true) {
        const stream = _streaming.get(data.id);
        if (!stream) return;

        if (data.type === 'chunk') {
          stream.onChunk(data.data);
        } else if (data.type === 'done') {
          _streaming.delete(data.id);
          stream.onDone();
        } else if (data.type === 'error') {
          _streaming.delete(data.id);
          stream.onError(data.errorCode || 'STREAM_ERROR', data.message || 'Unknown stream error');
        } else if (data.type === 'disconnected') {
          // Unexpected disconnect — treat as error
          _streaming.delete(data.id);
          stream.onError('EXTENSION_UNAVAILABLE', 'Extension disconnected unexpectedly');
        }
      }
    }

    window.addEventListener('message', onBridgeMessage);

    // ── Schedule trigger listener (background → page) ──
    // When chrome.alarms fires, background sends cw_schedule_run to content.ts,
    // which relays it here via window.postMessage with __agentWebScheduleTrigger.
    // We dispatch a CustomEvent that the CreatorWeave app listens for.
    const onScheduleTrigger = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__agentWebScheduleTrigger !== true) return;
      const scheduleId = data.scheduleId as string;
      if (!scheduleId) return;

      // Dispatch a custom event the CreatorWeave app can listen for
      window.dispatchEvent(new CustomEvent('cw:schedule-trigger', { detail: { scheduleId } }));
    };
    window.addEventListener('message', onScheduleTrigger);

    // Send request to ISOLATED relay → background
    function sendToBridge(type: string, payload: Record<string, any>, timeoutMs?: number): Promise<any> {
      return new Promise((resolve) => {
        const id = '__aw_' + (++_requestId) + '_' + Date.now();
        const timeoutId = window.setTimeout(() => {
          const pending = clearPending(id)
          if (pending) {
            pending.resolve({ ok: false, error: 'Bridge request timeout', errorCode: 'BRIDGE_TIMEOUT' });
          }
        }, timeoutMs || 35000)
        _pending.set(id, { resolve, timeoutId, invalidatedTimerId: null });

        window.postMessage({
          __agentWebBridge: true,
          id,
          type,
          payload,
        }, '*');
      });
    }

    /**
     * Send a streaming request through the bridge.
     * Returns an async iterable of raw SSE text chunks.
     */
    function sendToBridgeStream(type: string, payload: Record<string, any>): AsyncIterable<unknown> & { cancel: () => void } {
      const id = '__aw_' + (++_requestId) + '_' + Date.now();
      let cancelled = false;

      // The async iterable implementation
      const chunkQueue: unknown[] = [];
      let resolveChunk: ((result: IteratorResult<unknown>) => void) | null = null;
      let rejectChunk: ((err: Error) => void) | null = null;
      let streamFinished = false;
      let streamError: Error | null = null;

      // Codex can legitimately spend several minutes thinking. Its bridge
      // uses a 10-minute idle timeout (refreshed by every chunk) plus a
      // 31-minute page-side watchdog, slightly longer than the background's
      // 30-minute hard limit. Other bridge streams retain the existing
      // two-minute safety window, but it is now correctly treated as idle.
      const isCodexStream = type === 'codex_proxy_fetch_stream';
      // Give the background a small grace period to deliver its authoritative
      // 10-minute idle error instead of racing it in the page context.
      const idleTimeoutMs = isCodexStream ? 10 * 60 * 1000 + 5_000 : 2 * 60 * 1000;
      const totalTimeoutMs = isCodexStream ? 31 * 60 * 1000 : null;
      let idleTimeout: ReturnType<typeof setTimeout> | null = null;
      let totalTimeout: ReturnType<typeof setTimeout> | null = null;
      let cancelSent = false;

      function requestStreamCancel() {
        if (!isCodexStream || cancelSent) return;
        cancelSent = true;
        window.postMessage({
          __agentWebBridge: true,
          __agentWebStreamCancel: true,
          id,
        }, '*');
      }

      function clearStreamTimeouts() {
        if (idleTimeout !== null) {
          clearTimeout(idleTimeout);
          idleTimeout = null;
        }
        if (totalTimeout !== null) {
          clearTimeout(totalTimeout);
          totalTimeout = null;
        }
      }

      function armIdleTimeout() {
        if (idleTimeout !== null) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
          if (!streamFinished && !streamError && !cancelled) {
            _streaming.delete(id);
            requestStreamCancel();
            const message = isCodexStream
              ? 'Codex stream received no data for 10 minutes'
              : `Stream received no data for ${Math.round(idleTimeoutMs / 1000)}s`;
            failStream(new Error(message));
          }
        }, idleTimeoutMs);
      }

      function enqueueChunk(data: unknown) {
        if (cancelled) return;
        armIdleTimeout();
        if (resolveChunk) {
          const r = resolveChunk;
          resolveChunk = null;
          r({ value: data, done: false });
        } else {
          chunkQueue.push(data);
        }
      }

      function finishStream() {
        streamFinished = true;
        clearStreamTimeouts();
        if (resolveChunk) {
          const r = resolveChunk;
          resolveChunk = null;
          r({ value: undefined, done: true });
        }
      }

      function failStream(err: Error) {
        streamError = err;
        clearStreamTimeouts();
        if (rejectChunk) {
          const r = rejectChunk;
          rejectChunk = null;
          r(err);
        } else if (resolveChunk) {
          const r = resolveChunk;
          resolveChunk = null;
          r({ value: undefined, done: true });
        }
      }

      _streaming.set(id, {
        onChunk: enqueueChunk,
        onDone: finishStream,
        onError: (errorCode, message) => failStream(new Error(`[${errorCode}] ${message}`)),
      });

      // Send to content.ts relay
      window.postMessage({
        __agentWebBridge: true,
        id,
        type,
        payload,
      }, '*');

      // Start the idle watchdog after dispatch. Active streams keep it alive
      // by rearming it in enqueueChunk(). Codex additionally has a hard page-
      // side ceiling so a lost background port cannot wait forever.
      armIdleTimeout();
      if (totalTimeoutMs !== null) {
        totalTimeout = setTimeout(() => {
          if (!streamFinished && !streamError && !cancelled) {
            _streaming.delete(id);
            requestStreamCancel();
            failStream(new Error('Codex stream exceeded the 31-minute page watchdog'));
          }
        }, totalTimeoutMs);
      }

      const asyncIterator: AsyncIterable<unknown> & { cancel: () => void } = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (streamError) throw streamError;
              if (cancelled || streamFinished) return { value: undefined, done: true };
              if (chunkQueue.length > 0) {
                return { value: chunkQueue.shift()!, done: false };
              }
              // Wait for next chunk
              return new Promise<IteratorResult<unknown>>((resolve, reject) => {
                resolveChunk = resolve;
                rejectChunk = reject;
              });
            },
            return() {
              cancelled = true;
              clearStreamTimeouts();
              _streaming.delete(id);
              requestStreamCancel();
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
        cancel() {
          cancelled = true;
          clearStreamTimeouts();
          _streaming.delete(id);
          requestStreamCancel();
          finishStream();
        },
      };

      return asyncIterator;
    }

    // Shared Turndown instance with sensible defaults for AI consumption
    const _turndown = new TurndownService({
      headingStyle: 'atx',       // # style headings
      codeBlockStyle: 'fenced',  // ```code blocks```
      bulletListMarker: '-',     // - for lists
    })

    /**
     * Convert HTML to clean Markdown.
     * Pipeline: Readability (extract main content) → Turndown (HTML→Markdown).
     * Falls back to Turndown on the full page if Readability fails.
     *
     * `sourceUrl` MUST be the fetched page's own URL (post-redirect), never
     * left undefined: this function runs in the app page's MAIN world, and a
     * DOMParser-created Document inherits the HOST page's base URL. Without
     * pinning the source, Readability's _fixRelativeUris resolves every
     * relative link/img in the fetched HTML against the app origin,
     * producing bogus absolute URLs (e.g. https://<app-origin>/assets/x.png).
     */
    function htmlToMarkdown(body: string, sourceUrl?: string): {
      body: string;
      readability?: {
        title: string;
        excerpt: string;
        byline: string;
        siteName: string;
        length: number;
      };
    } {
      try {
        const doc = new DOMParser().parseFromString(body, 'text/html');
        // Pin the base URL so Readability resolves relative links against the
        // fetched page's own origin. document.baseURI already honors an
        // explicit <base href> if the page declares one — only inject ours
        // when absent. NOTE: doc.documentURI is read-only; an earlier version
        // assigned it here and the assignment silently did nothing.
        if (sourceUrl && !doc.querySelector('base[href]')) {
          try {
            const baseEl = doc.createElement('base');
            baseEl.href = sourceUrl;
            doc.head.prepend(baseEl);
          } catch {
            // Malformed sourceUrl — links stay host-relative rather than fail
          }
        }
        const reader = new Readability(doc);
        const article = reader.parse();

        if (article?.content) {
          const markdown = _turndown.turndown(article.content);
          const titlePrefix = article.title ? `# ${article.title}\n\n` : '';
          return {
            body: titlePrefix + markdown,
            readability: {
              title: article.title || '',
              excerpt: article.excerpt || '',
              byline: article.byline || '',
              siteName: article.siteName || '',
              length: markdown.length,
            },
          };
        }

        // Readability couldn't extract (probably not an article page)
        // Fall back to converting the full page HTML to Markdown
        const markdown = _turndown.turndown(body);
        return { body: markdown };
      } catch {
        // Turndown/Readability failed — last resort: strip tags
        return {
          body: body
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        };
      }
    }

    /**
     * Parse Baidu search results HTML using DOMParser.
     * Runs in MAIN world where DOM APIs are available.
     * Extracts title, url, snippet from each organic result block.
     */
    function parseBaiduHtml(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const results: Array<{ title: string; url: string; snippet: string }> = [];

      // Each organic result is a <div> with a result-title.
      // Baidu result blocks: <div class="result ..."> or <div class="c-container ...">
      // Title is in <h3><a>, snippet is in various child elements.
      const blocks = doc.querySelectorAll('div.result, div.c-container');

      // Known Baidu snippet container selectors (tried first, whitelist)
      const SNIPPET_SELECTORS = [
        '.c-abstract',
        '[class*="content-right_"]',
        '[class*="c-span-later"]',
        '[class*="text_"]',
      ];

      // Noise keywords commonly found inside Baidu result blocks
      const NOISE_TEXTS = ['收藏', '举报', '快照', '分享', '下载', '保障', '百度V', '高清版本', '查看更多', '免责声明'];

      /** Extract a clean snippet from a result block */
      function extractSnippet(block: Element): string {
        // Strategy 1: try known snippet containers
        for (const sel of SNIPPET_SELECTORS) {
          const el = block.querySelector(sel);
          if (el) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length > 10) return text.substring(0, 300);
          }
        }
        // Strategy 2: clone + remove title/icons/noise-text elements
        const clone = block.cloneNode(true) as Element;
        clone.querySelectorAll('h3, img, span.c-icon, .c-icon-bear-circle').forEach((e) => e.remove());
        // Remove elements whose text matches a known noise pattern
        clone.querySelectorAll('a, span, em, div').forEach((el) => {
          const text = (el.textContent || '').trim();
          if (text && text.length < 20 && NOISE_TEXTS.some((n) => text.includes(n))) {
            el.remove();
          }
        });
        return (clone.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 300);
      }

      for (const block of Array.from(blocks)) {
        if (results.length >= limit) break;

        const titleLink = block.querySelector('h3 a');
        if (!titleLink) continue;

        const title = (titleLink.textContent || '').trim();
        const url = titleLink.getAttribute('href') || '';

        if (!title || !url) continue;

        results.push({ title, url, snippet: extractSnippet(block) });
      }

      return results;
    }

    (window as any).__agentWeb = {
      ready: true,

      /**
       * Get the installed extension version.
       */
      async getVersion() {
        return sendToBridge('extension_get_version', {});
      },

      /**
       * Search the web. Provider auto-detected (DuckDuckGo or Baidu) unless
       * explicitly specified via options.provider.
       * For Baidu, raw HTML is fetched in background and parsed here via DOMParser.
       *
       * `provider: "auto"` may fall back after a provider failure or no parsed
       * results. Explicit provider requests are strict and return an error with
       * `suggestedProvider` instead of silently substituting search engines.
       */
      async search(query: string, options?: { count?: number; provider?: string }) {
        const opts = options || {};
        const response = await sendToBridge('web_search', {
          query,
          count: opts.count || 10,
          provider: opts.provider || 'auto',
        });

        // If background returned raw HTML (format: 'html'), parse it here via DOMParser
        if (response.ok && response.html && response.format === 'html') {
          const results = parseBaiduHtml(response.html, response.limit || 10);
          const isAuto = !opts.provider || opts.provider === 'auto';
          const attempts = Array.isArray(response.attempts) ? [...response.attempts] : [];

          if (results.length === 0 && isAuto) {
            attempts.push({ provider: 'baidu', ok: false, reason: '0 results' });
            const duckDuckGoAlreadyTried = attempts.some((attempt: any) => attempt.provider === 'duckduckgo');

            if (!duckDuckGoAlreadyTried) {
              const fallbackResponse = await sendToBridge('web_search', {
                query,
                count: opts.count || 10,
                provider: 'duckduckgo',
              });

              if (fallbackResponse.ok && Array.isArray(fallbackResponse.results) && fallbackResponse.results.length > 0) {
                return {
                  ok: true,
                  results: fallbackResponse.results,
                  provider: 'duckduckgo',
                  requestedProvider: response.requestedProvider || 'baidu',
                  fallback: true,
                };
              }

              attempts.push({
                provider: 'duckduckgo',
                ok: false,
                reason: fallbackResponse.reason || (fallbackResponse.ok ? '0 results' : 'unavailable'),
              });
            }

            return {
              ok: false,
              results: [],
              error: 'All search providers exhausted',
              requestedProvider: response.requestedProvider || 'baidu',
              attempts,
            };
          }

          return {
            ok: true,
            results,
            provider: response.provider,
            ...(response.requestedProvider ? { requestedProvider: response.requestedProvider } : {}),
            ...(typeof response.fallback === 'boolean' ? { fallback: response.fallback } : {}),
          };
        }

        if (response.ok) {
          const { attempts: _attempts, auto: _auto, ...publicResponse } = response;
          return publicResponse;
        }

        return response;
      },

      /**
       * Fetch a URL and return clean Markdown.
       * Pipeline: HTTP fetch → Readability (extract main content) → Turndown (HTML→Markdown).
       * Falls back to full-page Turndown if Readability can't extract.
       *
       * SPA detection: if Readability-extracted content is very short (likely a
       * JS-rendered SPA shell), automatically retries via a hidden browser tab
       * that executes JavaScript and extracts the fully rendered DOM.
       *
       * Set options.render = true to force hidden-tab rendering (skip HTTP fetch).
       */
      async fetch(url: string, options?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string | null;
        render?: boolean;
      }) {
        const opts = options || {};

        // Helper: get raw HTML response (HTTP or render mode)
        async function getRawHtml(useRender: boolean) {
          if (useRender) {
            return await sendToBridge('web_fetch_render', { url });
          }
          return await sendToBridge('web_fetch', {
            url,
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body || null,
            extract: 'raw',
          });
        }

        // Helper: apply Readability + Turndown to a response
        function toMarkdown(response: any) {
          // Prefer the response's final (post-redirect) URL; fall back to the
          // requested URL. Must never be undefined — the host page's URL would
          // otherwise become the base for the fetched page's relative links.
          const result = htmlToMarkdown(response.body, response.finalUrl || url);
          return {
            ...response,
            body: result.body,
            ...(result.readability ? { readability: result.readability } : {}),
          };
        }

        // Helper: decide whether the response body is HTML that benefits from
        // Readability + Turndown extraction. JSON / XML / plain text / images
        // are returned as-is so structured data is never corrupted by HTML
        // parsing (DOMParser('text/html') would strip `<`/`>` inside data values).
        function isHtmlResponse(response: any): boolean {
          const ct = (response.headers?.['content-type'] || response.headers?.['Content-Type'] || '').toLowerCase();
          // Only treat genuine HTML as HTML. Anything else (JSON, XML, text/*,
          // images, octet-stream, etc.) is returned verbatim.
          return ct.includes('text/html') || ct.includes('application/xhtml');
        }

        // ── Force render mode ──
        // Hidden-tab rendering always yields HTML, so it always goes through
        // the Markdown pipeline.
        if (opts.render === true) {
          const response = await getRawHtml(true);
          if (!response.ok) return response;
          return toMarkdown(response);
        }

        // ── Default: fast HTTP fetch first ──
        let response = await getRawHtml(false);

        // HTTP failed entirely → try render as last resort
        if (!response.ok || !response.body) {
          const renderResponse = await getRawHtml(true);
          if (renderResponse.ok && renderResponse.body) {
            return toMarkdown(renderResponse);
          }
          return response;
        }

        // Non-HTML responses (JSON, XML, plain text, images, etc.) are returned
        // verbatim. This preserves structured data — DOMParser('text/html')
        // would otherwise corrupt values containing `<`, `>`, or `&`.
        if (!isHtmlResponse(response)) {
          return response;
        }

        // HTML response: extract main content, then check if it looks like an SPA shell.
        // We measure Readability-extracted text length (not raw HTML bytes)
        // because SPA shells often have large HTML but near-zero readable text.
        const extracted = toMarkdown(response);
        const extractedLength = extracted.body.trim().length;

        if (extractedLength < 200) {
          // Likely a JS-rendered SPA shell — retry with full rendering
          const renderResponse = await getRawHtml(true);
          if (renderResponse.ok && renderResponse.body) {
            const rendered = toMarkdown(renderResponse);
            // Use rendered version only if it has more content
            if (rendered.body.trim().length > extractedLength) {
              return rendered;
            }
          }
        }

        return extracted;
      },

      /**
       * Get Codex OAuth authorization status.
       * Store build (CW_CODEX_OAUTH=0): the guard folds to `return` and the
       * bridge message name is treeshaken out.
       */
      async codexGetStatus() {
        if (!__CW_CODEX_OAUTH__) return { ok: false, errorCode: 'FEATURE_DISABLED' };
        return sendToBridge('codex_get_status', {});
      },

      /**
       * Proxy a Codex API request through the extension.
       * Store build: disabled (see above).
       */
      async codexProxyFetch(body: Record<string, any>) {
        if (!__CW_CODEX_OAUTH__) return { ok: false, errorCode: 'FEATURE_DISABLED' };
        return sendToBridge('codex_proxy_fetch', { body });
      },

      /**
       * Proxy an MCP HTTP request through the extension.
       */
      async mcpProxyFetch(payload: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string | null
        timeoutMs?: number
      }) {
        return sendToBridge('mcp_proxy_fetch', payload || {});
      },

      /**
       * Proxy an MCP HTTP request through the extension with SSE streaming.
       */
      mcpProxyFetchStream(payload: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string | null
        timeoutMs?: number
      }): AsyncIterable<
        | {
            type: 'response_start'
            status?: number
            statusText?: string
            headers?: Record<string, string>
          }
        | {
            type: 'chunk'
            data: string
          }
      > & { cancel: () => void } {
        const source = sendToBridgeStream('mcp_proxy_fetch_stream', payload || {})
        const typed: AsyncIterable<
          | {
              type: 'response_start'
              status?: number
              statusText?: string
              headers?: Record<string, string>
            }
          | {
              type: 'chunk'
              data: string
            }
        > & { cancel: () => void } = {
          [Symbol.asyncIterator]() {
            const it = source[Symbol.asyncIterator]()
            return {
              async next(): Promise<
                IteratorResult<
                  | {
                      type: 'response_start'
                      status?: number
                      statusText?: string
                      headers?: Record<string, string>
                    }
                  | {
                      type: 'chunk'
                      data: string
                    }
                >
              > {
                const value = await it.next()
                if (value.done) return { value: undefined, done: true }
                if (!value.value || typeof value.value !== 'object') {
                  throw new Error('Expected MCP proxy stream frame object for mcpProxyFetchStream')
                }
                return {
                  value: value.value as
                    | {
                        type: 'response_start'
                        status?: number
                        statusText?: string
                        headers?: Record<string, string>
                      }
                    | {
                        type: 'chunk'
                        data: string
                      },
                  done: false,
                }
              },
              return() {
                return it.return ? it.return() : Promise.resolve({ value: undefined, done: true })
              },
            }
          },
          cancel() {
            source.cancel()
          },
        }
        return typed
      },

      /**
       * Discover WebMCP tools across tabs in current browser window.
       */
      async webMCPDiscover(options?: { force?: boolean }) {
        // Only `force` is honored from pages. includeDisabled is a popup-only
        // escape hatch — a page must never see disabled (unauthorized) tools,
        // so it is stripped here regardless of what the caller sends.
        return sendToBridge('webmcp_discover_tools', {
          options: { force: options?.force === true },
        });
      },

      /**
       * Invoke a discovered WebMCP tool.
       */
      async webMCPInvoke(payload: {
        groupKey: string
        fullToolName: string
        args?: Record<string, unknown>
        preferredTabId?: number
      }) {
        return sendToBridge('webmcp_invoke_tool', payload || {});
      },

      /**
       * Get the extension-side WebMCP authorization state.
       * The extension storage is the single source of truth for host/group
       * switches (enforced by the background invoke gate); the web app only
       * renders this state. Management (toggling) lives exclusively in the
       * extension popup — no set methods are exposed to the page.
       */
      async webMCPGetAuthorization() {
        return sendToBridge('webmcp_get_host_authorization', {});
      },

      /**
       * Recipe opt-in probe: does the BOUND upstream tab host a built-in
       * recipe (e.g. jmail.world archive / JMessage) that is not enabled
       * yet? Used by the side panel to decide whether to show the one-time
       * opt-in modal. Returns recipe METADATA only (never tool schemas or
       * page content); `applicable: false` when no recipe matches.
       */
      async recipeCheckStatus(binding: string) {
        return sendToBridge('webmcp_recipe_get_status', { binding });
      },

      /**
       * Recipe opt-in commit: enable the recipe for the bound tab's site
       * (extension-side consent storage — the same map the recipes.html
       * management page writes) and reload the upstream page so injection
       * is guaranteed to take effect. The background re-validates the
       * recipeId against the live tab URL before writing.
       */
      async recipeEnable(binding: string, recipeId: string) {
        return sendToBridge('webmcp_recipe_enable', { binding, recipeId });
      },

      /**
       * Pull page context from the upstream tab that opened this CreatorWeave
       * side panel. Used by workspace-assistant-context.ts at system-prompt
       * build time. The extension executes
       * `window.__sidePanelContextProvider.getContext()` in the upstream tab's
       * MAIN world and returns the result raw (any shape, CreatorWeave does
       * not parse). Returns `null` if the upstream tab did not expose a
       * provider, the tab is unreachable, or the request times out.
       */
      async fetchBoundPageContext(binding: string) {
        return sendToBridge('requestBoundPageContext', { binding })
      },

      /**
       * Pull readable body text from the upstream tab (page-mode slash
       * commands: /summary /titles when nothing is selected). Returns a
       * truncated plain-text string, or null on failure.
       */
      async fetchPageBodyText(binding: string) {
        return sendToBridge('requestPageBodyText', { binding })
      },

      /**
       * Run a page-interaction action in the upstream tab's MAIN world.
       *
       * The extension relays `action` to `window.__cwPageAction.run(action)`
       * inside the target tab (injected by page-action-runner.content.ts).
       *
       * The agent layer is responsible for authorization gating before
       * calling this for write actions (click/fill/type/scroll/evaluate).
       * The bridge itself is a pure transport — it does not enforce policy.
       *
       * `action` shape examples:
       *   { type: 'snapshot' }
       *   { type: 'click', locator: { ... } }
       *   { type: 'fill', locator: { ... }, value: 'hello' }
       *   { type: 'text_content', locator: { ... } }
       *   { type: 'find_elements', locator: { ... } }
       *
       * Returns the raw runner result, always with an `ok` boolean. On
       * failure, includes `errorCode` and `error` string.
       */
      async runBoundPageAction(binding: string, action: Record<string, unknown>) {
        // Page actions (especially fill on ProseMirror/Yjs editors) can take
        // unbounded time. Use 5 min timeout instead of the default 35s.
        return sendToBridge('runBoundPageAction', { binding, action }, 300000)
      },

      /**
       * Capture the visible viewport of the upstream tab as a PNG/JPEG data URL.
       * Uses chrome.tabs.captureVisibleTab — no debugger permission, no yellow bar.
       * Only captures the current viewport; for full-page, scroll + capture again.
       *
       * Returns: { ok, dataUrl, format } or { ok:false, errorCode, error }.
       */
      async captureBoundTab(binding: string, format?: 'png' | 'jpeg', quality?: number) {
        return sendToBridge('captureBoundTab', { binding, format, quality })
      },

      /**
       * Proxy a Codex API request through the extension with SSE streaming.
       * Returns an async iterable of raw SSE text chunks.
       * The caller should parse SSE events from the yielded strings.
       */
      codexProxyFetchStream(body: Record<string, any>): AsyncIterable<string> & { cancel: () => void } {
        if (!__CW_CODEX_OAUTH__) {
          // Store build: disabled — yield nothing, cancel is a no-op.
          const dead: AsyncIterable<string> & { cancel: () => void } = {
            [Symbol.asyncIterator]() { return (async function* () {})(); },
            cancel() {},
          };
          return dead;
        }
        const source = sendToBridgeStream('codex_proxy_fetch_stream', { body })
        const typed: AsyncIterable<string> & { cancel: () => void } = {
          [Symbol.asyncIterator]() {
            const it = source[Symbol.asyncIterator]()
            return {
              async next(): Promise<IteratorResult<string>> {
                const value = await it.next()
                if (value.done) return { value: undefined, done: true }
                if (typeof value.value !== 'string') {
                  throw new Error('Expected string stream chunk for codexProxyFetchStream')
                }
                return { value: value.value, done: false }
              },
              return() {
                return it.return ? it.return() : Promise.resolve({ value: undefined, done: true })
              },
            }
          },
          cancel() {
            source.cancel()
          },
        }
        return typed
      },

      /**
       * Stream plugin download frames from extension background.
       */
      webMCPPluginDownloadStream(payload: {
        transferId: string
        downloadUrl: string
        savePath: string
        fileName: string
      }) {
        const source = sendToBridgeStream('webmcp_plugin_download_stream', { plan: payload })
        const typed: AsyncIterable<Record<string, unknown>> & { cancel: () => void } = {
          [Symbol.asyncIterator]() {
            const it = source[Symbol.asyncIterator]()
            return {
              async next(): Promise<IteratorResult<Record<string, unknown>>> {
                const value = await it.next()
                if (value.done) return { value: undefined, done: true }
                if (!value.value || typeof value.value !== 'object') {
                  throw new Error('Expected object frame for webMCPPluginDownloadStream')
                }
                return { value: value.value as Record<string, unknown>, done: false }
              },
              return() {
                return it.return ? it.return() : Promise.resolve({ value: undefined, done: true })
              },
            }
          },
          cancel() {
            source.cancel()
          },
        }
        return typed
      },

      /**
       * Finalize plugin download after main page persisted the file.
       */
      async webMCPPluginDownloadFinalize(payload: {
        transferId: string
        savedPath: string
      }) {
        return sendToBridge('webmcp_plugin_download_finalize', payload || {})
      },

      // ── Schedule ──────────────────────────────────────────────────────

      /**
       * Register an alarm for a schedule in the extension.
       * The extension will forward the trigger to this page when the alarm fires.
       */
      async scheduleRegisterAlarm(scheduleId: string, nextRunTime: number): Promise<{ ok: boolean; alarmName?: string; error?: string }> {
        return sendToBridge('cw_schedule_register_alarm', { scheduleId, nextRunTime });
      },

      /**
       * Clear a registered alarm for a schedule.
       */
      async scheduleClearAlarm(scheduleId: string): Promise<{ ok: boolean; error?: string }> {
        return sendToBridge('cw_schedule_clear_alarm', { scheduleId });
      },

      /**
       * Show a desktop notification from the extension.
       */
      async scheduleShowNotification(title: string, body: string): Promise<{ ok: boolean }> {
        return sendToBridge('cw_schedule_show_notification', { title, body });
      },

      // ── Native Host ──────────────────────────────────────────────────

      /**
       * Call the CreatorWeave native host (Rust binary) via Chrome Native
       * Messaging. Each call spawns a fresh host process (stateless model).
       *
       * Returns the host's JSON response verbatim.
       */
      async nativeHostCall(payload: Record<string, any>) {
        return sendToBridge('native_host_call', payload, 60000);
      },

      /**
       * Query the execpolicy decision for a command without executing it.
       * Stateless — uses sendNativeMessage under the hood.
       *
       * Returns: { ok, decision: 'auto'|'prompt'|'forbidden', command }
       */
      async nativeHostCheckPolicy(command: string[]): Promise<{
        ok: boolean
        decision?: 'auto' | 'prompt' | 'forbidden'
        command?: string[]
        error?: string
      }> {
        return sendToBridge('native_host_call', {
          action: 'check_policy',
          command,
        });
      },

      // ── Agent Notification ───────────────────────────────────────────

      /**
       * Show an agent-completion desktop notification via the extension's
       * background script.
       *
       * Rationale: When the agent runs inside the Extension's Side Panel,
       * the Web Service Worker's `registration.showNotification` cannot focus
       * the host browser tab on click (Web SWs lack tab privileges). The
       * extension background handles the click with
       * `chrome.notifications.onClicked` to execute
       * `chrome.tabs.update(senderTabId, { active: true })`.
       *
       * The Web App (`agent-notification.ts`) will then check for
       * `window.__agentWeb?.showAgentNotification` and prefer it over the Web SW.
       */
      async showAgentNotification(payload: {
        title: string
        body: string
        conversationId?: string
      }): Promise<{ ok: boolean; error?: string }> {
        return sendToBridge('cw_agent_show_notification', payload || {})
      },
    };

    ;(window as any).__agentWebBridgeState = {
      dispose() {
        window.removeEventListener('message', onBridgeMessage)
        window.removeEventListener('message', onScheduleTrigger)
        for (const [id, pending] of _pending) {
          _pending.delete(id)
          clearTimeout(pending.timeoutId)
          if (pending.invalidatedTimerId !== null) {
            clearTimeout(pending.invalidatedTimerId)
          }
          pending.resolve({
            ok: false,
            errorCode: 'BRIDGE_REPLACED',
            error: 'Bridge instance replaced by a newer injection',
          })
        }
        _streaming.clear()
      },
    }

    console.log('[Browser Extension] ✅ Ready, window.__agentWeb available');
  },
});
