// Build-time Codex OAuth feature flag (see wxt.config.ts).
// Store builds (CW_CODEX_OAUTH=0) hide the whole Codex box in the popup.
declare const __CW_CODEX_OAUTH__: boolean;

import { getCwWebappBaseUrl, CW_WEBAPP_APP_PATH } from '../../lib/webapp-origins';

function t(key: string, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key as any, substitutions) || key;
}

function localizeStaticContent(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(function (element) {
    element.textContent = t(element.dataset.i18n || '');
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(function (element) {
    element.title = t(element.dataset.i18nTitle || '');
  });
}

localizeStaticContent();
try { document.getElementById('version')!.textContent = 'v' + chrome.runtime.getManifest().version; } catch {}

// Show build mode badge — DEV builds only.
// Production builds hide the badge entirely: store users shouldn't see a
// "PROD" tag (it leaks internal jargon and looks unpolished).
(function () {
  var el = document.getElementById('buildMode');
  if (!el) return;
  // WXT/Vite injects `import.meta.env` typings via `wxt-env.d.ts` (generated).
  // MODE is one of 'development' | 'production' per Vite contract.
  var mode = import.meta.env.MODE || 'production';
  var isDev = mode === 'development';
  if (!isDev) {
    el.remove();
    return;
  }
  // DEV build: reveal and fill the badge (static HTML ships it hidden/empty).
  el.removeAttribute('hidden');
  el.className = 'build-mode ' + (isDev ? 'dev' : 'prod');
  el.textContent = isDev ? 'DEV' : 'PROD';
})();

// ── L1 primary action: open the side-panel workbench ──
// chrome.sidePanel.open() requires a user gesture, and that gesture does
// NOT survive the popup → background message hop — so the popup calls
// open() DIRECTLY, synchronously in its own click handler. The active tab
// is cached at popup load time so the click handler stays synchronous.
// Binding registration goes to the background fire-and-forget
// (cw_side_panel_register_binding): storage writes settle in ~ms while the
// panel web app resolves the binding much later, so the race is negligible.
(function () {
  var btn = document.getElementById('openWorkbenchBtn');
  if (!btn) return;

  // Cache the active tab once at popup load (async) so the click handler
  // below runs fully synchronously — preserving the user gesture.
  var activeTab: { id?: number; url?: string } | null = null;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (tab) activeTab = { id: tab.id, url: tab.url || '' };
  });

  btn.addEventListener('click', function () {
    var tabId = activeTab && activeTab.id;
    if (typeof tabId !== 'number') {
      // No valid tab yet (very rare — popup opened before query resolved):
      // open the web app in a plain tab as a graceful fallback.
      chrome.tabs.create({ url: getCwWebappBaseUrl() + CW_WEBAPP_APP_PATH });
      window.close();
      return;
    }

    // 1) Register the binding + panel-open marker (fire-and-forget).
    var bindingId = (crypto as any).randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
    var cwBase = getCwWebappBaseUrl();
    var params = new URLSearchParams();
    params.set('source', 'side_panel');
    params.set('binding', bindingId);
    var pageUrl = (activeTab && activeTab.url) || '';
    if (pageUrl) {
      try { params.set('origin', new URL(pageUrl).origin); } catch {}
    }
    chrome.runtime.sendMessage(
      { type: 'cw_side_panel_register_binding', bindingId: bindingId, tabId: tabId },
      function () { void chrome.runtime.lastError; }
    );

    // 2) Configure the panel for this tab, then open it — directly from the
    //    popup (user gesture intact). Same ordering contract as the floating
    //    button's background handler: fire setOptions WITHOUT awaiting, then
    //    call open() synchronously right after — Chrome processes both
    //    browser-process calls in order, and open() stays on the gesture
    //    call stack instead of inside a promise callback.
    chrome.sidePanel.setOptions({
      tabId: tabId,
      // Use a normal query for the Next.js App Router. A fragment launch URL
      // (`/#/?…`) races the root-page redirect during initial hydration.
      path: cwBase + CW_WEBAPP_APP_PATH + '?' + params.toString(),
      enabled: true,
    }).catch(function (err: any) {
      // eslint-disable-next-line no-console
      console.warn('[EO2Weave popup] sidePanel.setOptions failed:', err);
    });
    chrome.sidePanel.open({ tabId: tabId }).then(function () {
      window.close();
    }).catch(function (err: any) {
      // eslint-disable-next-line no-console
      console.warn('[EO2Weave popup] side panel open failed:', err);
    });
  });
})();

// ── L2 capability block: two quiet rows summarizing what works right now ──
// Two async writers feed one state object (injection check + WebMCP
// discovery); renderCapline() merges them so the block never flickers between
// competing updates. Search runs in the background service worker and works
// regardless of injection — injection only gates page reading/acting.
// Layout: row 1 = search status; row 2 (only when tools exist) = tool count
// + manage toggle right-aligned — structured rows instead of one wrapping
// long line (mid-sentence wraps looked broken at 360px).
var capState = {
  search: 'checking' as 'checking' | 'ready' | 'inactive' | 'internal' | 'unavailable' | 'error',
  tools: null as null | { hosts: number; total: number },
  note: '' as string, // diagnosability detail (tooltip only)
};
var capExpanded = false;

function renderCapline(): void {
  var dot = document.getElementById('capDot');
  var text = document.getElementById('capText');
  var toolsRow = document.getElementById('capToolsRow');
  var toolsText = document.getElementById('capToolsText');
  var mgr = document.getElementById('mgrToggle');
  if (!dot || !text || !mgr || !toolsRow || !toolsText) return;

  var base = '';
  var dotCls = 'cap-dot ok';
  switch (capState.search) {
    case 'ready': base = t('capReady'); break;
    case 'inactive': dotCls = 'cap-dot warn'; base = t('capInactive'); break;
    case 'internal': dotCls = 'cap-dot warn'; base = t('capInternal'); break;
    case 'unavailable': dotCls = 'cap-dot warn'; base = t('capUnavailable'); break;
    case 'error': dotCls = 'cap-dot warn'; base = t('capCheckFailed'); break;
    default: base = t('checking');
  }
  dot.className = dotCls;
  text.textContent = base;
  text.title = capState.note || '';

  if (capState.tools && capState.tools.hosts > 0) {
    toolsText.textContent = chrome.i18n.getMessage('capTools', [String(capState.tools.hosts)]) || String(capState.tools.hosts);
    toolsText.title = chrome.i18n.getMessage('webmcpFoundSummary', [String(capState.tools.hosts), String(capState.tools.total)]) || '';
    toolsRow.style.display = '';
    mgr.style.display = '';
    mgr.textContent = capExpanded ? t('hideTools') : t('manageTools');
  } else {
    toolsRow.style.display = 'none';
    mgr.style.display = 'none';
  }
}

(function () {
  var mgr = document.getElementById('mgrToggle');
  var box = document.getElementById('webmcpBox');
  if (!mgr || !box) return;
  mgr.addEventListener('click', function () {
    capExpanded = !capExpanded;
    box.style.display = capExpanded && capState.tools ? '' : 'none';
    renderCapline();
  });
})();

