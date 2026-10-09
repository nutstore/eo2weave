import { defineConfig } from 'wxt';
import pkg from './package.json';

// Codex OAuth feature flag.
// The Codex device-code login reuses the official Codex CLI's OAuth client_id
// and calls chatgpt.com/backend-api — fine for an internal/dev build, but NOT
// for the Chrome Web Store build (impersonation / OpenAI ToS review risk;
// see store-listing/cws-copy-and-permissions.md).
// Set CW_CODEX_OAUTH=0 to strip the feature at build time: `__CW_CODEX_OAUTH__`
// becomes `false` and treeshaking removes every OpenAI endpoint / client_id /
// UA string from the bundle. Default ON (internal builds keep full features).
const CODEX_OAUTH = process.env.CW_CODEX_OAUTH !== '0';
// Store-build marker (independent of Codex stripping): the CWS build omits the
// pinned manifest `key` (see below). Set CW_STORE_BUILD=1 via `build:store` /
// `zip:store`. Combine with CW_CODEX_OAUTH=0 if a Codex-free store zip is ever
// needed — the two flags are orthogonal by design.
const IS_STORE_BUILD = process.env.CW_STORE_BUILD === '1';

// Stable Chromium extension key (RSA public key DER, base64).
// Keeps a consistent extension ID across loads/updates so the native messaging
// manifest's `allowed_origins` stays valid. Override at build time via
// CREATORWEAVE_CHROMIUM_EXTENSION_KEY if you need a different key pair.
const DEFAULT_CHROMIUM_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq7brlUY/QJP5fnbKrcvOAbirr3GLFgiXDbT2g8D5NKi8GDVBp+OIHCt96LsJ3zTiFlvx4W7bhcvX5JF3eUfP0qjLaaoUw8b683Uupui3iLPaGYrVDxFRNYJR28BDUtExCkb/rehk/QVtLapPVB63YboFzuU2L0SUyGjfzXi6sLYOIFGnYfrrcLQu3pLf+iuRr04yjkfcvlXIG3Ws+Am5AfFFvWxYX1zvV58GyHM5kaKZy2MqugOMiwbQvID5Lkm35NhOxpO/lrjrOy5ZhNObiWZZk70VzJxGM3saE/q/aUEeOwY+0RLqzWb7cs/f8E1tMxB23rifheL7M58tuFpXDwIDAQAB';

