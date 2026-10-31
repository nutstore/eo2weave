// Self-contained adapter workflow. Token extraction and API fetches stay inside the discord.com tab.

export default {
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      before: { type: 'string', minLength: 1 },
      after: { type: 'string', minLength: 1 },
    },
    required: [],
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
    description: 'list_guilds',
    async run({ input, state, target }) {
      const options = { tab: target.tabId, timeout: 25000 }
      // Absolute deadline (epoch ms) for the WHOLE command, computed on the
      // adapter side before the eval is dispatched: the browser's 25s
      // timeout includes the tab-command queue wait, so the in-page fetch
      // must never outlive this instant (finding: an eval that starts late
      // could otherwise arm a full fresh deadline and complete after the
      // caller already received TAB_UNAVAILABLE).
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
            // deadline the command cannot cover — otherwise the request
            // can outlive the timed-out command and apply after the caller
            // already received TAB_UNAVAILABLE. When the command budget is
            // exhausted, the fetch aborts immediately instead of firing
            // into the dark.
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
            // Fail fast BEFORE arming the timer or dispatching: an eval
            // that starts after the command deadline has no budget left —
            // the caller already received TAB_UNAVAILABLE, so a request
            // sent here could apply after the caller believes the command
            // timed out. Arming Math.max(1, remainingMs) would only abort
            // a fetch that has already gone out.
            if (remainingMs <= 0)
              return {
                ok: false,
                error_code: 'NETWORK',
                message:
                  'Discord API request not sent: the browser command deadline expired before the page eval started.',
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
          var discordToolImplementations = {
            async list_guilds(args) {
              if (location.hostname !== 'discord.com')
                return error(
                  'UNSUPPORTED_PAGE',
                  'Not on a discord.com page.',
                )
              if (args.before !== undefined && args.after !== undefined)
                return error(
                  'VALIDATION',
                  'Pass only one of before or after per call; Discord guild pagination accepts a single cursor.',
                )
              var query = {
                limit: args.limit === undefined ? 200 : args.limit,
                with_counts: true,
              }
              if (args.before !== undefined) query.before = args.before
              if (args.after !== undefined) query.after = args.after
              var response = await discordApi('/users/@me/guilds', {
                query: query,
              })
              if (!response.ok) return response
              return ok({
                guilds: Array.isArray(response.data)
                  ? response.data.map(mapGuild)
                  : [],
              })
            },
          }

          async function stdin_default(args) {
            return discordToolImplementations['list_guilds'](args)
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
          '() => (' + execute.toString() + ')(' + JSON.stringify(inputWithDeadline) + ')',
          options,
        )
      } catch (error) {
        // An eval rejection whose error name carries the source marker
        // means the eval HARNESS itself faulted (page-side runtime error)
        // while the tab is still alive — TAB_UNAVAILABLE would mislead the
        // caller into reopening a healthy tab, so it gets EVAL_FAILED.
        if (error instanceof Error && error.name === '__eo2EvalSourceMarker__') {
          state.result = {
            status: 'error',
            data: null,
            message: 'The discord.com tab failed to run the tool (internal eval error): ' +
              String(error),
            error_code: 'EVAL_FAILED',
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
