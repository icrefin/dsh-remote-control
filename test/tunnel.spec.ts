/**
 * Tests for the host half of the page tunnel.
 *
 * A real loopback HTTP and WebSocket server stands in for the harness: the
 * behaviours worth pinning are all about how a request is *replayed* — which
 * headers survive, when the cookie is attached and refreshed, how a body is
 * streamed, and what happens when the origin refuses the connection.
 *
 * @module dsh-remote-control/test/tunnel
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { WebReplay, injectIntoHtml, type CookieProvider } from '../src/web/replay.ts'

/** Requests the stand-in origin received, for assertions. */
interface Received {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** A loopback origin plus the replay pointed at it. */
interface Origin {
  port: number
  received: Received[]
  /** Change what the origin answers with. */
  answer: (handler: (request: Received) => { status?: number, headers?: Record<string, string>, body?: string } | undefined) => void
  /** Socket the harness would upgrade for the mux. */
  sockets: ServerSocket[]
  stop: () => Promise<void>
}

/** Every origin a test opened, so they all close. */
const open: Array<{ stop: () => Promise<void> }> = []

afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop()
})

/**
 * Start a stand-in harness origin.
 * @returns the origin description.
 */
async function startOrigin(): Promise<Origin> {
  const received: Received[] = []
  let answer: (request: Received) => { status?: number, headers?: Record<string, string>, body?: string } | undefined = () => undefined
  const sockets: ServerSocket[] = []
  /** Paths the origin refuses outright, to exercise the reset path. */
  const refused = new Set<string>()

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const record: Received = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      received.push(record)
      if (refused.has(record.url)) {
        request.socket.destroy()
        return
      }
      const scripted = answer(record)
      if (scripted === undefined) {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(`origin ${record.url}`)
        return
      }
      response.writeHead(scripted.status ?? 200, scripted.headers ?? { 'content-type': 'text/plain' })
      response.end(scripted.body ?? '')
    })
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data, isBinary) => { socket.send(data, { binary: isBinary }) })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const origin: Origin = {
    port,
    received,
    answer: (handler) => { answer = handler },
    sockets,
    stop: async () => {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => { wss.close(() => resolve()) })
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    },
  }
  open.push(origin)
  return origin
}

/** A cookie provider that records how often it minted. */
function cookieStub(value: string | undefined = 'dsh-auth-x=abc'): CookieProvider & { mints: number, invalidations: number } {
  const state = {
    mints: 0,
    invalidations: 0,
    get: () => { state.mints += 1; return value },
    invalidate: () => { state.invalidations += 1 },
  }
  return state
}

/**
 * Build a replay around a frame sink.
 * @param port - loopback port the replay dials.
 * @param cookie - cookie source.
 * @param inject - optional HTML payload.
 * @returns the replay and a record of the frames it produced.
 */
function makeReplay(port: number, cookie: CookieProvider, inject?: () => { head?: string, body?: string }) {
  const frames: Array<Record<string, unknown>> = []
  const replay = new WebReplay({
    port: () => port,
    cookie,
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    ...(inject ? { inject } : {}),
  })
  return { replay, frames, sink: (frame: Record<string, unknown>) => { frames.push(frame) } }
}

/**
 * Wait until a predicate holds.
 * @param predicate - the condition.
 * @returns resolves once it does.
 */
async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => { if (!predicate()) throw new Error('not yet') }, { timeout: 5_000 })
}

/** Reassemble a response body from its frames. */
function bodyOf(frames: Array<Record<string, unknown>>): string {
  return frames.filter((frame) => frame.t === 'http-chunk')
    .map((frame) => Buffer.from(String(frame.data), 'base64').toString('utf8'))
    .join('')
}

