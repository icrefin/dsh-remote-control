#!/usr/bin/env node
/**
 * Headless-browser inspection harness for the remote UI.
 *
 * The refactor's acceptance criterion is visual — "the remote browser shows the
 * real Harness, scaled sensibly on a phone and a desktop" — so the checks that
 * matter are a rendered screenshot and a DOM reading, not an assertion about a
 * bundle. This drives Chrome over the DevTools protocol for exactly that: size
 * the viewport, navigate, wait for the app to settle, then capture a PNG, dump
 * the DOM, and/or evaluate one expression.
 *
 * A plain `chrome --screenshot` cannot do it: the app holds a WebSocket open, so
 * the load event never fires and the shot races the first paint.
 *
 * Usage:
 *   node scripts/ui-shot.mjs <url> [options]
 *
 * Options:
 *   --width <px>       viewport width            (default 1440)
 *   --height <px>      viewport height           (default 900)
 *   --mobile           apply phone metrics: touch, device scale 2, mobile UA
 *   --wait <ms>        settle time before capture (default 8000)
 *   --after <ms>       settle time after --eval runs   (default 1500)
 *   --out <path>       PNG destination            (default: no screenshot)
 *   --dom <path>       write document.documentElement.outerHTML
 *   --eval <expr>      evaluate in the page and print the JSON result
 *   --script <path>    run a JS file in the page (then settle, like --eval)
 *   --logs             print page console output and uncaught exceptions
 *   --scroll <x,y>     scroll to a point before capturing
 *   --headed           show the window (debugging)
 *   --keep             leave the browser running and print the debug port
 *
 * Environment:
 *   CHROME_BIN  Chrome executable (default: the macOS install path)
 *
 * @module scripts/ui-shot
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const CHROME = process.env.CHROME_BIN
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Parse the command line into a URL plus options.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{url: string, options: Record<string, unknown>}} parsed input.
 */
function parseArgs(argv) {
  const positional = argv.filter((value) => !value.startsWith('--'))
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`)
    if (at === -1) return fallback
    const value = argv[at + 1]
    return value === undefined || value.startsWith('--') ? true : value
  }
  const url = positional.find((value) => value.startsWith('http'))
  if (!url) {
    console.error('usage: node scripts/ui-shot.mjs <url> [--width N] [--height N] [--mobile] [--out path]')
    process.exit(2)
  }
  return {
    url,
    options: {
      width: Number(flag('width', 1440)),
      height: Number(flag('height', 900)),
      mobile: argv.includes('--mobile'),
      headed: argv.includes('--headed'),
      keep: argv.includes('--keep'),
      wait: Number(flag('wait', 8000)),
      after: Number(flag('after', 1500)),
      out: flag('out', undefined),
      dom: flag('dom', undefined),
      evaluate: flag('eval', undefined),
      script: flag('script', undefined),
      logs: argv.includes('--logs'),
      scroll: flag('scroll', undefined),
    },
  }
}

const { url, options } = parseArgs(process.argv.slice(2))
const port = 9400 + Math.floor(Math.random() * 500)
const profile = await mkdtemp(join(tmpdir(), 'dsh-ui-shot-'))

const chromeArgs = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--no-first-run`,
  `--no-default-browser-check`,
  `--disable-crash-reporter`,
  `--disable-breakpad`,
  `--disable-extensions`,
  `--hide-scrollbars`,
  `--window-size=${options.width},${options.height}`,
  'about:blank',
]
if (!options.headed) chromeArgs.unshift('--headless=new', '--no-sandbox', '--disable-gpu')

const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' })

/**
 * List the browser's debuggable targets.
 * @returns {Promise<object[]>} the target list, empty until the port is up.
 */
async function listTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    return await response.json()
  } catch {
    return []
  }
}

/** Poll until a page target exists. */
async function waitForPageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const page = (await listTargets()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
    if (page) return page
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  throw new Error('chrome never exposed a page target')
}

const page = await waitForPageTarget()
const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 })
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let nextId = 1
const pending = new Map()

/**
 * Send one CDP command.
 * @param {string} method - command name.
 * @param {object} params - command parameters.
 * @returns {Promise<any>} the command result.
 */
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** Console and exception lines captured while the page runs. */
const pageLogs = []

socket.on('message', (raw) => {
  let message
  try { message = JSON.parse(raw.toString()) } catch { return }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? [])
      .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type)))
      .join(' ')
    pageLogs.push(`${message.params.type}: ${text}`)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    pageLogs.push(`EXCEPTION: ${details.exception?.description ?? details.text ?? ''}`)
    return
  }
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`))
  else entry.resolve(message.result)
})

await send('Page.enable')
await send('Runtime.enable')

await send('Emulation.setDeviceMetricsOverride', {
  width: options.width,
  height: options.height,
  deviceScaleFactor: options.mobile ? 2 : 1,
  mobile: options.mobile,
})
if (options.mobile) {
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      + ' (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
}

await send('Page.navigate', { url })
await new Promise((resolve) => { setTimeout(resolve, options.wait) })

if (typeof options.scroll === 'string') {
  const [x, y] = options.scroll.split(',').map(Number)
  await send('Runtime.evaluate', { expression: `window.scrollTo(${x || 0}, ${y || 0})` })
  await new Promise((resolve) => { setTimeout(resolve, 500) })
}

if (options.dom) {
  const result = await send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  })
  await writeFile(options.dom, String(result.result.value ?? ''))
  console.log(`dom  → ${options.dom} (${String(result.result.value ?? '').length} chars)`)
}

let expression = typeof options.evaluate === 'string' && options.evaluate !== 'true' ? options.evaluate : undefined
if (typeof options.script === 'string' && options.script !== 'true') {
  expression = await readFile(options.script, 'utf8')
}
if (expression !== undefined) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  console.log('eval →', JSON.stringify(result.result.value ?? result.result.description ?? null, null, 2))
  // Interactive steps mutate the page, so give the app time to re-render
  // before the shot: capturing immediately would photograph the old frame.
  await new Promise((resolve) => { setTimeout(resolve, options.after) })
}

if (options.logs) {
  console.log(`--- page logs (${pageLogs.length}) ---`)
  for (const line of pageLogs.slice(-80)) console.log(line.slice(0, 400))
}

if (options.out) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(options.out, Buffer.from(shot.data, 'base64'))
  console.log(`shot → ${options.out}`)
}

if (options.keep) {
  console.log(`debug port ${port}; page target ${page.webSocketDebuggerUrl}`)
} else {
  try { socket.close() } catch { /* already gone */ }
  chrome.kill('SIGKILL')
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
process.exit(0)