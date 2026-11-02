/**
 * Tests for the `/api/dsh-remote-control` route family.
 *
 * These exercise the fences rather than the happy path only: the routes are the
 * operator's control surface, and the two ways they can go wrong are serving a
 * non-loopback caller and accepting the wrong method.
 *
 * @module dsh-remote-control/test/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { API, type StatusPayload } from '../src/protocol.ts'
import { makeRoutes, type RemoteController } from '../src/routes.ts'

/** A controller whose behaviour each test can steer. */
function fakeController(overrides: Partial<RemoteController> = {}): RemoteController {
  return {
    getStatus: () => ({
      version: '0.5.2',
      enabled: true,
      phase: 'online',
      relayOrigin: 'http://relay.test',
      relaySource: 'patch',
      relayEditable: true,
      secretSet: false,
      secretPath: '/tmp/relay-secret',
      phoneConnected: false,
      reconnects: 0,
      requests: 0,
      errors: 0,
      pending: { http: 0, sockets: 0 },
      authenticated: true,
      connectionService: true,
      designWidth: 1120,
    }),
    start: async () => {},
    setRelay: async () => {},
    setSecret: async () => {},
    getSecret: () => 'stored-secret',
    audit: async () => {},
    test: async () => ({
      ok: true,
      checkedAt: '2026-10-03T00:00:00.000Z',
      origin: 'http://relay.test',
      version: '0.5.2',
      checks: [{ id: 'configured', ok: true, detail: 'http://relay.test (saved)' }],
    }),
    stop: async () => {},
    pair: async () => 'http://relay.test/#/pair?t=abc',
    ...overrides,
  }
}

/** A minimal response double that records what the handler wrote. */
function fakeResponse() {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' }
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      if (headers) state.headers = { ...state.headers, ...headers }
      return response
    },
    end(chunk?: string) {
      state.body = chunk ?? ''
      return response
    },
  }
  return { response: response as unknown as ServerResponse, state }
}

/**
 * Build a request/response pair.
 * @param method - HTTP method.
 * @param address - peer address.
 * @param body - raw request body, for routes that read one.
 * @returns the request and a response recorder.
 */
function exchange(
  method: string,
  address = '127.0.0.1',
  body?: string,
  headers: Record<string, string> = {},
) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  const request = {
    method,
    headers,
    socket: { remoteAddress: address },
    // The settings route streams its body, so the double has to be iterable.
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
  return { request, ...fakeResponse() }
}

/**
 * Find a route by path.
 * @param controller - controller to build routes for.
 * @param path - route path.
 * @returns the route.
 */
function routeFor(controller: RemoteController, path: string) {
  const route = makeRoutes(controller).find((candidate) => candidate.path === path)
  if (!route) throw new Error(`no route for ${path}`)
  return route
}

/**
 * Wait for an asynchronous handler to answer.
 * @param predicate - condition to await.
 */
async function settle(predicate: () => boolean) {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error('handler has not answered yet')
  }, { timeout: 3_000 })
}

describe('route fences', () => {
  it('refuses a non-loopback caller on every route', () => {
    const controller = fakeController()
    for (const route of makeRoutes(controller)) {
      const { request, response, state } = exchange('GET', '192.0.2.10')
      route.handler(request, response)
      expect(state.status, route.path).toBe(403)
      expect((JSON.parse(state.body) as { error: string }).error).toContain('loopback-only')
    }
  })

  it('requires POST on the mutating routes', () => {
    const controller = fakeController()
    for (const path of [API.start, API.stop, API.pair, API.settings]) {
      const { request, response, state } = exchange('GET')
      routeFor(controller, path).handler(request, response)
      expect(state.status, path).toBe(405)
    }
  })

  it('refuses POST on a read route', () => {
    const controller = fakeController()
    const { request, response, state } = exchange('POST')
    routeFor(controller, API.status).handler(request, response)
    expect(state.status).toBe(405)
  })

  it('never caches a response, because the payload carries a credential', () => {
    const controller = fakeController()
    const { request, response, state } = exchange('GET')
    routeFor(controller, API.status).handler(request, response)
    expect(state.headers['cache-control']).toBe('no-store')
  })
})

