// Self-contained adapter workflow. Token extraction and API fetches stay inside the discord.com tab.

export default {
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', minLength: 1 },
      content: { type: 'string', minLength: 1, maxLength: 2000 },
      reply_to: { type: 'string', minLength: 1 },
      nonce: {
        type: 'string',
        minLength: 1,
        maxLength: 25,
        description:
          'Client idempotency key (max 25 chars, Discord limit). Reuse the same value when retrying a timed-out send so Discord can dedupe it',
      },
    },
    required: ['channel', 'content'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
      },
      data: {
        type: ['object', 'null'],
      },
      message: {
        type: ['string', 'null'],
      },
      error_code: {
        type: ['string', 'null'],
      },
    },
    required: ['status', 'data'],
    additionalProperties: false,
  },
  tree: {
    type: 'action',
    description: 'send_message',
    async run({ input, state, target }) {
      const options = { tab: target.tabId, timeout: 25000 }
      const execute = async (args) => {
        var workflow = (() => {

          // Page-side Discord runtime (translated from OpenTabs discord-api.ts, MIT).
          // Runs INSIDE the discord.com tab: token never leaves page context.
          var AUTH_ERRORS = [0, 40001, 40002, 50014]
          var NOT_FOUND_ERRORS = [10003, 10004, 10006, 10008, 10013, 10011, 10014, 10015]
          var FORBIDDEN_ERRORS = [50001, 50013]
          var VALIDATION_ERRORS = [50003, 50006, 50007, 50008, 50035, 50109]
          function classify(code, message) {
            if (VALIDATION_ERRORS.indexOf(code) !== -1) return 'VALIDATION'
            if (NOT_FOUND_ERRORS.indexOf(code) !== -1) return 'NOT_FOUND'
            if (FORBIDDEN_ERRORS.indexOf(code) !== -1) return 'FORBIDDEN'
            if (AUTH_ERRORS.indexOf(code) !== -1) return 'AUTH'
            return 'API'
          }
          function getTokenFromWebpack() {
            try {
              var chunks = globalThis.webpackChunkdiscord_app
              if (!chunks || typeof chunks.push !== 'function') return null
              var token = null
              var self = getTokenFromWebpack
              self.done = false
              var entry = [
                [Math.random().toString(36).slice(2)],
                {},
                function (require) {
                  // Mark the probe as having actually run so a caller can
                  // tell a completed walk that found nothing from one whose
                  // callback never ran (webpack mid-update).
                  self.done = true
                  var modules
                  try {
                    modules = Object.values(require.c || {})
                  } catch (e) {
                    return
                  }
                  for (var i = 0; i < modules.length; i++) {
                    try {
                      var exports = modules[i] && modules[i].exports
                      if (!exports) continue
                      var def = exports.default || exports
                      if (typeof (def && def.getToken) !== 'function') continue
                      var result = def.getToken()
                      if (typeof result === 'string' && result.length > 0) {
                        token = result
                        break
                      }
                    } catch (e) {
                      continue
                    }
                  }
                },
              ]
              chunks.push(entry)
              // Drop the probe chunk right away: webpack retains pushed
              // entries for the tab lifetime, and each entry's callback
              // would otherwise keep a token string alive. Splicing our own
              // entry out does not touch webpack's real chunk bookkeeping.
              try {
                var idx = chunks.indexOf(entry)
                if (idx !== -1) chunks.splice(idx, 1)
              } catch (e) {}
              return token
            } catch (e) {
              return null
            }
          }
          function getTokenCached() {
            // Re-read the live webpack token on every call and refresh the
            // cache with it: a user switching accounts in a still-loaded
            // tab must never let requests run as the previous account.
            // The cache is only a fallback for windows where the walk itself
            // fails (webpack not yet loaded, page mid-navigation). A walk
            // that RAN but found no token means the page really has no
            // credential (logged out, account switched), so the cached
            // token from a previous account must NOT be used. A token that
            // Discord rejected with 401 is also suppressed until the page
            // exposes a fresh credential. Because a cached token cannot be
            // attributed to the current account when the probe is
            // unavailable or incomplete, the fallback below is REMOVED:
            // without a confirmed live token the caller sees
            // UNAUTHENTICATED instead of risking the previous account's
            // credential.
            var rejectedSet = null
            try {
              rejectedSet = globalThis.__eo2DiscordRejectedTokens
            } catch (e) {}
            var ran = false
            var completed = true
            var token = null
            try {
              var chunks = globalThis.webpackChunkdiscord_app
              if (chunks && typeof chunks.push === 'function') {
                ran = true
                token = getTokenFromWebpack()
                completed = getTokenFromWebpack.done !== false
              }
            } catch (e) {}
            if (ran && token) {
              // The page exposes a live credential. If the exact string was
              // already rejected with 401, keep it suppressed; a DIFFERENT
              // token means a fresh session (re-login, account switch).
              if (
                rejectedSet &&
                typeof rejectedSet.has === 'function' &&
                rejectedSet.has(token)
              )
                return null
              try {
                if (rejectedSet && typeof rejectedSet.delete === 'function')
                  rejectedSet.delete(token)
                globalThis.__eo2DiscordToken = token
              } catch (e) {}
              return token
            }
            // The walk RAN and COMPLETED but found no token: the page
            // really has no credential (logged out), so drop the cached
            // token and record the logged-out state — otherwise a later
            // call whose probe fails to run would fall back to the
            // previous account's cached token.
            if (ran && completed) {
              try {
                delete globalThis.__eo2DiscordToken
                globalThis.__eo2DiscordLoggedOut = true
              } catch (e) {}
              return null
            }
            // The walk itself failed or never completed (webpack not
            // loaded, or the chunk global was swapped mid-update and the
            // probe callback did not run): the cached token can no longer
            // be confirmed to belong to the CURRENT account — an account
            // switch exactly when the probe is unavailable would silently
            // reuse the previous account's credential. Fail closed with
            // UNAUTHENTICATED until a fresh token can be read.
            return null
          }
          async function discordApi(endpoint, options) {
            options = options || {}
            var token = getTokenCached()
            if (!token)
              return {
                ok: false,
                error_code: 'UNAUTHENTICATED',
                message:
                  'No Discord token found in this tab. Open and log in to discord.com, then wait for the app to finish loading.',
              }
            var url = 'https://discord.com/api/v9' + endpoint
            if (options.query) {
              var params = new URLSearchParams()
              var keys = Object.keys(options.query)
              for (var i = 0; i < keys.length; i++) {
                var value = options.query[keys[i]]
                if (value !== undefined && value !== null)
                  params.append(keys[i], String(value))
              }
              var qs = params.toString()
              if (qs) url += '?' + qs
            }
            var headers = { Authorization: token }
            var body
            if (options.body !== undefined) {
              headers['Content-Type'] = 'application/json'
              body = JSON.stringify(options.body)
            }
            // Abort the in-page fetch before the 25s browser command
            // deadline can orphan it, so a timed-out call does not leave
            // the request running (and retries piling up) against quota.
            var abortController = null
            if (typeof AbortController === 'function')
              try {
                abortController = new AbortController()
              } catch (e) {}
            // One absolute deadline from the START of the request (not
            // restarted when headers arrive): headers + a stalled body must
            // never outlive the 25s browser-eval timeout. The timer is
            // cleared exactly once, when the response is fully consumed.
            var deadlineMs = 18000
            var startedAt = Date.now()
            var abortTimer =
              abortController !== null
                ? setTimeout(
                    function () {
                      try {
                        abortController.abort()
                      } catch (e) {}
                    },
                    Math.max(1, deadlineMs - (Date.now() - startedAt)),
                  )
                : null
            var response
            try {
              response = await fetch(url, {
                method: options.method || 'GET',
                headers: headers,
                body: body,
                credentials: 'include',
                signal: abortController ? abortController.signal : undefined,
              })
            } catch (e) {
              if (abortTimer !== null) clearTimeout(abortTimer)
              var aborted =
                e && (e.name === 'AbortError' || String(e).indexOf('abort') !== -1)
              return {
                ok: false,
                error_code: 'NETWORK',
                message: aborted
                  ? 'Discord API request aborted after the 20s in-page deadline.'
                  : 'Network error calling Discord API: ' + String(e),
              }
            }
            // The abort timer stays armed across body consumption: the
            // absolute deadline above already covers headers + body, so it
            // must NOT be restarted here (that would let a slow-headers
            // request outlive the browser-eval timeout).
            if (!response.ok) {
              var text = ''
              try {
                text = await response.text()
              } catch (e) {}
              if (abortTimer !== null) clearTimeout(abortTimer)
              var code, message
              try {
                var parsed = JSON.parse(text)
                code = parsed.code
                message = parsed.message
              } catch (e) {}
              if (response.status === 429) {
                // Rate limiting does not reject the credential: keep the
                // cache so a later failed walk does not read as a logout.
                return {
                  ok: false,
                  error_code: 'RATE_LIMITED',
                  status: 429,
                  message: 'Discord API rate limited: ' + text.slice(0, 512),
                }
              }
              if (code !== undefined) {
                // A coded 403 (e.g. 50013 Missing Permissions) is a
                // permission denial, not a login failure: classify it and
                // keep the cached token. Every HTTP 401 is an auth failure
                // in the caller-visible contract regardless of the Discord
                // code (an unknown code such as 50012 must not degrade to a
                // generic API error), so override the classification and
                // clear the cache; the code stays in the message and in
                // discord_code as diagnostic detail.
                var classified = classify(code, message)
                if (response.status === 401) classified = 'AUTH'
                if (classified === 'AUTH') {
                  // Evict only if the cache still holds THIS rejected
                  // token: a newer credential cached by a concurrent call
                  // (account switch) must survive this stale 401.
                  try {
                    if (globalThis.__eo2DiscordToken === token)
                      delete globalThis.__eo2DiscordToken
                  } catch (e) {}
                  // A 401 means Discord rejected this credential: suppress
                  // it even if the webpack module still exposes it, until
                  // a fresh (different) token appears. Rejections are
                  // tracked per token VALUE in an insert-only set, so two
                  // overlapping 401s for different tokens each suppress
                  // their own credential and neither can erase the other's
                  // rejection (a stale in-flight 401 can neither
                  // re-enable a newer rejected token nor block a fresh
                  // rejection from being recorded). The set is never
                  // truncated: a truncated entry would let webpack
                  // re-expose an old credential Discord already refused,
                  // so every 401'd token stays recognizable for the
                  // tab's lifetime (tokens are short strings and a tab
                  // sees only a handful of credentials).
                  try {
                    var set =
                      (globalThis.__eo2DiscordRejectedTokens =
                        globalThis.__eo2DiscordRejectedTokens || new Set())
                    set.delete(token)
                    set.add(token)
                  } catch (e) {}
                }
                return {
                  ok: false,
                  error_code: classified,
                  status: response.status,
                  discord_code: code,
                  message:
                    'Discord API error: ' +
                    (message || text.slice(0, 512)) +
                    ' (code ' +
                    code +
                    ')',
                }
              }
              if (response.status === 401 || response.status === 403) {
                // Uncoded bodies: 401 keeps its AUTH classification here,
                // while an uncoded 403 falls through to the generic HTTP
                // branch below (only coded 403s are permission denials).
                try {
                  if (globalThis.__eo2DiscordToken === token)
                    delete globalThis.__eo2DiscordToken
                } catch (e) {}
                if (response.status === 401)
                  try {
                    // Same per-token set as the coded branch: overlapping
                    // 401s for different tokens are tracked independently,
                    // so neither can erase the other's rejection. No
                    // truncation here either: webpack may re-expose any
                    // token it ever exposed, and every rejected value
                    // must stay recognizable.
                    var set =
                      (globalThis.__eo2DiscordRejectedTokens =
                        globalThis.__eo2DiscordRejectedTokens || new Set())
                    set.delete(token)
                    set.add(token)
                  } catch (e) {}
                return {
                  ok: false,
                  error_code: 'AUTH',
                  status: response.status,
                  message: 'Discord API auth error (' + response.status + '): ' + text.slice(0, 512),
                }
              }
              return {
                ok: false,
                error_code: 'HTTP',
                status: response.status,
                message:
                  'Discord API error (' + response.status + '): ' + text.slice(0, 512),
              }
            }
            if (response.status === 204) {
              if (abortTimer !== null) clearTimeout(abortTimer)
              return { ok: true, data: {} }
            }
            try {
              var data = await response.json()
              if (abortTimer !== null) clearTimeout(abortTimer)
              return { ok: true, data: data }
            } catch (e) {
              if (abortTimer !== null) clearTimeout(abortTimer)
              var aborted =
                e && (e.name === 'AbortError' || String(e).indexOf('abort') !== -1)
              if (aborted)
                return {
                  ok: false,
                  error_code: 'NETWORK',
                  message: 'Discord API response aborted after the 20s in-page deadline.',
                }
              return {
                ok: false,
                error_code: 'HTTP',
                message: 'Discord API returned invalid JSON',
              }
            }
          }
          function mapUser(u) {
            u = u || {}
            return {
              id: u.id || '',
              username: u.username || '',
              global_name: u.global_name === undefined ? null : u.global_name,
              avatar: u.avatar === undefined ? null : u.avatar,
              bot: !!u.bot,
            }
          }
          function mapAttachment(a) {
            a = a || {}
            return {
              id: a.id || '',
              filename: a.filename || '',
              content_type:
                a.content_type === undefined ? null : a.content_type,
              size: typeof a.size === 'number' ? a.size : 0,
              url: a.url || '',
              proxy_url: a.proxy_url || '',
              width: typeof a.width === 'number' ? a.width : null,
              height: typeof a.height === 'number' ? a.height : null,
            }
          }
          function mapMessage(m) {
            m = m || {}
            return {
              id: m.id || '',
              channel_id: m.channel_id || '',
              author: mapUser(m.author),
              content: m.content || '',
              timestamp: m.timestamp || '',
              edited_timestamp:
                m.edited_timestamp === undefined ? null : m.edited_timestamp,
              pinned: !!m.pinned,
              attachments: Array.isArray(m.attachments)
                ? m.attachments.map(mapAttachment)
                : [],
            }
          }
          function mapChannel(c) {
            c = c || {}
            return {
              id: c.id || '',
              type: typeof c.type === 'number' ? c.type : 0,
              guild_id: c.guild_id || '',
              name: c.name || '',
              topic: c.topic === undefined ? null : c.topic,
              position: typeof c.position === 'number' ? c.position : 0,
              parent_id: c.parent_id === undefined ? null : c.parent_id,
              nsfw: !!c.nsfw,
            }
          }
          function mapGuild(g) {
            g = g || {}
            return {
              id: g.id || '',
              name: g.name || '',
              icon: g.icon === undefined ? null : g.icon,
              owner: !!g.owner,
              description: g.description === undefined ? null : g.description,
              approximate_member_count:
                typeof g.approximate_member_count === 'number'
                  ? g.approximate_member_count
                  : typeof g.member_count === 'number'
                    ? g.member_count
                    : 0,
            }
          }

          function ok(data) {
            return {
              status: 'ok',
              data,
              message: null,
              page_url: location.href,
            }
          }
          function error(code, message) {
            return {
              status: 'error',
              data: null,
              error_code: code,
              message,
              page_url: location.href,
            }
          }
          // Cross-tab retry store. The in-tab nonce map
          // (globalThis.__eo2DiscordRetryNonces) lives in ONE page's
          // globalThis, so a retry routed to a DIFFERENT discord.com tab
          // could not find the original nonce and would double-post.
          // localStorage on the discord.com origin is shared by every tab of
          // the same browser profile, so it is the cross-tab source of truth;
          // the per-tab map stays as a fallback for contexts where
          // localStorage is unavailable or throws (sandboxed frames,
          // storage-disabled modes). Same 5-minute window, store-once and
          // delete-on-delivery semantics as the map.
          // Called with storage access suspended: if it throws, cross-tab
          // dedup degrades to the per-tab map (documented in the result).
          // Declared with var (not implicit): QuickJS rejects assignment
          // to an undeclared identifier.
          var __eo2StorageOk = true
          function withoutStorage(tryBlock) {
            __eo2StorageOk = true
            try {
              tryBlock()
            } catch (e) {
              __eo2StorageOk = false
            }
          }
          var RETRY_NONCES_STORAGE_KEY = '__eo2DiscordRetryNonces'
          function readRetryNoncesFromStorage() {
            var raw = localStorage.getItem(RETRY_NONCES_STORAGE_KEY)
            if (typeof raw !== 'string' || raw === '') return null
            var parsed = JSON.parse(raw)
            var out = {}
            for (var k in parsed) {
              if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue
              var v = parsed[k]
              if (v && typeof v.nonce === 'string' && typeof v.at === 'number')
                out[k] = { nonce: v.nonce, at: v.at }
            }
            return out
          }
          function writeRetryNoncesToStorage(entries) {
            localStorage.setItem(RETRY_NONCES_STORAGE_KEY, JSON.stringify(entries))
          }
          function deleteRetryNonceFromStorage(retryKey) {
            var entries = readRetryNoncesFromStorage()
            if (!entries || !entries[retryKey]) return
            delete entries[retryKey]
            writeRetryNoncesToStorage(entries)
          }
          var discordToolImplementations = {
            async send_message(args) {
              if (location.hostname !== 'discord.com')
                return error(
                  'UNSUPPORTED_PAGE',
                  'Not on a discord.com page.',
                )
              // nonce lets Discord dedupe a retried POST after a lost
              // response, and enforce_nonce makes Discord itself reject a
              // duplicate. Callers retrying after a timeout should pass the
              // SAME nonce again for exact retry control; when the caller
              // omitted one, the auto-generated value is remembered per
              // (channel, reply, content) key in a bounded map, so retries
              // of DIFFERENT sends do not evict each other the way a single
              // last-send slot would. The remember window is 5 minutes,
              // matched to Discord's enforce_nonce guarantee ("uniqueness
              // is checked over the past few minutes"): within it a retry
              // IS deduped by Discord; a retry AFTER it re-sends the same
              // nonce but Discord no longer enforces uniqueness, so it can
              // post a duplicate — automatic reuse is deliberately bounded
              // to the window Discord actually guarantees. The timestamp is
              // set once at nonce creation and NOT refreshed on retry
              // attempts, so the window cannot be extended by retries.
              // The remembered entry is DELETED once the send is confirmed
              // delivered (HTTP 2xx): a nonce only exists to dedupe a retry
              // of an UNACKNOWLEDGED send, so a confirmed delivery frees the
              // key and a second, intentional identical send mints a fresh
              // nonce and posts normally. The map therefore only ever holds
              // keys whose delivery outcome is still unknown.
              // The map holds at most 128 keys (oldest evicted first); a
              // key can only reach eviction while its send is still
              // unconfirmed, and Discord only enforces uniqueness for a few
              // minutes, so a retry after eviction falls back to the
              // caller-supplied nonce contract for exact control.
              // A different message always gets a fresh nonce, so two sends
              // in the same millisecond never collide. The generated value
              // is echoed back in data.nonce for reuse.
              var nonce = args.nonce
              var retryKey = null
              if (nonce === undefined) {
                retryKey =
                  args.channel +
                  '|' +
                  (args.reply_to === undefined ? '' : args.reply_to) +
                  '|' +
                  args.content
                try {
                  var retries =
                    (globalThis.__eo2DiscordRetryNonces =
                      globalThis.__eo2DiscordRetryNonces || new Map())
                  // Lazily drop expired entries instead of timing each one.
                  // 5 minutes = the dedup window Discord's enforce_nonce
                  // guarantees ("uniqueness ... over the past few
                  // minutes"); automatic nonce reuse never outlives it.
                  var now = Date.now()
                  retries.forEach(function (value, k) {
                    if (now - value.at >= 300000) retries.delete(k)
                  })
                  var remembered = retries.get(retryKey)
                  if (
                    remembered &&
                    typeof remembered.nonce === 'string' &&
                    now - remembered.at < 300000
                  )
                    nonce = remembered.nonce
                  // Cross-tab lookup: another discord.com tab may hold the
                  // original nonce (same origin → shared localStorage).
                  // The map is only a fallback, so a remembered entry wins
                  // and a storage entry is adopted when the map has none.
                  // A map hit alone is NOT proof of cross-tab dedup: the
                  // map is per-tab, so its entry must still be VERIFIED in
                  // (or mirrored into) shared storage before dedup_scope
                  // may report 'cross-tab'. Run the same storage probe for
                  // both paths; only a storage read/write that succeeds
                  // keeps __eo2StorageOk true, and a map entry absent from
                  // storage is mirrored there so another tab can adopt it.
                  withoutStorage(function () {
                    var stored = readRetryNoncesFromStorage()
                    if (stored) {
                      for (var sk in stored) {
                        if (!Object.prototype.hasOwnProperty.call(stored, sk)) continue
                        var sv = stored[sk]
                        if (now - sv.at < 300000) {
                          if (sk === retryKey) {
                            if (nonce === undefined) nonce = sv.nonce
                          } else {
                            // Refresh the in-tab map from storage so its
                            // lazy expiry and eviction see the shared state.
                            retries.set(sk, { nonce: sv.nonce, at: sv.at })
                          }
                        }
                      }
                    }
                    // Map-hit path: verify against / mirror into storage so
                    // the reported dedup scope matches what another tab can
                    // actually see.
                    if (
                      nonce !== undefined &&
                      (!stored || !stored[retryKey] || now - stored[retryKey].at >= 300000)
                    ) {
                      var p = stored || {}
                      var pkeys = Object.keys(p)
                      while (pkeys.length >= 128) {
                        var pk = pkeys.shift()
                        if (pk !== undefined) delete p[pk]
                      }
                      var mapEntry = retries.get(retryKey)
                      p[retryKey] = {
                        nonce: nonce,
                        at: mapEntry && typeof mapEntry.at === 'number' ? mapEntry.at : now,
                      }
                      writeRetryNoncesToStorage(p)
                    }
                  })
                  // Echo the flag into the in-page args so the adapter
                  // (which sees only args) can surface it on every result
                  // path, including unconfirmed-send errors where the
                  // caller must retry.
                  if (__eo2StorageOk === false) args.__eo2DedupDegraded = true
                } catch (e) {}
              }
              if (nonce === undefined)
                nonce =
                  String(Date.now()) +
                  '-' +
                  Math.random().toString(36).slice(2, 10)
              // Creation timestamp for the store-once contract: captured ONCE
              // here, never re-read on retry attempts, so the 5-minute reuse
              // window cannot be extended by retries.
              var now2 = Date.now()
              if (retryKey !== null)
                try {
                  var store =
                    (globalThis.__eo2DiscordRetryNonces =
                      globalThis.__eo2DiscordRetryNonces || new Map())
                  var existing = store.get(retryKey)
                  // Store-once: the timestamp marks when the nonce was
                  // CREATED, never refreshed on retry attempts, so the
                  // 5-minute reuse window cannot be extended by retries.
                  if (!existing) {
                    store.delete(retryKey)
                    store.set(retryKey, { nonce: nonce, at: Date.now() })
                    // Mirror the fresh nonce into localStorage so a retry
                    // that lands on ANOTHER discord.com tab finds it (the
                    // per-tab map is invisible across tabs). Store-once:
                    // only write when no entry exists yet — or when the
                    // stored entry has EXPIRED (it would never be adopted,
                    // so it must not block the fresh entry) — keeping the
                    // original creation timestamp — and the 5-minute
                    // window — anchored to the FIRST send, not the retry.
                    // A storage failure here leaves the nonce tab-local;
                    // __eo2StorageOk is false and the result says so.
                    withoutStorage(function () {
                      var persisted = readRetryNoncesFromStorage()
                      var persistedEntry = persisted ? persisted[retryKey] : undefined
                      var persistedExpired =
                        persistedEntry && now2 - persistedEntry.at >= 300000
                      if (!persistedEntry || persistedExpired) {
                        persisted = persisted || {}
                        // Keep the shared store bounded too (same 128-key
                        // cap as the map, oldest entries dropped first) so a
                        // backlog of unconfirmed sends cannot grow it
                        // unboundedly across tabs.
                        var pkeys = Object.keys(persisted)
                        while (pkeys.length >= 128) {
                          var pk = pkeys.shift()
                          if (pk !== undefined) delete persisted[pk]
                        }
                        persisted[retryKey] = { nonce: nonce, at: now2 }
                        writeRetryNoncesToStorage(persisted)
                      }
                    })
                  }
                  // Bounded: keep the map at 128 keys, evicting the oldest.
                  while (store.size > 128) {
                    var oldest = store.keys().next().value
                    store.delete(oldest)
                  }
                } catch (e) {}
              // A storage failure at persist time left the nonce tab-local,
              // so cross-tab dedup is degraded; it is surfaced via
              // data.dedup_scope. Everything here is best-effort too:
              // delivery still stands even if the cleanup throws.
              var dedupScope = __eo2StorageOk === false ? 'tab' : 'cross-tab'
              if (__eo2StorageOk === false) args.__eo2DedupDegraded = true
              var body = {
                content: args.content,
                nonce: nonce,
                enforce_nonce: true,
              }
              if (args.reply_to !== undefined)
                body.message_reference = { message_id: args.reply_to }
              var response = await discordApi(
                '/channels/' + encodeURIComponent(args.channel) + '/messages',
                { method: 'POST', body: body },
              )
              if (!response.ok) return response
              // Delivered: the nonce has done its job — drop the remember
              // entry so a later intentional identical send is NOT deduped
              // by Discord against this nonce (only retries of sends whose
              // outcome is unknown need the remembered value).
              if (retryKey !== null)
                try {
                  var delivered =
                    (globalThis.__eo2DiscordRetryNonces =
                      globalThis.__eo2DiscordRetryNonces || new Map())
                  delivered.delete(retryKey)
                  // Also drop the cross-tab copy: a retry landing on a
                  // DIFFERENT tab must not reuse a nonce whose send already
                  // succeeded (it would be silently deduped by Discord and
                  // never posted).
                  deleteRetryNonceFromStorage(retryKey)
                } catch (e) {}
              return ok({
                message: mapMessage(response.data),
                nonce: nonce,
                dedup_scope: dedupScope,
              })
            },
          }

          async function stdin_default(args) {
            return discordToolImplementations['send_message'](args)
          }
          return stdin_default
        })()

        return workflow(args)
      }
      let response
      try {
        response = await browser.eval(
          '() => { var __args = ' +
            JSON.stringify(input) +
            '; var __out = (' + execute.toString() + ')(__args); ' +
            'return Promise.resolve(__out).then(function (o) { ' +
            'if (__args.__eo2DedupDegraded === true) o.degradedDedup = true; return o; }) }',
          options,
        )
      } catch (error) {
        // Tab closed/navigated or the eval timed out: surface a stable
        // workflow error instead of letting the adapter rejection escape.
        state.result = {
          status: 'error',
          data: null,
          message:
            'The discord.com tab could not run the tool (it may have closed or navigated away): ' +
            String(error),
          error_code: 'TAB_UNAVAILABLE',
        }
        return 'success'
      }
      if (response.tabId !== target.tabId) {
        state.result = {
          status: 'error',
          data: null,
          message: 'Browser returned another tab',
          error_code: 'TAB_UNAVAILABLE',
        }
        return 'success'
      }
      const result = response.result
      if (result && result.status === 'ok')
        state.result = { status: 'ok', data: result.data, message: null }
      else if (result)
        state.result = {
          status: 'error',
          data: null,
          message: result.message || 'Discord API call failed',
          error_code: result.error_code || 'UNKNOWN',
        }
      else
        state.result = {
          status: 'error',
          data: null,
          message: 'The discord.com tab returned no result',
          error_code: 'EMPTY_RESULT',
        }
      // Storage was unavailable in the page: cross-tab dedup degraded to
      // this tab's map. The in-page code echoes the flag back through the
      // eval source so the adapter can annotate every result path — a
      // caller retrying an unconfirmed send must know another tab cannot
      // see the remembered nonce.
      if (result && result.degradedDedup === true && state.result.message !== null) {
        state.result.message +=
          ' (cross-tab retry dedup is degraded: page storage was unavailable, so only this tab remembers the nonce)'
      }
      return 'success'
    },
  },
  result({ state }) {
    return state.result
  },
}
