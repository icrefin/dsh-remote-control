#!/usr/bin/env node
/**
 * End-to-end check: a real browser, through a real relay, against a real
 * harness.
 *
 * The plugin's whole claim is "the remote browser runs the shipped client", and
 * nothing short of a rendered page can confirm it. This starts the same
 * `HostLink` + `WebReplay` the plugin uses against a running `dsh web`, points
 * a real relay at it, pairs headless Chrome, and then asserts what the browser
 * actually rendered — at desktop width, at phone width, and in the display
 * layer's Fit mode.
 *
 * Usage:
 *   node relay/e2e.mjs --dsh http://127.0.0.1:19499 \
 *                      --token <the ?token= from `dsh web` output> \
 *                      [--relay http://127.0.0.1:18899] [--shot-dir /tmp/dsh-e2e]
 *
 * `--relay` may point at a relay this script starts itself with `--relay-start`
 * (a bare `node relay/server.mjs` on an ephemeral port), which is the default
 * when the flag is omitted.
 *
 * @module dsh-remote-relay/e2e
 */

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { HostLink } from '../lib/relay/hostLink.js'
import { WebCookie, WebReplay } from '../lib/web/replay.js'
import { adaptSnippet } from '../lib/web/adapt.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const CHROME = process.env.CHROME_BIN
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const DSH = arg('--dsh', 'http://127.0.0.1:19499')
const TOKEN = arg('--token', process.env.DSH_WEB_TOKEN ?? '')
const SHOT_DIR = arg('--shot-dir', join(tmpdir(), 'dsh-remote-e2e'))
const RELAY = arg('--relay', '')
const RELAY_PORT = Number(arg('--relay-port', 0)) || 8100 + Math.floor(Math.random() * 800)

let passed = 0
let failed = 0
const startedAt = Date.now()

/**
 * Record one check.
 * @param {string} label - what is being checked.
 * @param {unknown} ok - whether it held.
 * @param {unknown} [detail] - printed on failure.
 * @returns {void}
 */
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`)
  }
}

/**
 * Timestamped log line.
 * @param {...unknown} parts - values to print.
 * @returns {void}
 */
const log = (...parts) => console.log(`+${((Date.now() - startedAt) / 1000).toFixed(1)}s`, ...parts)

/**
 * Start the relay on an ephemeral port when the caller did not supply one.
 * @returns {Promise<{origin: string, child: import('node:child_process').ChildProcess|null, dir: string}>}
 *   the relay origin and its process, if this script owns it.
 */
async function startRelay() {
  if (RELAY) return { origin: RELAY.replace(/\/$/u, ''), child: null, dir: '' }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-relay-'))
  const origin = `http://127.0.0.1:${RELAY_PORT}`
  const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(RELAY_PORT),
      HOST: '127.0.0.1',
      STATE_FILE: join(dir, 'state.json'),
      PUBLIC_ORIGIN: origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { if (process.env.E2E_VERBOSE) process.stdout.write(`  [relay] ${chunk}`) })
  child.stderr.on('data', (chunk) => process.stderr.write(`  [relay] ${chunk}`))
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await (await fetch(`${origin}/healthz`)).json()
      if (health.ok) return { origin, child, dir }
    } catch { /* not up yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  throw new Error('the relay never became healthy')
}

/**
 * Start a headless Chrome and wait for a debuggable page.
 *
 * Retried on a fresh port: a browser that is killed while a previous run is
 * still tearing down occasionally never publishes its debugger endpoint, and
 * that is a harness flake, not a product failure.
 *
 * @param {number} width - window width.
 * @param {number} height - window height.
 * @returns {Promise<{chrome: import('node:child_process').ChildProcess, port: number,
 *   target: object, profile: string}>} the browser and its page target.
 */
async function launchChrome(width, height) {
  let lastError = null
  for (let launch = 0; launch < 3; launch += 1) {
    const port = 9400 + Math.floor(Math.random() * 500)
    const profile = await mkdtemp(join(tmpdir(), 'dsh-remote-e2e-chrome-'))
    const chrome = spawn(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
      '--disable-crash-reporter', '--disable-breakpad', '--disable-extensions',
      '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`, 'about:blank',
    ], { stdio: 'ignore' })
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const target = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (target) return { chrome, port, target, profile }
      } catch { /* not up yet */ }
      await new Promise((resolve) => { setTimeout(resolve, 200) })
    }
    chrome.kill('SIGKILL')
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    lastError = new Error(`chrome never exposed a page target on port ${port}`)
  }
  throw lastError ?? new Error('chrome never started')
}