// WebMCP tools discovered in this window — grouped by hostname.
// Mirrors the web app's Settings → WebMCP host list (WebMCPHostList.tsx):
// hostname + tool count + per-host authorization switch. Clicking the
// host name jumps to the source tab; the switch writes the extension-side
// authorization store (enforced by the background invoke gate).
(function () {
  var box = document.getElementById('webmcpBox');
  var list = document.getElementById('webmcpList');
  var summary = document.getElementById('webmcpSummary');
  var guide = document.getElementById('webmcpGuide');
  if (!box || !list || !summary) return;

  // hostname → latest authorization state (default: enabled)
  var hostEnabled: Record<string, boolean> = {};

  function renderIdle() {
    if (guide) guide.style.display = 'none';
    box.style.display = 'none';
  }

  function renderEmpty() {
    if (guide) guide.style.display = 'none';
    box.style.display = 'none';
    capState.tools = null;
    capState.note = '';
    renderCapline();
  }

  // Zero-tools state: show a guide instead of hiding the section entirely.
  // The guide FIRST probes the real switch state (see detectWebMCPSwitch):
  // "0 tools" alone cannot distinguish "switch off" from "switch on but no
  // site is providing tools", so the message differs per state. When the
  // switch is missing we explain the version requirement and offer a
  // one-click jump to chrome://flags — a privileged URL only an extension
  // page can open (the web app's settings page can never do this).
  function renderNoTools(detail?: string) {
    capState.tools = null;
    capState.note = detail || '';
    summary.textContent = detectWebMCPSwitch().on
      ? t('webmcpGuideTitleNoTools')
      : t('webmcpGuideTitle');
    renderCapline();
    if (!guide) {
      // No guide container (stale HTML?) → keep the old hide behavior.
      box.style.display = 'none';
      return;
    }
    // renderIdle() hides the whole card at popup boot — un-hide it here.
    // (Bugfix: only revealing the inner guide left the outer box hidden.)
    box.style.display = '';
    guide.style.display = '';
    if (guide.dataset.built !== '1') {
      guide.dataset.built = '1';
      buildGuide();
    }
  }

  // Probe: WebMCP is a Blink runtime feature ([RuntimeEnabled=WebMCP]).
  // When the browser-level switch is on (flag / --enable-blink-features),
  // the API exists in EVERY document — including this popup. CAVEAT: from
  // the Origin-Trial era onward the object can also be present WITHOUT any
  // user-touched switch (built-in rollout / trial tokens), so ON here means
  // "WebMCP available in this browser", NOT necessarily "user enabled the
  // flag" — the ON copy stays cause-neutral accordingly. OFF, however, is
  // conclusive: no built-in and no flag → this browser really has no WebMCP.
  // The version then picks the remedy: flags entry exists 146–151; removed
  // since 152 (CL 8330412) → Origin-Trial path.
  function detectWebMCPSwitch(): { on: boolean; isChromium: boolean; major: number } {
    var on = !!(document as any).modelContext;
    var m = /Chrome\/(\d+)\./.exec(navigator.userAgent);
    var major = m ? parseInt(m[1], 10) : NaN;
    return { on: on, isChromium: !isNaN(major), major: major };
  }

  function buildGuide(): void {
    if (!guide) return;
    var det = detectWebMCPSwitch();
    // The three OFF states are only reachable when the probe says OFF:
    // switch exists but disabled (146–151), switch removed (152+), or a
    // non-Chromium browser (the Firefox build).
    var flagAvailable = !det.on && det.isChromium && det.major >= 146 && det.major <= 151;
    var flagRemoved = !det.on && det.isChromium && det.major >= 152;

    var text = document.createElement('div');
    text.className = 'webmcp-guide-text';
    text.textContent = det.on
      // Cause-neutral: on newer versions the object can be there without
      // the user ever touching a switch, so don't claim they enabled one.
      // 148+ additionally gets the site-side Origin Trial hint.
      ? (t('webmcpGuideFlagOn') + (det.major >= 148 ? ' ' + t('webmcpGuideFlagOnOt') : ''))
      : flagAvailable
        ? t('webmcpGuideChromium')
        : flagRemoved
          ? t('webmcpGuideChromiumNew')
          : t('webmcpGuideUnsupported');

    // ON → the missing piece is tool providers, not the browser: open the
    // supported-sites manager. OFF (146–151) → jump straight to the WebMCP
    // flag entry on chrome://flags (new tab; popup closes — standard).
    // OFF (152+) → official docs explain the Origin Trial path. Else → README.
    var targetUrl = det.on
      ? chrome.runtime.getURL('/recipes.html')
      : flagAvailable
        ? 'chrome://flags/#enable-webmcp-testing'
        : flagRemoved
          ? 'https://developer.chrome.com/docs/ai/webmcp'
          : 'https://github.com/nutstore/creatorweave/blob/main/browser-extension/README.md';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'webmcp-guide-btn';
    btn.textContent = det.on
      ? t('webmcpGuideOpenSites')
      : flagAvailable
        ? t('webmcpGuideOpenFlags')
        : flagRemoved
          ? t('webmcpGuideOpenDocs')
          : t('webmcpGuideOpenReadme');
    btn.addEventListener('click', function () {
      chrome.tabs.create({ url: targetUrl });
      window.close();
    });

    var ver = document.createElement('div');
    ver.className = 'webmcp-guide-ver';
    ver.textContent = det.isChromium
      ? t('webmcpGuideVersion', [det.on
        ? t('webmcpGuideStateOn')
        : t('webmcpGuideStateOff'), String(det.major)])
      : '';

    guide.appendChild(text);
    guide.appendChild(btn);
    guide.appendChild(ver);
  }

  function renderError(detail: string) {
    if (guide) guide.style.display = 'none';
    box.style.display = 'none';
    capState.tools = null;
    capState.note = (chrome.i18n.getMessage('webmcpDiscoverError') || 'webmcpDiscoverError') + ': ' + detail;
    renderCapline();
  }

  function cssEscape(value: string): string {
    return (window as any).CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
  }

  function setHostEnabledState(hostname: string, enabled: boolean) {
    hostEnabled[hostname] = enabled;
    var row = list && list.querySelector('[data-host="' + cssEscape(hostname) + '"]');
    if (row) {
      row.classList.toggle('disabled-host', !enabled);
      var toggle = row.querySelector('input.webmcp-toggle') as HTMLInputElement | null;
      if (toggle) {
        toggle.checked = enabled;
        toggle.disabled = false;
        toggle.title = enabled
          ? (chrome.i18n.getMessage('webmcpToggleHostTitle') || 'webmcpToggleHostTitle')
          : (chrome.i18n.getMessage('webmcpHostDisabled') || 'webmcpHostDisabled');
      }
      var leftEl = row.querySelector('.webmcp-host-left') as HTMLElement | null;
      if (leftEl) {
        leftEl.title = enabled
          ? (row.getAttribute('data-tools') || '')
          : (chrome.i18n.getMessage('webmcpHostDisabled') || 'webmcpHostDisabled');
      }
    }
  }

  function buildToggle(opts: {
    checked: boolean;
    disabled?: boolean;
    titleOn: string;
    titleOff: string;
    disabledTitle?: string;
    onToggle: (next: boolean, done: (ok: boolean) => void) => void;
  }): HTMLLabelElement {
    var toggleLabel = document.createElement('label');
    toggleLabel.style.margin = '0';
    toggleLabel.style.flex = '0 0 auto';
    var toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'webmcp-toggle';
    toggle.checked = opts.checked;
    toggle.disabled = !!opts.disabled;
    if (opts.disabled && opts.disabledTitle) {
      toggle.title = opts.disabledTitle;
    } else {
      toggle.title = opts.checked ? opts.titleOn : opts.titleOff;
    }
    toggle.addEventListener('change', function () {
      var next = toggle.checked;
      toggle.disabled = true;
      opts.onToggle(next, function (ok) {
        if (!ok) {
          toggle.checked = !next;
          toggle.disabled = false;
          return;
        }
        toggle.checked = next;
        toggle.disabled = false;
        toggle.title = next ? opts.titleOn : opts.titleOff;
      });
    });
    toggleLabel.appendChild(toggle);
    return toggleLabel;
  }

  function sendSetEnabled(message: any, done: (ok: boolean) => void) {
    chrome.runtime.sendMessage(message, function (resp: any) {
      if (chrome.runtime.lastError || !resp || !resp.ok) { done(false); return; }
      done(true);
    });
  }

  function renderList(tools: any[]) {
    if (!tools || tools.length === 0) {
      renderEmpty();
      return;
    }
    if (guide) guide.style.display = 'none';
    box.style.display = capExpanded ? '' : 'none';
    // Group by hostname → { groups: Map<groupKey, ...>, hostEnabled }
    var byHost: Record<string, {
      count: number;
      tabId: number;
      groups: Record<string, { count: number; tabId: number; toolNames: string[]; tabTitles: string[]; enabled?: boolean }>;
      enabled?: boolean;
    }> = {};
    for (var i = 0; i < tools.length; i++) {
      var tool = tools[i];
      var host = tool.hostname || 'unknown';
      if (!byHost[host]) byHost[host] = { count: 0, tabId: tool.tabId, groups: {} };
      byHost[host].count++;
      if (typeof tool.hostEnabled === 'boolean') byHost[host].enabled = tool.hostEnabled;
      var gk = tool.groupKey || (host + '_default');
      if (!byHost[host].groups[gk]) byHost[host].groups[gk] = { count: 0, tabId: tool.tabId, toolNames: [], tabTitles: [] };
      byHost[host].groups[gk].count++;
      if (typeof tool.groupEnabled === 'boolean') byHost[host].groups[gk].enabled = tool.groupEnabled;
      if (byHost[host].groups[gk].toolNames.length < 6 && byHost[host].groups[gk].toolNames.indexOf(tool.name) === -1) byHost[host].groups[gk].toolNames.push(tool.name);
      var tt = (tool.tabTitle || '').trim();
      if (tt && byHost[host].groups[gk].tabTitles.indexOf(tt) === -1 && byHost[host].groups[gk].tabTitles.length < 3) byHost[host].groups[gk].tabTitles.push(tt);
    }
    var hosts = Object.keys(byHost);
    var totalTools = tools.length;
    // chrome.i18n.getMessage handles $HOSTS$/$TOOLS$ via declared placeholders
    // + substitutions — bare $NAME in the message gets eaten by Chrome's own
    // substitution parser ("$HOSTS" rendered as "OSTS").
    summary.textContent = chrome.i18n.getMessage('webmcpFoundSummary', [String(hosts.length), String(totalTools)])
      || (hosts.length + ' site(s), ' + totalTools + ' tool(s)');
    // Fold the counts into the capability line and refresh the manage toggle.
    capState.tools = { hosts: hosts.length, total: totalTools };
    renderCapline();

    list.textContent = '';
    hosts.sort().forEach(function (host) {
      var info = byHost[host];
      var hostOn = info.enabled !== false;
      hostEnabled[host] = hostOn;

      var item = document.createElement('div');
      item.className = 'webmcp-host' + (hostOn ? '' : ' disabled-host');
      item.dataset.host = host;

      var left = document.createElement('div');
      left.className = 'webmcp-host-left';
      left.addEventListener('click', function () {
        if (typeof info.tabId === 'number') {
          chrome.tabs.update(info.tabId, { active: true });
          window.close();
        }
      });
      var name = document.createElement('span');
      name.className = 'webmcp-host-name';
      name.textContent = host;
      var count = document.createElement('span');
      count.className = 'webmcp-host-count';
      count.textContent = String(info.count);
      left.appendChild(name);
      left.appendChild(count);

      // Group rows register here so the host switch can cascade state to
      // them (mirrors web WebMCPHostList: host off → group switches disabled).
      var groupUpdaters: Array<(hostOn: boolean) => void> = [];

      var hostToggle = buildToggle({
        checked: hostOn,
        titleOn: chrome.i18n.getMessage('webmcpToggleHostTitle') || 'webmcpToggleHostTitle',
        titleOff: chrome.i18n.getMessage('webmcpHostDisabled') || 'webmcpHostDisabled',
        onToggle: function (next, done) {
          sendSetEnabled({ type: 'webmcp_set_host_enabled', hostname: host, enabled: next }, function (ok) {
            if (ok) {
              hostEnabled[host] = next;
              item.classList.toggle('disabled-host', !next);
              left.title = next ? String(info.count) + ' tool(s)' : (chrome.i18n.getMessage('webmcpHostDisabled') || 'webmcpHostDisabled');
              for (var u = 0; u < groupUpdaters.length; u++) groupUpdaters[u](next);
            }
            done(ok);
          });
        },
      });
      // Header row keeps name area and switch on the same line.
      var head = document.createElement('div');
      head.className = 'webmcp-host-head';
      head.appendChild(left);
      head.appendChild(hostToggle);
      item.appendChild(head);

      // Nested group rows (mirror the web app's WebMCPHostList hierarchy).
      var groupKeys = Object.keys(info.groups);
      if (groupKeys.length > 0) {
        var groupsWrap = document.createElement('div');
        groupsWrap.className = 'webmcp-groups';
        groupKeys.forEach(function (gk, idx) {
          var g = info.groups[gk];
          // Switch position reflects the group's OWN state; the host gate is
          // expressed via disabled + row dimming (mirrors web BrandSwitch:
          // checked={groupChecked} disabled={!globalEnabled || !checked}).
          // Using effective state here made the switch show "off" while the
          // group itself was on — clicking then toggled the wrong direction.
          var groupOwn = g.enabled !== false;
          var effective = hostOn && groupOwn;
          var row = document.createElement('div');
          row.className = 'webmcp-group' + (effective ? '' : ' disabled-host');

          // Group title = source tab title — that's a group's identity
          // (one toolset version from one page). Tool names go to the
          // preview line. Fallback: tabTitle → first tool name → Group N.
          var titleText = (g.tabTitles && g.tabTitles[0])
            || g.toolNames[0]
            || ('Group ' + (idx + 1));

          var gLeft = document.createElement('div');
          gLeft.className = 'webmcp-group-left';
          gLeft.title = g.toolNames.join(', ') + (g.tabTitles.length ? '\n' + g.tabTitles.join('\n') : '');
          gLeft.addEventListener('click', function () {
            if (typeof g.tabId === 'number') {
              chrome.tabs.update(g.tabId, { active: true });
              window.close();
            }
          });
          var gNameWrap = document.createElement('div');
          gNameWrap.className = 'webmcp-group-name-wrap';
          var gName = document.createElement('span');
          gName.className = 'webmcp-group-name';
          gName.textContent = titleText;
          var gCount = document.createElement('span');
          gCount.className = 'webmcp-group-count';
          gCount.textContent = String(g.count);
          gCount.title = chrome.i18n.getMessage('webmcpToolCountTitle') || 'webmcpToolCountTitle';
          var gNameRow = document.createElement('div');
          gNameRow.className = 'webmcp-group-name-row';
          gNameRow.appendChild(gName);
          gNameRow.appendChild(gCount);
          gNameWrap.appendChild(gNameRow);
          // Tool name preview (light, one line, ellipsized) — mirrors the
          // web group card's tool preview strip.
          if (g.toolNames.length > 0) {
            var gPreview = document.createElement('div');
            gPreview.className = 'webmcp-group-preview';
            gPreview.textContent = g.toolNames.join(' · ');
            gNameWrap.appendChild(gPreview);
          }
          gLeft.appendChild(gNameWrap);

          var gToggleInput: HTMLInputElement | null = null;
          var gToggle = buildToggle({
            checked: groupOwn,
            disabled: !hostOn,
            titleOn: chrome.i18n.getMessage('webmcpToggleGroupTitle') || 'webmcpToggleGroupTitle',
            titleOff: chrome.i18n.getMessage('webmcpGroupDisabled') || 'webmcpGroupDisabled',
            disabledTitle: chrome.i18n.getMessage('webmcpHostDisabled') || 'webmcpHostDisabled',
            onToggle: function (next, done) {
              sendSetEnabled({ type: 'webmcp_set_group_enabled', groupKey: gk, enabled: next }, function (ok) {
                if (ok) {
                  g.enabled = next;
                  row.classList.toggle('disabled-host', !(hostEnabled[host] && next));
                }
                done(ok);
              });
            },
          });
          gToggleInput = gToggle.querySelector('input.webmcp-toggle');

          // Cascade registration: recompute this group row's visual + switch
          // state whenever the host switch changes. Mirrors the web app's
          // effective = hostOn && groupOn semantics.
          groupUpdaters.push(function (hostOnNow: boolean) {
            var effective = hostOnNow && g.enabled !== false;
            row.classList.toggle('disabled-host', !effective);
            if (gToggleInput) {
              gToggleInput.disabled = !hostOnNow;
              gToggleInput.title = !hostOnNow
                ? (chrome.i18n.getMessage('webmcpHostDisabled') || 'webmcpHostDisabled')
                : (gToggleInput.checked
                    ? (chrome.i18n.getMessage('webmcpToggleGroupTitle') || 'webmcpToggleGroupTitle')
                    : (chrome.i18n.getMessage('webmcpGroupDisabled') || 'webmcpGroupDisabled'));
            }
          });

          row.appendChild(gLeft);
          row.appendChild(gToggle);
          groupsWrap.appendChild(row);
        });
        item.appendChild(groupsWrap);
      }

      list.appendChild(item);
    });
  }

  renderIdle();
  // includeDisabled: the popup IS the management surface — it must see
  // disabled hosts/groups so the user can re-enable them. Regular pages
  // get the filtered view (disabled sites simply don't exist for them).
  //
  // Discovery is now registry-backed (event-fed by the static content
  // scripts), so this first read is fast (no per-tab scan). The registry
  // broadcast below re-triggers it whenever a tab reports new tools.
  //
  // Window scoping: the popup has no sender.tab, so background can't tell
  // which window to scope to. Cache chrome.windows.getCurrent()'s id at
  // popup-open time and forward it via options.windowId — otherwise the
  // response would be a CROSS-WINDOW global list.
  let popupWindowId: number | undefined;
  chrome.windows.getCurrent(function (win) {
    if (win && typeof win.id === 'number') popupWindowId = win.id;
  });

  function loadTools() {
    chrome.runtime.sendMessage(
      { type: 'webmcp_discover_tools', options: { includeDisabled: true, windowId: popupWindowId } },
      function (resp: any) {
        if (chrome.runtime.lastError) {
          renderError(chrome.runtime.lastError.message || 'runtime error');
          return;
        }
        if (!resp) {
          renderError('no response from background');
          return;
        }
        if (!resp.ok) {
          renderError(resp.error || 'unknown error');
          return;
        }
        const tools = resp.tools || [];
        if (tools.length === 0) {
          renderNoTools(resp.scannedTabs != null ? `${resp.scannedTabs} tab(s) scanned, 0 tools` : undefined);
          return;
        }
        renderList(tools);
      }
    );
  }

  // Incremental refresh: background broadcasts webmcp_registry_updated
  // whenever a tab pushes a new snapshot (ready/toolchange/poll-diff).
  // Debounced so a burst of tab reports coalesces into one re-render.
  var refreshTimer: number | null = null;
  chrome.runtime.onMessage.addListener(function (message: any) {
    if (message?.type === 'webmcp_registry_updated') {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(function () {
        refreshTimer = null;
        loadTools();
      }, 150);
      return false;
    }
    return false;
  });

  loadTools();
})();

