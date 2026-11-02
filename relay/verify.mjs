#!/usr/bin/env node
/**
 * Standalone verification for the DSH remote-control relay.
 *
 * Starts the real server on an ephemeral port with a temporary state file and
 * no DSH anywhere, then drives every contract the relay owns: registration, the
 * pairing cookie, the `/_relay` API, the HTTP proxy, and the WebSocket upgrade
 * routing. The host is a stub that answers tunnel frames directly, so a failure
 * here is always the relay's.
 *
 * The vitest suite covers the same ground from inside the plugin's TypeScript;
 * this one runs on a bare `node` with no build step, which is what makes it the
 * right tool when the relay is deployed somewhere and something is wrong.
 *
 * Run: node relay/verify.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PORT = 8100 + Math.floor(Math.random() * 800)
const ORIGIN = `http://127.0.0.1:${PORT}`
const WS_ORIGIN = `ws://127.0.0.1:${PORT}`

let passed = 0
let failed = 0

/**
 * Assert one condition and record the outcome.
 * @param {string} label - what is being checked.
 * @param {unknown} condition - truthy when the check passes.
 * @param {unknown} [detail] - extra context printed on failure.
 * @returns {void}
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 240)}`}`)
  }
}

/**
 * Wait for one frame matching a predicate.
 * @param {object} state - `{ frames }` collected by the caller.
 * @param {(frame: any) => boolean} predicate - matcher.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<any>} the matching frame, or undefined on timeout.
 */
async function waitFrame(state, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = state.frames.find(predicate)
    if (found) return found
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
}

/**
 * Collect frames from a socket.
 * @param {WebSocket} socket - the socket.
 * @returns the frame log.
 */
function collect(socket) {
  const state = { frames: [] }
  socket.on('message', (raw) => {
    try { state.frames.push(JSON.parse(raw.toString())) } catch { /* not ours */ }
  })
  return state
}

/**
 * Collect raw payloads from a tunnelled application socket.
 *
 * A tunnelled socket is the harness's own WebSocket, not a relay control
 * socket: its frames are application bytes, so they are not JSON envelopes.
 * @param {WebSocket} socket - the socket.
 * @returns the payload log.
 */
function collectRaw(socket) {
  const state = { frames: [] }
  socket.on('message', (raw, isBinary) => {
    state.frames.push({ text: Buffer.from(raw).toString('utf8'), binary: isBinary })
  })
  return state
}

/**
 * Open a socket and wait for it to be ready.
 * @param {string} url - socket URL.
 * @returns {Promise<WebSocket>} the open socket.
 */
async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

/**
 * Send one tunnel frame to the host socket.
 * @param {WebSocket} host - the host socket.
 * @param {object} payload - frame body.
 * @returns {void}
 */
function toHost(host, payload) {
  host.send(JSON.stringify({ t: 'msg', payload }))
}

/**
 * Answer tunnelled requests on a socket, naming the host that served them.
 * @param {import('ws').WebSocket} socket - the host socket.
 * @param {string} label - the name to answer with.
 * @returns {void}
 */
function serveHttp(socket, label) {
  socket.on('message', (raw) => {
    let frame
    try { frame = JSON.parse(raw.toString()) } catch { return }
    const payload = frame.payload
    if (!payload) return
    if (payload.t === 'http-req') {
      toHost(socket, { t: 'http-res', id: payload.id, status: 200, headers: { 'content-type': 'text/plain' } })
      toHost(socket, {
        t: 'http-chunk',
        id: payload.id,
        data: Buffer.from(`${label} ${payload.url}`).toString('base64'),
      })
    } else if (payload.t === 'ping') {
      toHost(socket, { t: 'pong', id: payload.id })
    }
  })
}

/**
 * Attach a host socket to a session, as the real plugin does.
 * @param {string} origin - relay origin.
 * @param {{sessionId: string, hostSecret: string, hostLabel?: string}} session - credentials.
 * @returns {Promise<import('ws').WebSocket>} the open socket.
 */
