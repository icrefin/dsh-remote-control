#!/usr/bin/env node
/**
 * DSH remote-control relay.
 *
 * Connects a DSH host (your machine, running the `dsh-remote-control` plugin) to a
 * browser, so the browser can drive the Harness from anywhere.
 *
 *   DSH host  ──WS /ws (role=host)──▶  relay  ◀──HTTP + WS──  browser
 *
 * The relay is a reverse proxy. It terminates the browser's HTTP and WebSocket
 * traffic and replays it, frame by frame, against the host's own loopback web
 * server — so the browser loads the *real* Harness client and the relay stays
 * ignorant of what a session, a message or a tool call is. The wire contract is
 * in `PROTOCOL.md`.
 *
 * Persistence is a single JSON file: keeping sessions on disk means a relay
 * restart does not unpair every browser, and redeploying is not a breaking
 * event.
 *
 * @module dsh-remote-relay/server
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, stat, writeFile, rename, mkdir } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/**
 * Relay build identity.
 *
 * Reported by `/healthz` so a version skew between this process and the plugin
 * is one `curl` away: they must be deployed together, and the symptom of not
 * doing so is a pairing page that cannot get past the exchange.
 */
const VERSION = await readFile(join(HERE, 'package.json'), 'utf8')
  .then((text) => JSON.parse(text).version ?? 'unknown')
  .catch(() => 'unknown')
const PORT = Number(process.env.PORT ?? 80)
const HOST = process.env.HOST ?? '0.0.0.0'
/** Directory holding the pairing shell. */
const WEB_ROOT = process.env.WEB_ROOT ?? join(HERE, 'web')
/** Where the session table is persisted. */
const STATE_FILE = process.env.STATE_FILE ?? join(HERE, 'state.json')
/** How long a pairing token stays valid. */
const PAIRING_TTL_MS = Number(process.env.PAIRING_TTL_MS ?? 10 * 60 * 1000)
/** Public origin used to build the QR URL, when it differs from the request host. */
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? ''

/**
 * Shared secret a host must present to register.
 *
 * The relay is somebody's private bandwidth and a tunnel into machines they
 * own; that it happens to be reachable on the internet is not an invitation.
 * Registration is the one door that has to stay shut — everything after it is
 * keyed by a secret the relay itself minted, so an unregistered host has
 * nothing to present.
 *
 * Required. There is no default, because a default would be a published key.
 */
const RELAY_SECRET = (process.env.RELAY_SECRET ?? '').trim()

/** Explicit opt-out, for a throwaway relay on a laptop on a trusted network. */
const ALLOW_OPEN = process.env.RELAY_ALLOW_OPEN === '1'

if (RELAY_SECRET === '' && !ALLOW_OPEN) {
  console.error(
    'refusing to start: set RELAY_SECRET to a long random value so only hosts you\n'
    + 'authorise can register with this relay. Generate one with:\n'
    + '\n'
    + '  openssl rand -base64 32\n'
    + '\n'
    + 'Put it in the service environment, and in each host plugin (the Relay secret\n'
    + 'field, or DSH_REMOTE_RELAY_SECRET). RELAY_ALLOW_OPEN=1 runs it unprotected —\n'
    + 'only for a local test relay.',
  )
  process.exit(1)
}
const HEARTBEAT_MS = 30_000
/** How long a tunnelled request may wait for its response head. */
const TUNNEL_HEAD_TIMEOUT_MS = Number(process.env.TUNNEL_HEAD_TIMEOUT_MS ?? 30_000)
/** How long a tunnelled WebSocket may wait for the host to accept the upgrade. */
const TUNNEL_OPEN_TIMEOUT_MS = Number(process.env.TUNNEL_OPEN_TIMEOUT_MS ?? 15_000)
/** Browser frames queued while a tunnelled socket is still opening. */
const TUNNEL_BACKLOG_MAX = 256
/**
 * How long after a session's last tunnelled exchange the host is told the
 * browser has gone.
 *
 * Presence is *inferred* from tunnelled traffic rather than from a socket the
 * browser has to hold open: the harness keeps one mux WebSocket anyway, so an
 * idle page is indistinguishable from a closed one for a few seconds, which is
 * exactly what this delay admits.
 */
const BROWSER_IDLE_MS = Number(process.env.BROWSER_IDLE_MS ?? 15_000)
/** How long a tunnel round trip may take before it is called a failure. */
const PING_TIMEOUT_MS = Number(process.env.PING_TIMEOUT_MS ?? 5_000)
/**
 * How long a browser's tunnels survive the host stepping away.
 *
 * A host socket drop is not the same event as a dead pairing: the machine is
 * usually still there and reconnecting, and the plugin's own backoff brings it
 * back within a second or two. Tearing the browsers down immediately makes that
 * blip visible and expensive — the harness client rebuilds its connection
 * generation, which discards whatever the user was in the middle of typing or
 * answering. So the relay holds the browser's sockets and in-flight requests
 * open for this long, and only gives up when the host really has not returned.
 *
 * It must exceed the client's reconnect delay, or the host cannot win the race.
 */
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS ?? 30_000)

/**
 * How many browsers may stay paired to one session.
 *
 * A pairing is a token, so this is "how many browsers may hold one" — a bound on
 * the session table rather than a security boundary, since every token was
 * issued by whoever held a pairing link. It is not small on purpose: a bound
 * that is reached silently is worse than one that is never reached, and the
 * eviction below is the thing that makes reaching it safe.
 */
const PHONE_TOKEN_LIMIT = Math.max(1, Number(process.env.PHONE_TOKEN_LIMIT ?? 50) || 50)

/**
 * How often the last-used times are written down.
 *
 * Every authenticated request refreshes a token's recency, so persisting each
 * one would put a disk write behind every page load. The bound is a minute: a
 * relay that restarts inside it loses at most a minute of recency, and a token
 * that is actually in use is refreshed again by the very next request.
 */
const PHONE_TOKEN_FLUSH_MS = Number(process.env.PHONE_TOKEN_FLUSH_MS ?? 60_000)

/** Cookie carrying a browser's durable phone token. */
const PHONE_COOKIE = 'dsh-remote-phone'

/**
 * Paths the relay answers itself.
 *
 * Deliberately not under `/api`: that namespace belongs to the tunnelled
 * harness — its RPC bridge, its gateway mux — and shadowing any of it would
 * break the client in ways that are hard to see.
 */
const RELAY_API = {
  session: '/_relay/session',
  probe: '/_relay/probe',
  pair: '/_relay/pair',
  unpair: '/_relay/unpair',
  forget: '/_relay/forget',
  ping: '/_relay/ping',
  health: '/healthz',
}

/** MIME types for the handful of extensions the pairing shell uses. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

/** Whether frame-level diagnostics are on (`DEBUG=1`). */
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'

/**
 * Timestamped log line.
 * @param {...unknown} parts - values to print.
 * @returns {void}
 */
function log(...parts) {
  console.log(new Date().toISOString(), ...parts)
}

/**
 * Frame-level trace, off unless `DEBUG=1`.
 *
 * A tunnelled page is dozens of requests deep before it renders, so when one
 * stalls the useful question is always "which frame stopped moving".
 * @param {...unknown} parts - values to print.
 * @returns {void}
 */
