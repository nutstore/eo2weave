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
      // Absolute deadline (epoch ms) for the WHOLE command, computed on the
      // adapter side before the eval is dispatched: the browser's 25s
      // timeout includes the tab-command queue wait, so the in-page fetch
      // must never outlive this instant (finding: an eval that starts late
      // could otherwise arm a full fresh deadline and DELIVER a message
      // after the caller already received TAB_UNAVAILABLE, making a retry
      // of it post a duplicate).
      const commandDeadlineMs = Date.now() + options.timeout
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
            // Clamp to the COMMAND deadline (epoch ms, injected from the
            // adapter as __args.__eo2CommandDeadlineMs): the browser's 25s
            // timeout includes the tab-command queue wait BEFORE the eval
            // runs, so a late-starting eval must not arm a fresh 18s
            // deadline the command cannot cover — otherwise the POST can
            // deliver after the caller already received TAB_UNAVAILABLE,
            // and a retry of that send posts a duplicate. When the command
            // budget is exhausted, the fetch aborts immediately instead of
            // firing into the dark.
            var commandDeadline = null
            try {
              var injected = args && args.__eo2CommandDeadlineMs
              if (typeof injected === 'number' && injected > 0)
                commandDeadline = injected
            } catch (e) {}
            var remainingMs = deadlineMs
            if (commandDeadline !== null) {
              var commandRemainingMs = commandDeadline - startedAt
              if (commandRemainingMs < remainingMs) remainingMs = commandRemainingMs
            }
            var abortTimer =
              abortController !== null
                ? setTimeout(
                    function () {
                      try {
                        abortController.abort()
                      } catch (e) {}
                    },
                    Math.max(1, remainingMs),
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
          // Sticky within ONE workflow evaluation: any storage failure
          // during the send (lookup, reserve, or cleanup) keeps the flag
          // false so the result reports the degraded tab-only scope, even
          // if later reads succeed. The var declaration above re-initializes
          // the flag on every page eval, so degradation never leaks across
          // sends.
          function withoutStorage(tryBlock) {
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
          // Young (unexpired) entry for a retry key, or null: the shared
          // store's 5-minute window matches the map's, so a stale entry is
          // never adopted (and reserveRetryNonceInStorage replaces it).
          function retryNonceEntryAt(retryKey, at) {
            var persisted = readRetryNoncesFromStorage()
            var entry = persisted ? persisted[retryKey] : undefined
            if (
              entry &&
              typeof entry.nonce === 'string' &&
              typeof entry.at === 'number' &&
              at - entry.at < 300000
            )
              return entry
            return null
          }
          // Bounded merge onto the CURRENT stored map: the caller's change
          // callback edits the freshly-read map in place (upsert or delete
          // of its own key only), and the merged result is written back.
          // No writer ever rewrites the map from its own stale snapshot.
          function applyRetryNoncesChange(change) {
            var persisted = readRetryNoncesFromStorage()
            var out = persisted || {}
            change(out)
            writeRetryNoncesToStorage(out)
          }
          // Reserve a freshly minted nonce under the retry key BEFORE the
          // POST (finding: two tabs racing the same automatic-nonce send
          // could each read "no stored nonce", each mint a different nonce,
          // and Discord would see two distinct submissions — no dedup, a
          // duplicate post). The reservation makes the cross-tab sequence
          // atomic WITHOUT async primitives the page runtime lacks: every
          // other tab's lookup path synchronously RE-READS storage right
          // before minting (see the retryKey branch below) and catches the
          // 'storage' event's refresh on the final guard, so the loser of
          // the race re-reads, finds the winner's reservation, and adopts
          // the SAME nonce — Discord sees one shared idempotency key and
          // dedupes. The kept creation timestamp anchors the 5-minute
          // reuse window to the FIRST persist (store-once), and the same
          // 128-key oldest-first cap as the map bounds the shared store.
          function reserveRetryNonceInStorage(retryKey, nonce, at) {
            applyRetryNoncesChange(function (persisted) {
              var existing = persisted[retryKey]
              if (
                existing &&
                typeof existing.at === 'number' &&
                at - existing.at < 300000
              ) {
                // A still-young entry exists (another tab reserved or
                // persisted first): keep it verbatim — its nonce is the
                // one concurrent attempts must adopt.
                persisted[retryKey] = { nonce: existing.nonce, at: existing.at }
              } else {
                persisted[retryKey] = { nonce: nonce, at: at }
              }
              var pkeys = Object.keys(persisted)
              while (pkeys.length >= 128) {
                var pk = pkeys.shift()
                if (pk !== undefined) delete persisted[pk]
              }
            })
          }
          // Merge-on-write delete (finding: writeRetryNoncesToStorage used
          // to rewrite the whole shared map from a per-tab snapshot, so the
          // last concurrent write silently dropped the other tab's nonce
          // and its retry minted a fresh nonce and double-posted): the
          // read-merge-write drops ONLY this key and preserves every other
          // entry the current storage holds.
          function deleteRetryNonceFromStorage(retryKey) {
            applyRetryNoncesChange(function (persisted) {
              delete persisted[retryKey]
            })
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
              // Retry key for the automatic-nonce remember map (per-tab)
              // and the shared localStorage store (cross-tab).
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
                  // shared storage before dedup_scope may report
                  // 'cross-tab' — the lookup below is that verification,
                  // and a storage throw keeps __eo2StorageOk false so the
                  // result reports the degraded tab-only scope.
                  if (nonce === undefined)
                    withoutStorage(function () {
                      var entry = retryNonceEntryAt(retryKey, now)
                      if (entry) nonce = entry.nonce
                    })
                  if (__eo2StorageOk === false) args.__eo2DedupDegraded = true
                } catch (e) {}
              }
              if (nonce === undefined) {
                // Re-check shared storage JUST before minting (finding: two
                // discord.com tabs starting the same automatic-nonce send
                // before either persisted could each mint its own nonce, so
                // Discord saw two distinct submissions and deduped nothing).
                // A nonce another tab reserved in this window is adopted
                // here instead of being raced with a second value.
                withoutStorage(function () {
                  var entry = retryNonceEntryAt(retryKey, Date.now())
                  if (entry && nonce === undefined) nonce = entry.nonce
                })
                if (__eo2StorageOk === false) args.__eo2DedupDegraded = true
              }
              if (nonce === undefined) {
                nonce =
                  String(Date.now()) +
                  '-' +
                  Math.random().toString(36).slice(2, 10)
                // Reserve BEFORE the POST (finding: concurrent cross-tab
                // sends bypassed dedup). From this moment every other
                // discord.com tab's lookup or pre-mint re-check observes
                // this reservation under the same retry key and adopts the
                // SAME nonce, so concurrent attempts for one send submit
                // one shared idempotency key and Discord dedupes instead
                // of posting twice. Failure keeps the nonce tab-local and
                // the result reports the degraded scope.
                if (retryKey !== null)
                  try {
                    withoutStorage(function () {
                      reserveRetryNonceInStorage(retryKey, nonce, Date.now())
                    })
                  } catch (e) {}
                if (__eo2StorageOk === false) args.__eo2DedupDegraded = true
              }
              // Final adoption guard: whatever shared storage holds for
              // this retry key RIGHT BEFORE the fetch wins. A racing tab
              // that reserved between this tab's re-check and its own
              // reserve is adopted here, so both tabs POST the SAME nonce
              // and Discord's enforce_nonce dedupes. This is also the
              // verification step for a remembered (map) nonce: a stale or
              // foreign reservation replaces it before the send.
              if (retryKey !== null && nonce !== undefined)
                try {
                  withoutStorage(function () {
                    var entry = retryNonceEntryAt(retryKey, Date.now())
                    if (entry && entry.nonce !== nonce) nonce = entry.nonce
                  })
                } catch (e) {}
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
                    store.set(retryKey, { nonce: nonce, at: now2 })
                  }
                  // Bounded: keep the map at 128 keys, evicting the oldest.
                  while (store.size > 128) {
                    var oldest = store.keys().next().value
                    store.delete(oldest)
                  }
                } catch (e) {}
              // Mirror-after-recovery (finding: recovered storage left the
              // nonce tab-local): a nonce remembered only in the per-tab map
              // because its first reserve hit a storage failure must not
              // keep reporting cross-tab dedup while shared storage has no
              // live entry — a retry routed to ANOTHER tab could not see it
              // and would double-post. Once storage works again, reserve the
              // map's nonce under the SAME retry key so every tab adopts it;
              // reserveRetryNonceInStorage keeps a still-young foreign entry
              // verbatim, and the final adoption guard above reconciles the
              // map value with it before the send.
              if (retryKey !== null && __eo2StorageOk !== false)
                withoutStorage(function () {
                  if (retryNonceEntryAt(retryKey, now2) === null)
                    reserveRetryNonceInStorage(retryKey, nonce, now2)
                })
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
                  // never posted). The delete is a merge-on-write: it drops
                  // ONLY this key from the CURRENT stored map, so it cannot
                  // erase a nonce another tab persisted concurrently for a
                  // different unconfirmed send. A FAILED delete must not be
                  // swallowed silently (finding: the delivered nonce stayed
                  // in shared storage with dedup still reported as
                  // 'cross-tab', so a later identical send was suppressed):
                  // the sticky degraded flag marks the result so the caller
                  // knows cross-tab dedup is unreliable, and cannot be
                  // cleared by the successful map delete below.
                  withoutStorage(function () {
                    deleteRetryNonceFromStorage(retryKey)
                  })
                  if (__eo2StorageOk === false) args.__eo2DedupDegraded = true
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
        // The command deadline rides into the page via __args so the
        // in-page abort timer can clamp its remaining budget to it (the
        // browser's 25s timeout includes the tab-command queue wait).
        const inputWithDeadline = {
          ...input,
          __eo2CommandDeadlineMs: commandDeadlineMs,
        }
        response = await browser.eval(
          '() => { var __args = ' +
            JSON.stringify(inputWithDeadline) +
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