describe('WebReplay HTTP', () => {
  it('replays a request and streams the response in order', async () => {
    const origin = await startOrigin()
    origin.answer(() => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello' }))
    const { replay, frames, sink } = makeReplay(origin.port, cookieStub())

    replay.handle({ t: 'http-req', id: 1, method: 'GET', url: '/a', headers: {} }, sink)
    replay.handle({ t: 'http-req-end', id: 1 }, sink)
    await until(() => frames.some((frame) => frame.t === 'http-end'))

    expect(frames[0]).toMatchObject({ t: 'http-res', id: 1, status: 200 })
    expect(bodyOf(frames)).toBe('hello')
    expect(replay.pending.http).toBe(0)
  })

  it('rewrites the authority, drops browser markers, and attaches the cookie', async () => {
    const origin = await startOrigin()
    const cookie = cookieStub('dsh-auth-zz=secret')
    const { replay, frames, sink } = makeReplay(origin.port, cookie)

    replay.handle({
      t: 'http-req',
      id: 1,
      method: 'GET',
      url: '/api/thing',
      headers: {
        host: 'relay.example',
        origin: 'http://relay.example',
        referer: 'http://relay.example/',
        'sec-fetch-site': 'cross-site',
        cookie: 'dsh-remote-phone=relay-side',
        accept: 'application/json',
      },
    }, sink)
    replay.handle({ t: 'http-req-end', id: 1 }, sink)
    await until(() => frames.some((frame) => frame.t === 'http-end'))

    const seen = origin.received[0]!
    expect(seen.headers.host).toBe(`127.0.0.1:${origin.port}`)
    expect(seen.headers.origin).toBeUndefined()
    expect(seen.headers.referer).toBeUndefined()
    expect(seen.headers['sec-fetch-site']).toBeUndefined()
    expect(seen.headers.cookie).toBe('dsh-auth-zz=secret')
    expect(seen.headers.accept).toBe('application/json')
  })

  it('keeps compression for subresources and drops it for a navigation', async () => {
    const origin = await startOrigin()
    const { replay, frames, sink } = makeReplay(origin.port, cookieStub())

    replay.handle({
      t: 'http-req', id: 20, method: 'GET', url: '/', headers: {
        accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'gzip, br',
      },
    }, sink)
    replay.handle({ t: 'http-req-end', id: 20 }, sink)
    await until(() => frames.filter((frame) => frame.t === 'http-end').length === 1)

    replay.handle({
      t: 'http-req', id: 21, method: 'GET', url: '/assets/index.js', headers: {
        accept: '*/*', 'accept-encoding': 'gzip, br',
      },
    }, sink)
    replay.handle({ t: 'http-req-end', id: 21 }, sink)
    await until(() => frames.filter((frame) => frame.t === 'http-end').length === 2)

    // A navigation's HTML has to stay readable so the display payload can be
    // spliced into it; a bundle does not, and is the bulk of a cold load.
    expect(origin.received[0]?.headers['accept-encoding']).toBeUndefined()
    expect(origin.received[1]?.headers['accept-encoding']).toBe('gzip, br')
  })

  it('never rewrites an encoded body', async () => {
    const origin = await startOrigin()
    // gzip bytes with a text/html label: a rewrite would corrupt them.
    const gzipped = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00])
    origin.answer(() => ({
      status: 200,
      headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      body: gzipped.toString('binary'),
    }))
    const { replay, frames, sink } = makeReplay(origin.port, cookieStub(), () => ({ body: '<injected />' }))

    replay.handle({ t: 'http-req', id: 1, method: 'GET', url: '/', headers: { accept: 'text/html' } }, sink)
    replay.handle({ t: 'http-req-end', id: 1 }, sink)
    await until(() => frames.some((frame) => frame.t === 'http-end'))

    expect(frames.map((frame) => frame.t)).not.toContain('http-error')
    expect(bodyOf(frames)).not.toContain('injected')
  })

  it('streams a request body rather than buffering it whole', async () => {
    const origin = await startOrigin()
    origin.answer((request) => ({ status: 200, body: request.body }))
    const { replay, frames, sink } = makeReplay(origin.port, cookieStub())

    replay.handle({ t: 'http-req', id: 7, method: 'POST', url: '/upload', headers: {} }, sink)
    replay.handle({ t: 'http-body', id: 7, data: Buffer.from('one').toString('base64') }, sink)
    replay.handle({ t: 'http-body', id: 7, data: Buffer.from('two').toString('base64') }, sink)
    replay.handle({ t: 'http-req-end', id: 7 }, sink)
    await until(() => frames.some((frame) => frame.t === 'http-end'))

    expect(origin.received[0]?.body).toBe('onetwo')
  })

  it('keeps a body chunk that arrives before the request exists', async () => {
    const origin = await startOrigin()
    origin.answer((request) => ({ status: 200, body: request.body }))
    // A cookie source that resolves late forces the race: the frames arrive
    // while the replay is still waiting for the browser-session cookie.
    const slow: CookieProvider = {
      get: () => new Promise((resolve) => { setTimeout(() => resolve('dsh-auth-slow=1'), 50) }),
      invalidate: () => {},
    }
    const { replay, frames, sink } = makeReplay(origin.port, slow)

    replay.handle({ t: 'http-req', id: 9, method: 'POST', url: '/early', headers: {} }, sink)
    replay.handle({ t: 'http-body', id: 9, data: Buffer.from('early-bird').toString('base64') }, sink)
    replay.handle({ t: 'http-req-end', id: 9 }, sink)
    await until(() => frames.some((frame) => frame.t === 'http-end'))

    expect(origin.received[0]?.body).toBe('early-bird')
  })

  it('refreshes an expired cookie once and replays the request', async () => {
    const origin = await startOrigin()
    let first = true
    origin.answer(() => {
      if (first) {
        first = false
        return { status: 401, headers: { 'content-type': 'text/plain' }, body: 'denied' }
      }
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'after refresh' }
    })
    const cookie = cookieStub()
    const { replay, frames, sink } = makeReplay(origin.port, cookie)

    replay.handle({ t: 'http-req', id: 3, method: 'GET', url: '/', headers: {} }, sink)
    replay.handle({ t: 'http-req-end', id: 3 }, sink)
    await until(() => frames.some((frame) => frame.t === 'http-end'))

    expect(cookie.invalidations).toBe(1)
    expect(frames[0]).toMatchObject({ t: 'http-res', status: 200 })
    expect(bodyOf(frames)).toBe('after refresh')
    expect(origin.received).toHaveLength(2)
  })

  it('surfaces a second 401 rather than looping', async () => {
    const origin = await startOrigin()
    origin.answer(() => ({ status: 401, headers: { 'content-type': 'text/plain' }, body: 'denied' }))
    const { replay, frames, sink } = makeReplay(origin.port, cookieStub())

    replay.handle({ t: 'http-req', id: 4, method: 'GET', url: '/', headers: {} }, sink)
    replay.handle({ t: 'http-req-end', id: 4 }, sink)
    await until(() => frames.some((frame) => frame.t === 'http-end'))

    expect(frames[0]).toMatchObject({ t: 'http-res', status: 401 })
    expect(origin.received).toHaveLength(2)
  })

  it('reports an unreachable origin instead of hanging', async () => {
    // Port 1 on loopback refuses immediately on every platform we ship.
    const { replay, frames, sink } = makeReplay(1, cookieStub())
    replay.handle({ t: 'http-req', id: 5, method: 'GET', url: '/', headers: {} }, sink)
    replay.handle({ t: 'http-req-end', id: 5 }, sink)

    await until(() => frames.some((frame) => frame.t === 'http-error'))
    expect(frames[0]).toMatchObject({ t: 'http-error', id: 5, code: 'host-unreachable' })
  })

  it('aborts an in-flight request', async () => {
    const origin = await startOrigin()
    origin.answer(() => undefined)
    const { replay, sink } = makeReplay(origin.port, cookieStub())
    let settled = false
    const frames: Array<Record<string, unknown>> = []
    replay.handle({ t: 'http-req', id: 6, method: 'GET', url: '/slow', headers: {} }, (frame) => {
      frames.push(frame)
      settled ||= frame.t === 'http-end'
      sink(frame)
    })
    await until(() => replay.pending.http === 1)
    replay.handle({ t: 'http-abort', id: 6 }, sink)
    expect(replay.pending.http).toBe(0)
    expect(settled).toBe(false)
  })
})