function trace(...parts) {
  if (DEBUG) console.log(new Date().toISOString(), '[frame]', ...parts)
}

/**
 * URL-safe random identifier.
 * @param {number} bytes - entropy size.
 * @returns {string} the token.
 */
function token(bytes = 24) {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Constant-time string comparison that tolerates differing lengths.
 * @param {string} a - first value.
 * @param {string} b - second value.
 * @returns {boolean} whether they are equal.
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

// ── session table ──────────────────────────────────────────────────────────
//
// Shape:
//   { sessions: { [sessionId]: {
//       hostSecret, hostLabel, createdAt, lastSeenAt,
//       phoneTokens: string[],
//       phoneTokenSeen: { [token]: lastUsedAt },
//       pairingTokens: { [token]: expiresAt } } } }
//
// `phoneTokenSeen` is what makes eviction choose correctly: without it the only
// order available is insertion order, which evicts the browser that has been
// paired longest — often the one that is used every day. A token missing from
// it is one written by a build that did not track recency; it reads as "never
// used", so it is evicted before anything this build has seen, and it acquires a
// timestamp the moment it presents itself.

let state = { sessions: {} }
let savePending = null

/** When the last-used times were last written, so touches do not write per request. */
let phoneTokensFlushedAt = 0

/**
 * Read the persisted session table, tolerating absence or corruption.
 *
 * Every record is normalised on the way in rather than at each use: a session
 * written by an older build has no `phoneTokenSeen`, and one written by a
 * crashed build can have any field at all.
 */
async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.sessions) state = parsed
    for (const session of Object.values(state.sessions)) {
      if (!Array.isArray(session.phoneTokens)) session.phoneTokens = []
      if (session.phoneTokenSeen === null || typeof session.phoneTokenSeen !== 'object') {
        session.phoneTokenSeen = {}
      }
    }
    log(`state loaded: ${Object.keys(state.sessions).length} session(s)`)
  } catch (error) {
    if (error?.code !== 'ENOENT') log('state unreadable, starting empty:', String(error))
    else log('no state file yet; starting empty')
  }
}

/**
 * Persist the session table atomically, coalescing bursts of writes.
 * @returns {Promise<void>} resolves once the table is on disk.
 */
function saveState() {
  if (savePending) return savePending
  savePending = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    savePending = null
    const tmp = `${STATE_FILE}.tmp`
    try {
      await mkdir(join(STATE_FILE, '..'), { recursive: true }).catch(() => {})
      await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
      await rename(tmp, STATE_FILE)
    } catch (error) {
      log('state write failed:', String(error))
    }
  })()
  return savePending
}

/** Live sockets per session. */
const live = new Map()

/**
 * In-flight `ping` round trips, keyed by tunnel id.
 *
 * A ping is the one check that exercises the whole path the pages actually use
 * — host socket, relay, tunnel framing, and back — so when a browser sees an
 * offline page, this is what says whether the plumbing is sound or the host is
 * simply not there.
 */
const pongs = new Map()

/** Next tunnel request id. One counter for the process keeps ids unique across
 *  every browser sharing a host socket. */
let nextTunnelId = 1

/**
 * Live channel record for one session, created on demand.
 * @param {string} sessionId - session key.
 * @returns {{host: import('ws').WebSocket|null, pending: Map<number, object>,
 *            sockets: Map<number, object>, browserPresent: boolean,
 *            idleTimer: NodeJS.Timeout|null, graceTimer: NodeJS.Timeout|null,
 *            hostWaiters: object[]}} record.
 */
function liveFor(sessionId) {
  let entry = live.get(sessionId)
  if (!entry) {
    entry = {
      host: null,
      pending: new Map(),
      sockets: new Map(),
      browserPresent: false,
      idleTimer: null,
      /**
       * Armed when the host socket drops, cleared if it comes back. While it is
       * pending the browsers are deliberately left attached, so a blip does not
       * become an outage (see {@link detach}).
       */
      graceTimer: null,
      /**
       * Requests that arrived while the host was away inside the grace window.
       * They wait rather than being answered with the offline page, and are
       * released when the host returns (see {@link waitForHost}).
       */
      hostWaiters: [],
      /**
       * Whether a host has ever attached to this session since the relay
       * started. A session that never had one is almost always a spent pairing
       * rather than a sleeping machine, and the two need different advice.
       */
      everAttached: false,
    }
    live.set(sessionId, entry)
  }
  return entry
}

/**
 * Issue a fresh single-use pairing token for a session.
 * @param {object} session - session record.
 * @returns {{pairingToken: string, expiresAt: number}} the token and its expiry.
 */
function mintPairingToken(session) {
  const now = Date.now()
  for (const [value, expiry] of Object.entries(session.pairingTokens ?? {})) {
    if (expiry <= now) delete session.pairingTokens[value]
  }
  const pairingToken = token(18)
  const expiresAt = now + PAIRING_TTL_MS
  session.pairingTokens = session.pairingTokens ?? {}
  session.pairingTokens[pairingToken] = expiresAt
  return { pairingToken, expiresAt }
}

/**
 * Identify the session owning a pairing token and consume it.
 * @param {string} pairingToken - token from the QR.
 * @returns {string|null} the session id, or null when unknown or expired.
 */
function consumePairingToken(pairingToken) {
  const now = Date.now()
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    const expiry = session.pairingTokens?.[pairingToken]
    if (expiry === undefined) continue
    delete session.pairingTokens[pairingToken]
    void saveState()
    if (expiry <= now) return null
    return sessionId
  }
  return null
}

// ── relay plumbing ─────────────────────────────────────────────────────────

/**
 * Send a JSON frame if the socket is still open.
 * @param {import('ws').WebSocket} socket - destination.
 * @param {object} frame - payload.
 * @returns {boolean} whether it was written.
 */
function send(socket, frame) {
  if (!socket || socket.readyState !== socket.OPEN) return false
  socket.send(JSON.stringify(frame))
  return true
}

/**
 * Tell the host whether a browser is using this session.
 * @param {string} sessionId - session key.
 * @returns {void}
 */
function announcePeer(sessionId) {
  const entry = liveFor(sessionId)
  if (!entry.host) return
  send(entry.host, {
    t: 'peer',
    state: entry.browserPresent ? 'connected' : 'disconnected',
    peers: entry.sockets.size + entry.pending.size,
  })
}

/**
 * Record tunnelled activity, which is what "a browser is here" means.
 * @param {string} sessionId - session key.
 * @returns {void}
 */
function touchBrowser(sessionId) {
  const entry = liveFor(sessionId)
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }
  if (entry.browserPresent) return
  entry.browserPresent = true
  announcePeer(sessionId)
}

/**
 * Start the countdown that ends browser presence once nothing is in flight.
 * @param {string} sessionId - session key.
 * @returns {void}
 */
function settleBrowser(sessionId) {
  const entry = liveFor(sessionId)
  if (!entry.browserPresent || entry.idleTimer) return
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null
    if (entry.sockets.size > 0 || entry.pending.size > 0) return
    entry.browserPresent = false
    announcePeer(sessionId)
  }, BROWSER_IDLE_MS)
  entry.idleTimer.unref?.()
}

