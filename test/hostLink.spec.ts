/**
 * Integration test: {@link HostLink} and the relay's page tunnel together.
 *
 * The relay is spawned for real rather than mocked, because the parts most
 * likely to be wrong are the ones a mock would paper over: the exact
 * registration shape, the `/_relay` namespace, the pairing cookie, and the
 * tunnel envelope in both directions.
 *
 * The "browser" here is a plain `fetch`, which is the point: a paired browser
 * reaches the harness over HTTP at the relay's front door, with no socket of
 * its own to keep alive.
 *
 * @module dsh-remote-control/test/hostLink
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { HostLink } from '../src/relay/hostLink.ts'

const RELAY = fileURLToPath(new URL('../relay/server.mjs', import.meta.url))
const PORT = 8200 + Math.floor(Math.random() * 700)
const ORIGIN = `http://127.0.0.1:${PORT}`
/** Shared secret the relay demands before it registers a host. */
const SECRET = 'test-relay-secret'

let relay: ChildProcess
let work: string
/** Everything the relay has logged, so a test can assert on its trace. */
const relayLog: string[] = []

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'hostlink-'))
  relay = spawn(process.execPath, [RELAY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      STATE_FILE: join(work, 'state.json'),
      WEB_ROOT: fileURLToPath(new URL('../relay/web', import.meta.url)),
      PUBLIC_ORIGIN: ORIGIN,
      // The relay refuses to register a host without one, so the suite runs
      // with a secret and the links below have to present it.
      RELAY_SECRET: SECRET,
      // Short enough that a test can watch presence lapse.
      BROWSER_IDLE_MS: '400',
      // The grace window a host blip is covered by. Short enough to keep the
      // suite quick, wide enough that bringing a host back inside it is not a
      // race against the test runner.
      HOST_GRACE_MS: '3000',
      // Small enough that a test can reach the eviction path in four pairings,
      // rather than the fifty a deployment would need.
      PHONE_TOKEN_LIMIT: '3',
      // Short enough that a test can watch a stream the host *accepted* outlive
      // the deadline that only exists for a host that never answers.
      TUNNEL_OPEN_TIMEOUT_MS: '700',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  relay.stdout?.on('data', (chunk: Buffer) => { relayLog.push(chunk.toString('utf8')) })
  relay.stderr?.on('data', (chunk: Buffer) => { relayLog.push(chunk.toString('utf8')) })
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      // Health is behind the secret too: a 401 means the relay is up and
      // refusing, which is the state this loop is waiting to reach.
      const probe = await fetch(`${ORIGIN}/healthz`, { headers: { 'x-dsh-relay-secret': SECRET } })
      if (probe.ok) return
    } catch { /* not up yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 150) })
  }
  throw new Error('relay never started')
})

afterAll(async () => {
  relay?.kill('SIGKILL')
  await rm(work, { recursive: true, force: true }).catch(() => {})
})

/** A logger that swallows output but records warnings for assertions. */
function quietLogger(): { warnings: string[]; logger: { debug(): void; info(): void; warn(m: string): void } } {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => { warnings.push(message) },
    },
  }
}

/** What one hop of the tunnel received and answered. */
interface FrameLog {
  /** Every frame the link was handed, in order. */
  frames: Array<Record<string, unknown>>
  /** Frames the link wrote back, in order. */
  sent: Array<Record<string, unknown>>
}

/** Answers a tunnelled request with a small body. */
type Responder = (frame: Record<string, unknown>, send: (frame: Record<string, unknown>) => void) => void

/**
 * Answer a tunnelled request with a small body.
 * @param frame - the `http-req` frame.
 * @param send - destination for response frames.
 * @returns {void}
 */
const defaultRespond: Responder = (frame, send) => {
  send({ t: 'http-res', id: frame.id, status: 200, headers: { 'content-type': 'text/plain' } })
  send({ t: 'http-chunk', id: frame.id, data: Buffer.from(`served ${String(frame.url)}`).toString('base64') })
  send({ t: 'http-end', id: frame.id })
}

/**
 * Build a link that records tunnel frames and answers them from a script.
 * @param respond - called for each `http-req`.
 * @returns the link, its warning capture, its state path and its frame log.
 */