describe('status route', () => {
  it('stamps the plugin identity and host clock onto the controller snapshot', () => {
    const { request, response, state } = exchange('GET')
    routeFor(fakeController(), API.status).handler(request, response)
    const body = JSON.parse(state.body) as StatusPayload
    expect(body.id).toBe('dsh-remote-control')
    expect(body.pid).toBe(process.pid)
    expect(Number.isNaN(Date.parse(body.time))).toBe(false)
    expect(body.phase).toBe('online')
    expect(body.relayOrigin).toBe('http://relay.test')
  })

  it('reports an unstarted link as disabled and idle', () => {
    const controller = fakeController({
      getStatus: () => ({
        version: '0.5.2',
        enabled: false,
        phase: 'idle',
        relayOrigin: 'http://relay.test',
        relaySource: 'patch',
        relayEditable: true,
      secretSet: false,
      secretPath: '/tmp/relay-secret',
        phoneConnected: false,
        reconnects: 0,
        requests: 0,
        errors: 0,
        pending: { http: 0, sockets: 0 },
        authenticated: false,
        connectionService: true,
        designWidth: 1120,
      }),
    })
    const { request, response, state } = exchange('GET')
    routeFor(controller, API.status).handler(request, response)
    expect((JSON.parse(state.body) as StatusPayload).enabled).toBe(false)
  })
})