/**
 * Detach a host socket, holding the browsers for a grace period.
 *
 * A host socket dropping is not proof that the pairing is over: the machine is
 * usually still running and its plugin is already backing off towards a retry,
 * which lands well inside {@link HOST_GRACE_MS}. Tearing every browser down on
 * the spot turns that blip into a visible outage — the harness client rebuilds
 * its connection generation and discards in-flight interaction state, which is
 * how a user loses the answers they were part-way through giving.
 *
 * So this only marks the host absent and arms the timer. {@link attachHost}
 * cancels it when the host returns, and the browsers never notice. Only when
 * the host is still gone at the deadline does {@link finalizeHostLoss} run.
 *
 * @param {import('ws').WebSocket} socket - closing socket.
 * @returns {void}
 */
function detach(socket) {
  const sessionId = socket.sessionId
  if (!sessionId || socket.role !== 'host') return
  const entry = liveFor(sessionId)
  if (entry.host !== socket) return
  entry.host = null
  if (entry.graceTimer) clearTimeout(entry.graceTimer)
  entry.graceTimer = setTimeout(() => {
    entry.graceTimer = null
    finalizeHostLoss(sessionId)
  }, HOST_GRACE_MS)
  entry.graceTimer.unref?.()
  log(`host left session ${sessionId}; holding browsers for ${HOST_GRACE_MS}ms`)
}

/**
 * Give up on a host that did not come back inside the grace window.
 *
 * This is the old immediate behaviour, now reached only once the host is known
 * to be gone: every in-flight request is failed rather than left to time out,
 * and every browser tunnel is closed so the client reconnects against a host
 * that may by then have a different session.
 *
 * @param {string} sessionId - session key.
 * @returns {void}
 */
function finalizeHostLoss(sessionId) {
  const entry = liveFor(sessionId)
  // A host that reattached between the deadline firing and this running wins.
  if (entry.host) return
  // Nothing can be answered now; fail every browser request that was in flight
  // rather than leaving it to time out.
  for (const [, pending] of entry.pending) {
    clearTimeout(pending.timer)
    if (!pending.response.headersSent) {
      pending.response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    pending.response.end('the host disconnected\n')
  }
  entry.pending.clear()
  // Requests held across the window get the page a browser would have seen had
  // it arrived a moment later, rather than hanging on a host that never came.
  const waiting = entry.hostWaiters
  entry.hostWaiters = []
  for (const waiter of waiting) {
    if (waiter.abandoned || waiter.response.writableEnded) continue
    offlinePage(waiter.response, false, sessionId)
  }  for (const ctx of entry.sockets.values()) {
    try { ctx.browser.close(1011, 'the host disconnected') } catch { /* already gone */ }
  }
  entry.sockets.clear()
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null }
  entry.browserPresent = false
  log(`host did not return to session ${sessionId}; browsers released`)
}

/**
 * Handle one relay-level frame.
 * @param {import('ws').WebSocket} socket - sender.
 * @param {object} frame - decoded frame.
 * @returns {void}
 */
function onRelayFrame(socket, frame) {
  switch (frame.t) {
    case 'ping':
      send(socket, { t: 'pong' })
      return

    case 'msg': {
      // Only the host speaks here. Browsers reach the harness over HTTP and
      // WebSocket at the relay's front door, not over this control socket.
      if (socket.role !== 'host' || !socket.sessionId) {
        send(socket, { t: 'error', code: 'unauthorized', message: 'not the session host' })
        return
      }
      onHostFrame(socket.sessionId, frame.payload)
      return
    }

    default:
      send(socket, { t: 'error', code: 'bad-request', message: `unknown frame type ${String(frame.t)}` })
  }
}

/**
 * Handle one tunnel frame coming back from the host.
 * @param {string} sessionId - session key.
 * @param {unknown} payload - the frame.
 * @returns {void}
 */
function onHostFrame(sessionId, payload) {
  if (!payload || typeof payload !== 'object') return
  trace(`host-> ${String(payload.t)}${payload.id === undefined ? '' : ` #${payload.id}`}`
    + (payload.status === undefined ? '' : ` ${payload.status}`)
    + (payload.message === undefined ? '' : ` ${String(payload.message).slice(0, 200)}`))
  const entry = liveFor(sessionId)
  const id = payload.id
  if (typeof id !== 'number') return

  const pending = entry.pending.get(id)
  const socketCtx = entry.sockets.get(id)

  switch (payload.t) {
    case 'http-res': {
      if (!pending || pending.kind !== 'http') return
      clearTimeout(pending.timer)
      pending.timer = null
      const headers = { ...(payload.headers ?? {}) }
      // The relay frames the body itself, so the origin's length is not ours.
      delete headers['content-length']
      try {
        pending.response.writeHead(Number(payload.status) || 502, headers)
      } catch (error) {
        log('response head failed:', String(error))
      }
      return
    }

    case 'http-chunk': {
      if (!pending || pending.kind !== 'http') return
      const data = typeof payload.data === 'string' ? Buffer.from(payload.data, 'base64') : Buffer.alloc(0)
      pending.response.write(data)
      return
    }

    case 'http-end': {
      if (!pending || pending.kind !== 'http') return
      entry.pending.delete(id)
      clearTimeout(pending.timer)
      if (!pending.response.writableEnded) pending.response.end()
      settleBrowser(sessionId)
      return
    }

    case 'http-error': {
      if (!pending || pending.kind !== 'http') return
      entry.pending.delete(id)
      clearTimeout(pending.timer)
      settleBrowser(sessionId)
      if (!pending.response.headersSent) {
        pending.response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      pending.response.end(`${String(payload.message ?? 'the host could not answer')}\n`)
      return
    }

    case 'ws-open-ok': {
      if (!socketCtx) return
      socketCtx.opened = true
      clearTimeout(socketCtx.timer)
      socketCtx.timer = null
      for (const queued of socketCtx.backlog) {
        send(entry.host, { t: 'msg', payload: { t: 'ws-msg', id, ...queued } })
      }
      socketCtx.backlog.length = 0
      return
    }

    case 'ws-msg': {
      if (!socketCtx) return
      const data = typeof payload.data === 'string' ? Buffer.from(payload.data, 'base64') : Buffer.alloc(0)
      if (socketCtx.browser.readyState === socketCtx.browser.OPEN) {
        socketCtx.browser.send(data, { binary: payload.binary === true })
      }
      return
    }

    case 'ws-close': {
      if (!socketCtx) return
      entry.sockets.delete(id)
      clearTimeout(socketCtx.timer)
      settleBrowser(sessionId)
      try { socketCtx.browser.close(Number(payload.code) || 1000, String(payload.reason ?? '')) } catch { /* gone */ }
      return
    }

    case 'ws-error': {
      if (!socketCtx) return
      entry.sockets.delete(id)
      clearTimeout(socketCtx.timer)
      settleBrowser(sessionId)
      try { socketCtx.browser.close(1011, String(payload.message ?? 'the host refused the stream')) } catch { /* gone */ }
      return
    }

    case 'pong': {
      const waiting = pongs.get(id)
      if (!waiting) return
      pongs.delete(id)
      clearTimeout(waiting.timer)
      waiting.resolve()
      return
    }

    default:
      return
  }
}

/**
 * Attach a socket as the session's host.
 * @param {import('ws').WebSocket} socket - host socket.
 * @param {string} sessionId - session key.
 * @returns {void}
 */
function attachHost(socket, sessionId) {
  const entry = liveFor(sessionId)
  if (entry.host && entry.host !== socket) {
    send(entry.host, { t: 'error', code: 'replaced', message: 'another host connected for this session' })
    entry.host.close()
  }
  // A host that made it back inside the grace window cancels the teardown, so
  // the browsers it was holding never learn it was gone.
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer)
    entry.graceTimer = null
    log(`host returned to session ${sessionId} within the grace window`)
  }
  entry.host = socket
  entry.everAttached = true
  socket.role = 'host'
  socket.sessionId = sessionId
  const session = state.sessions[sessionId]
  if (session) {
    // Persisted, so "has a host ever attached?" survives a relay restart — the
    // offline page's advice depends on it being true.
    session.everAttached = true
    session.lastSeenAt = Date.now()
    void saveState()
  }
  send(socket, { t: 'ready', sessionId, role: 'host' })
  announcePeer(sessionId)
  log(`host attached to session ${sessionId}`)
  // Requests that arrived during the blip go out now, in the order they came.
  releaseHostWaiters(sessionId)
}

