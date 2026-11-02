/**
 * Reloading the plugin is not a Stop.
 *
 * The plugin is disposed and re-applied on every reconfiguration, every reload
 * and every shutdown, and the teardown used to be the same call the panel's Stop
 * button makes: it told the relay the session had ended and deleted the stored
 * identity. A process that was about to come back therefore revoked every
 * browser on its way out, and the browsers were shown the "pairing ended" page
 * and had their cookie cleared — the exact opposite of what the panel promises.
 *
 * This mounts the real plugin over a real relay with a real (stub) web server
 * behind it, pairs a browser, tears the plugin down the way a reload does, and
 * checks what that browser is told. Nothing here is mocked except the harness's
 * own services, and the pieces that matter — the relay session, the stored
 * identity, the pairing cookie — are the real ones.
 *
 * @module dsh-remote-control/test/unmount
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

const RELAY = fileURLToPath(new URL('../relay/server.mjs', import.meta.url))
const WEB_ROOT = fileURLToPath(new URL('../relay/web', import.meta.url))
const PORT = 9000 + Math.floor(Math.random() * 400)
const ORIGIN = `http://127.0.0.1:${PORT}`
/** Shared secret the relay demands before it registers a host. */
const SECRET = 'unmount-suite-secret'

let relay: ChildProcess
let work: string
let home: string
/** The harness web server the tunnel replays into, standing in for the GUI. */
let origin: Server
let originPort: number
/** `DSH_HOME` as it was, so this suite cannot leak into another one. */
let previousHome: string | undefined

/** Where the plugin writes the session identity it must not throw away. */
const identityPath = (): string => join(home, 'dsh-remote-control', 'relay.json')

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'unmount-relay-'))
  home = await mkdtemp(join(tmpdir(), 'unmount-home-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await writeFile(join(home, 'relay-secret'), SECRET, { mode: 0o600 })

  // The tunnelled origin: every request it sees is a request the relay decided
  // to carry, which is what "this browser is still paired" looks like.
  origin = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`served ${request.url ?? '/'}`)
  })
  await new Promise<void>((resolve) => { origin.listen(0, '127.0.0.1', resolve) })
  originPort = (origin.address() as AddressInfo).port

  relay = spawn(process.execPath, [RELAY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      STATE_FILE: join(work, 'state.json'),
      WEB_ROOT,
      PUBLIC_ORIGIN: ORIGIN,
      RELAY_SECRET: SECRET,
      // Short enough that this suite can watch the window close and the
      // browsers be released, without waiting the 30 s a deployment uses.
      HOST_GRACE_MS: '600',
    },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const probe = await fetch(`${ORIGIN}/healthz`, { headers: { 'x-dsh-relay-secret': SECRET } })
      if (probe.ok) return
    } catch { /* not up yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 150) })
  }
  throw new Error('relay never started')
})

afterAll(async () => {
  relay?.kill('SIGKILL')
  await new Promise<void>((resolve) => { origin.close(() => resolve()) })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(work, { recursive: true, force: true }).catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

/**
 * Mount the plugin the way the harness does, and hand back its teardown.
 *
 * The fake context carries only the four seats this plugin touches at mount:
 * `effect` (which is where its teardown is registered), `logger`, `get` for the
 * services it looks up lazily, and `webServer`.
 * @returns the teardown the mount registered.
 */
function mount(): () => void {
  let teardown: (() => void) | undefined
  const ctx = {
    effect: (run: () => () => void) => { teardown = run() },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    get: () => undefined,
    webServer: { port: originPort, register: () => () => {} },
  }
  apply(ctx as unknown as Parameters<typeof apply>[0], { relay: ORIGIN, enabled: true })
  if (teardown === undefined) throw new Error('the mount registered no teardown')
  return teardown
}

/**
 * Wait until the plugin has registered and written its session identity.
 * @returns the stored identity.
 */
async function waitForIdentity(): Promise<{ sessionId: string, hostSecret: string }> {
  let identity: { sessionId?: string, hostSecret?: string } | undefined
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      identity = JSON.parse(await readFile(identityPath(), 'utf8')) as typeof identity
      if (identity?.sessionId && identity.hostSecret) {
        return { sessionId: identity.sessionId, hostSecret: identity.hostSecret }
      }
    } catch { /* not written yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
  throw new Error('the plugin never wrote a session identity')
}

/**
 * Pair a browser against the session the plugin registered.
 *
 * A pairing token is minted the way the panel's QR does it — by asking the relay
 * to register the same host secret again — so this exercises the real pairing
 * exchange without reaching into the plugin's own routes.
 * @param hostSecret - the secret the identity file holds.
 * @returns the browser's cookie header value.
 */
async function pairBrowser(hostSecret: string): Promise<string> {
  const minted = await fetch(`${ORIGIN}/_relay/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-relay-secret': SECRET },
    body: JSON.stringify({ hostSecret }),
  })
  const body = await minted.json() as { pairingToken?: string }
  expect(body.pairingToken).toBeTruthy()
  const paired = await fetch(`${ORIGIN}/_relay/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: body.pairingToken }),
  })
  expect(paired.status).toBe(200)
  const cookie = String(paired.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  expect(cookie).toContain('dsh-remote-phone=')
  return cookie
}

/**
 * Ask the relay to carry one request for this browser.
 * @param cookie - the browser's pairing cookie.
 * @returns the answer, for the caller to judge.
 */
async function browse(cookie: string): Promise<Response> {
  return fetch(`${ORIGIN}/hello`, { headers: { cookie } })
}

describe('plugin teardown', () => {
  // The two waits below are generous on purpose: a mount has to register, open a
  // socket and settle, and the failing case has to be *seen* to fail rather than
  // cut short by the default deadline.
  const SETTLE_MS = 20_000

  it('leaves the pairing intact so a reload does not un-pair every browser', { timeout: 60_000 }, async () => {
    const unmount = mount()
    const identity = await waitForIdentity()
    const cookie = await pairBrowser(identity.hostSecret)

    // The tunnel works: the relay carried the request to the harness's own web
    // server, which is the only thing that answers like this.
    await vi.waitFor(async () => {
      const response = await browse(cookie)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('served /hello')
    }, { timeout: SETTLE_MS })

    // Unload the plugin the way a reload, an upgrade or a shutdown does.
    unmount()

    // What that browser is told is the whole point. The host has gone away, so
    // it is *offline* — a state it recovers from by itself — and its cookie is
    // kept. A revoke would say the pairing ended and expire the cookie, which is
    // what used to greet every browser when the app was restarted.
    await vi.waitFor(async () => {
      const response = await browse(cookie)
      expect(response.status).toBe(503)
      expect(await response.text()).toContain('offline')
      expect(response.headers.get('set-cookie')).toBeNull()
    }, { timeout: SETTLE_MS })

    // The identity is still on disk, which is what lets the next mount resume
    // the session rather than registering a new one.
    const saved = JSON.parse(await readFile(identityPath(), 'utf8')) as { sessionId?: string }
    expect(saved.sessionId).toBe(identity.sessionId)
    expect((await stat(identityPath())).isFile()).toBe(true)

    // Mounting again resumes that session, and the browser that was paired
    // before the reload never has to pair again.
    mount()
    await vi.waitFor(async () => {
      const response = await browse(cookie)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('served /hello')
    }, { timeout: SETTLE_MS })
  })
})
