#!/usr/bin/env node
/**
 * Phone simulator: drive the real ZCode mobile web app headlessly.
 *
 * Instead of asking a human to scan the pairing QR, this loads the very same
 * page a phone would load and lets its genuine client bundle run. Whatever it
 * asks the paired device for is therefore exactly what a real phone asks for —
 * which is the whole point: it turns "what does the phone call?" into an
 * observation instead of a guess.
 *
 * It drives Chrome over the DevTools protocol so the page's console, its
 * exceptions and its WebSocket traffic are all visible; a plain `--screenshot`
 * never fires on a page that holds a socket open.
 *
 * Usage:
 *   node scripts/phone-sim.mjs "<pairing-url>" [--seconds 90] [--headed]
 *
 * The pairing URL is the one the device prints when it reaches
 * `waiting_terminal`.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const CHROME = process.env.CHROME_BIN
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const argv = process.argv.slice(2)
const url = argv.find((a) => a.startsWith('http'))
const headed = argv.includes('--headed')
const seconds = Number(argv[argv.indexOf('--seconds') + 1]) || 90

if (!url) {
  console.error('usage: node scripts/phone-sim.mjs "<pairing-url>" [--seconds N] [--headed]')
  process.exit(2)
}

const port = 9000 + Math.floor(Math.random() * 900)
const profile = await mkdtemp(join(tmpdir(), 'dsh-phone-sim-'))

/** Timestamped line, so the sequence of events is readable. */
const t0 = Date.now()
const log = (...parts) => {
  const stamp = `+${((Date.now() - t0) / 1000).toFixed(1)}s`
  console.log(`${stamp.padStart(7)} |`, ...parts)
}

const chromeArgs = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--disable-extensions',
  '--window-size=430,900',
  'about:blank',
]
if (!headed) {
  chromeArgs.unshift('--headless=new', '--no-sandbox', '--disable-gpu')
}

log('launching chrome', headed ? '(headed)' : '(headless)', 'debug port', port)
const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' })
let finished = false

/**
 * Ask the browser for its debuggable targets.
 * @returns the target list, or an empty array while the port is not up yet.
 */
async function listTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    return await response.json()
  } catch {
    return []
  }
}

/** Poll until the page target exists. */
async function waitForPageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const targets = await listTargets()
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    if (page) return page
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  throw new Error('chrome never exposed a page target')
}

const page = await waitForPageTarget()
log('attached to page target')

const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let nextId = 1
const pending = new Map()

/**
 * Send one CDP command.
 * @param method - command name.
 * @param params - command parameters.
 * @returns the command result.
 */
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

socket.on('message', (raw) => {
  let message
  try { message = JSON.parse(raw.toString()) } catch { return }
  if (message.id !== undefined) {
    const entry = pending.get(message.id)
    if (entry) {
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    }
    return
  }
  handleEvent(message)
})

/** Render a console argument the way the page meant it. */
function renderArg(arg) {
  if (arg === null || arg === undefined) return String(arg)
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
  if (arg.description) return arg.description
  return arg.type
}

/**
 * Surface everything that tells us what the page is doing.
 * @param message - a CDP event.
 */
function handleEvent(message) {
  const { method, params } = message
  switch (method) {
    case 'Runtime.consoleAPICalled':
      log(`console.${params.type}:`, params.args.map(renderArg).join(' ').slice(0, 300))
      return
    case 'Runtime.exceptionThrown': {
      const details = params.exceptionDetails
      log('EXCEPTION:', (details.exception?.description ?? details.text ?? '').slice(0, 400))
      return
    }
    case 'Log.entryAdded': {
      const entry = params.entry
      if (entry.level === 'verbose') return
      log(`log.${entry.level}:`, String(entry.text ?? '').slice(0, 300))
      return
    }
    case 'Network.webSocketCreated':
      log('WS created:', params.url.slice(0, 140))
      return
    case 'Network.webSocketClosed':
      log('WS closed:', params.url.slice(0, 100))
      return
    case 'Network.webSocketFrameError':
      log('WS frame error:', String(params.errorMessage ?? '').slice(0, 200))
      return
    case 'Network.webSocketFrameSent': {
      const data = params.response.payloadData ?? ''
      if (data.length < 600) log('WS ->', data.slice(0, 300))
      return
    }
    case 'Network.webSocketFrameReceived': {
      const data = params.response.payloadData ?? ''
      if (data.length < 600) log('WS <-', data.slice(0, 300))
      return
    }
    case 'Network.loadingFailed':
      log('NETWORK FAILED:', params.errorText, String(params.url ?? '').slice(0, 120))
      return
    default:
  }
}

/** Tear everything down once. */
async function shutdown(code) {
  if (finished) return
  finished = true
  try { socket.close() } catch { /* already gone */ }
  chrome.kill('SIGKILL')
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  process.exit(code)
}

await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.enable')
log('domains enabled; navigating')

await send('Page.navigate', { url })

// Capture the rendered page before tearing down: the console tells us whether
// the app threw, and the picture tells us whether it actually got past the
// loading screen.
const shotPath = process.env.PHONE_SIM_SHOT
setTimeout(() => {
  if (!shotPath) return
  void (async () => {
    try {
      const result = await send('Page.captureScreenshot', { format: 'png' })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(shotPath, Buffer.from(result.data, 'base64'))
      log('screenshot written to', shotPath)
    } catch (error) {
      log('screenshot failed:', String(error))
    }
  })()
}, Math.max(5, seconds - 5) * 1000)

setTimeout(() => {
  log('--- window closed ---')
  void shutdown(0)
}, seconds * 1000)

process.on('SIGINT', () => { void shutdown(0) })