// ── cookies ────────────────────────────────────────────────────────────────

/**
 * Read one cookie value out of a request.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {string} name - cookie name.
 * @returns {string|undefined} the value.
 */
function cookieValues(request, name) {
  const raw = request.headers.cookie
  if (typeof raw !== 'string') return []
  const found = []
  for (const segment of raw.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    found.push(segment.slice(at + 1).trim())
  }
  return found
}

/**
 * The first value of a cookie, for callers that want one.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {string} name - cookie name.
 * @returns {string|undefined} the value.
 */
function cookieValue(request, name) {
  return cookieValues(request, name)[0]
}

/**
 * Whether a request may register a host or read the relay's totals.
 *
 * Compared in constant time: this is a shared secret an attacker can guess at
 * freely, and a byte-by-byte comparison leaks how much of it was right.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {boolean} true when the caller presented the relay secret.
 */
function isAuthorised(request) {
  if (RELAY_SECRET === '') return true
  const presented = request.headers['x-dsh-relay-secret']
  if (typeof presented !== 'string' || presented === '') return false
  return safeEqual(presented, RELAY_SECRET)
}

/**
 * Scope segment that names a session in a URL.
 *
 * One relay origin serves many hosts, and a browser can only hold one cookie of
 * a given name per origin — so a second pairing used to overwrite the first and
 * both windows then showed whichever host was paired last. Giving every session
 * a path of its own fixes that where cookies cannot: the document is scoped, so
 * its relative URLs stay scoped, and its cookie is scoped with it.
 */
const SCOPE = '/s/'

/**
 * Split a path into its session scope and the path beneath it.
 * @param {string} pathname - request path.
 * @returns {{sessionId: string, rest: string}|null} the scope, or null.
 */
function parseScope(pathname) {
  if (!pathname.startsWith(SCOPE)) return null
  const rest = pathname.slice(SCOPE.length)
  const slash = rest.indexOf('/')
  const sessionId = slash === -1 ? rest : rest.slice(0, slash)
  if (sessionId === '') return null
  return { sessionId, rest: slash === -1 ? '/' : rest.slice(slash) }
}

/**
 * The session named by a request's referer, if it carries a scope.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {string|undefined} the session id.
 */
function scopeFromReferer(request) {
  const referer = request.headers.referer
  if (typeof referer !== 'string' || referer === '') return undefined
  try {
    const scoped = parseScope(new URL(referer).pathname)
    if (!scoped || state.sessions[scoped.sessionId] === undefined) return undefined
    return scoped.sessionId
  } catch {
    return undefined
  }
}

/**
 * Resolve the session a browser request belongs to.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {{sessionId: string, session: object}|null} the session, or null.
 */
function sessionForRequest(request) {
  const phoneToken = cookieValue(request, PHONE_COOKIE)
  if (!phoneToken) return null
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (session.phoneTokens?.some((value) => safeEqual(value, phoneToken))) return { sessionId, session }
  }
  return null
}

/**
 * Decide which session a request is for, and whether it is allowed to have it.
 *
 * Three signals, in decreasing authority:
 *
 *  1. the path scope — the browser is plainly asking a named host;
 *  2. the referer's scope — a scoped page asking for an origin-absolute asset
 *     or API path, which is what a client that resolves against the origin
 *     rather than the document will do;
 *  3. the pairing cookie — an unscoped request from a browser paired to exactly
 *     one host, which is what an old link or a bare visit looks like.
 *
 * A cookie that does not belong to the scoped session is not an error: the
 * browser simply is not paired *to that host yet*, which is what the pairing
 * shell is for.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {string} pathname - request path.
 * @returns {{sessionId: string, rest: string, paired: boolean}|null} the route.
 */
function routeFor(request, pathname) {
  const presented = cookieValues(request, PHONE_COOKIE)
  const scoped = parseScope(pathname)
  if (scoped !== null) {
    const session = state.sessions[scoped.sessionId]
    if (session === undefined) return null
    const token = phoneTokenFor(session, presented)
    touchPhoneToken(session, token)
    return {
      sessionId: scoped.sessionId,
      rest: scoped.rest,
      paired: token !== '',
    }
  }
  const fromReferer = scopeFromReferer(request)
  if (fromReferer !== undefined) {
    const session = state.sessions[fromReferer]
    const token = session === undefined ? '' : phoneTokenFor(session, presented)
    if (session !== undefined) touchPhoneToken(session, token)
    return {
      sessionId: fromReferer,
      rest: pathname,
      paired: token !== '',
    }
  }
  const found = sessionForRequest(request)
  if (found !== null) {
    touchPhoneToken(found.session, cookieValue(request, PHONE_COOKIE) ?? '')
    return { sessionId: found.sessionId, rest: pathname, paired: true }
  }
  return null
}

/**
 * The pairing cookie this request presented that belongs to this session.
 *
 * Asking the *session* rather than taking the first cookie matters because a
 * browser can hold several pairing cookies at once — that is the point of
 * scoping them — and the order they arrive in is not something to depend on.
 * @param {object} session - the session record.
 * @param {string[]} presented - every pairing cookie the request carried.
 * @returns {string} the matching token, or an empty string when none matches.
 */
function phoneTokenFor(session, presented) {
  const tokens = Array.isArray(session.phoneTokens) ? session.phoneTokens : []
  return presented.find((value) => tokens.some((token) => safeEqual(token, value))) ?? ''
}

/**
 * Record that a token has just been used, which is what eviction sorts by.
 *
 * Recency is the whole input to the choice made in {@link evictPhoneTokens}, so
 * it is refreshed on every request the token authenticates — including the
 * sub-resource requests a live page makes continuously. The write is throttled
 * because a busy browser would otherwise put a state write behind every frame.
 * @param {object} session - the session record.
 * @param {string} token - the token that authenticated this request.
 * @returns {void}
 */
function touchPhoneToken(session, token) {
  if (token === '') return
  if (session.phoneTokenSeen === null || typeof session.phoneTokenSeen !== 'object') {
    session.phoneTokenSeen = {}
  }
  session.phoneTokenSeen[token] = Date.now()
  if (Date.now() - phoneTokensFlushedAt < PHONE_TOKEN_FLUSH_MS) return
  phoneTokensFlushedAt = Date.now()
  void saveState()
}