describe('WebReplay HTML injection', () => {
  it('splices the payload into head and body, once', async () => {
    const origin = await startOrigin()
    origin.answer(() => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><head><title>t</title></head><body><div id="root"></div></body></html>',
    }))
    const { replay, frames, sink } = makeReplay(origin.port, cookieStub(), () => ({
      head: '<meta data-dsh-remote-adapt="head" />',
      body: '<script data-dsh-remote-adapt="body"></script>',
    }))

    replay.handle({ t: 'http-req', id: 1, method: 'GET', url: '/', headers: {} }, sink)
    replay.handle({ t: 'http-req-end', id: 1 }, sink)
    await until(() => frames.some((frame) => frame.t === 'http-end'))

    const html = bodyOf(frames)
    expect(html.indexOf('data-dsh-remote-adapt="head"')).toBeLessThan(html.indexOf('</head>'))
    expect(html.indexOf('data-dsh-remote-adapt="body"')).toBeGreaterThan(html.indexOf('<div id="root">'))
    expect(html.indexOf('data-dsh-remote-adapt="body"')).toBeLessThan(html.indexOf('</body>'))
  })

  it('leaves a response that is not HTML untouched', async () => {
    const origin = await startOrigin()
    origin.answer(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' }))
    const { replay, frames, sink } = makeReplay(origin.port, cookieStub(), () => ({ body: '<injected />' }))

    replay.handle({ t: 'http-req', id: 1, method: 'GET', url: '/api/x', headers: {} }, sink)
    replay.handle({ t: 'http-req-end', id: 1 }, sink)
    await until(() => frames.some((frame) => frame.t === 'http-end'))
    expect(bodyOf(frames)).toBe('{"a":1}')
  })

  it('appends when the document has no closing body tag', () => {
    expect(injectIntoHtml('<p>x</p>', { body: '<!--t-->' })).toBe('<p>x</p><!--t-->')
  })

  it('is idempotent', () => {
    const once = injectIntoHtml('<html><body>x</body></html>', { body: '<i data-dsh-remote-adapt="1"></i>' })
    const twice = injectIntoHtml(once, { body: '<i data-dsh-remote-adapt="1"></i>' })
    expect(twice).toBe(once)
  })
})