export default defineConfig({
  outDir: 'dist',
  // Separate dev/build output directories via WXT's {{modeSuffix}} placeholder:
  //   wxt (dev) → chrome-mv3-dev   |   wxt build → chrome-mv3
  // (WXT 0.19's DEFAULT template has no mode suffix — dev and build would
  // overwrite each other in the same chrome-mv3 dir.)
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}{{modeSuffix}}',
  // WXT copies public assets AFTER vite's closeBundle, so build-specific
  // locale changes run here (after everything is on disk).
  hooks: {
    'build:done': (wxt) => {
      const isDevBuild = wxt.config.mode === 'development';
      if (!isDevBuild && CODEX_OAUTH) return;
      const fs = require('fs') as typeof import('fs');
      const pathMod = require('path') as typeof import('path');
      // Dev builds land in chrome-mv3-dev ({{modeSuffix}}), builds in chrome-mv3.
      const outBase = isDevBuild ? 'dist/chrome-mv3-dev' : 'dist/chrome-mv3';
      const localesDir = pathMod.resolve(__dirname, outBase + '/_locales');
      if (!fs.existsSync(localesDir)) return;
      const now = new Date();
      const buildTime = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
      for (const locale of fs.readdirSync(localesDir)) {
        const file = pathMod.join(localesDir, locale, 'messages.json');
        if (!fs.existsSync(file)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          let changed = false;
          if (isDevBuild && typeof parsed.extensionNameDev?.message === 'string') {
            parsed.extensionNameDev.message += ` ${buildTime}`;
            changed = true;
          }
          if (!CODEX_OAUTH) {
            for (const key of Object.keys(parsed)) {
              if (/codex|devicecode|resetcredit|useresetcredit|authorizedcanuse|waitingforauthorization/i.test(key)
                || (!isDevBuild && /extensionnamedev/i.test(key))) {
                delete parsed[key];
                changed = true;
              }
            }
          }
          if (changed) fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
        } catch {
          // leave file untouched on parse failure
        }
      }
    },
  },
  // NOTE: `define` must live inside the `vite` hook — a top-level `define` key
  // is silently ignored by WXT, leaving `__CW_CODEX_OAUTH__` un-replaced in
  // the bundle (verified in the first store build; OpenAI strings survived).
  vite: () => ({
    define: {
      __CW_CODEX_OAUTH__: JSON.stringify(CODEX_OAUTH),
    },
    // NOTE: rollupOptions.output is ignored by WXT for its HTML entries, and a
    // post-build rename breaks WXT's own lstat pass — so the `_virtual_*`
    // chunk is renamed inside the bundle via the sanitize-virtual-chunk-names
    // plugin below.
    // Store build: also strip the Codex box from popup.html at build time.
    // (main.ts removes it at runtime, but the markup would still ship in the
    // zip for reviewers to find.) The .codex-box div is the last element
    // before <footer>, so a greedy match up to the last </div> before footer
    // removes exactly that block.
    plugins: [
      {
        name: 'sanitize-virtual-chunk-names',
        // Chrome MV3 does not serve extension resources whose path starts with
        // '_' (reserved namespace: _locales, _next, ...). Vite names chunks
        // after their virtual module ('_virtual_wxt-html-plugins-*.js'), which
        // Chrome refuses to load. Rename in-bundle and rewrite all references
        // before anything is written to disk.
        closeBundle() {
          // Chrome MV3 does not serve extension resources whose path starts
          // with '_' (reserved namespace: _locales, _next, ...). Vite names
          // chunks after their virtual module ('_virtual_wxt-html-plugins-*.js'),
          // which Chrome refuses to load. WXT's HTML plugin emits those chunks
          // outside of Vite's bundle graph, so we rename on disk here (after
          // Vite writes everything, before WXT's own lstat pass) and rewrite
          // every HTML/JS reference.
          const fsMod = require('fs') as typeof import('fs');
          const pathMod = require('path') as typeof import('path');
          const renames = new Map<string, string>();
          const walk = (dir: string): void => {
            for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
              const full = pathMod.join(dir, entry.name);
              if (entry.isDirectory()) walk(full);
              else if (entry.name.startsWith('_virtual_')) {
                const fixed = 'virtual_' + entry.name.slice('_virtual_'.length);
                const target = pathMod.join(dir, fixed);
                // COPY (not rename) — WXT does its own lstat on the original
                // path AFTER Vite closes, and removing the original throws
                // ENOENT. The browser loads from HTML/JS references, which we
                // rewrite to the new (safe) name below.
                fsMod.copyFileSync(full, target);
                renames.set(entry.name, fixed);
              }
            }
          };
          // closeBundle runs from vite's own cwd (browser-extension), so resolve
          // the dist directory relative to it.
          const candidates = [
            pathMod.resolve('dist/chrome-mv3'),
            pathMod.resolve('dist/chrome-mv3-dev'),
          ];
          for (const out of candidates) {
            if (fsMod.existsSync(out)) walk(out);
          }
          if (!renames.size) return;
          const rewrite = (dir: string): void => {
            for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
              const full = pathMod.join(dir, entry.name);
              if (entry.isDirectory()) rewrite(full);
              else if (/\.(html|js|css|json)$/.test(entry.name)) {
                let text = fsMod.readFileSync(full, 'utf8');
                let changed = false;
                for (const [from, to] of renames) {
                  if (text.includes(from)) {
                    text = text.split(from).join(to);
                    changed = true;
                  }
                }
                if (changed) fsMod.writeFileSync(full, text);
              }
            }
          };
          for (const out of candidates) {
            if (fsMod.existsSync(out)) rewrite(out);
          }
          // eslint-disable-next-line no-console
          console.log(`[sanitize-virtual-chunks] renamed: ${[...renames.keys()].join(', ')}`);
          // The browser loads from HTML/JS references (now `virtual_*`), so
          // the original `_virtual_*` files are dead weight in the zip.
          // WXT still lstats them during its build summary, which fires AFTER
          // Vite's closeBundle, so we can't delete them synchronously here.
          // Register a process-exit cleanup that runs once Node has finished
          // everything (including WXT's summary print) but before the next
          // build step (`prepare:assets`) starts touching the dist dir.
          process.on('exit', () => {
            for (const out of candidates) {
              if (!fsMod.existsSync(out)) continue;
              for (const [from] of renames) {
                for (const entry of fsMod.readdirSync(out, { withFileTypes: true })) {
                  const full = pathMod.join(out, entry.name);
                  if (entry.isDirectory()) {
                    try {
                      fsMod.unlinkSync(pathMod.join(full, from));
                    } catch {
                      // already gone — ignore
                    }
                  } else if (entry.name === from) {
                    try {
                      fsMod.unlinkSync(full);
                    } catch {
                      // already gone — ignore
                    }
                  }
                }
              }
            }
          });
        },
      },
      ...(CODEX_OAUTH
        ? []
        : [
            {
              name: 'strip-codex-popup',
              transformIndexHtml: {
                order: 'post' as const,
                handler(html: string) {
                  // Strip the Codex markup block AND its CSS class definitions
                  // (.codex-box / .codex-btn / .codex-log / .reset-credit-*) so
                  // no trace of the feature ships in the store zip.
                  let out = html.replace(/[ \t]*<div class="codex-box">[\s\S]*<\/div>(\s*<footer)/, '$1');
                  out = out.replace(/[ \t]*\.(?:codex-[a-z-]+|reset-credit-[a-z-]+)[^{]*\{[^}]*\}[\s\S]*?(?=\n[ \t]*\.|\n[ \t]*<\/style>)/g, '');
                  return out;
                },
              },
            },
          ]),
    ],
  }),
  // Dev (`wxt`) and build (`wxt build`) output to DIFFERENT directories:
  //   dev   → dist/chrome-mv3-dev   (WXT default; live-reload artifacts)
  //   build → dist/chrome-mv3       (production artifacts; also what the
  //                                  web app's copy:extension script zips)
  // This lets Chrome hold an unpacked stable build and a dev build side by
  // side without them overwriting each other. The web app's dev server
  // (vite-plugin-extension-serve) prefers chrome-mv3-dev when present —
  // see web/vite-plugin-extension-serve.ts.
  // Don't auto-launch a separate browser during `wxt dev`. CreatorWeave loads
  // the extension via a zip downloaded from the web app, not via web-ext's
  // managed browser. The manual runner just logs the output path.
  runner: {
    disabled: true,
  },
  // `manifest` as a function receives WXT's ConfigEnv (mode: 'development'
  // for `wxt`, 'production' for `wxt build`). We use it to give dev builds a
  // distinct NAME — "EO2Weave Dev HH:mm:ss" / "怡氧知知 Dev HH:mm:ss"
  // via __MSG_extensionNameDev__
  // — so chrome://extensions and the toolbar tooltip can tell the two unpacked
  // loads apart. Without this, both builds share the same pinned extension
  // key → same extension ID → two identically-named entries.
  manifest: (env) => ({
    name: env.mode === 'development' ? '__MSG_extensionNameDev__' : '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
    version: pkg.version,
    // Pin a stable extension ID derived from a fixed public key — for unpacked
    // loads (dev + self-distribution zips) so the native messaging manifest's
    // `allowed_origins` stays valid across reinstalls.
    //
    // CWS REJECTS uploads whose manifest contains `key` ("清单文件中不允许使用
    // key 字段") — the store derives its own key/ID when the item is created.
    // So store builds omit it; the store item therefore gets a DIFFERENT
    // extension ID than kdnnhmagmghdhfinoipgbcddnpmffbkp. Once the item exists
    // and its ID is known, add that ID to native-host allowed_origins (or pin
    // the store item's public key via CREATORWEAVE_CHROMIUM_EXTENSION_KEY to
    // unify both IDs).
    ...(IS_STORE_BUILD
      ? {}
      : { key: process.env.CREATORWEAVE_CHROMIUM_EXTENSION_KEY || DEFAULT_CHROMIUM_EXTENSION_KEY }),
    permissions: ['scripting', 'tabs', 'storage', 'alarms', 'notifications', 'sidePanel', 'nativeMessaging', 'debugger'],
    host_permissions: ['<all_urls>'],
    // Fixed Firefox add-on ID for native messaging registration.
    browser_specific_settings: {
      gecko: {
        id: 'creatorweave-bridge@creatorweave.local',
      },
    },
    // No global side_panel config — side panel is only enabled per-tab
    // via setOptions({ tabId }) when user clicks the workspace assistant button.
    // icons and action icon are auto-generated by WXT from public/icon.png
    action: {
      // Toolbar tooltip + extension name surface; keep in sync with
      // _locales extensionName (product name: EO2Weave). WXT derives this
      // from popup <title> when present (which would override this) — that's
      // why popup/index.html has no <title>.
      // Literal strings (not __MSG_*__): Chrome only resolves __MSG_*__ for
      // manifest name/description, not for action.default_title.
      default_title: env.mode === 'development' ? 'EO2Weave Dev' : 'EO2Weave',
    },
  }),
});