/**
 * Drop the least recently used browser tokens until the session is within its
 * limit.
 *
 * The list used to be trimmed from the front, which is insertion order: the
 * browser paired longest ago went first, even when it was the one being used
 * every day, and it went silently — a pairing that stopped working months later
 * with nothing on screen or in the log to explain it. Eviction now sorts by last
 * use, so the token that goes is one no browser has presented in a while, and
 * every drop is logged with when that token was last seen.
 * @param {string} sessionId - for the log line.
 * @param {object} session - the session record.
 * @param {string} keep - the token just issued, which is never the victim.
 * @returns {void}
 */
function evictPhoneTokens(sessionId, session, keep) {
  const tokens = session.phoneTokens
  const seen = session.phoneTokenSeen ?? {}
  while (tokens.length > PHONE_TOKEN_LIMIT) {
    let victim = -1
    for (let index = 0; index < tokens.length; index += 1) {
      const candidate = tokens[index]
      if (candidate === keep) continue
      if (victim === -1 || (seen[candidate] ?? 0) < (seen[tokens[victim]] ?? 0)) victim = index
    }
    // Only reachable when the limit is 1 and the newcomer is the whole list.
    if (victim === -1) return
    const [dropped] = tokens.splice(victim, 1)
    const lastUsed = seen[dropped] ?? 0
    delete seen[dropped]
    log(
      `session ${sessionId}: dropped browser token ${lastUsed === 0
        ? 'that has never been used'
        : `last used ${new Date(lastUsed).toISOString()}`}; ${tokens.length} still paired`,
    )
  }
}

/**
 * Whether a request reached the relay over TLS, directly or via a proxy.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {boolean} true when the browser's connection was secure.
 */
function isSecure(request) {
  return request.headers['x-forwarded-proto'] === 'https'
}

/**
 * Expire the browser's pairing cookie.
 *
 * Called the moment the relay knows the cookie cannot work — an unknown token,
 * or a session the host has ended. Leaving it in place is what strands a
 * browser: every later request presents a cookie that will never be honoured,
 * and nothing on screen says so. Clearing it puts the browser back in the one
 * state it can recover from, which is the pairing shell.
 * @param {import('node:http').ServerResponse} response - response.
 * @param {boolean} secure - whether the request arrived over TLS.
 * @returns {void}
 */
function clearPhoneCookie(response, secure, sessionId) {
  // Expired on the scope it was set for; a cookie set on a different path is a
  // different cookie and would survive.
  const path = sessionId === undefined ? '/' : `${SCOPE}${sessionId}`
  response.setHeader(
    'Set-Cookie',
    `${PHONE_COOKIE}=; Max-Age=0; Path=${path}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
  )
}

/**
 * Serialize the browser cookie.
 * @param {string} value - phone token.
 * @param {boolean} secure - whether the request arrived over TLS.
 * @returns {string} a `Set-Cookie` value.
 */
function phoneCookie(value, secure, sessionId) {
  const year = 365 * 24 * 60 * 60
  // Scoped to the session, so pairing a second host adds a cookie rather than
  // replacing the first, and each window keeps talking to its own machine.
  const path = `${SCOPE}${sessionId}`
  return `${PHONE_COOKIE}=${value}; Max-Age=${year}; Path=${path}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

// ── HTTP ───────────────────────────────────────────────────────────────────

/**
 * Read and JSON-parse a request body with a size cap.
 * @param {import('node:http').IncomingMessage} request - request.
 * @returns {Promise<object>} parsed body, or an empty object.
 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Reply with JSON.
 * @param {import('node:http').ServerResponse} response - response.
 * @param {number} status - HTTP status.
 * @param {object} body - payload.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {void}
 */
function json(response, status, body, headers = {}) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(text)
}

/**
 * Determine the public origin for QR URLs.
 * @param {import('node:http').IncomingMessage} request - request.
 * @returns {string} origin without a trailing slash.
 */
function originFor(request) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN.replace(/\/$/u, '')
  const proto = request.headers['x-forwarded-proto'] ?? 'http'
  const host = request.headers['x-forwarded-host'] ?? request.headers.host ?? `localhost:${PORT}`
  return `${proto}://${host}`
}

/**
 * Serve the relay's own JSON API, or report that this path is not ours.
 * @param {import('node:http').IncomingMessage} request - request.
 * @param {import('node:http').ServerResponse} response - response.
 * @returns {Promise<boolean>} whether the request was answered.
 */