function makeLink(respond: Responder = defaultRespond): {
  link: HostLink
  warnings: string[]
  statePath: string
  log: FrameLog
} {
  const { warnings, logger } = quietLogger()
  const statePath = join(work, `link-${Math.random().toString(36).slice(2)}.json`)
  const log: FrameLog = { frames: [], sent: [] }
  const link = new HostLink({
    origin: ORIGIN,
    secret: SECRET,
    hostLabel: 'test-host',
    statePath,
    logger,
    backoff: { minMs: 50, maxMs: 200 },
    onFrame: (frame, send) => {
      log.frames.push(frame)
      const reply = (out: Record<string, unknown>): void => { log.sent.push(out); send(out) }
      if (frame.t === 'http-req') respond(frame, reply)
      else if (frame.t === 'ws-open') reply({ t: 'ws-open-ok', id: frame.id })
    },
  })
  return { link, warnings, statePath, log }
}

/**
 * Pair a browser against the running relay.
 * @param link - a started link.
 * @returns the browser cookie value.
 */
async function pair(link: HostLink): Promise<string> {
  const pairUrl = await link.refreshPairing()
  const token = new URL(pairUrl.replace('/#/pair?t=', '/?t=')).searchParams.get('t')
  const response = await fetch(`${ORIGIN}/_relay/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')
  expect(cookie).toContain('dsh-remote-phone=')
  return cookie!.split(';')[0]!
}

/**
 * Start a link and wait for it to come online.
 * @param link - the link to start.
 * @returns resolves once the socket reports online.
 */
async function bringUp(link: HostLink): Promise<void> {
  await link.start()
  await vi.waitFor(() => { expect(link.getStatus().phase).toBe('online') }, { timeout: 10_000 })
}

describe('HostLink against a live relay', () => {
  it('registers, exposes a QR URL, and reports itself online', async () => {
    const { link } = makeLink()
    await bringUp(link)

    const status = link.getStatus()
    expect(status.sessionId).toBeTruthy()
    expect(status.pairUrl).toContain('/#/pair?t=')
    expect(status.pairExpiresAt).toBeGreaterThan(Date.now())
    expect(status.phoneConnected).toBe(false)
    link.stop()
  })

  it('replays a paired browser request through the host', async () => {
    const { link, log } = makeLink()
    await bringUp(link)
    const cookie = await pair(link)

    const response = await fetch(`${ORIGIN}/hello?x=1`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('served /hello?x=1')

    const request = log.frames.find((frame) => frame.t === 'http-req')
    expect(request).toBeDefined()
    expect(request?.method).toBe('GET')
    expect(request?.url).toBe('/hello?x=1')
    // The browser's own cookie names the relay; the host replays are free to
    // drop it, and the tunnel must not depend on it surviving.
    expect(log.frames.some((frame) => frame.t === 'http-req-end')).toBe(true)
    link.stop()
  })

  it('keeps a tunnelled socket open once the host has accepted it', { timeout: 15_000 }, async () => {
    const { link } = makeLink()
    await bringUp(link)
    const cookie = await pair(link)
    const sessionId = link.getStatus().sessionId

    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/s/${sessionId}/api/remote.mux`, {
      headers: { cookie },
    })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })

    // The deadline exists for a host that never answers (`ws-open-ok` never
    // comes). Once it *has*, the stream belongs to the browser and must outlive
    // that deadline — cancelling it is the difference between a working tunnel
    // and one torn down 15s in, over and over.
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(link.getStatus().reconnects).toBe(0)

    socket.close()
    link.stop()
  })

  it('streams a request body to the host and a response body back', async () => {
    const { link, log } = makeLink((frame, send) => {
      send({ t: 'http-res', id: frame.id, status: 201, headers: { 'content-type': 'text/plain' } })
      send({ t: 'http-chunk', id: frame.id, data: Buffer.from('part-one|').toString('base64') })
      send({ t: 'http-chunk', id: frame.id, data: Buffer.from('part-two').toString('base64') })
      send({ t: 'http-end', id: frame.id })
    })
    await bringUp(link)
    const cookie = await pair(link)

    const response = await fetch(`${ORIGIN}/submit`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: 'a-payload',
    })
    expect(response.status).toBe(201)
    expect(await response.text()).toBe('part-one|part-two')

    const body = log.frames.filter((frame) => frame.t === 'http-body')
      .map((frame) => Buffer.from(String(frame.data), 'base64').toString('utf8'))
      .join('')
    expect(body).toBe('a-payload')
    link.stop()
  })

  it('reports a host failure as a 502 rather than hanging', async () => {
    const { link } = makeLink((frame, send) => {
      send({ t: 'http-error', id: frame.id, code: 'host-unreachable', message: 'no route to host' })
    })
    await bringUp(link)
    const cookie = await pair(link)

    const response = await fetch(`${ORIGIN}/broken`, { headers: { cookie } })
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('no route to host')
    link.stop()
  })

  it('answers an unpaired browser with the pairing shell instead of the tunnel', async () => {
    const { link, log } = makeLink()
    await bringUp(link)

    // The bare origin answers 404 now — it is not an advertisement. A pairing
    // link names its session, so the shell only appears on a scoped path.
    const bare = await fetch(`${ORIGIN}/`)
    expect(bare.status).toBe(404)

    const scoped = await fetch(`${ORIGIN}/s/${link.getStatus().sessionId}/`)
    expect(scoped.status).toBe(200)
    expect(await scoped.text()).toContain('Pair this browser')
    expect(log.frames).toHaveLength(0)
    link.stop()
  })

  it('holds a request through a host blip instead of failing it', async () => {
    const { link, statePath } = makeLink()
    await bringUp(link)
    const sessionId = link.getStatus().sessionId
    const cookie = await pair(link)
    const scoped = `${ORIGIN}/s/${sessionId}/during-blip`

    // Drop the host, then ask for a page while its grace window is still open.
    // The relay must not answer with the offline page: the host is expected
    // back, and showing that page is what makes a blip expensive — it reloads
    // the document and throws away whatever the user was in the middle of.
    link.stop()
    await vi.waitFor(async () => {
      const probe = await (await fetch(`${ORIGIN}/_relay/probe?session=${sessionId}`)).json() as
        { online?: boolean }
      expect(probe.online).toBe(false)
    }, { timeout: 5_000 })

    const held = fetch(scoped, { headers: { cookie } })
    // A fresh link on the same state file resumes the session, which is what a
    // plugin reconnecting after a blip does.
    const resumed = new HostLink({
      origin: ORIGIN,
      secret: SECRET,
      hostLabel: 'test-host',
      statePath,
      logger: quietLogger().logger,
      onFrame: defaultRespond,
    })
    await bringUp(resumed)

    // The held request goes out to the host that came back, and the browser
    // sees a normal answer rather than an outage.
    const response = await held
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('served /during-blip')
    resumed.stop()
  })

  it('releases held requests to the offline page once the window closes', { timeout: 15_000 }, async () => {
    const { link } = makeLink()
    await bringUp(link)
    const sessionId = link.getStatus().sessionId
    const cookie = await pair(link)

    // No host comes back this time, so the request held across the window is
    // answered the way an outage is — and the page it gets waits on the relay
    // rather than reloading blindly.
    link.stop()
    await vi.waitFor(async () => {
      const probe = await (await fetch(`${ORIGIN}/_relay/probe?session=${sessionId}`)).json() as
        { online?: boolean }
      expect(probe.online).toBe(false)
    }, { timeout: 5_000 })

    const response = await fetch(`${ORIGIN}/s/${sessionId}/never-returns`, { headers: { cookie } })
    expect(response.status).toBe(503)
    const page = await response.text()
    expect(page).toContain('offline')
    // The regression this guards: a blind reload every 5 s, which discarded the
    // user's in-progress answers on every tick.
    expect(page).not.toContain('location.reload(), 5000')
    expect(page).toContain('/_relay/probe')
  })

  it('tells the host when a browser starts and stops using the session', async () => {
    const { link } = makeLink()
    await bringUp(link)
    const cookie = await pair(link)
    await fetch(`${ORIGIN}/ping`, { headers: { cookie } })

    await vi.waitFor(() => { expect(link.getStatus().phoneConnected).toBe(true) }, { timeout: 5_000 })
    // Presence is inferred from tunnelled traffic, so it lapses once the
    // session is quiet — the relay's idle window is 400 ms in this suite.
    await vi.waitFor(() => { expect(link.getStatus().phoneConnected).toBe(false) }, { timeout: 5_000 })
    link.stop()
  })

  it('persists its session identity so a restart keeps the pairing', async () => {
    const { link, statePath } = makeLink()
    await bringUp(link)
    const first = link.getStatus().sessionId
    link.stop()

    const saved = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, string>
    expect(saved.sessionId).toBe(first)
    expect(saved.hostSecret).toBeTruthy()

    // Reuse the same state file to prove resume, not re-registration.
    const resumed = new HostLink({
      origin: ORIGIN,
      secret: SECRET,
      hostLabel: 'test-host',
      statePath,
      logger: quietLogger().logger,
      onFrame: () => {},
    })
    await bringUp(resumed)
    expect(resumed.getStatus().sessionId).toBe(first)
    resumed.stop()
  })

  it('mints a new pairing token on refresh without changing the session', async () => {
    const { link } = makeLink()
    await bringUp(link)
    const before = link.getStatus()

    const refreshed = await link.refreshPairing()
    const after = link.getStatus()
    expect(after.sessionId).toBe(before.sessionId)
    expect(refreshed).not.toBe(before.pairUrl)
    link.stop()
  })

  it('names the version skew when the relay answers with HTML', async () => {
    // An older relay serves its own page for any path it does not know, so a
    // plugin pointing at one receives HTML with a 200. Reporting that as a JSON
    // parse error would send an operator looking in the wrong place.
    const stale: Server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>older relay</title>')
    })
    await new Promise<void>((resolve) => stale.listen(0, '127.0.0.1', resolve))
    const port = (stale.address() as AddressInfo).port

    const link = new HostLink({
      origin: `http://127.0.0.1:${port}`,
      hostLabel: 'test-host',
      statePath: join(work, `skew-${Math.random().toString(36).slice(2)}.json`),
      logger: quietLogger().logger,
      onFrame: () => {},
      backoff: { minMs: 50, maxMs: 100 },
    })
    await link.start()
    await vi.waitFor(() => {
      expect(link.getStatus().failure?.code).toBe('relay-unreachable')
    }, { timeout: 10_000 })
    expect(link.getStatus().failure?.message).toContain('older build')
    link.stop()
    await new Promise<void>((resolve) => { stale.close(() => resolve()) })
  })

  it('discards a host secret the relay no longer knows', async () => {
    const { link, statePath } = makeLink()
    await bringUp(link)
    link.stop()

    // A stale identity: the relay refuses the socket, and the link must
    // re-register rather than retry a secret that will never work.
    await writeFile(statePath, JSON.stringify({ sessionId: 'gone', hostSecret: 'stale' }))
    const { link: revived } = makeLink()
    const fresh = new HostLink({
      origin: ORIGIN,
      hostLabel: 'test-host',
      statePath,
      logger: quietLogger().logger,
      onFrame: () => {},
      backoff: { minMs: 50, maxMs: 200 },
    })
    void link
    void revived
    await fresh.start()
    await vi.waitFor(() => { expect(fresh.getStatus().sessionId).not.toBe('gone') }, { timeout: 10_000 })
    fresh.stop()
  })

  it('drops the least recently used browser rather than the oldest pairing', async () => {
    const { link, log } = makeLink()
    await bringUp(link)
    const sessionId = String(link.getStatus().sessionId)
    // A real browser asks on its own scope, which is where the shell and the
    // cookie both live.
    const scoped = (path: string): string => `${ORIGIN}/s/${sessionId}${path}`

    // Three tokens fill this suite's list, then the oldest *pairing* is the one
    // that gets used, then a fourth browser pairs. Trimming the front of the
    // list — which is insertion order — would drop the browser that just spoke
    // and keep an idle one; recency is what decides, so the idle one goes.
    const oldest = await pair(link)
    const idle = await pair(link)
    await pair(link)
    const used = await fetch(scoped('/oldest'), { headers: { cookie: oldest } })
    expect(used.status).toBe(200)
    await pair(link)

    const kept = await fetch(scoped('/kept'), { headers: { cookie: oldest } })
    expect(kept.status).toBe(200)
    expect(await kept.text()).toBe('served /kept')

    // The evicted browser is not tunnelled: it is a stranger again, and the
    // shell tells it so rather than quietly showing it someone else's app.
    const before = log.frames.length
    const dropped = await fetch(scoped('/'), { headers: { cookie: idle } })
    expect(dropped.status).toBe(200)
    const shell = await dropped.text()
    expect(shell).toContain('Pair this browser')
    expect(shell).toContain('data-pair-notice="scope"')
    expect(log.frames.length).toBe(before)

    // An eviction that says nothing is indistinguishable from a browser being
    // unpaired at random, which is the failure this replaced.
    await vi.waitFor(() => {
      expect(relayLog.join('')).toContain('dropped browser token last used')
    }, { timeout: 5_000 })
    link.stop()
  })
})