// L2 writer #1: page injection check. Feeds the capability line — search
// itself runs in the background service worker, so "ready" here means
// "page reading is available on the current tab".
(function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      capState.search = 'unavailable';
      capState.note = t('cannotAccessCurrentPage');
      renderCapline();
      return;
    }
    var url = tab.url || '';
    if (url.indexOf('chrome') === 0 || url.indexOf('about:') === 0) {
      capState.search = 'internal';
      capState.note = t('browserInternalPage');
      renderCapline();
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: function () { return !!(window.__agentWeb && (window.__agentWeb as any).ready); }
    }, function (results) {
      if (chrome.runtime.lastError) {
        capState.search = 'error';
        capState.note = t('injectionCheckFailed') + ': ' + chrome.runtime.lastError.message;
        renderCapline();
        return;
      }
      if (results && results[0] && results[0].result === true) {
        capState.search = 'ready';
      } else {
        capState.search = 'inactive';
      }
      renderCapline();
    });
  });
})();

(function () {
  // Whole IIFE is folded away in store builds (CW_CODEX_OAUTH=0) via the
  // __CW_CODEX_OAUTH__ block guard; markup/CSS/locales are also stripped at
  // build time (wxt.config.ts). Dev builds keep full functionality.
  if (__CW_CODEX_OAUTH__) {
  var logEl = document.getElementById('codexLog')!;
  var btn = document.getElementById('codexLoginBtn')!;
  var resetBtn = document.getElementById('codexResetBtn')!;
  var resetCreditBox = document.getElementById('resetCreditBox')!;
  var resetCreditCount = document.getElementById('resetCreditCount')!;
  var resetCreditMeta = document.getElementById('resetCreditMeta')!;
  var resetCreditBtn = document.getElementById('resetCreditBtn')!;
  if (!logEl || !btn || !resetBtn || !resetCreditBox || !resetCreditCount || !resetCreditMeta || !resetCreditBtn) return;

  function sleep(ms: number) { return new Promise<void>(function (r) { setTimeout(r, ms); }); }
  function log(line: string) { logEl.textContent += (logEl.textContent ? '\n' : '') + line; }
  function sendMessage(message: any): Promise<any> {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          var lastErr = chrome.runtime.lastError;
          if (lastErr) {
            reject(new Error(lastErr.message || 'runtime.lastError'));
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  function savePendingAuth(data: any): Promise<void> {
    return chrome.storage.local.set({ codex_pending_auth: data });
  }
  function clearPendingAuth(): Promise<void> {
    return chrome.storage.local.remove('codex_pending_auth');
  }
  function loadPendingAuth(): Promise<any> {
    return new Promise(function (resolve) {
      chrome.storage.local.get('codex_pending_auth', function (res) {
        resolve(res && res.codex_pending_auth ? res.codex_pending_auth : null);
      });
    });
  }

  var statusDot = document.getElementById('codexStatusDot')!;
  var statusText = document.getElementById('codexStatusText')!;

  function setCodexStatus(state: string, text: string) {
    if (statusDot) {
      var colors: Record<string, string> = {
        authorized: '#22c55e',
        pending: '#eab308',
        expired: '#ef4444',
        idle: '#d1d5db',
        error: '#ef4444',
      };
      statusDot.style.background = colors[state] || '#d1d5db';
    }
    if (statusText) statusText.textContent = text;
  }

  // Check current auth status from background on popup open
  sendMessage({ type: 'codex_get_status' }).then(function (resp) {
    if (!resp || !resp.ok || !resp.data) {
      setCodexStatus('error', t('statusCheckFailed'));
      return;
    }
    var d = resp.data;
    switch (d.authState) {
      case 'authorized':
        setCodexStatus('authorized', t('authorized'));
        break;
      case 'pending':
        setCodexStatus('pending', t('authorizationPending'));
        break;
      case 'expired':
        setCodexStatus('expired', t('tokenExpired'));
        break;
      default:
        setCodexStatus('idle', t('notAuthorized'));
    }

    // Load usage data if authorized
    if (d.authState === 'authorized') {
      loadUsageData();
    }

    // Only poll when the background explicitly reports a pending device-code
    // authorization. An expired/missing token must not revive a stale pending
    // record left by an earlier login attempt.
    if (d.authState === 'pending') {
      loadPendingAuth().then(function (p) {
        if (p && p.device_auth_id && p.user_code && p.expires_at && p.expires_at > Date.now()) {
          setCodexStatus('pending', t('waitingForAuthorization'));
          // Start polling every 5 seconds within the popup
          var pollInterval = setInterval(function () {
            sendMessage({
              type: 'codex_auth_poll',
              deviceAuthId: p.device_auth_id,
              userCode: p.user_code,
            }).then(function (pollResp) {
              if (pollResp && pollResp.done) {
                clearInterval(pollInterval);
                setCodexStatus('authorized', t('authorizedCanUseCodex'));
                document.getElementById('deviceCodeBox')!.style.display = 'none';
                loadUsageData();
              } else if (pollResp && pollResp.pending) {
                setCodexStatus('pending', t('waitingForAuthorization'));
              } else if (!pollResp || !pollResp.ok) {
                clearInterval(pollInterval);
                setCodexStatus('error', t('authorizationFailed'));
              }
            }).catch(function (err: any) {
              clearInterval(pollInterval);
              // Do not leave the popup stuck on “checking” when the
              // background service worker is unavailable or the message fails.
              setCodexStatus('error', t('authorizationFailed'));
              log(t('pollError', String(err?.message || err)));
            });
            // Stop polling if expired
            if (p.expires_at && p.expires_at <= Date.now()) {
              clearInterval(pollInterval);
              setCodexStatus('expired', t('authorizationCodeExpired'));
            }
          }, 5000);
        }
      });
    }
  }).catch(function () {
    setCodexStatus('error', t('failedToCheckStatus'));
  });

  loadPendingAuth().then(function (p) {
    if (!p) return;
    if (p.user_code && p.expires_at && p.expires_at > Date.now()) {
      showDeviceCode(p.user_code, p.verification_uri_complete || p.verification_uri);
    }
  });

  // ── Usage display helpers ──

  function parseWindow(headers: Record<string, string>, prefix: string) {
    var pctStr = headers[prefix + '-used-percent'];
    if (pctStr == null) return null;
    var pct = parseFloat(pctStr);
    if (!isFinite(pct)) return null;
    var winStr = headers[prefix + '-window-minutes'];
    var resetStr = headers[prefix + '-reset-at'];
    var windowMinutes = winStr ? parseInt(winStr, 10) || null : null;
    var resetAt = resetStr ? parseInt(resetStr, 10) || null : null;
    // codex-rs `has_data` guard: a window whose fields are all zero/empty is
    // a placeholder the server emits when no secondary limit applies, not a
    // real 100%-remaining bar. Drop it so we don't render a phantom row.
    var hasData = pct !== 0 || (windowMinutes != null && windowMinutes !== 0) || resetAt != null;
    if (!hasData) return null;
    return {
      usedPercent: pct,
      windowMinutes: windowMinutes,
      resetAt: resetAt,
    };
  }

  // Ported from codex-rs `get_limits_duration` (tui/src/chatwidget.rs).
  // Derives a short label from the window duration so the popup stays correct
  // no matter which windows OpenAI returns (5h / weekly / monthly / ...).
  function formatDurationLabel(windowMinutes: number | null, fallback: string): string {
    var M = 60, D = 24 * M, W = 7 * D, MO = 30 * D, BIAS = 3;
    if (windowMinutes == null || windowMinutes < 0) return fallback;
    if (windowMinutes <= D + BIAS) {
      var hours = Math.max(1, Math.floor((windowMinutes + BIAS) / M));
      return hours + 'h';
    }
    if (windowMinutes <= W + BIAS) return 'Wk';
    if (windowMinutes <= MO + BIAS) return 'Mo';
    return 'Yr';
  }

  function formatResetTime(resetAt: number) {
    if (!resetAt) return '';
    var d = new Date(resetAt * 1000);
    var now = Date.now();
    if (d.getTime() <= now) return t('resetting');
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var today = new Date(now);
    if (d.toDateString() === today.toDateString()) {
      return t('todayAt', hh + ':' + mm);
    }
    var month = d.getMonth() + 1;
    var day = d.getDate();
    return month + '/' + day + ' ' + hh + ':' + mm;
  }

  function getBarColor(pct: number) {
    if (pct >= 90) return '#ef4444';
    if (pct >= 70) return '#f59e0b';
    return '#22c55e';
  }

  function renderWindow(containerId: string, label: string, win: any) {
    var el = document.getElementById(containerId)!;
    if (!el || !win) { if (el) el.innerHTML = ''; return; }
    var remaining = Math.max(0, 100 - win.usedPercent);
    var color = getBarColor(win.usedPercent);
    var resetLabel = formatResetTime(win.resetAt);
    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">' +
        '<span style="font-size:10px;font-weight:600;color:#6b7280;width:22px;">' + label + '</span>' +
        '<div style="flex:1;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">' +
          '<div style="height:100%;width:' + Math.min(100, remaining) + '%;background:' + color + ';border-radius:3px;transition:width 0.3s;"></div>' +
        '</div>' +
        '<span style="font-size:10px;font-weight:600;color:' + color + ';min-width:36px;text-align:right;">' + t('percentLeft', String(Math.round(remaining))) + '</span>' +
      '</div>' +
      (resetLabel ?
        '<div style="font-size:10px;color:#9ca3af;margin-left:30px;">' + t('resetsAt', resetLabel) + '</div>'
        : '');
  }

  // ── Rich rendering for the live /codex/usage payload (persisted by the
  // background as `codex_usage.live`). Everything here is additive: when the
  // field is absent the row simply stays hidden.
  function renderLiveUsage(live: any) {
    if (!live || typeof live !== 'object') return;

    // Spend control (team/workspace credit budget) — string decimals from
    // the API, so parse before formatting.
    var spend = live.spend_control && live.spend_control.individual_limit;
    var spendEl = document.getElementById('usageSpend');
    if (spendEl) {
      var used = spend ? parseFloat(spend.used) : NaN;
      var limit = spend ? parseFloat(spend.limit) : NaN;
      if (spend && isFinite(used) && isFinite(limit) && limit > 0) {
        var pct = Math.round((used / limit) * 100);
        spendEl.style.display = 'block';
        // chrome.i18n.getMessage takes all substitutions as ONE array —
        // passing them as separate arguments silently drops the extras.
        spendEl.textContent = t('spendControl', [String(Math.round(used)), String(Math.round(limit)), String(pct)]);
      } else {
        spendEl.style.display = 'none';
      }
    }

    // Available models — up to three names, collapsed with +N when longer.
    var modelsEl = document.getElementById('usageModels');
    if (modelsEl) {
      var modelUsage = live.model_usage || {};
      var names = Object.keys(modelUsage).filter(function (id) { return modelUsage[id] && modelUsage[id].available; });
      if (names.length > 0) {
        var shown = names.slice(0, 3).join(', ');
        var extra = names.length - 3;
        modelsEl.style.display = 'block';
        modelsEl.textContent = extra > 0 ? t('modelsAvailable', shown + ' +' + extra) : t('modelsAvailable', shown);
      } else {
        modelsEl.style.display = 'none';
      }
    }
  }

  // ── Device code display + copy ──

  function showDeviceCode(code: string, url?: string) {
    var box = document.getElementById('deviceCodeBox')!;
    var textEl = document.getElementById('deviceCodeText')!;
    var linkEl = document.getElementById('deviceCodeLink')!;
    if (!box || !textEl) return;
    textEl.textContent = code || '';
    box.style.display = 'block';
    if (url) {
      linkEl.innerHTML = '<a href="' + url + '" target="_blank" style="color: #0d9488; text-decoration: none;">' + url + '</a>';
    } else {
      linkEl.innerHTML = '';
    }
  }

  document.getElementById('copyCodeBtn')!.addEventListener('click', function () {
    var code = (document.getElementById('deviceCodeText')!.textContent || '').trim();
    if (!code) return;
    var btn = document.getElementById('copyCodeBtn')!;
    navigator.clipboard.writeText(code).then(function () {
      btn.textContent = '✓';
      btn.style.color = '#22c55e';
      setTimeout(function () {
        btn.textContent = '📋';
        btn.style.color = '#6b7280';
      }, 1500);
    });
  });

  function renderResetCredits(resp: any) {
    if (!resp || !resp.ok || !resp.data) {
      resetCreditBox.style.display = 'none';
      return;
    }
      var credits = Array.isArray(resp.data.credits) ? resp.data.credits : [];
      var available = credits.filter(function (credit: any) { return credit && credit.status === 'available' && credit.id; });
      var count = typeof resp.data.available_count === 'number' ? resp.data.available_count : available.length;
      if (count <= 0 || available.length === 0) {
        resetCreditBox.style.display = 'none';
        return;
      }
      resetCreditBox.style.display = 'block';
      resetCreditCount.textContent = t('availableCount', String(count));
      var expiresAt = available
        .map(function (credit: any) { return credit.expires_at ? new Date(credit.expires_at).getTime() : Infinity; })
        .filter(function (value: number) { return isFinite(value); })
        .sort(function (a: number, b: number) { return a - b; })[0];
      resetCreditMeta.textContent = isFinite(expiresAt)
        ? t('resetCreditExpires', new Date(expiresAt).toLocaleDateString())
        : '';
      resetCreditBtn.dataset.creditId = available[0].id;
  }

  // Stale-while-revalidate (mirrors loadUsageData): paint the cached credit
  // count instantly on popup open, then refresh from the live endpoint. The
  // cache is dropped on consume, so a just-used credit never lingers.
  function loadResetCredits() {
    sendMessage({ type: 'codex_get_reset_credits_cached' }).then(function (cachedResp) {
      if (cachedResp && cachedResp.ok && cachedResp.data) {
        renderResetCredits(cachedResp);
      }
      return sendMessage({ type: 'codex_get_reset_credits' }).then(function (resp) {
        renderResetCredits(resp);
      });
    }).catch(function () {
      resetCreditBox.style.display = 'none';
    });
  }

  // Shared renderer for a `codex_usage` snapshot (headers + optional live
  // payload). Used by both the popup-open load path and the manual refresh
  // button, so they always stay visually consistent.
  function renderSnapshotUsage(usage: any) {
    if (!usage) return;
    var headers = usage.headers || {};
    // Both windows are optional — render whichever the server returns and
    // hide the other. Labels are derived from each window's `window-minutes`
    // (matching codex-rs), so this stays correct if OpenAI re-enables the
    // 5-hour window or changes durations later.
    var primary = parseWindow(headers, 'x-codex-primary');
    var secondary = parseWindow(headers, 'x-codex-secondary');
    if (!primary && !secondary) return;

    var container = document.getElementById('codexUsage')!;
    if (container) container.style.display = 'block';

    var planType = headers['x-codex-plan-type'] || headers['x-codex-active-limit'] || '';
    var planEl = document.getElementById('usagePlan')!;
    if (planEl && planType) planEl.textContent = planType;

    renderWindow('usagePrimary', formatDurationLabel(primary && primary.windowMinutes, '5h'), primary);
    renderWindow('usageSecondary', formatDurationLabel(secondary && secondary.windowMinutes, 'Wk'), secondary);
    renderLiveUsage(usage.live);

    if (usage.updatedAt) {
      var updatedEl = document.getElementById('usageUpdated')!;
      if (updatedEl) updatedEl.textContent = t('updatedAt', new Date(usage.updatedAt).toLocaleTimeString());
    }
  }

  function loadUsageData() {
    // Stale-while-revalidate: paint the cached snapshot FIRST so the popup
    // opens with numbers instead of an empty box, then re-render from the
    // live /codex/usage query when it resolves (renderSnapshotUsage shows
    // each snapshot's own updatedAt, so the swap is self-explaining).
    sendMessage({ type: 'codex_get_usage' }).then(function (cachedResp) {
      if (cachedResp && cachedResp.ok && cachedResp.data) {
        renderSnapshotUsage(cachedResp.data);
      }
      // Fire the live refresh regardless — the cached paint is a preview,
      // not a substitute. Errors fall through to the cached render above.
      return sendMessage({ type: 'codex_query_usage' }).then(function (resp) {
        if (resp && resp.ok && resp.data) {
          renderSnapshotUsage(resp.data);
          loadResetCredits();
          return;
        }
        if (resp && !resp.ok) {
          console.warn('[popup] live usage query failed:', resp.message || resp.error || resp.errorCode);
        }
        loadResetCredits();
      });
    }).catch(function () {
      loadResetCredits();
    });
  }

  resetCreditBtn.addEventListener('click', async function () {
    var creditId = resetCreditBtn.dataset.creditId || '';
    if (!creditId) return;
    if (!window.confirm(t('useResetCreditConfirm'))) return;
    resetCreditBtn.disabled = true;
    try {
      var resp = await sendMessage({ type: 'codex_consume_reset_credit', creditId: creditId });
      if (!resp || !resp.ok) {
        log(t('resetCreditFailed', String(resp?.message || resp?.errorCode || 'unknown error')));
        return;
      }
      log(t('resetCreditUsed'));
      resetCreditBox.style.display = 'none';
      loadUsageData();
    } catch (err: any) {
      log(t('resetCreditFailed', String(err?.message || err)));
    } finally {
      resetCreditBtn.disabled = false;
    }
  });

  resetBtn.addEventListener('click', async function () {
    await chrome.storage.local.remove(['codex_pending_auth', 'codex_tokens', 'codex_token_saved_at', 'codex_usage', 'codex_reset_credits']);
    logEl.textContent = '';
    setCodexStatus('idle', t('notAuthorized'));
    var usageEl = document.getElementById('codexUsage')!;
    if (usageEl) usageEl.style.display = 'none';
    log(t('loginStateCleared'));
  });

  // Manual refresh: force a live /codex/usage query. The popup path always
  // queries; the 4-minute throttle only gates the alarm-driven refresh.
  var usageRefreshBtn = document.getElementById('usageRefreshBtn');
  if (usageRefreshBtn) {
    usageRefreshBtn.addEventListener('click', function () {
      var updatedEl = document.getElementById('usageUpdated');
      if (updatedEl) updatedEl.textContent = t('refreshing');
      sendMessage({ type: 'codex_query_usage' }).then(function (resp) {
        console.log('[popup] refresh response:', JSON.stringify({
          ok: resp && resp.ok,
          errorCode: resp && resp.errorCode,
          message: resp && resp.message,
          hasData: Boolean(resp && resp.data),
          hasLive: Boolean(resp && resp.data && resp.data.live),
          headers: resp && resp.data && resp.data.headers,
        }));
        if (resp && resp.ok && resp.data) {
          renderSnapshotUsage(resp.data);
        } else if (updatedEl) {
          updatedEl.textContent = t('refreshFailed');
        }
      }).catch(function (err) {
        console.warn('[popup] refresh threw:', err);
        if (updatedEl) updatedEl.textContent = t('refreshFailed');
      });
    });
  }

  btn.addEventListener('click', async function () {
    logEl.textContent = '';

    var pending = await loadPendingAuth();
    var d: any;

    if (pending && pending.device_auth_id && pending.user_code && pending.expires_at && pending.expires_at > Date.now()) {
      d = {
        user_code: pending.user_code,
        device_auth_id: pending.device_auth_id,
        verification_uri: pending.verification_uri,
        verification_uri_complete: pending.verification_uri_complete,
        expires_in: Math.max(1, Math.floor((pending.expires_at - Date.now()) / 1000)),
        interval: 5,
      };
      log(t('resumingLogin'));
      showDeviceCode(d.user_code, d.verification_uri_complete || d.verification_uri);
    } else {
      var start;
      try {
        start = await sendMessage({ type: 'codex_auth_start' });
      } catch (err: any) {
        log(t('startError', String((err && err.message) || err || 'runtime sendMessage failed')));
        return;
      }
      if (!start) {
        log(t('noBackgroundResponse'));
        return;
      }
      if (!start.ok) {
        log(t('startError', JSON.stringify(start.error || start)));
        return;
      }

      d = start.data || {};
      showDeviceCode(d.user_code, d.verification_uri_complete || d.verification_uri);

      await savePendingAuth({
        user_code: d.user_code,
        device_auth_id: d.device_auth_id,
        verification_uri: d.verification_uri,
        verification_uri_complete: d.verification_uri_complete,
        expires_at: Date.now() + (d.expires_in || 900) * 1000,
      });

      if (d.verification_uri_complete || d.verification_uri) {
        chrome.tabs.create({ url: d.verification_uri_complete || d.verification_uri });
      }
    }

    var intervalMs = (d.interval || 5) * 1000;
    var deadline = Date.now() + (d.expires_in || 900) * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      var poll = await sendMessage({
        type: 'codex_auth_poll',
        deviceAuthId: d.device_auth_id,
        userCode: d.user_code,
      });

      if (!poll || !poll.ok) {
        log(t('pollError', JSON.stringify(poll && poll.error ? poll.error : poll)));
        return;
      }

      if (poll.done) {
        await clearPendingAuth();
        log(t('authorizationSucceeded'));
        setCodexStatus('authorized', t('authorizedCanUseWebApp'));
        document.getElementById('deviceCodeBox')!.style.display = 'none';
        return;
      }

      if (poll.pending) {
        log(t('authorizationPendingLog', String(poll.code)));
        if (poll.code === 'slow_down') intervalMs += 2000;
      }
    }

    await clearPendingAuth();
    log(t('authorizationExpiredLog'));
  });
  } // end if (__CW_CODEX_OAUTH__)
})();

document.getElementById('openDocs')!.addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://github.com/nutstore/creatorweave/blob/main/browser-extension/README.md' });
});
document.getElementById('openGithub')!.addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://github.com/nutstore/creatorweave' });
});

