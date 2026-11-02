/**
 * Pairing shell — the only page the relay serves itself.
 *
 * Everything else the browser asks for is tunnelled to the host and answered by
 * the real Harness client. This page exists for the one thing that cannot be
 * tunnelled: proving the browser is allowed to open the tunnel in the first
 * place.
 *
 * The flow is deliberately HTTP-only. A pairing token arrives in the URL
 * fragment (`#/pair?t=…`, which the QR carries) or the query string (which a
 * pasted link carries); it is exchanged at `POST /_relay/pair` for an HttpOnly
 * cookie, and the browser is then redirected to the session's scope, where the
 * tunnel takes
 * over.
 *
 * **Every path out of this page is bounded and says what happened.** Its
 * predecessor could sit on a spinner forever when the token had already been
 * spent, which reads as "pairing is broken" rather than "that link has been
 * used". A pairing token is single-use, so *reloading the page that carried it*
 * is the most common way to reach that state, and it has to be recoverable in
 * one tap.
 *
 * @module dsh-remote-relay/pair
 */

/** Steps of the flow, in the order a user can reach them. */
const STEPS = ['step-link', 'step-working', 'step-error', 'step-offline']

/** How long the relay may take to answer a pairing exchange. */
const PAIR_TIMEOUT_MS = 15_000

/** How long the relay may take to answer a liveness probe. */
const PROBE_TIMEOUT_MS = 8_000

/** How long to wait for a paired-but-absent host before giving up. */
const OFFLINE_WAIT_MS = 120_000

/** How often to re-probe while waiting for the host. */
const PROBE_INTERVAL_MS = 3_000

/**
 * The message for a relay that answered with something that is not its API.
 *
 * This is what a version skew looks like from the browser: the plugin and the
 * relay have to be deployed together, and an old relay serves its own HTML
 * shell for any path it does not know — including this one.
 */
const SKEW_MESSAGE = 'The relay answered with a page instead of its API. It is '
  + 'probably running an older build — deploy the relay/ directory from the same '
  + 'version as the plugin, then restart it.'

/**
 * Show exactly one step.
 * @param {string} id - element id of the step to reveal.
 * @returns {void}
 */
function show(id) {
  for (const step of STEPS) {
    const element = document.getElementById(step)
    if (element) element.hidden = step !== id
  }
}

/**
 * Update the progress line inside a step.
 * @param {string} id - element id of the hint.
 * @param {string} text - copy to show.
 * @returns {void}
 */
function hint(id, text) {
  const element = document.getElementById(id)
  if (element) element.textContent = text
}

/**
 * Forget the token in the address bar.
 *
 * Called once a token is known to be dead, so a reload lands on the "enter a
 * link" step instead of silently retrying a credential the relay has burned.
 * @returns {void}
 */
function forgetToken() {
  try {
    history.replaceState(null, '', location.pathname)
  } catch { /* a sandboxed history API must not break the page */ }
}

/**
 * Report a dead end and offer the one useful next action.
 * @param {string} message - what went wrong, in the user's terms.
 * @returns {void}
 */
function fail(message) {
  forgetToken()
  hint('error-text', message)
  show('step-error')
}

/**
 * Pull a pairing token out of a pasted link or this page's own URL.
 *
 * Accepts the whole QR URL, a bare token, and both `#/pair?t=` and `?t=`
 * shapes, because a link that has been through a chat client may have lost its
 * fragment.
 *
 * @param {string} value - raw input.
 * @returns {string} the token, or an empty string.
 */
function tokenFrom(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  try {
    const url = new URL(text, location.href)
    const direct = url.searchParams.get('t') ?? url.searchParams.get('token')
    if (direct) return direct
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?')) : ''
    const fromHash = new URLSearchParams(query).get('t')
    if (fromHash) return fromHash
  } catch {
    // Not a URL: fall through and treat it as a bare token.
  }
  return /^[A-Za-z0-9_-]{8,}$/.test(text) ? text : ''
}

/**
 * Call one relay JSON endpoint with a deadline.
 *
 * Never rejects: the caller gets a value it can render, because a pairing page
 * that throws is a pairing page that hangs.
 *
 * @param {string} path - endpoint, relative to the current directory.
 * @param {RequestInit} [init] - fetch options.
 * @param {number} [timeoutMs] - how long to wait for an answer.
 * @returns {Promise<{ok: boolean, status: number, body: Record<string, unknown>, error?: string}>}
 *   the parsed outcome; `error` is set for a transport or protocol failure.
 */
async function callRelay(path, init = {}, timeoutMs = PAIR_TIMEOUT_MS) {
  // `AbortSignal.timeout` is missing on older mobile browsers, and a pairing
  // page must not be the thing that decides whether the app works there.
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  let response
  try {
    response = await fetch(path, signal === undefined ? init : { ...init, signal })
  } catch (error) {
    const name = error && typeof error === 'object' ? error.name : ''
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    return {
      ok: false,
      status: 0,
      body: {},
      error: timedOut
        ? `The relay did not answer within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach the relay: ${String(error)}`,
    }
  }
  const text = await response.text().catch(() => '')
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, status: response.status, body: {}, error: SKEW_MESSAGE }
  }
  if (body === null || typeof body !== 'object') {
    return { ok: false, status: response.status, body: {}, error: SKEW_MESSAGE }
  }
  return { ok: response.ok, status: response.status, body }
}

