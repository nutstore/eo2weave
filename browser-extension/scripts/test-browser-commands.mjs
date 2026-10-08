// Real Chrome/CDP tests of the command runtime. Chrome extension APIs are adapted
// to isolated Playwright pages; these tests do not use the user's browser profile.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
const require = createRequire(new URL('../../web/package.json', import.meta.url))
const { chromium } = require('@playwright/test')
const { build } = require('esbuild')
const root = fileURLToPath(new URL('../', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'cw-browser-test-'))
const bundle = join(temp, 'runtime.mjs')
await build({ stdin: { contents: `export * from './lib/bash-commands/browser/runtime'; export * from './lib/bash-commands/browser/command';`, resolveDir: root }, bundle: true, minify: true, platform: 'node', format: 'esm', outfile: bundle })
const api = await import(pathToFileURL(bundle).href)
const browser = await chromium.launch({ channel: process.env.CW_TEST_BROWSER || 'chrome', headless: true })
// Use Chrome's native viewport, as an extension does, without a second CDP
// client's device emulation interfering with captureScreenshot.
const context = await browser.newContext({ viewport: null })
const listeners = new Set(), updates = new Set(), removals = new Set(), detaches = new Set()
const tabs = new Map(), storage = {}, cdps = new Map()
let nextId = 1, activeId
const get = id => { if (!tabs.has(id)) throw new Error(`Tab ${id} absent`); return { id, url: tabs.get(id).url(), title: 'Fixture', active: id === activeId, windowId: 1, status: 'complete' } }
async function createTab({ url = 'about:blank', active = true }) {
  const page = await context.newPage(), id = nextId++
  tabs.set(id, page); if (active) activeId = id
  const cdp = await context.newCDPSession(page); cdps.set(id, cdp)
  for (const name of ['Page.lifecycleEvent', 'Page.frameNavigated', 'Page.navigatedWithinDocument']) cdp.on(name, params => {
    for (const listener of listeners) listener({ tabId: id }, name, params)
    if (name === 'Page.frameNavigated' && !params.frame.parentId) for (const listener of updates) listener(id, { url: params.frame.url })
  })
  await page.goto(url)
  return get(id)
}
globalThis.chrome = {
  runtime: { getPlatformInfo: async () => ({ os: process.platform === 'darwin' ? 'mac' : 'linux' }) },
  storage: { session: { get: async key => ({ [key]: storage[key] }), set: async values => Object.assign(storage, values) } },
  tabs: { query: async () => [...tabs.keys()].map(get), get: async id => get(id), create: createTab,
    update: async (id, value) => { if (value.active) activeId = id; return get(id) },
    remove: async id => { await tabs.get(id).close(); tabs.delete(id); for (const listener of removals) listener(id) },
    onUpdated: { addListener: fn => updates.add(fn) }, onRemoved: { addListener: fn => removals.add(fn) } },
  debugger: { attach: (_target, _version, done) => done(), detach: (_target, done) => done(),
    onDetach: { addListener: fn => detaches.add(fn) }, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    sendCommand: (target, method, params, done) => {
      cdps.get(target.tabId).send(method, params).then(done, error => {
        chrome.runtime.lastError = { message: error.message }; done(); delete chrome.runtime.lastError
      })
    } },
}
api.installBrowserLifecycle()
const run = (args, stdin = '', signal) => api.runBrowserRequest('fixture', api.parseBrowserCommand({ args, stdin }), signal)
const command = (args, stdin = '') => api.invokeBrowserCommand({ args, stdin }, request => api.runBrowserRequest('fixture', request))
let checks = 0
async function check(name, fn) { await fn(); checks++; process.stdout.write(`PASS ${name}\n`) }
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Content-Security-Policy', "script-src 'unsafe-inline'; object-src 'none'")
  res.end(`<!doctype html><html><body>
  <button id="save" onclick="this.dataset.clicked = Number(this.dataset.clicked || 0) + 1">Save</button>
  <input id="name" value="old"><input id="email" type="email" value="old@test.com"><input id="number" type="number" value="12"><input id="check" type="checkbox">
  <div id="editor" contenteditable="true">old</div><select id="select"><option value="a">A</option><option value="b">B</option></select>
  <div id="host"></div><div style="height:1400px"></div><button id="bottom">Bottom</button>
  <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button id="shadow" onclick="this.dataset.clicked=1">Shadow</button>';</script>
  </body></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
try {
  await check('stable tab IDs and background creation', async () => {
    const first = await run(['tab-new', url]); assert.equal(first.tabId, 1)
    const other = await run(['tab-new', '--background']); assert.equal(other.active, false)
    await run(['tab-select', '1']); assert.equal((await run(['tab-list'])).tabs.find(t => t.selected).tabId, 1)
    await run(['tab-close', String(other.tabId)])
  })
  const page = tabs.get(1)
  await check('snapshot refs, subtree and shadow DOM actions', async () => {
    const snap = await run(['snapshot', '--boxes'])
    const node = snap.nodes.find(n => n.name === 'Save' && n.ref)
    assert.ok(node?.box)
    await run(['click', node.ref])
    assert.equal(await page.locator('#save').getAttribute('data-clicked'), '1')
    const sub = await run(['snapshot', '#host'])
    assert.ok(sub.nodes.some(n => n.name === 'Shadow'))
    await run(['click', '#shadow'])
    assert.equal(await page.locator('#shadow').getAttribute('data-clicked'), '1')
    const newer = await run(['snapshot']); const ref = newer.nodes.find(n => n.name === 'Save').ref
    await page.locator('#save').evaluate(el => { el.outerHTML = el.outerHTML })
    await assert.rejects(run(['click', ref]), /detached|resolve|node|Node/)
  })
  await check('targeted fill, append, clear and actual input events', async () => {
    await page.evaluate(() => { window.events = []; document.addEventListener('input', e => window.events.push({ id: e.target.id, trusted: e.isTrusted })) })
    await run(['fill', '#name'], '你好'); await run(['type', '#name', '!'])
    assert.equal(await page.locator('#name').inputValue(), '你好!')
    assert.ok((await page.evaluate(() => window.events)).every(e => e.trusted))
    await run(['fill', '#name'], ''); assert.equal(await page.locator('#name').inputValue(), '')
    await run(['type', '#editor', '+']); assert.equal(await page.locator('#editor').textContent(), 'old+')
    await run(['fill', '#editor'], ''); assert.equal(await page.locator('#editor').textContent(), '')
    await run(['fill', '#email', 'new@test.com']); await run(['type', '#email', 'x'])
    assert.equal(await page.locator('#email').inputValue(), 'new@test.comx')
    await run(['type', '#number', '3']); assert.equal(await page.locator('#number').inputValue(), '123')
  })
  await check('delayed actionability, ambiguous diagnostics and deadline', async () => {
    await page.evaluate(() => { const cover = document.createElement('div'); cover.id='cover'; cover.style='position:fixed;inset:0;background:red;z-index:999'; document.body.append(cover); setTimeout(() => cover.remove(), 250) })
    await run(['click', '#save'])
    const ambiguous = await command(['click', 'button']); assert.equal(ambiguous.exitCode, 1); assert.match(JSON.parse(ambiguous.stderr).error.message, /AMBIGUOUS/)
    const missing = await command(['click', '#missing', '--timeout=150']); assert.equal(missing.exitCode, 1)
    assert.match(missing.stderr, /timed out/)
    await page.evaluate(() => { const large = document.createElement('button'); large.id='large'; large.style='height:2000px;width:100px'; large.onclick=() => large.dataset.clicked='1'; document.body.append(large) })
    await run(['click', '#large'])
    assert.equal(await page.locator('#large').getAttribute('data-clicked'), '1')
    await page.locator('#large').evaluate(el => el.remove())
  })
  await check('checkbox, select, keyboard modifiers and held mouse state', async () => {
    await run(['check', '#check']); await run(['check', '#check']); assert.equal(await page.locator('#check').isChecked(), true)
    await run(['uncheck', '#check']); assert.equal(await page.locator('#check').isChecked(), false)
    await run(['select', '#select', 'b']); assert.equal(await page.locator('#select').inputValue(), 'b')
    await run(['fill', '#name', 'replace']); await run(['press', 'ControlOrMeta+A']); await run(['press', 'Backspace']); assert.equal(await page.locator('#name').inputValue(), '')
    await run(['keydown', 'Shift']); await run(['press', 'a']); await run(['keyup', 'Shift']); assert.equal(await page.locator('#name').inputValue(), 'A')
    await page.evaluate(() => { window.mouse = []; document.addEventListener('mousemove', e => window.mouse.push(e.buttons)) })
    await run(['mousemove', '5', '5']); await run(['mousedown']); await run(['mousemove', '25', '25']); await run(['mouseup'])
    assert.ok((await page.evaluate(() => window.mouse)).includes(1))
  })
  await check('eval captures logs/results and errors under CSP', async () => {
    const result = await run(['eval', 'async () => { console.log("first"); await Promise.resolve(); const x={n:1n}; x.self=x; return x }'])
    assert.match(result.buffer, /^\[log\] first\n\[result\]/); assert.match(result.buffer, /Circular/)
    const failure = await command(['eval', '() => { console.warn("before"); throw new Error("bad") }'])
    assert.equal(failure.exitCode, 1); assert.match(JSON.parse(failure.stderr).error.details.buffer, /\[warn\] before/)
    assert.match((await run(['eval', 'el => el.id', '#name'])).buffer, /\[result\] name/)
  })
  await check('cancellation and timeout terminate JS and prevent queued actions', async () => {
    const controller = new AbortController()
    const running = run(['eval', '() => { while (true) {} }'], '', controller.signal).then(() => null, e => e)
    setTimeout(() => controller.abort(new Error('test canceled')), 120)
    assert.match(String(await running), /canceled/)
    assert.match((await run(['eval', '() => 42'])).buffer, /42/)
    const timeout = await command(['eval', '() => new Promise(() => {})', '--timeout=150']); assert.equal(timeout.exitCode, 1)
    await run(['click', '#save'])
    const holder = new AbortController(), queued = new AbortController()
    const holding = run(['eval', '() => new Promise(() => {})'], '', holder.signal).catch(e => e)
    await new Promise(resolve => setTimeout(resolve, 80))
    const waiting = run(['eval', '() => { window.queuedMutation = true }'], '', queued.signal).catch(e => e)
    queued.abort(new Error('queue canceled')); assert.match(String(await waiting), /canceled/)
    holder.abort(new Error('holder canceled')); await holding
    await run(['eval', '() => 1'])
    assert.equal(await page.evaluate(() => window.queuedMutation), undefined)
  })
  await check('dialog response bypasses the tab queue', async () => {
    let appeared
    const dialog = new Promise(resolve => { appeared = resolve })
    const listener = () => appeared()
    page.on('dialog', listener)
    const pending = run(['eval', '() => prompt("Name?")'])
    await dialog
    await run(['dialog-accept', 'Alice'])
    assert.match((await pending).buffer, /Alice/)
    page.off('dialog', listener)
  })
  await check('screenshots are JSON base64 and preserve viewport layout', async () => {
    const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const shot = await command(['screenshot', '--full-page'])
    assert.equal(shot.exitCode, 0)
    const data = JSON.parse(shot.stdout); const png = Buffer.from(data.data, 'base64')
    assert.equal(data.mimeType, 'image/png'); assert.ok(png.readUInt32BE(20) > 1000)
    assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), before)
    const element = await run(['screenshot', '#bottom']); assert.ok(Buffer.from(element.data, 'base64').length > 100)
  })
  await check('navigation waits and invalidates previous references', async () => {
    const snap = await run(['snapshot']), ref = snap.nodes.find(n => n.name === 'Save').ref
    await run(['goto', `${url}?next=1`, '--wait-until=domcontentloaded'])
    await assert.rejects(run(['click', ref]), /Snapshot expired/)
    await run(['go-back']); assert.equal(page.url(), url)
    await run(['reload']); await run(['goto', `${url}#hash`]); assert.equal(await page.evaluate(() => location.href), `${url}#hash`)
  })
  process.stdout.write(`${checks} real Chrome scenarios passed\n`)
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true })
}