/**
 * Drive headless Chrome over CDP.
 *
 * A plain `--screenshot` cannot do this: the app holds a WebSocket open, so the
 * load event never fires and the capture races the first paint.
 *
 * @param {object} options - navigation and probe settings.
 * @returns {Promise<{probe: object, consoleErrors: string[], shot: string|null}>} what the page produced.
 */
async function render(options) {
  const { url, width, height, mobile = false, wait, screenshot, script } = options
  const { chrome, port, target, profile } = await launchChrome(width, height)

  const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })

  let nextId = 1
  const pending = new Map()
  const consoleErrors = []
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (entry) {
        pending.delete(message.id)
        message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
      }
      return
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(String(message.params.exceptionDetails.exception?.description
        ?? message.params.exceptionDetails.text))
    }
  })
  /** Send one CDP command. */
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: mobile ? 2 : 1, mobile,
  })
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  await send('Page.navigate', { url })
  await new Promise((resolve) => { setTimeout(resolve, wait) })

  // The shell pairs, redirects, then boots the client through the tunnel.
  const shoot = async (name) => {
    if (!name) return null
    await mkdir(SHOT_DIR, { recursive: true })
    const image = await send('Page.captureScreenshot', { format: 'png' })
    const path = join(SHOT_DIR, name)
    await writeFile(path, Buffer.from(image.data, 'base64'))
    return path
  }

  // The probe may change the display mode, so the "before" shot has to be
  // taken first — otherwise the evidence shows only the state it left behind.
  if (options.scriptBefore) {
    await send('Runtime.evaluate', { expression: options.scriptBefore, returnByValue: true, awaitPromise: true })
  }
  const before = await shoot(options.screenshotBefore ?? null)

  let probe = null
  if (script) {
    const result = await send('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true })
    probe = result.result.value ?? null
  }

  const shot = await shoot(screenshot ?? null)

  socket.close()
  chrome.kill('SIGKILL')
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  void port
  return { probe, consoleErrors, shot, before }
}

/** Dismiss the harness's first-run dialogs, then report what is on screen. */
const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let round = 0; round < 8; round += 1) {
    const target = [...document.querySelectorAll('button')]
      .find((b) => /^(continue|configure later|got it|skip)$/i.test((b.textContent || '').trim()))
    if (!target) break
    target.click()
    await sleep(900)
  }
  await sleep(600)
  const switcher = document.getElementById('dsh-remote-display')
  const de = document.documentElement
  const root = document.getElementById('root')
  return {
    title: document.title,
    rendered: Boolean(root && root.childElementCount > 0),
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
    adapted: de.getAttribute('data-dsh-remote-control'),
    viewportMeta: (document.querySelector('meta[name="viewport"]') || {}).content || null,
    switcher: switcher ? { label: switcher.textContent, shown: switcher.getAttribute('data-shown') } : null,
    innerWidth: window.innerWidth,
    overflowX: de.scrollWidth - de.clientWidth,
  }
})()`

/**
 * Dismiss the harness's first-run dialogs and let the client settle.
 *
 * Separate from the reading probe so the "before" screenshot shows the client
 * rather than an onboarding modal.
 */
const DISMISS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let round = 0; round < 8; round += 1) {
    const target = [...document.querySelectorAll('button')]
      .find((b) => /^(continue|configure later|got it|skip)$/i.test((b.textContent || '').trim()))
    if (!target) break
    target.click()
    await sleep(900)
  }
  await sleep(800)
  return true
})()`