// ── Supported Sites entry → recipes management page ──
// Shows "N/M enabled" and opens the full-page manager in a tab
// (the manager needs space for tool chips + descriptions).
(function () {
  var btn = document.getElementById('supportedSitesBtn');
  var sub = document.getElementById('sitesSubtitle');
  if (!btn || !sub) return;

  // Recipes metadata is tiny; import from the shared module.
  import('../webmcp/recipes').then(function (mod) {
    var total = mod.recipes.length;
    function refresh() {
      chrome.storage.local.get(mod.ENABLED_RECIPES_STORAGE_KEY, function (stored) {
        var enabled = stored && stored[mod.ENABLED_RECIPES_STORAGE_KEY];
        var count = enabled && typeof enabled === 'object' ? Object.keys(enabled).length : 0;
        sub.textContent = chrome.i18n.getMessage('recipesCount', [String(count), String(total)])
          || (count + ' / ' + total + ' enabled');
      });
    }
    refresh();
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes[mod.ENABLED_RECIPES_STORAGE_KEY]) refresh();
    });
  }).catch(function () {
    // metadata import failed — keep the entry but show a dash
  });

  btn.addEventListener('click', function () {
    chrome.tabs.create({ url: chrome.runtime.getURL('/recipes.html') });
    window.close();
  });
})();