async function attachHost(origin, session) {
  const query = `role=host&session=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(session.hostSecret)}`
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws?${query}`)
  await new Promise((resolve) => { socket.once('open', resolve) })
  serveHttp(socket, session.hostLabel ?? 'served')
  await new Promise((resolve) => { setTimeout(resolve, 200) })
  return socket
}

/** Shared secret the relay demands before it will register a host. */
const SECRET = 'verify-relay-secret'

// Every call below is made by a host, so the secret rides along by default and
// the few negative cases reach past it deliberately.
const unauthorised = globalThis.fetch
globalThis.fetch = (url, init = {}) => unauthorised(url, {
  ...init,
  headers: { ...(init.headers ?? {}), 'x-dsh-relay-secret': SECRET },
})

const work = await mkdtemp(join(tmpdir(), 'relay-verify-'))

// A session record as an older relay wrote it: no `everAttached` field at all.
// Those are exactly the records that were being called "dead", sending a browser
// to re-pair over a machine that was merely asleep.
const LEGACY_SESSION = 'legacy-session'
const LEGACY_PHONE = 'legacy-phone-token'
await writeFile(join(work, 'state.json'), JSON.stringify({
  sessions: {
    [LEGACY_SESSION]: {
      hostSecret: 'legacy-host-secret',
      hostLabel: 'legacy-host',
      createdAt: Date.now() - 86_400_000,
      lastSeenAt: Date.now() - 3_600_000,
      phoneTokens: [LEGACY_PHONE],
      pairingTokens: {},
    },
  },
}), { mode: 0o600 })

const relay = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    STATE_FILE: join(work, 'state.json'),
    PUBLIC_ORIGIN: ORIGIN,
    PAIRING_TTL_MS: '600',
    BROWSER_IDLE_MS: '400',
    RELAY_SECRET: SECRET,
    // This suite pins the relay's *contract*, and several checks read the
    // offline page the moment a host goes away. The grace window that holds
    // browsers through a blip is covered by the plugin's own suites, so it is
    // switched off here rather than waited out.
    HOST_GRACE_MS: '0',
    ...(process.env.VERBOSE ? { DEBUG: '1' } : {}),
  },
  stdio: process.env.VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore',
})

let host = null

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${ORIGIN}/healthz`)).ok) break
    } catch { /* not up yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 150) })
  }

  // ── the relay's own HTTP surface ─────────────────────────────────────────
  // ── the door ─────────────────────────────────────────────────────────────
  //
  // The relay is somebody's private bandwidth and a tunnel into machines they
  // own, reachable from the open internet. Registration is the one thing that
  // has to stay shut.
  const openRegister = await unauthorised(`${ORIGIN}/_relay/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostLabel: 'stranger' }),
  })
  check('registration without the relay secret is refused', openRegister.status === 401, openRegister.status)
  const openHealth = await unauthorised(`${ORIGIN}/healthz`)
  check('the relay totals are behind the secret too', openHealth.status === 401, openHealth.status)

  // The bare origin used to serve the pairing page, which advertised a private
  // relay to anything that scanned it. A real link never needs it: pairing links
  // name their session, so they arrive scoped.
  const bare = await unauthorised(`${ORIGIN}/`)
  check('the bare origin advertises nothing', bare.status === 404, bare.status)

  const health = await (await fetch(`${ORIGIN}/healthz`)).json()
  check('healthz reports a healthy relay', health.ok === true, health)
  check('healthz counts the seeded legacy session', health.sessions === 1, health)

  // The regression: a record from before `everAttached` existed is unknowable,
  // and must read as a sleeping host rather than a finished pairing.
  const legacyPage = await fetch(`${ORIGIN}/`, { headers: { cookie: `dsh-remote-phone=${LEGACY_PHONE}` } })
  const legacyBody = await legacyPage.text()
  check('a legacy record is not called a dead pairing',
    legacyPage.status === 503 && !/no longer in use/i.test(legacyBody), legacyBody.slice(0, 160))
  check('a legacy record is offered the retry page', /offline/i.test(legacyBody), legacyBody.slice(0, 160))

  // A scoped, unpaired browser is the only visitor the shell is for: it knows
  // its session because a pairing link named it.
  const shell = await fetch(`${ORIGIN}/s/${LEGACY_SESSION}/`)
  check('an unpaired browser on a session gets the pairing shell',
    (await shell.text()).includes('Pair this browser'))
  check('the pairing shell is never cached', shell.headers.get('cache-control') === 'no-store')

  const unknown = await fetch(`${ORIGIN}/_relay/nope`)
  check('an unknown relay route is a 404, not a tunnel', unknown.status === 404, unknown.status)

  // ── registration ─────────────────────────────────────────────────────────
  const registered = await fetch(`${ORIGIN}/_relay/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostLabel: 'verify-host' }),
  })
  const session = await registered.json()
  check('registration mints a session and secret', Boolean(session.sessionId) && Boolean(session.hostSecret))
  check('the pairing URL carries the token', String(session.pairUrl).includes('/#/pair?t='), session.pairUrl)

  const resumed = await (await fetch(`${ORIGIN}/_relay/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostSecret: session.hostSecret, hostLabel: 'ignored' }),
  })).json()
  check('a known host secret resumes the same session', resumed.sessionId === session.sessionId)

  // ── host socket ──────────────────────────────────────────────────────────
  host = await connect(`${WS_ORIGIN}/ws?role=host&session=${session.sessionId}&token=${session.hostSecret}`)
  const hostState = collect(host)
  check('the host socket is accepted', (await waitFrame(hostState, (f) => f.t === 'ready')) !== undefined)

  const badHost = await connect(`${WS_ORIGIN}/ws?role=host&session=${session.sessionId}&token=wrong`)
    .then((socket) => ({ socket, state: collect(socket) }))
  const rejected = await waitFrame(badHost.state, (f) => f.t === 'error')
  check('a wrong host secret is refused', rejected?.code === 'unauthorized')
  badHost.socket.close()

  const probe = await (await fetch(`${ORIGIN}/_relay/probe?session=${session.sessionId}`)).json()
  check('probe reports the host online', probe.online === true, probe)

  // ── pairing ──────────────────────────────────────────────────────────────
  const token = new URL(session.pairUrl.replace('/#/pair?t=', '/?t=')).searchParams.get('t')
  const paired = await fetch(`${ORIGIN}/_relay/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const cookie = String(paired.headers.get('set-cookie') ?? '').split(';')[0]
  check('pairing sets a browser cookie', cookie.startsWith('dsh-remote-phone='), cookie)
  check('the browser cookie is HttpOnly', /HttpOnly/i.test(String(paired.headers.get('set-cookie'))))

  const reused = await fetch(`${ORIGIN}/_relay/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  check('a pairing token is single-use', reused.status === 401, reused.status)

  const stale = await (await fetch(`${ORIGIN}/_relay/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostSecret: session.hostSecret }),
  })).json()
  await new Promise((resolve) => { setTimeout(resolve, 700) })
  const expired = await fetch(`${ORIGIN}/_relay/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: new URL(stale.pairUrl.replace('/#/pair?t=', '/?t=')).searchParams.get('t') }),
  })
  check('an expired pairing token is refused', expired.status === 401, expired.status)

  // ── the HTTP proxy ───────────────────────────────────────────────────────
  // The stub host answers every tunnelled request from here on.
  host.on('message', (raw) => {
    let frame
    try { frame = JSON.parse(raw.toString()) } catch { return }
    const payload = frame.payload
    if (!payload) return
    if (payload.t === 'http-req') {
      if (String(payload.url).startsWith('/slow')) return
      toHost(host, { t: 'http-res', id: payload.id, status: 200, headers: { 'content-type': 'text/plain' } })
      toHost(host, {
        t: 'http-chunk',
        id: payload.id,
        data: Buffer.from(`${host.hostLabel ?? 'served'} ${payload.url}`).toString('base64'),
      })
      toHost(host, { t: 'http-end', id: payload.id })
    } else if (payload.t === 'ws-open') {
      toHost(host, { t: 'ws-open-ok', id: payload.id })
      toHost(host, { t: 'ws-msg', id: payload.id, data: Buffer.from('hello-socket').toString('base64'), binary: false })
    } else if (payload.t === 'ws-msg') {
      toHost(host, { t: 'ws-msg', id: payload.id, data: payload.data, binary: payload.binary })
    } else if (payload.t === 'ping') {
      // What the real host half does with a liveness probe.
      toHost(host, { t: 'pong', id: payload.id })
    }
  })

  const proxied = await fetch(`${ORIGIN}/hello?x=1`, { headers: { cookie } })
  check('a tunnelled GET is answered end to end', proxied.status === 200, proxied.status)
  check('the tunneled body survives the relay', (await proxied.text()) === 'served /hello?x=1')

  const unpaired = await fetch(`${ORIGIN}/hello`)
  const unpairedBody = await unpaired.text()
  check('a request without the cookie is not tunnelled',
    unpaired.status === 404 && !unpairedBody.includes('served'),
    `${unpaired.status} ${unpairedBody.slice(0, 40)}`)

  // The host must be told to abort a request the browser walked away from.
  const controller = new AbortController()
  const aborted = fetch(`${ORIGIN}/slow`, { headers: { cookie }, signal: controller.signal })
    .catch(() => 'aborted')
  await new Promise((resolve) => { setTimeout(resolve, 150) })
  controller.abort()
  await aborted
  const abortFrame = await waitFrame(hostState, (f) => f.payload?.t === 'http-abort', 3_000)
  check('a dropped browser request is aborted at the host', abortFrame !== undefined)

  // ── WebSocket upgrades ───────────────────────────────────────────────────
  const unpairedUpgrade = await new Promise((resolve) => {
    const socket = new WebSocket(`${WS_ORIGIN}/api/remote.mux`)
    socket.once('open', () => { socket.close(); resolve('opened') })
    socket.once('error', (error) => resolve(error.message))
  })
  check('an unpaired upgrade is refused', /401/u.test(String(unpairedUpgrade)), unpairedUpgrade)

  const tunnelled = new WebSocket(`${WS_ORIGIN}/api/remote.mux`, { headers: { cookie } })
  const tunnelledState = collectRaw(tunnelled)
  await new Promise((resolve, reject) => {
    tunnelled.once('open', resolve)
    tunnelled.once('error', reject)
  })
  const greeting = await waitFrame(tunnelledState, (f) => f.text === 'hello-socket', 3_000)
  check('a tunnelled socket receives host frames', greeting !== undefined, tunnelledState.frames)

  tunnelled.send('echo-me')
  const echoed = await waitFrame(tunnelledState, (f) => f.text === 'echo-me', 3_000)
  check('a tunnelled socket carries browser frames back', echoed !== undefined, tunnelledState.frames)
  tunnelled.close()

  // ── presence, unpair, and shutdown ───────────────────────────────────────
  await waitFrame(hostState, (f) => f.t === 'peer' && f.state === 'connected', 3_000)
  const present = await waitFrame(hostState, (f) => f.t === 'peer' && f.state === 'connected', 1_000)
  check('the host is told a browser is using the session', present !== undefined)
  const gone = await waitFrame(hostState, (f) => f.t === 'peer' && f.state === 'disconnected', 3_000)
  check('the host is told when the browser goes quiet', gone !== undefined)

  // The round trip is the one check that proves the tunnel carries frames in
  // both directions rather than merely holding a socket open.
  const pong = await (await fetch(`${ORIGIN}/_relay/ping`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: session.sessionId, token: session.hostSecret }),
  })).json()
  check('the relay round-trips a frame through the tunnel', pong.ok === true, pong)
  check('the round trip is timed', typeof pong.rttMs === 'number' && pong.rttMs >= 0, pong)

  const badPing = await fetch(`${ORIGIN}/_relay/ping`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: session.sessionId, token: 'wrong' }),
  })
  check('a ping with the wrong host secret is refused', badPing.status === 401, badPing.status)

  // A host that *had* attached and then went away is the recoverable case, and
  // it must keep the old "reload in a moment" advice.
  host.close()
  await new Promise((resolve) => { setTimeout(resolve, 300) })
  const noHostPing = await fetch(`${ORIGIN}/_relay/ping`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: session.sessionId, token: session.hostSecret }),
  })
  check('a ping with no host attached is a 503, not a hang', noHostPing.status === 503, noHostPing.status)
  const lapsed = await fetch(`${ORIGIN}/`, { headers: { cookie } })
  const lapsedBody = await lapsed.text()
  check('a host that merely went away is reported as offline', lapsed.status === 503, lapsed.status)
  // The page must tell the browser to wait, and must do it by *asking* the
  // relay rather than reloading on a timer. A blind reload threw the document
  // away every few seconds, and with it whatever the user was part-way through
  // answering; the probe means a recovery costs exactly one reload.
  check('the recoverable page asks the browser to retry',
    /offline/i.test(lapsedBody) && /_relay\/probe/.test(lapsedBody), lapsedBody.slice(0, 160))
  check('the recoverable page does not reload on a blind timer',
    !/location\.reload\(\), *5000/.test(lapsedBody))
  check('the recoverable page sets retry-after', lapsed.headers.get('retry-after') === '2',
    lapsed.headers.get('retry-after'))

  // The exact stale signal: a host that cannot resume its secret re-registers
  // and names the session it is leaving. Without this, a dead pairing and a
  // sleeping machine are indistinguishable and the browser is told to keep
  // reloading a link that can never come back.
  const reborn = await (await fetch(`${ORIGIN}/_relay/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previous: session.sessionId, hostLabel: 'verify-host-2' }),
  })).json()
  check('a re-registering host gets a new session', reborn.sessionId !== session.sessionId, reborn.sessionId)

  // A dead pairing must not be a dead end: the cookie is expired on the spot
  // and the browser is put back on the pairing shell, which is the only state
  // it can recover from. Anything else strands it on a page it cannot leave.
  const superseded = await fetch(`${ORIGIN}/`, { headers: { cookie } })
  const supersededBody = await superseded.text()
  check('a superseded session sends the browser to the pairing shell',
    superseded.status === 200 && /pair this browser/i.test(supersededBody), superseded.status)
  check('a superseded session expires the browser cookie',
    /Max-Age=0/u.test(String(superseded.headers.get('set-cookie'))), superseded.headers.get('set-cookie'))
  check('the shell is told why it is showing',
    /data-pair-notice="ended"/u.test(supersededBody), supersededBody.slice(0, 200))
  check('a superseded session does not promise a retry',
    !/reload this page/i.test(supersededBody))

  // Stop tells the relay *before* discarding the secret, so browsers left on
  // that session are told it is over instead of retrying forever.
  const forgot = await fetch(`${ORIGIN}/_relay/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: reborn.sessionId, token: reborn.hostSecret }),
  })
  check('the host can mark its session finished', forgot.status === 200, forgot.status)
  const forgotten = await fetch(`${ORIGIN}/`, { headers: { cookie } })
  check('a forgotten session is not reported as merely offline',
    forgotten.status === 200 && /pair this browser/i.test(await forgotten.text()))
  const badForget = await fetch(`${ORIGIN}/_relay/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: reborn.sessionId, token: 'wrong' }),
  })
  check('forgetting someone else\u2019s session is refused', badForget.status === 401, badForget.status)

  // ── two hosts, one browser ────────────────────────────────────────────────
  //
  // The bug this exists for: a browser holds one cookie per name and origin, so
  // pairing a second host replaced the first's cookie and both windows then
  // showed whichever host was paired last. Scoping each session to a path is
  // what makes two pairings coexist, so the assertions below are about *which*
  // host answers, not merely that something did.
  const one = await (await fetch(`${ORIGIN}/_relay/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostLabel: 'HOST-ONE' }),
  })).json()
  const two = await (await fetch(`${ORIGIN}/_relay/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostLabel: 'HOST-TWO' }),
  })).json()
  const oneHost = await attachHost(ORIGIN, one)
  const twoHost = await attachHost(ORIGIN, two)

  check('a pairing link names the session it belongs to',
    one.pairUrl.includes(`/s/${one.sessionId}/#/pair?t=`), one.pairUrl)
  check('two hosts get different scopes', one.pairUrl !== two.pairUrl)

  const cookieFor = async (session) => {
    const response = await fetch(`${ORIGIN}/_relay/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: new URL(session.pairUrl.replace('/#/pair?t=', '/?t=')).searchParams.get('t') }),
    })
    const body = await response.json()
    const raw = String(response.headers.get('set-cookie') ?? '')
    return { cookie: raw.split(';')[0], raw, body }
  }
  const onePair = await cookieFor(one)
  const twoPair = await cookieFor(two)
  check('a pairing cookie is scoped to its own session',
    String(onePair.body.redirect) === `/s/${one.sessionId}/`, onePair.body.redirect)
  check('the pairing cookie is scoped to that session path',
    String(onePair.raw).includes(`Path=/s/${one.sessionId}`), onePair.raw)

  const scopedGet = (session, cookie, path = '/') =>
    fetch(`${ORIGIN}/s/${session.sessionId}${path}`, { headers: { cookie } }).then((r) => r.text())

  const oneBody = await scopedGet(one, onePair.cookie)
  const twoBody = await scopedGet(two, twoPair.cookie)
  check('a scoped request reaches its own host', oneBody.includes('HOST-ONE'), oneBody.slice(0, 60))
  check('a scoped request reaches the other host', twoBody.includes('HOST-TWO'), twoBody.slice(0, 60))

  // The regression itself: one browser jar holds both cookies, so both are sent.
  const both = `${onePair.cookie}; ${twoPair.cookie}`
  const oneWithBoth = await scopedGet(one, both)
  const twoWithBoth = await scopedGet(two, both)
  check('the first host still answers when both are paired',
    oneWithBoth.includes('HOST-ONE') && !oneWithBoth.includes('HOST-TWO'), oneWithBoth.slice(0, 60))
  check('the second host still answers when both are paired',
    twoWithBoth.includes('HOST-TWO') && !twoWithBoth.includes('HOST-ONE'), twoWithBoth.slice(0, 60))

  // The scope is stripped before the host sees the path.
  const deep = await scopedGet(one, onePair.cookie, '/deep')
  check('the host sees a path without the scope', deep.includes('HOST-ONE /deep'), deep.slice(0, 60))

  // A scope the browser is not paired with must not borrow another host's app.
  const borrowed = await fetch(`${ORIGIN}/s/${one.sessionId}/`, { headers: { cookie: twoPair.cookie } })
  const borrowedBody = await borrowed.text()
  check('an unpaired scope shows the pairing shell, not another host',
    borrowed.status === 200 && !borrowedBody.includes('HOST-ONE'), borrowedBody.slice(0, 60))

  // An origin-absolute path a scoped page asks for is attributed by its referer.
  const viaReferer = await fetch(`${ORIGIN}/assets/app.js`, {
    headers: { cookie: both, referer: `${ORIGIN}/s/${two.sessionId}/` },
  })
  const refererBody = await viaReferer.text()
  check('an unscoped asset is attributed by the referer',
    refererBody.includes('HOST-TWO'), refererBody.slice(0, 60))

  oneHost.close()
  twoHost.close()

  const unpair = await fetch(`${ORIGIN}/_relay/unpair`, { method: 'POST' })
  check('unpair clears the browser cookie', /Max-Age=0/u.test(String(unpair.headers.get('set-cookie'))))

  const offline = spawn(process.execPath, [join(HERE, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT + 1),
      HOST: '127.0.0.1',
      STATE_FILE: join(work, 'other.json'),
      RELAY_SECRET: SECRET,
      // Same reason as the first relay: this suite reads the offline page as
      // soon as a host leaves, so the blip window is switched off.
      HOST_GRACE_MS: '0',
    },
    stdio: 'ignore',
  })
  await new Promise((resolve) => { setTimeout(resolve, 800) })
  const otherOrigin = `http://127.0.0.1:${PORT + 1}`
  const otherSession = await (await fetch(`${otherOrigin}/_relay/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })).json()
  const otherPair = await fetch(`${otherOrigin}/_relay/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: new URL(otherSession.pairUrl.replace('/#/pair?t=', '/?t=')).searchParams.get('t') }),
  })
  const otherCookie = String(otherPair.headers.get('set-cookie') ?? '').split(';')[0]

  // A session whose host has never attached is a spent pairing, not a sleeping
  // machine: reloading will never fix it, so it gets the shell, not the retry
  // page — and the cookie goes with it.
  const never = await fetch(`${otherOrigin}/`, { headers: { cookie: otherCookie } })
  check('a never-attached session is sent to the pairing shell',
    never.status === 200 && /pair this browser/i.test(await never.text()), never.status)
  check('a never-attached session expires the cookie',
    /Max-Age=0/u.test(String(never.headers.get('set-cookie'))))

  // The recoverable case is different and must stay different: the host was
  // here and has gone away, so the pairing is still good and the browser keeps
  // its cookie while the page retries.
  const otherHost = await attachHost(otherOrigin, otherSession)
  await new Promise((resolve) => { setTimeout(resolve, 150) })
  otherHost.close()
  await new Promise((resolve) => { setTimeout(resolve, 300) })
  const offlineResponse = await fetch(`${otherOrigin}/`, { headers: { cookie: otherCookie } })
  check('a paired browser whose host went away is told it is offline',
    offlineResponse.status === 503, offlineResponse.status)
  const offlineBody = await offlineResponse.text()
  // The recoverable advice is "wait", not "pair again" — the pairing is fine.
  check('the offline page tells the browser to wait rather than re-pair',
    /not connected/i.test(offlineBody) && !/pair this browser/i.test(offlineBody),
    offlineBody.slice(0, 200))
  check('the recoverable page keeps the cookie',
    offlineResponse.headers.get('set-cookie') === null, offlineResponse.headers.get('set-cookie'))
  check('the recoverable page asks the browser to retry',
    /_relay\/probe/.test(offlineBody) && !/location\.reload\(\), *5000/.test(offlineBody))
  offline.kill('SIGKILL')
} catch (error) {
  failed += 1
  console.error('aborted:', error?.stack ?? String(error))
} finally {
  host?.close()
  relay.kill('SIGKILL')
  await rm(work, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'─'.repeat(60)}`)
console.log(failed === 0 ? `ALL CHECKS PASSED (${passed})` : `${passed} passed, ${failed} FAILED`)
console.log('─'.repeat(60))
process.exit(failed === 0 ? 0 : 1)