async function handleRelayApi(request, response) {
  const url = new URL(request.url ?? '/', 'http://placeholder')
  // The shell lives on the session's scope, so its relative API calls arrive
  // prefixed (`/s/<id>/_relay/pair`). The API itself is origin-level: strip the
  // scope and serve it here, rather than tunnelling it to a host that has no
  // idea what `_relay` means.
  const scoped = parseScope(url.pathname)
  const path = scoped === null ? url.pathname : scoped.rest
  const secure = isSecure(request)

  if (path === RELAY_API.health) {
    if (!isAuthorised(request)) {
      json(response, 401, { error: 'unauthorized', message: 'health is behind the relay secret' })
      return true
    }
    const sessions = Object.values(state.sessions)
    json(response, 200, {
      ok: true,
      version: VERSION,
      sessions: sessions.length,
      hosts: sessions.filter((session) => liveFor(findId(session))?.host).length,
      browsers: tunnelWss.clients.size,
      uptime: Math.round(process.uptime()),
    })
    return true
  }

  // Create or resume a pairing session. Called by the host, never by a browser.
  if (path === RELAY_API.session && request.method === 'POST') {
    if (!isAuthorised(request)) {
      log(`refused registration from ${request.socket.remoteAddress ?? '?'} (no relay secret)`)
      json(response, 401, {
        error: 'unauthorized',
        message: 'this relay requires a secret; set it in the plugin, or DSH_REMOTE_RELAY_SECRET',
      })
      return true
    }
    let body
    try {
      body = await readJson(request)
    } catch {
      json(response, 400, { error: 'bad-request', message: 'body must be JSON' })
      return true
    }
    const supplied = typeof body.hostSecret === 'string' ? body.hostSecret : ''
    let sessionId = supplied ? findIdBySecret(supplied) : null
    let session
    if (sessionId) {
      session = state.sessions[sessionId]
    } else {
      sessionId = token(9)
      session = {
        hostSecret: token(32),
        hostLabel: typeof body.hostLabel === 'string' ? body.hostLabel.slice(0, 64) : '',
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        phoneTokens: [],
        phoneTokenSeen: {},
        pairingTokens: {},
        everAttached: false,
      }
      state.sessions[sessionId] = session
      log(`session ${sessionId} created (${session.hostLabel || 'unlabelled'})`)
    }
    // The host telling us which session it is leaving. This is the one *exact*
    // signal that a pairing is dead: the machine did not go away, it moved, and
    // a browser on the old session must be told to pair again rather than to
    // keep reloading. Recorded on the record so a relay restart cannot lose it.
    const previous = typeof body.previous === 'string' ? body.previous : ''
    if (previous !== '' && previous !== sessionId && state.sessions[previous] !== undefined) {
      state.sessions[previous].supersededBy = sessionId
      log(`session ${previous} superseded by ${sessionId}`)
    }
    const { pairingToken, expiresAt } = mintPairingToken(session)
    void saveState()
    const origin = originFor(request)
    json(response, 200, {
      sessionId,
      hostSecret: session.hostSecret,
      hostLabel: session.hostLabel,
      pairingToken,
      expiresAt,
      wsUrl: `${origin.replace(/^http/u, 'ws')}/ws`,
      // Scoped: the browser lands on this host's path, so its cookie and every
      // relative URL it goes on to request stay with this host.
      pairUrl: `${origin}${SCOPE}${sessionId}/#/pair?t=${pairingToken}`,
    })
    return true
  }

  // Exchange a single-use pairing token for a durable browser cookie.
  if (path === RELAY_API.pair && request.method === 'POST') {
    let body
    try {
      body = await readJson(request)
    } catch {
      json(response, 400, { error: 'bad-request', message: 'body must be JSON' })
      return true
    }
    const sessionId = consumePairingToken(String(body.token ?? ''))
    if (!sessionId) {
      json(response, 401, {
        error: 'unauthorized',
        message: 'This pairing link has already been used, or it has expired.',
      })
      return true
    }
    const session = state.sessions[sessionId]
    const phoneToken = token(24)
    session.phoneTokens = Array.isArray(session.phoneTokens) ? session.phoneTokens : []
    if (session.phoneTokenSeen === null || typeof session.phoneTokenSeen !== 'object') {
      session.phoneTokenSeen = {}
    }
    session.phoneTokens.push(phoneToken)
    // A pairing is a use: the token that was just scanned is the freshest one
    // there is, so it is the last thing eviction would ever consider.
    session.phoneTokenSeen[phoneToken] = Date.now()
    evictPhoneTokens(sessionId, session, phoneToken)
    session.lastSeenAt = Date.now()
    void saveState()
    log(`browser paired with session ${sessionId}`)
    json(response, 200, {
      sessionId,
      hostLabel: session.hostLabel,
      online: Boolean(liveFor(sessionId).host),
      // Where the shell should put the browser once the cookie is set.
      redirect: `${SCOPE}${sessionId}/`,
    }, { 'set-cookie': phoneCookie(phoneToken, secure, sessionId) })
    return true
  }

  // Round-trip a frame through the tunnel. The host is the only caller: it
  // proves its own socket, and everything the tunnel does to a frame, at once.
  if (path === RELAY_API.ping && request.method === 'POST') {
    let body
    try {
      body = await readJson(request)
    } catch {
      json(response, 400, { error: 'bad-request', message: 'body must be JSON' })
      return true
    }
    const sessionId = String(body.session ?? '')
    const session = state.sessions[sessionId]
    if (!session || !safeEqual(session.hostSecret, String(body.token ?? ''))) {
      json(response, 401, { error: 'unauthorized', message: 'bad session or host secret' })
      return true
    }
    const entry = liveFor(sessionId)
    if (!entry.host) {
      json(response, 503, { ok: false, error: 'host-offline', message: 'no host socket is attached' })
      return true
    }
    const id = nextTunnelId++
    const started = Date.now()
    const settled = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pongs.delete(id)
        resolve('timeout')
      }, PING_TIMEOUT_MS)
      timer.unref?.()
      pongs.set(id, { resolve: () => resolve('ok'), timer })
      send(entry.host, { t: 'msg', payload: { t: 'ping', id } })
    })
    if (settled !== 'ok') {
      json(response, 504, { ok: false, error: 'timeout', message: 'the host did not answer the ping' })
      return true
    }
    json(response, 200, { ok: true, rttMs: Date.now() - started, version: VERSION })
    return true
  }

  // Stop, from the host's side. The host marks the session dead
  // *before* it discards the secret, because afterwards it can no longer name
  // it — and a browser left on a session nobody will ever serve should be told
  // so, rather than shown an offline page that retries forever.
  if (path === RELAY_API.forget && request.method === 'POST') {
    let body
    try {
      body = await readJson(request)
    } catch {
      json(response, 400, { error: 'bad-request', message: 'body must be JSON' })
      return true
    }
    const sessionId = String(body.session ?? '')
    const session = state.sessions[sessionId]
    if (!session || !safeEqual(session.hostSecret, String(body.token ?? ''))) {
      json(response, 401, { error: 'unauthorized', message: 'bad session or host secret' })
      return true
    }
    // No replacement session: the host has simply walked away.
    session.supersededBy = ''
    session.pairingTokens = {}
    void saveState()
    log(`session ${sessionId} forgotten by its host`)
    json(response, 200, { ok: true })
    return true
  }

  if (path === RELAY_API.unpair && request.method === 'POST') {
    // Both scopes: the root one an unscoped pairing used to get, and the
    // session's own. A cookie set on a path only exists at that path, so
    // expiring one is not expiring the other.
    const found = sessionForRequest(request)
    const expired = [`${PHONE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`]
    if (found !== null) {
      expired.push(
        `${PHONE_COOKIE}=; Max-Age=0; Path=${SCOPE}${found.sessionId}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
      )
    }
    json(response, 200, { ok: true }, { 'set-cookie': expired })
    return true
  }

  // Is the host attached right now? Used by the pairing shell before it
  // redirects, so a scan against a sleeping desktop explains itself.
  if (path === RELAY_API.probe) {
    const sessionId = String(url.searchParams.get('session') ?? '')
    const session = state.sessions[sessionId]
    json(response, 200, {
      known: Boolean(session),
      online: Boolean(session && liveFor(sessionId).host),
      ...(session ? { hostLabel: session.hostLabel } : {}),
    })
    return true
  }

  if (path.startsWith('/_relay/')) {
    json(response, 404, { error: 'not-found', message: `no relay route ${path}` })
    return true
  }
  return false
}

/**
 * Serve the "host is away" page, which waits for the host rather than thrashing.
 *
 * @param {import('node:http').ServerResponse} response - response.
 * @param {boolean} stale - whether no host has ever attached to this session.
 * @param {string} sessionId - the session this page is waiting on, so the page
 *   can ask the relay whether that host has come back.
 * @returns {void}
 */
function offlinePage(response, stale, sessionId = '') {
  const heading = stale ? 'This pairing is no longer in use' : 'This computer is offline'
  const body = stale
    ? 'The host has re-registered since this browser paired, so this link points at '
      + 'a session nobody is listening on. Open the Remote Control panel on that '
      + 'machine, scan its current QR code, and this browser will be paired again.'
    : 'The remote-control link is paired but the DSH host is not connected. '
      + 'This page reloads by itself as soon as that machine comes back, so there '
      + 'is nothing to do here.'
  // A blind `location.reload()` on a timer is what made a host blip expensive:
  // every tick threw the document away, and with it whatever the user had typed
  // or was part-way through answering. Ask the relay whether the host is back
  // and reload only when the answer is yes, so a recovery costs exactly one
  // reload — at the moment it can actually succeed.
  const retry = stale || sessionId === ''
    ? ''
    : `<script>(() => {
  const session = ${JSON.stringify(sessionId)};
  const tick = async () => {
    try {
      const probe = await fetch('/_relay/probe?session=' + encodeURIComponent(session), { cache: 'no-store' });
      const state = await probe.json();
      if (state && state.online) { location.reload(); return; }
    } catch (error) { /* relay unreachable; keep waiting */ }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 1000);
})()</script>`
  const page = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#151517;color:#f9fafb;
font:15px/1.6 system-ui,-apple-system,sans-serif;text-align:center}p{max-width:38ch;color:#cfd3d6}
h1{font-size:17px;margin:0 0 8px}</style>
<div><h1>${heading}</h1><p>${body}</p></div>${retry}`
  response.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...(stale ? {} : { 'retry-after': '2' }),
  })
  response.end(page)
}