/**
 * Exchange a pairing token for the browser cookie.
 * @param {string} token - the pairing token.
 * @returns {Promise<{ok: true, sessionId: string, hostLabel: string, online: boolean}
 *   | {ok: false, message: string}>} the outcome.
 */
async function pair(token) {
  const result = await callRelay('./_relay/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (result.error) return { ok: false, message: result.error }
  const message = typeof result.body.message === 'string' ? result.body.message : ''
  if (!result.ok) {
    if (result.status === 401) {
      const reason = message || 'This pairing link has already been used, or it has expired.'
      return {
        ok: false,
        message: `${/\.$/.test(reason) ? reason : `${reason}.`} `
          + 'Pairing links work once — open the panel on the host and use a fresh one.',
      }
    }
    return { ok: false, message: message || `The relay answered ${result.status}` }
  }
  return {
    ok: true,
    sessionId: String(result.body.sessionId ?? ''),
    redirect: typeof result.body.redirect === 'string' ? result.body.redirect : '',
    hostLabel: String(result.body.hostLabel ?? ''),
    online: result.body.online === true,
  }
}

/**
 * Ask whether the host attached to a session is up.
 * @param {string} sessionId - session key.
 * @returns {Promise<'online'|'offline'|'unknown'>} the host's state.
 */
async function probe(sessionId) {
  const result = await callRelay(
    `./_relay/probe?session=${encodeURIComponent(sessionId)}`,
    {},
    PROBE_TIMEOUT_MS,
  )
  if (result.error || !result.ok) return 'unknown'
  return result.body.online === true ? 'online' : 'offline'
}

/** Where to put the browser once it holds a cookie. */
let handoffPath = './'

/**
 * Hand the browser over to the tunnelled application.
 *
 * The relay answers a pairing with the session's own scope, because that is
 * where the cookie it just set applies. A link that arrived unscoped — an old
 * bookmark, or the shell served at the origin root — otherwise pairs and then
 * immediately looks unpaired again.
 */
function handoff() {
  location.replace(handoffPath)
}

/**
 * Wait for a paired host to attach, with a deadline the user can see.
 *
 * The token is already spent at this point, so this browser stays paired — the
 * only question is whether the machine answers. Giving up with an explanation
 * beats spinning: the plugin may simply not be armed.
 *
 * @param {string} sessionId - session key.
 * @returns {Promise<void>} resolves once the page navigates or reports failure.
 */
async function waitForHost(sessionId) {
  show('step-offline')
  const deadline = Date.now() + OFFLINE_WAIT_MS
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      fail('This browser is paired, but the host never came online. Start the '
        + 'Harness on that machine and arm Remote Control, then pair again.')
      return
    }
    hint('offline-hint', `Retrying — ${Math.ceil(remaining / 1000)}s left. `
      + 'Start the Harness on the host machine.')
    await new Promise((resolve) => { setTimeout(resolve, PROBE_INTERVAL_MS) })
    const state = await probe(sessionId)
    if (state === 'online') { handoff(); return }
    if (state === 'unknown') {
      fail(SKEW_MESSAGE)
      return
    }
  }
}

/**
 * Complete the pairing and hand over to the tunnelled app.
 * @param {string} token - the pairing token.
 * @returns {Promise<void>} resolves once the page navigates or shows an error.
 */
async function run(token) {
  show('step-working')
  hint('working-hint', 'Asking the host to let this browser in.')
  const result = await pair(token)
  if (!result.ok) {
    fail(result.message)
    return
  }
  // Follow the relay's scope: it just set the cookie for that path, so this is
  // where the browser has to be for the tunnel to recognise it.
  if (result.redirect !== '') handoffPath = result.redirect
  if (result.online) {
    handoff()
    return
  }
  await waitForHost(result.sessionId)
}

/**
 * Start the shell.
 * @returns {void}
 */
function main() {
  const host = document.getElementById('relay-host')
  if (host) host.textContent = location.host

  for (const id of ['retry', 'offline-retry']) {
    document.getElementById(id)?.addEventListener('click', () => {
      forgetToken()
      show('step-link')
    })
  }

  const form = document.getElementById('link-form')
  form?.addEventListener('submit', (event) => {
    event.preventDefault()
    const input = document.getElementById('link-input')
    const token = tokenFrom(input?.value ?? '')
    if (token === '') {
      fail('That does not look like a pairing link. Copy the whole link from the host panel.')
      return
    }
    void run(token)
  })

  // The relay marks the shell when it had to expire a cookie it could not
  // honour, so a browser that believed it was paired is told why it is here
  // rather than quietly shown a pairing page.
  const notice = document.body.dataset.pairNotice
  const NOTICES = {
    ended: 'This browser was paired to a session the host has since ended. Pair again to reconnect.',
    unpaired: 'This browser is no longer paired. Pair again to reconnect.',
    scope: 'This browser is not paired with this host. Pair to open it — other pairs stay as they are.',
  }
  if (notice && NOTICES[notice]) {
    const line = document.getElementById('link-notice')
    if (line) {
      line.textContent = NOTICES[notice]
      line.hidden = false
    }
  }

  const token = tokenFrom(location.href)
  if (token === '') show('step-link')
  else void run(token)
}

main()