describe('mutating routes', () => {
  it('starts the link and answers with the resulting status', async () => {
    const start = vi.fn(async () => {})
    const { request, response, state } = exchange('POST')
    routeFor(fakeController({ start }), API.start).handler(request, response)
    await settle(() => state.status !== 0)
    expect(start).toHaveBeenCalledOnce()
    expect(state.status).toBe(200)
  })

  it('surfaces a start failure as a 500 with the message', async () => {
    const start = vi.fn(async () => { throw new Error('relay unreachable') })
    const { request, response, state } = exchange('POST')
    routeFor(fakeController({ start }), API.start).handler(request, response)
    await settle(() => state.status !== 0)
    expect(state.status).toBe(500)
    expect((JSON.parse(state.body) as { error: string }).error).toBe('relay unreachable')
  })

  it('stops the link', async () => {
    const stop = vi.fn()
    const { request, response, state } = exchange('POST')
    routeFor(fakeController({ stop }), API.stop).handler(request, response)
    await settle(() => state.status !== 0)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('answers with the status from after the action, not before it', async () => {
    // Stop is the case that matters: it must be finished before the reply is
    // built, or the panel is told the link is still running.
    let finished = false
    const stop = vi.fn(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      finished = true
    })
    const controller = fakeController({ stop })
    const { request, response, state } = exchange('POST')
    await routeFor(controller, API.stop).handler(request, response)
    await settle(() => state.status !== 0)

    expect(stop).toHaveBeenCalledOnce()
    expect(finished).toBe(true)
    expect(state.status).toBe(200)
  })

  it('saves a relay origin through the host settings service', async () => {
    const setRelay = vi.fn(async () => {})
    const { request, response, state } = exchange(
      'POST', '127.0.0.1', JSON.stringify({ relay: 'https://relay.example' }),
    )
    await routeFor(fakeController({ setRelay }), API.settings).handler(request, response)
    await settle(() => state.status !== 0)

    expect(setRelay).toHaveBeenCalledWith('https://relay.example')
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toMatchObject({ id: 'dsh-remote-control', relayOrigin: 'http://relay.test' })
  })

  it('rejects a settings body that carries no relay string', async () => {
    const setRelay = vi.fn(async () => {})
    for (const body of ['{"relay":42}', '{"nope":true}', 'not json']) {
      const { request, response, state } = exchange('POST', '127.0.0.1', body)
      await routeFor(fakeController({ setRelay }), API.settings).handler(request, response)
      await settle(() => state.status !== 0)
      expect(state.status).toBe(400)
    }
    expect(setRelay).not.toHaveBeenCalled()
  })

  it('reports a refused origin as a 400 carrying the reason', async () => {
    const setRelay = vi.fn(async () => {
      throw new Error('`ftp:` is not supported. Use http or https.')
    })
    const { request, response, state } = exchange(
      'POST', '127.0.0.1', JSON.stringify({ relay: 'ftp://relay.example' }),
    )
    await routeFor(fakeController({ setRelay }), API.settings).handler(request, response)
    await settle(() => state.status !== 0)

    expect(state.status).toBe(400)
    expect(state.body).toContain('not supported')
  })

  it('tells the audit trail whether a mutating call came through the tunnel', async () => {
    const audit = vi.fn(async () => {})
    const controller = fakeController({ audit })
    const { request, response } = exchange('POST', '127.0.0.1', undefined, {
      'x-dsh-remote-control-tunnelled': '1',
      'user-agent': 'Mozilla/5.0 (iPhone)',
    })
    await routeFor(controller, API.stop).handler(request, response)
    await settle(() => audit.mock.calls.length > 0 || response.writableEnded)

    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      route: API.stop,
      tunnelled: true,
      agent: 'Mozilla/5.0 (iPhone)',
    }))
  })

  it('runs the connection test and answers with its report', async () => {
    const test = vi.fn(async () => ({
      ok: false,
      checkedAt: '2026-10-03T00:00:00.000Z',
      origin: 'http://relay.test',
      version: '0.5.2',
      checks: [
        { id: 'configured' as const, ok: true, detail: 'http://relay.test' },
        { id: 'reachable' as const, ok: false, detail: 'no answer within 5s', ms: 5000 },
      ],
    }))
    const { request, response, state } = exchange('POST')
    await routeFor(fakeController({ test }), API.test).handler(request, response)
    await settle(() => state.status !== 0)

    expect(state.status).toBe(200)
    expect(test).toHaveBeenCalledTimes(1)
    const body = JSON.parse(state.body)
    expect(body.checks).toHaveLength(2)
    expect(body.checks[1]).toMatchObject({ id: 'reachable', ok: false })
  })

  it('returns a freshly minted pairing URL', async () => {
    const pair = vi.fn(async () => 'http://relay.test/#/pair?t=fresh')
    const { request, response, state } = exchange('POST')
    routeFor(fakeController({ pair }), API.pair).handler(request, response)
    await settle(() => state.status !== 0)
    expect((JSON.parse(state.body) as { pairUrl: string }).pairUrl).toBe('http://relay.test/#/pair?t=fresh')
    expect(pair).toHaveBeenCalledOnce()
  })
})

describe('qr route', () => {
  it('re-mints a token and renders an SVG', async () => {
    const pair = vi.fn(async () => 'http://relay.test/#/pair?t=fresh')
    const { request, response, state } = exchange('GET')
    routeFor(fakeController({ pair }), API.qr).handler(request, response)
    await settle(() => state.status !== 0)
    // Re-minting matters: a token expires, so a panel left open must not keep
    // showing a QR that no longer pairs.
    expect(pair).toHaveBeenCalledOnce()
    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toContain('image/svg+xml')
    expect(state.body).toContain('<svg')
  })

  it('answers 503 rather than a broken image when the relay will not issue a token', async () => {
    const pair = vi.fn(async () => { throw new Error('relay unreachable') })
    const { request, response, state } = exchange('GET')
    routeFor(fakeController({ pair }), API.qr).handler(request, response)
    await settle(() => state.status !== 0)
    expect(state.status).toBe(503)
    expect((JSON.parse(state.body) as { error: string }).error).toBe('relay unreachable')
  })
})