/**
 * Serve the relay's own pages, or the tunnel.
 * @param {import('node:http').IncomingMessage} request - request.
 * @param {import('node:http').ServerResponse} response - response.
 * @returns {Promise<void>} resolves when the response is finished.
 */
async function handleHttp(request, response) {
  if (await handleRelayApi(request, response)) return
  const url = new URL(request.url ?? '/', 'http://placeholder')
  const pathname = url.pathname
  const route = routeFor(request, pathname)
  if (route === null) {
    // A cookie that resolves to nothing is a spent pairing. Expire it so the
    // browser stops presenting it.
    if (cookieValue(request, PHONE_COOKIE) !== undefined) clearPhoneCookie(response, isSecure(request))
    // Anything else — the bare origin, a guessed path — is answered with a
    // plain 404 rather than the pairing page. Serving the shell here would
    // advertise a private relay to every scanner that finds it, and a pairing
    // link never needs it: links name their session, so they arrive scoped.
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end('not found\n')
    return
  }
  if (!route.paired) {
    // Scoped to a host this browser has not paired with: show it that host's
    // pairing page rather than someone else's app.
    await serveStatic(response, route.rest, parseScope(pathname) === null ? '' : 'scope')
    return
  }
  tunnelHttp(route.sessionId, request, response, route.rest + url.search)
}

/**
 * Replay one browser request against the host and stream its answer back.
 * @param {string} sessionId - session key.
 * @param {import('node:http').IncomingMessage} request - request.
 * @param {import('node:http').ServerResponse} response - response.
 * @returns {void}
 */
function tunnelHttp(sessionId, request, response, path) {
  const entry = liveFor(sessionId)
  if (!entry.host) {
    // A session the host has explicitly left is dead, not sleeping. Failing
    // that, one that has never had a host on it is dead too — and both facts
    // are read from the record rather than from this process, so a relay
    // restart cannot turn a dead pairing into an apparently-recoverable one.
    const session = state.sessions[sessionId]
    // `supersededBy !== undefined` is the exact signal: the host said so.
    const superseded = session !== undefined && session.supersededBy !== undefined
    // `everAttached === false` means a build that tracks this said the host has
    // never attached. `undefined` is a record written before that field
    // existed, where we simply cannot know — and claiming a pairing is dead
    // when it may only be asleep is worse than saying nothing.
    const neverAttached = session !== undefined && session.everAttached === false && !entry.everAttached
    if (superseded || neverAttached) {
      // Dead, not asleep. Expire the cookie here too, so the browser lands on
      // the pairing shell and can be paired again instead of retrying a link
      // that will never answer.
      clearPhoneCookie(response, isSecure(request), sessionId)
      void serveStatic(response, '/', 'ended')
      return
    }
    // The host is away but its grace timer is still running, so this is a blip
    // rather than an outage. Holding the request keeps the offline page — and
    // the reload it implies — away from a browser whose host is about to come
    // back. Requests that outlive the window are released by the teardown.
    if (entry.graceTimer) {
      waitForHost(sessionId, request, response, path)
      return
    }
    offlinePage(response, false, sessionId)
    return
  }

  const id = nextTunnelId++
  touchBrowser(sessionId)

  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }

  trace(`browser-> ${request.method} ${request.url}`)
  const pending = { kind: 'http', response, timer: null }
  entry.pending.set(id, pending)
  pending.timer = setTimeout(() => {
    if (!entry.pending.has(id)) return
    entry.pending.delete(id)
    send(entry.host, { t: 'msg', payload: { t: 'http-abort', id } })
    if (!response.headersSent) {
      response.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' })
    }
    response.end('the host did not answer in time\n')
  }, TUNNEL_HEAD_TIMEOUT_MS)
  pending.timer.unref?.()

  const aborted = () => {
    if (!entry.pending.has(id)) return
    entry.pending.delete(id)
    clearTimeout(pending.timer)
    send(entry.host, { t: 'msg', payload: { t: 'http-abort', id } })
    settleBrowser(sessionId)
  }
  request.on('aborted', aborted)
  response.on('close', () => { if (!response.writableEnded) aborted() })

  send(entry.host, {
    t: 'msg',
    payload: { t: 'http-req', id, method: request.method, url: path, headers },
  })
  request.on('data', (chunk) => {
    send(entry.host, { t: 'msg', payload: { t: 'http-body', id, data: chunk.toString('base64') } })
  })
  request.on('end', () => {
    if (entry.pending.has(id)) send(entry.host, { t: 'msg', payload: { t: 'http-req-end', id } })
  })
  request.on('error', aborted)
}

/**
 * Hold a request until the host returns, or until the grace window closes.
 *
 * The request is deliberately left **unconsumed**. An `IncomingMessage` stays
 * paused until something reads it, so the body remains in the socket and the
 * browser is held by ordinary TCP backpressure — no buffering, and therefore no
 * bound to how large a held upload may be. When the host reattaches the request
 * is simply handed back to {@link tunnelHttp}, which streams it as it would
 * have done had the host never left; if the window closes first,
 * {@link finalizeHostLoss} answers it with the offline page.
 *
 * @param {string} sessionId - session key.
 * @param {import('node:http').IncomingMessage} request - request, untouched.
 * @param {import('node:http').ServerResponse} response - response.
 * @param {string} path - tunnelled path, query included.
 * @returns {void}
 */
function waitForHost(sessionId, request, response, path) {
  const entry = liveFor(sessionId)
  const waiter = { request, response, path, abandoned: false }
  entry.hostWaiters.push(waiter)
  trace(`held ${request.method} ${path} for the returning host`)
  // A browser that navigated away while we held it must not be written to.
  response.on('close', () => {
    if (!response.writableEnded) waiter.abandoned = true
  })
}

/**
 * Hand every request that waited for the host back to the tunnel.
 * @param {string} sessionId - session key.
 * @returns {void}
 */
function releaseHostWaiters(sessionId) {
  const entry = liveFor(sessionId)
  const waiting = entry.hostWaiters
  entry.hostWaiters = []
  for (const waiter of waiting) {
    if (waiter.abandoned || waiter.response.writableEnded) continue
    // The host is attached again, so this takes the normal path and streams the
    // still-unread request body through to it.
    tunnelHttp(sessionId, waiter.request, waiter.response, waiter.path)
  }
}


/**
 * Find a session id by its host secret.
 * @param {string} secret - candidate secret.
 * @returns {string|null} the session id, or null.
 */
function findIdBySecret(secret) {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (safeEqual(session.hostSecret, secret)) return sessionId
  }
  return null
}