// ── External agent MCP bridge (WebMCP tools for out-of-browser MCP clients) ──
// Any MCP stdio client works: Codex, Claude Code, Cursor, …
// Toggle sends webmcp_bridge_set_enabled to the background, which owns the
// connectNative port + daemon lifecycle (see entrypoints/webmcp/native-bridge.ts).
// When running, shows ready-to-paste setup commands built from the daemon's
// hello (binaryPath comes from the native host itself).
(function () {
  var box = document.getElementById('webmcpBridgeBox');
  var toggle = document.getElementById('bridgeToggle') as HTMLInputElement | null;
  var statusText = document.getElementById('bridgeStatusText');
  var cmdBox = document.getElementById('bridgeCmdBox');
  var cmdCodex = document.getElementById('bridgeCmdCodex');
  var cmdClaude = document.getElementById('bridgeCmdClaude');
  var infoRow = document.getElementById('bridgeInfoRow');
  if (!box || !toggle || !statusText || !cmdBox || !cmdCodex || !cmdClaude || !infoRow) return;

  // The bridge is useless without the native host binary — probe it first
  // (sendNativeMessage ping via the background's native_host_call relay)
  // and keep the whole card hidden when the host isn't installed. This
  // mirrors the web app's capability detection: features that can't work
  // on this machine simply don't appear.
  function probeNativeHost(done: (ok: boolean) => void): void {
    chrome.runtime.sendMessage(
      { type: 'native_host_call', action: 'ping' },
      function (resp: any) {
        void chrome.runtime.lastError;
        done(!!(resp && resp.ok));
      }
    );
  }

  probeNativeHost(function (hostAvailable) {
    if (!hostAvailable) return; // stay hidden — no native host installed
    box.style.display = '';
    query();
  });

  function buildMcpCommandTail(binaryPath: string | undefined): string {
    // binaryPath comes from the daemon hello (current_exe) — the exact
    // binary Chrome launched via the NM manifest. Same binary for both
    // roles is a protocol requirement. The bare-name fallback only covers
    // a theoretical missing-hello window.
    // Always double-quote: installed paths contain spaces
    // ("EO2Weave NativeHost", "Application Support") — an unquoted path
    // makes `codex mcp add` split it into command + bogus args, and the
    // server fails to start with "connection closed".
    var bin = binaryPath && binaryPath.indexOf('cw-native-host') !== -1
      ? '"' + binaryPath + '"'
      : 'cw-native-host';
    return bin + ' --mcp-stdio';
  }

  function render(resp: any): void {
    var enabled = resp && resp.ok && resp.enabled === true;
    var status = (resp && resp.status) || {};
    var running = status.running === true;
    toggle.checked = enabled;
    toggle.disabled = false;
    if (running) {
      statusText.textContent = chrome.i18n.getMessage('bridgeRunning', [String(status.port || '?')])
        || ('Running on 127.0.0.1:' + String(status.port || '?'));
      statusText.style.color = '#0f766e';
      var cmdTail = buildMcpCommandTail(status.binaryPath);
      cmdCodex.textContent = 'codex mcp add eo2weave-webmcp -- ' + cmdTail;
      cmdClaude.textContent = 'claude mcp add eo2weave-webmcp -- ' + cmdTail;
      cmdBox.style.display = '';
    } else if (enabled) {
      statusText.textContent = status.lastError
        ? t('bridgeError') + ': ' + String(status.lastError).slice(0, 120)
        : t('bridgeStarting');
      statusText.style.color = '#b86e0d';
      cmdBox.style.display = 'none';
    } else {
      statusText.textContent = t('bridgeOff');
      statusText.style.color = '#737373';
      cmdBox.style.display = 'none';
    }
  }

  function query(): void {
    chrome.runtime.sendMessage({ type: 'webmcp_bridge_get_status' }, function (resp: any) {
      void chrome.runtime.lastError;
      render(resp);
    });
  }

  toggle.addEventListener('change', function () {
    var enabled = toggle.checked;
    toggle.disabled = true;
    statusText.textContent = enabled ? t('bridgeStarting') : t('bridgeStopping');
    chrome.runtime.sendMessage({ type: 'webmcp_bridge_set_enabled', enabled: enabled }, function (resp: any) {
      void chrome.runtime.lastError;
      render(resp && resp.ok ? resp : null);
      if (!resp || !resp.ok) {
        // failed — reflect actual state on next query
        query();
      }
    });
  });

  function bindCopy(el: HTMLElement): void {
    el.addEventListener('click', function () {
      var text = el.textContent || '';
      function done(ok: boolean) {
        var old = el.textContent;
        el.textContent = ok ? t('bridgeCopied') : t('bridgeCopyFailed');
        window.setTimeout(function () { el.textContent = old; }, 1200);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  }
  bindCopy(cmdCodex);
  bindCopy(cmdClaude);

  // The info row toggles the switch too (bigger hit target, matches the
  // host-card interaction pattern above).
  infoRow.addEventListener('click', function () {
    toggle.checked = !toggle.checked;
    toggle.dispatchEvent(new Event('change'));
  });
  infoRow.addEventListener('keydown', function (e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle.checked = !toggle.checked;
      toggle.dispatchEvent(new Event('change'));
    }
  });

  // NOTE: initial query() runs inside the probeNativeHost callback above —
  // the card stays hidden (and no status request is made) until the native
  // host answers ping.
})();