/**
 * Report which step the pairing shell is showing.
 *
 * Used on a link that has already been spent, where the right answer is a clear
 * error step — never a spinner that never stops.
 */
const SHELL_STEP = `(async () => {
  await new Promise((r) => setTimeout(r, 5_000))
  const ids = ['step-link', 'step-working', 'step-error', 'step-offline']
  const visible = ids.filter((id) => {
    const el = document.getElementById(id)
    return el !== null && !el.hidden
  })
  return {
    visible,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
  }
})()`

/**
 * Read the display layer, switch it to Fit, and read it again.
 *
 * Both reads happen in one page load because every pairing token is single-use:
 * a second load would need a second pairing.
 */
const READ_AND_SWITCH = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const button = document.getElementById('dsh-remote-display')
  const de = document.documentElement
  const root = document.getElementById('root')
  const read = () => ({
    mode: de.getAttribute('data-dsh-remote-control'),
    viewportMeta: (document.querySelector('meta[name="viewport"]') || {}).content || null,
    switcherShown: button ? button.getAttribute('data-shown') : null,
    switcherLabel: button ? button.textContent : null,
    innerWidth: window.innerWidth,
    overflowX: de.scrollWidth - de.clientWidth,
  })
  const base = read()
  if (button) { button.click(); await sleep(1600) }
  return {
    title: document.title,
    rendered: Boolean(root && root.childElementCount > 0),
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
    base,
    fit: read(),
  }
})()`

let relay = null
let link = null
const work = await mkdtemp(join(tmpdir(), 'dsh-remote-e2e-'))

try {
  if (!TOKEN) {
    console.error('e2e: pass --token (the ?token= value printed by `dsh web`), or set DSH_WEB_TOKEN')
    process.exit(2)
  }
  const dshUrl = new URL(DSH)
  const dshPort = Number(dshUrl.port || 80)

  relay = await startRelay()
  log(`relay: ${relay.origin}`)
  const health = await (await fetch(`${relay.origin}/healthz`)).json()
  check('relay is healthy', health.ok === true, health)

  const cookie = new WebCookie({
    host: '127.0.0.1',
    port: () => dshPort,
    launchUrl: () => `${dshUrl.origin}/?token=${TOKEN}`,
    logger: { debug: () => {}, info: () => {}, warn: (m) => log(`[host] ${m}`) },
  })
  const replay = new WebReplay({
    port: () => dshPort,
    cookie,
    inject: adaptSnippet,
    logger: { debug: () => {}, info: () => {}, warn: (m) => log(`[host] ${m}`) },
  })
  link = new HostLink({
    origin: relay.origin,
    hostLabel: 'e2e-host',
    statePath: join(work, 'relay.json'),
    onFrame: (payload, send) => replay.handle(payload, send),
    logger: { debug: () => {}, info: (m) => log(`[host] ${m}`), warn: (m) => log(`[host:warn] ${m}`) },
  })

  await link.start()
  for (let i = 0; i < 80 && link.getStatus().phase !== 'online'; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  check('host is online', link.getStatus().phase === 'online', link.getStatus())

  const pairUrl = await link.refreshPairing()
  check('a pairing URL was minted', pairUrl.includes('/#/pair?t='), pairUrl)
  log(`pair URL: ${pairUrl}`)

  // ── desktop ─────────────────────────────────────────────────────────────
  const desktop = await render({
    url: pairUrl, width: 1512, height: 950, wait: 26_000,
    screenshot: 'desktop.png', scriptBefore: DISMISS, script: READ_AND_SWITCH,
  })
  check('desktop: no console errors', desktop.consoleErrors.length === 0, desktop.consoleErrors.slice(0, 2))
  check('desktop: the client rendered', desktop.probe?.rendered === true, desktop.probe?.text)
  check('desktop: the client chrome is present',
    /New Session/.test(desktop.probe?.text ?? '') && /Settings/.test(desktop.probe?.text ?? ''),
    desktop.probe?.text)
  check('desktop: the display switcher stays hidden', desktop.probe?.base?.switcherShown === '0',
    desktop.probe?.base)
  check('desktop: no horizontal overflow', desktop.probe?.base?.overflowX === 0, desktop.probe?.base)
  check('desktop: Fit changed nothing', desktop.probe?.fit?.innerWidth === desktop.probe?.base?.innerWidth
    && desktop.probe?.fit?.viewportMeta === desktop.probe?.base?.viewportMeta, desktop.probe?.fit)
  check('desktop: the tunnel minted the browser session', cookie.current !== undefined, cookie.current)

  // ── a spent pairing link must fail loudly, not spin ─────────────────────
  const spent = await render({ url: pairUrl, width: 420, height: 800, wait: 3_000, script: SHELL_STEP })
  check('a reused pairing link lands on the error step',
    spent.probe?.visible?.join() === 'step-error', spent.probe)
  check('a reused pairing link explains itself',
    /used|expired/i.test(spent.probe?.text ?? ''), spent.probe?.text)

  // ── phone ───────────────────────────────────────────────────────────────
  const phone = await render({
    url: await link.refreshPairing(), width: 390, height: 844, mobile: true, wait: 26_000,
    screenshotBefore: 'phone-native.png', screenshot: 'phone-fit.png',
    scriptBefore: DISMISS, script: READ_AND_SWITCH,
  })
  check('phone: no console errors', phone.consoleErrors.length === 0, phone.consoleErrors.slice(0, 2))
  check('phone: the client rendered', phone.probe?.rendered === true, phone.probe?.text)
  check('phone: no horizontal overflow', phone.probe?.base?.overflowX === 0, phone.probe?.base)
  check('phone: the display switcher is offered', phone.probe?.base?.switcherShown === '1', phone.probe?.base)
  check('phone: the viewport asks for content resizing',
    String(phone.probe?.base?.viewportMeta).includes('interactive-widget=resizes-content'),
    phone.probe?.base?.viewportMeta)
  check('phone: it starts in the native reflow', phone.probe?.base?.mode === 'native', phone.probe?.base?.mode)
  check('phone: Fit switches the viewport to the design width',
    String(phone.probe?.fit?.viewportMeta).startsWith('width=1120'), phone.probe?.fit?.viewportMeta)
  check('phone: Fit gives the layout the design width', phone.probe?.fit?.innerWidth === 1120,
    phone.probe?.fit?.innerWidth)
  check('phone: the switcher stays reachable in Fit', phone.probe?.fit?.switcherShown === '1',
    phone.probe?.fit)
  check('phone: Fit leaves no horizontal overflow', phone.probe?.fit?.overflowX === 0, phone.probe?.fit)

  const stats = link.getStatus()
  check('the tunnel served the client', stats.requests > 50, stats.requests)
  check('the tunnel reported no failed frames', stats.errors === 0, stats.errors)

  log(`screenshots in ${SHOT_DIR}`)
} catch (error) {
  failed += 1
  console.error('aborted:', error?.stack ?? String(error))
} finally {
  link?.stop()
  relay?.child?.kill('SIGKILL')
  if (relay?.dir) await rm(relay.dir, { recursive: true, force: true }).catch(() => {})
  await rm(work, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'─'.repeat(60)}`)
console.log(failed === 0 ? `ALL CHECKS PASSED (${passed})` : `${passed} passed, ${failed} FAILED`)
console.log('─'.repeat(60))
process.exit(failed === 0 ? 0 : 1)