describe('reconnect backoff', () => {
  /**
   * A relay that registers hosts but never lets a socket stay up.
   *
   * This is the shape the backoff bug actually needed: registration has to
   * *succeed*, so `connect()` gets as far as opening a socket, and the socket
   * has to fail *asynchronously*, which is the only way `ws` reports a refused
   * or dropped connection. Pointing the link at a dead port does not reproduce
   * it — `register()` throws first and `openSocket()` is never reached.
   *
   * @returns the stub origin and a way to stop it.
   */
  async function startFlappingRelay(): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      if (request.method === 'POST' && request.url?.startsWith('/_relay/session') === true) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          sessionId: 'flap-session',
          hostSecret: 'flap-secret',
          pairingToken: 'flap-token',
          expiresAt: Date.now() + 60_000,
          pairUrl: 'http://127.0.0.1/#/pair?t=flap-token',
        }))
        return
      }
      response.writeHead(404)
      response.end()
    })
    // Every upgrade is dropped, so the client sees an async error/close rather
    // than a thrown constructor — exactly what a flapping relay looks like.
    server.on('upgrade', (_request, socket) => { socket.destroy() })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as AddressInfo).port
    return {
      origin: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
    }
  }

  it('grows the delay across consecutive failures instead of pinning it at the floor', { timeout: 20_000 }, async () => {
    // The regression this guards: `connect()` used to clear `attempt` as soon
    // as it had *started* a socket. `ws` never throws from its constructor — a
    // dropped connection arrives later as an `error`/`close` event — so the
    // `catch` around `openSocket()` never ran, `attempt` was cleared on every
    // pass, and the ladder stayed pinned at its first rung forever. A flapping
    // link then became a reconnect storm instead of backing off.
    const relay = await startFlappingRelay()
    const delays: number[] = []
    const logger = {
      debug: (message: string): void => {
        const match = /reconnecting in (\d+)ms/u.exec(message)
        if (match) delays.push(Number(match[1]))
      },
      info: (): void => {},
      warn: (): void => {},
    }
    const link = new HostLink({
      origin: relay.origin,
      hostLabel: 'backoff-host',
      statePath: join(work, `backoff-${Math.random().toString(36).slice(2)}.json`),
      logger,
      // Each rung's jitter window starts where the previous one ends, so a
      // working ladder is strictly increasing by construction — no flakiness
      // from the random component.
      backoff: { minMs: 150, maxMs: 30_000 },
      onFrame: () => {},
    })

    try {
      await link.start()
      // Long enough for several rungs; the ladder is what is under test, not
      // the wall-clock timing of any one retry.
      await new Promise((resolve) => { setTimeout(resolve, 3_000) })
      link.stop()

      expect(delays.length).toBeGreaterThanOrEqual(4)
      for (let index = 1; index < delays.length; index += 1) {
        expect(delays[index]).toBeGreaterThan(delays[index - 1]!)
      }
      // The shape that matters in production: a link that keeps failing gets
      // meaningfully less chatty rather than retrying at the floor forever.
      expect(delays.at(-1)!).toBeGreaterThan(delays[0]! * 2)
    } finally {
      link.stop()
      await relay.close()
    }
  })
})