/**
 * Find the id a session record is stored under.
 * @param {object} session - record from the table.
 * @returns {string} its key.
 */
function findId(session) {
  return Object.keys(state.sessions).find((key) => state.sessions[key] === session) ?? ''
}

/**
 * Serve one file from the pairing shell directory.
 * @param {import('node:http').ServerResponse} response - response.
 * @param {string} path - request path.
 * @returns {Promise<void>} resolves when the response is finished.
 */
async function serveStatic(response, path, notice = '') {
  const relative = path === '/' || path === '' ? 'index.html' : path.replace(/^\/+/u, '')
  const candidate = normalize(join(WEB_ROOT, relative))
  if (!candidate.startsWith(normalize(WEB_ROOT))) {
    response.writeHead(403)
    response.end('forbidden\n')
    return
  }
  try {
    const info = await stat(candidate)
    if (!info.isFile()) throw new Error('not a file')
    let body = await readFile(candidate)
    if (notice !== '' && candidate.endsWith('index.html')) {
      // A marker on the shell rather than a query string: no redirect, no
      // history entry, and the shell can say *why* it is showing the pairing
      // page to a browser that thought it was already paired.
      body = Buffer.from(
        body.toString('utf8').replace('<body', `<body data-pair-notice="${notice}"`),
        'utf8',
      )
    }
    response.writeHead(200, {
      'content-type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.byteLength,
      'cache-control': candidate.endsWith('.html') ? 'no-store' : 'no-cache',
    })
    response.end(body)
  } catch {
    // An unpaired browser asking for anything else is asking for the app; the
    // pairing shell is the only page it may have, and it knows how to come back.
    try {
      const shell = await readFile(join(WEB_ROOT, 'index.html'))
      response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
      response.end(shell)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found\n')
    }
  }
}

// ── WebSocket upgrades ─────────────────────────────────────────────────────

/** Control-socket server, for `role=host` and `role=phone` sockets. */
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
/** Tunnelled browser sockets, one per upgraded page stream. */
const tunnelWss = new WebSocketServer({ noServer: true, perMessageDeflate: true, maxPayload: 64 * 1024 * 1024 })

/**
 * Reject an upgrade before the handshake, so the browser sees a status.
 * @param {import('node:stream').Duplex} socket - the raw socket.
 * @param {number} status - HTTP status.
 * @param {string} message - reason phrase.
 * @returns {void}
 */
function refuseUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

wss.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/ws', 'http://placeholder')
  const role = url.searchParams.get('role')
  const sessionParam = url.searchParams.get('session') ?? ''
  const tokenParam = url.searchParams.get('token') ?? ''

  socket.isAlive = true
  socket.on('pong', () => { socket.isAlive = true })

  if (role === 'host') {
    const sessionId = sessionParam || findIdBySecret(tokenParam) || ''
    const session = state.sessions[sessionId]
    if (!session || !safeEqual(session.hostSecret, tokenParam)) {
      send(socket, { t: 'error', code: 'unauthorized', message: 'bad session or host secret' })
      socket.close()
      return
    }
    attachHost(socket, sessionId)
  } else {
    // Only the host authenticates here; browsers are served over HTTP.
    send(socket, { t: 'hello', server_ts: Date.now() })
  }

  socket.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(raw.toString())
    } catch {
      send(socket, { t: 'error', code: 'bad-request', message: 'frames must be JSON' })
      return
    }
    try {
      onRelayFrame(socket, frame)
    } catch (error) {
      log('frame handler error:', error?.stack ?? String(error))
    }
  })

  socket.on('close', () => detach(socket))
  socket.on('error', (error) => log('socket error:', String(error)))
})

/**
 * Route one browser WebSocket upgrade: the control socket, or a tunnelled stream.
 * @param {import('node:http').IncomingMessage} request - upgrade request.
 * @param {import('node:stream').Duplex} socket - raw socket.
 * @param {Buffer} head - first packet, if any.
 * @returns {void}
 */
function onUpgrade(request, socket, head) {
  const url = new URL(request.url ?? '/', 'http://placeholder')
  if (url.pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request) })
    return
  }

  const route = routeFor(request, url.pathname)
  if (route === null || !route.paired) {
    refuseUpgrade(socket, 401, 'Unauthorized')
    return
  }
  const found = { sessionId: route.sessionId }
  const entry = liveFor(route.sessionId)
  if (!entry.host) {
    refuseUpgrade(socket, 503, 'Service Unavailable')
    return
  }

  tunnelWss.handleUpgrade(request, socket, head, (ws) => {
    const id = nextTunnelId++
    touchBrowser(found.sessionId)

    const ctx = { id, browser: ws, opened: false, backlog: [], timer: null }
    entry.sockets.set(id, ctx)
    ctx.timer = setTimeout(() => {
      if (!entry.sockets.has(id)) return
      entry.sockets.delete(id)
      try { ws.close(1011, 'the host did not accept the stream') } catch { /* gone */ }
      settleBrowser(found.sessionId)
    }, TUNNEL_OPEN_TIMEOUT_MS)
    ctx.timer.unref?.()

    const headers = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value)
    }
    const upstream = route.rest + url.search
    const protocol = headers['sec-websocket-protocol']
    send(entry.host, {
      t: 'msg',
      payload: {
        t: 'ws-open',
        id,
        url: upstream,
        headers,
        ...(protocol ? { protocol: protocol.split(',')[0].trim() } : {}),
      },
    })

    ws.on('message', (data, isBinary) => {
      const chunk = { data: Buffer.from(data).toString('base64'), binary: isBinary === true }
      if (!ctx.opened) {
        if (ctx.backlog.length < TUNNEL_BACKLOG_MAX) ctx.backlog.push(chunk)
        return
      }
      send(entry.host, { t: 'msg', payload: { t: 'ws-msg', id, ...chunk } })
    })

    const close = (code, reason) => {
      if (!entry.sockets.has(id)) return
      entry.sockets.delete(id)
      clearTimeout(ctx.timer)
      send(entry.host, {
        t: 'msg',
        payload: { t: 'ws-close', id, code: code || 1000, reason: String(reason ?? '').slice(0, 200) },
      })
      settleBrowser(found.sessionId)
    }
    ws.on('close', (code, reason) => close(code, reason))
    ws.on('error', () => close(1011, 'relay socket error'))
  })
}

// ── boot ───────────────────────────────────────────────────────────────────

await loadState()

const server = createServer((request, response) => {
  handleHttp(request, response).catch((error) => {
    log('http handler error:', error?.stack ?? String(error))
    if (!response.headersSent) json(response, 500, { error: 'internal', message: String(error) })
  })
})
server.on('upgrade', onUpgrade)

const sweeper = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate()
      continue
    }
    socket.isAlive = false
    socket.ping()
  }
}, HEARTBEAT_MS)
sweeper.unref()

server.listen(PORT, HOST, () => {
  log(`dsh-remote-control relay listening on http://${HOST}:${PORT}`)
  log(`  web root : ${WEB_ROOT}`)
  log(`  state    : ${STATE_FILE}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`received ${signal}, shutting down`)
    clearInterval(sweeper)
    for (const socket of wss.clients) socket.close()
    for (const socket of tunnelWss.clients) socket.close()
    void saveState().finally(() => {
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 3_000).unref()
    })
  })
}