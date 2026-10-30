// Self-contained adapter workflow. Token extraction and API fetches stay inside the discord.com tab.

export default {
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', minLength: 1 },
      message_id: { type: 'string', minLength: 1 },
      emoji: {
        type: 'string',
        minLength: 1,
        description: 'Unicode emoji or custom emoji in name:id form',
      },
    },
    required: ['channel', 'message_id', 'emoji'],
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
    description: 'remove_reaction',
    async run({ input, state, target }) {
      const options = { tab: target.tabId, timeout: 25000 }
      // Absolute deadline (epoch ms) for the WHOLE command, computed on the
      // adapter side before the eval is dispatched: the browser's 25s
      // timeout includes the tab-command queue wait, so the in-page fetch
      // must never outlive this instant (finding: an eval that starts late
      // could otherwise arm a full fresh deadline and apply a reaction
      // after the caller already received TAB_UNAVAILABLE).
      const commandDeadlineMs = Date.now() + options.timeout
      const execute = async (args, commandDeadlineMs) => {
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
            // One absolute deadline per REQUEST measured from the moment
            // the call was QUEUED (not restarted when headers arrive and
            // not reset when a queued entry finally starts running):
            // headers + a stalled body must never outlive the 25s
            // browser-eval timeout. withReactionLock passes its queue
            // timestamp through discordApi's options.queued_at, and the
            // fetch only gets the REMAINING budget from that timestamp —
            // a queued call that starts late cannot get a fresh deadline
            // that outlives the eval. The budget is additionally clamped
            // to the COMMAND deadline (epoch ms, injected from the
            // adapter as __args.__eo2CommandDeadlineMs): the browser's
            // 25s timeout includes the tab-command queue wait BEFORE the
            // eval runs, so a late-starting eval must not arm a fresh
            // 18s deadline the command cannot cover — otherwise the
            // caller gets TAB_UNAVAILABLE while the reaction still
            // applies afterwards. When the command budget is exhausted,
            // the fetch aborts immediately instead of firing into the
            // dark. The timer is cleared exactly once, when the response
            // is fully consumed.
            var deadlineMs = 18000
            var queuedAtMs =
              options && typeof options.queued_at === 'number'
                ? options.queued_at
                : Date.now()
            var remainingMs = deadlineMs - (Date.now() - queuedAtMs)
            // The adapter-side command deadline arrives INSIDE __args
            // (__eo2CommandDeadlineMs, spread into the eval input by the
            // adapter): execute.toString() is invoked with the input object
            // only, so the execute function's own second parameter is never
            // bound and must not be relied on. Clamping to the command
            // deadline keeps a queued reaction from applying after the
            // caller already received TAB_UNAVAILABLE.
            var commandDeadline = null
            try {
              var injected = args && args.__eo2CommandDeadlineMs
              if (typeof injected === 'number' && injected > 0)
                commandDeadline = injected
            } catch (e) {}
            if (commandDeadline !== null) {
              var commandRemainingMs = commandDeadline - Date.now()
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

          // Outcome-unknown ledger (finding: a timed-out mutation released
          // its ordering lock). If Discord accepted an add or remove but
          // the response was delayed past the abort deadline, discordApi
          // returns NETWORK after the client aborts, the lock promise
          // settles, and a QUEUED OPPOSITE mutation would then dispatch —
          // Discord may already have accepted the timed-out mutation and
          // still apply it after the queued one, leaving the reaction
          // state OPPOSITE to the later request. The ledger records the
          // last aborted (outcome-unknown) mutation per reaction key; an
          // opposing mutation consults it BEFORE dispatching, re-fetches
          // the message's actual reaction state (reconcile), and re-arms
          // its own mutation to whatever direction the reconciled state
          // still needs, so the final state always matches the LATER
          // request. Aborted mutations of the SAME direction are also
          // reconciled and re-applied if absent — the same outcome-unknown
          // reasoning applies: Discord may not have applied it after all.
          // Kept per tab: the reaction lock serializes same-tab opposing
          // mutations, and the ledger only matters for a mutation queued
          // BEHIND an unknown-outcome one, which is always same-tab.
          var __eo2ReactionUnknownOutcome = {}
          function noteReactionUnknownOutcome(key, direction) {
            __eo2ReactionUnknownOutcome[key] = {
              direction: direction,
              at: Date.now(),
            }
          }
          function clearReactionUnknownOutcome(key) {
            delete __eo2ReactionUnknownOutcome[key]
          }
          // Re-fetch the message and return its CURRENT reaction state for
          // this emoji: { present: true } when the user's reaction exists,
          // { present: false } when it does not, null when the state cannot
          // be determined (the reconcile itself failed). Reads the SAME
          // endpoint the read_messages tool uses (GET .../reactions/<emoji>
          // with the current user's context via the Discord default of
          // pagination but a 1-item limit): the API returns the users who
          // added that reaction — an empty list means absent.
          async function reconcileReactionState(channel, messageId, emojiEnc) {
            var probe = await discordApi(
              '/channels/' +
                encodeURIComponent(channel) +
                '/messages/' +
                encodeURIComponent(messageId) +
                '/reactions/' +
                emojiEnc +
                '?limit=1',
              { method: 'GET' },
            )
            if (!probe.ok) return null
            var users = probe.data
            var present = Array.isArray(users)
              ? users.some(function (u) {
                  return u && u.id === selfUserId()
                })
              : false
            return { present: present }
          }
          // Resolve the current user's id from the token context: Discord's
          // reaction-user list entries carry full user objects, so the id
          // must come from /users/@me (cached for the tab lifetime — the
          // account-switch guard in getTokenCached already refuses stale
          // credentials, and a switched account would fail the token walk
          // before this cache is ever consulted).
          var __eo2SelfUserId = null
          function selfUserId() {
            if (__eo2SelfUserId !== null) return __eo2SelfUserId
            return null
          }
          async function ensureSelfUserId() {
            if (__eo2SelfUserId !== null) return __eo2SelfUserId
            var me = await discordApi('/users/@me', { method: 'GET' })
            if (me.ok && me.data && typeof me.data.id === 'string')
              __eo2SelfUserId = me.data.id
            return __eo2SelfUserId
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
          // Lock-expiry rejections are flagged so both the in-page guard
          // and the outer eval catch can pass them through as LOCK_TIMEOUT
          // instead of TAB_UNAVAILABLE: the tab answered the eval, so
          // "tab unavailable" would mislead the caller into reopening a
          // tab that is fine. The marker is an own enumerable property so
          // it survives the QuickJS host-call failure() metadata crossing.
          function makeLockTimeoutError(message) {
            var e = new Error(message)
            e.name = 'LOCK_TIMEOUT'
            e.lockTimeout = true
            return e
          }
          // Page-global lock keyed by channel:message:emoji. add_reaction
          // and remove_reaction share it, so opposing mutations for the
          // same reaction are serialized and cannot land out of order.
          // Two lifetime rules keep the map and the queue honest:
          // 1. A settled slot is removed (unless a newer call already
          //    re-keyed it), so the map does not grow for the tab lifetime.
          // 2. A queued entry that only starts running after the 15s
          //    wait cutoff has passed is skipped: its caller's eval window
          //    is nearly spent (and the fetch deadline is additionally
          //    clamped to the injected command deadline), so running it
          //    would turn a reported failure into a surprise reaction
          //    change.
          // Cross-tab reaction lock (navigator.locks, same discord.com
          // origin across tabs of one profile): opposing add/remove
          // mutations for the same message+emoji serialize across TABS, so
          // the later request cannot reach Discord before the earlier
          // mutation's result is known — the per-tab promise map alone is
          // invisible to another tab and let Discord process opposing
          // mutations in reverse order (finding: final reaction state
          // contradicted the later request). The queued entry skips
          // dispatch after the same 15s wait cutoff as the per-tab path
          // (checked when the lock is granted, no extra timer: exactly one
          // setTimeout per workflow stays the contract), returning
          // LOCK_TIMEOUT so the caller knows nothing was applied; and the
          // fetch deadline is separately clamped to the injected command
          // deadline, so a lock wait that overshot the eval window cannot
          // leave a reaction applying after TAB_UNAVAILABLE. Runtimes
          // without Web Locks (the QuickJS eval harness, older browsers)
          // fall back to the per-tab chain below, preserving single-tab
          // serialization; cross-tab ordering then degrades exactly as
          // before instead of failing the tool.
          function crossTabReactionLock(key, run) {
            var locksObj = null
            try {
              locksObj = navigator.locks
            } catch (e) {}
            if (!locksObj || typeof locksObj.request !== 'function') return null
            var queuedAt = Date.now()
            // The WAIT itself must be bounded inside the eval window: another
            // tab can hold the cross-tab lock far past the 25s browser-command
            // timeout, and the host would then terminate the eval before the
            // granted-lock expiry check below ever runs — the outer catch
            // would misreport the live tab as TAB_UNAVAILABLE (Sourcery
            // round 7). Race the lock request against a wait-budget timer so
            // an over-long wait surfaces as LOCK_TIMEOUT while the tab can
            // still answer. The budget is additionally clamped to the
            // injected command deadline minus a safety margin, so the timer
            // always beats the host kill.
            var waitBudgetMs = 15000
            try {
              var injectedWaitDeadline = args && args.__eo2CommandDeadlineMs
              if (typeof injectedWaitDeadline === 'number' && injectedWaitDeadline > 0) {
                var commandRemainingWaitMs = injectedWaitDeadline - Date.now() - 2000
                if (commandRemainingWaitMs < waitBudgetMs) waitBudgetMs = commandRemainingWaitMs
              }
            } catch (e) {}
            if (!(waitBudgetMs >= 1)) waitBudgetMs = 1
            var expired = false
            var rejectWait = null
            var waited = new Promise(function (resolve, reject) {
              rejectWait = reject
            })
            var lockWaitTimer = setTimeout(function () {
              expired = true
              rejectWait(
                makeLockTimeoutError(
                  'Reaction request queued behind another tab working on the same reaction and gave up after the cross-tab lock wait (the tab is still available).',
                ),
              )
            }, waitBudgetMs)
            var granted = locksObj.request('eo2-discord-reaction:' + key, function () {
              // Granted after a long wait: the caller's window is nearly
              // spent, so skip dispatch (same cutoff and rationale as the
              // per-tab path below). Also skip when the wait-budget timer
              // already expired this request.
              if (expired || Date.now() - queuedAt > 15000)
                throw makeLockTimeoutError(
                  'Reaction request queued behind another tab working on the same reaction and gave up after the 15s cross-tab lock wait (the tab is still available).',
                )
              return run(queuedAt)
            })
            // Promise.race attaches handlers to BOTH inputs, so a late grant
            // after the timer already rejected cannot produce an unhandled
            // rejection; the timer is cleared on whichever outcome lands.
            return Promise.race([granted, waited]).then(
              function (value) {
                clearTimeout(lockWaitTimer)
                return value
              },
              function (e) {
                clearTimeout(lockWaitTimer)
                throw e
              },
            )
          }
          function withReactionLock(key, run) {
            var crossTab = crossTabReactionLock(key, run)
            if (crossTab) return crossTab
            var locks
            try {
              locks = globalThis.__eo2ReactionLocks =
                globalThis.__eo2ReactionLocks || {}
            } catch (e) {
              return run(Date.now())
            }
            var previous = locks[key] || Promise.resolve()
            var queuedAt = Date.now()
            var entry = previous.then(function () {
              // The dispatch cutoff AND the fetch deadline both derive from
              // this queue timestamp (passed to the run callback and on to
              // discordApi's options.queued_at): a dispatched entry always
              // has the full remaining budget of the caller's 25s eval
              // window, and an entry that could only start after the 15s
              // wait cutoff is skipped so it can never touch Discord after
              // its caller has nearly exhausted the eval window. The
              // expiry is flagged on the error itself; the outer eval
              // catch passes it through as LOCK_TIMEOUT — the tab is
              // alive, so TAB_UNAVAILABLE would misreport the failure.
              if (Date.now() - queuedAt > 15000)
                throw makeLockTimeoutError(
                  'Reaction request queued behind another reaction on the same target and gave up after the 15s lock wait (the tab is still available).',
                )
              return run(queuedAt)
            })
            var settled = entry.then(function () {}, function () {})
            // Only hand the slot to this entry if it is still the latest
            // for the key; a newer call otherwise owns the slot.
            if (locks[key] === previous || locks[key] === undefined)
              locks[key] = settled
            settled.then(function () {
              if (locks[key] === settled) delete locks[key]
            })
            return entry
          }
          var discordToolImplementations = {
            async remove_reaction(args) {
              if (location.hostname !== 'discord.com')
                return error(
                  'UNSUPPORTED_PAGE',
                  'Not on a discord.com page.',
                )
              var emoji = encodeURIComponent(args.emoji)
              var lockKey = args.channel + ':' + args.message_id + ':' + args.emoji
              var response = await withReactionLock(
                lockKey,
                async function (queuedAt) {
                  // Outcome-unknown reconcile (see the ledger above): a
                  // PREVIOUS mutation for this reaction aborted past its
                  // deadline — its outcome is unknown. Re-fetch the live
                  // reaction state and only dispatch when the mutation is
                  // still needed; if the reconcile itself fails, the
                  // outcome stays unknown and the request fails closed
                  // (NETWORK, retryable) instead of dispatching blind.
                  var unknown = __eo2ReactionUnknownOutcome[lockKey]
                  if (unknown) {
                    var mine = await ensureSelfUserId()
                    if (mine === null)
                      return {
                        ok: false,
                        error_code: 'NETWORK',
                        message:
                          'Previous reaction mutation timed out with unknown outcome and the reconciling state read failed; retry to re-check the reaction.',
                      }
                    var state = await reconcileReactionState(
                      args.channel,
                      args.message_id,
                      emoji,
                    )
                    if (state === null)
                      return {
                        ok: false,
                        error_code: 'NETWORK',
                        message:
                          'Previous reaction mutation timed out with unknown outcome and the reconciling state read failed; retry to re-check the reaction.',
                      }
                    clearReactionUnknownOutcome(lockKey)
                    if (!state.present) return { ok: true, data: {} }
                  }
                  return discordApi(
                    '/channels/' +
                      encodeURIComponent(args.channel) +
                      '/messages/' +
                      encodeURIComponent(args.message_id) +
                      '/reactions/' +
                      emoji +
                      '/@me',
                    { method: 'DELETE', queued_at: queuedAt },
                  )
                },
              ).catch(function (e) {
                // The lock expiry must not escape the page: the outer
                // browser.eval catch maps every rejection to
                // TAB_UNAVAILABLE, which would misreport a live tab.
                if (e && e.lockTimeout) return error('LOCK_TIMEOUT', String(e.message || e))
                throw e
              })
              if (!response.ok) {
                // An ABORTED mutation (deadline abort) has an UNKNOWN
                // outcome: Discord may have accepted it even though the
                // response never arrived. Record it so the NEXT mutation
                // for this reaction reconciles the live state instead of
                // dispatching blind (see the ledger above).
                if (response.error_code === 'NETWORK')
                  noteReactionUnknownOutcome(lockKey, 'remove')
                return response
              }
              return ok({ removed: true })
            },
          }

          async function stdin_default(args) {
            return discordToolImplementations['remove_reaction'](args)
          }
          return stdin_default
        })()

        return workflow(args)
      }
      let response
      try {
        // The command deadline rides into the page via __args (the eval
        // source below passes __args into execute) so the in-page abort
        // timer can clamp its remaining budget to it.
        const inputWithDeadline = {
          ...input,
          __eo2CommandDeadlineMs: commandDeadlineMs,
        }
        response = await browser.eval(
          '() => (' + execute.toString() + ')(' + JSON.stringify(inputWithDeadline) + ')',
          options,
        )
      } catch (error) {
        // A reaction queued behind a same-key request can exhaust its 15s
        // lock wait while the tab is perfectly alive; that rejection is
        // flagged LOCK_TIMEOUT and passes through unmapped so callers do
        // not misread it as a dead tab.
        if (error instanceof Error && error.name === 'LOCK_TIMEOUT') {
          state.result = {
            status: 'error',
            data: null,
            message: String(error.message || error),
            error_code: 'LOCK_TIMEOUT',
          }
          return 'success'
        }
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
      return 'success'
    },
  },
  result({ state }) {
    return state.result
  },
}