describe('WebReplay WebSocket', () => {
  it('tunnels a socket in both directions and closes it', async () => {
    const origin = await startOrigin()
    const { replay, frames, sink } = makeReplay(origin.port, cookieStub())

    replay.handle({ t: 'ws-open', id: 2, url: '/api/remote.mux', headers: {} }, sink)
    await until(() => frames.some((frame) => frame.t === 'ws-open-ok'))

    replay.handle({ t: 'ws-msg', id: 2, data: Buffer.from('ping').toString('base64'), binary: false }, sink)
    await until(() => frames.some((frame) => frame.t === 'ws-msg'))

    const echoed = frames.find((frame) => frame.t === 'ws-msg')
    expect(Buffer.from(String(echoed?.data), 'base64').toString('utf8')).toBe('ping')
    expect(origin.sockets).toHaveLength(1)

    replay.handle({ t: 'ws-close', id: 2, code: 1000 }, sink)
    await until(() => replay.pending.sockets === 0)
  })

  it('reports a refused upgrade as ws-error', async () => {
    const { replay, frames, sink } = makeReplay(1, cookieStub())
    replay.handle({ t: 'ws-open', id: 3, url: '/api/remote.mux', headers: {} }, sink)
    await until(() => frames.some((frame) => frame.t === 'ws-error'))
    expect(frames[0]).toMatchObject({ t: 'ws-error', id: 3 })
  })

  it('queues frames that arrive before the handshake finishes', async () => {
    const origin = await startOrigin()
    const { replay, frames, sink } = makeReplay(origin.port, cookieStub())
    replay.handle({ t: 'ws-open', id: 4, url: '/api/remote.mux', headers: {} }, sink)
    // Sent immediately, before `ws-open-ok` can have come back.
    replay.handle({ t: 'ws-msg', id: 4, data: Buffer.from('early').toString('base64'), binary: false }, sink)

    await until(() => frames.some((frame) => frame.t === 'ws-msg'))
    const echoed = frames.find((frame) => frame.t === 'ws-msg')
    expect(Buffer.from(String(echoed?.data), 'base64').toString('utf8')).toBe('early')
  })
})