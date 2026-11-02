/**
 * Host half of the native-UI tunnel.
 *
 * The relay forwards a browser's HTTP requests and WebSocket upgrades here as
 * JSON frames; this class replays each one against the local DSH web server and
 * streams the answer back. That is what lets a remote browser run the *real*
 * Harness client instead of a hand-built mobile facsimile: the bytes are the
 * ones the native page would see on loopback.
 *
 * Four details are load-bearing:
 *
 * - **Host and Origin are rewritten.** A replay targets `127.0.0.1:<port>`, so
 *   the request passes the web server's loopback fence, and the browser's own
 *   `Origin`/`Referer`/`Sec-Fetch-*` markers are dropped because they name the
 *   relay, not loopback.
 * - **A minted browser-session cookie is attached.** The `/api` carrier and the
 *   gateway upgrade require the signed cookie the printed URL's launch token
 *   exchanges for; `WebCookie` below mints one for `127.0.0.1:<port>` and reuses
 *   it. Neither the browser nor the relay ever sees it.
 * - **Compression is negotiated per request, not globally.** A document
 *   navigation drops `accept-encoding`, because this class has to read the
 *   shell's HTML to splice in the display payload (§3.4 of
 *   `relay/PROTOCOL.md`); everything else keeps it, so the bundles that make up
 *   most of a cold page load arrive gzipped from the origin. Serving those
 *   uncompressed is what makes a first load over a phone link take a minute.
 * - **Only `text/html` is buffered, and only when it is unencoded.** Every other
 *   body streams chunk by chunk, so a large asset never waits for its last byte
 *   before the first is sent.
 *
 * The wire frames are documented in `relay/PROTOCOL.md` section 3.
 *
 * @module dsh-remote-control/web/replay
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import WebSocket from 'ws'

/** Minimal logging seam, matching the plugin's logger shape. */
export interface ReplayLogger {
  /** Verbose diagnostics, suppressed in normal runs. */
  debug(message: string): void
  /** Lifecycle transitions worth recording. */
  info(message: string): void
  /** Recoverable problems. */
  warn(message: string): void
}

/** Destination for frames produced by the replay. */
export type TunnelSink = (payload: Record<string, unknown>) => void

/**
 * Source of the minted browser-session cookie.
 *
 * `{@link WebCookie}` implements it; a test can pass a literal.
 */
export interface CookieProvider {
  /**
   * The cookie as `name=value`, minting it if necessary.
   * @returns the cookie, or undefined when none can be minted.
   */
  get(): Promise<string | undefined> | string | undefined
  /** Discard the cached cookie so the next read mints a fresh one. */
  invalidate(): void
}

/** Options for {@link WebReplay}. */
export interface WebReplayOptions {
  /** Loopback interface the DSH web server listens on. */
  host?: string
  /** Read the DSH web server port; read per request, because it may change. */
  port: () => number
  /**
   * Minted browser-session cookie (`name=value`), read fresh per request so a
   * cookie refreshed after a host restart is picked up.
   */
  cookie: CookieProvider
  /**
   * Payload added to every tunnelled HTML response: `head` before `</head>`,
   * `body` before `</body>`. Absent means "replay the document untouched".
   */
  inject?: () => { head?: string; body?: string }
  /** Destination for lifecycle logs. */
  logger: ReplayLogger
  /** Largest HTML body to buffer for injection, in bytes. @default 8 MiB */
  maxHtmlBytes?: number
}

/** One in-flight HTTP replay. */
interface PendingHttp {
  /** The loopback request, once the cookie resolution has let us build it. */
  request?: ClientRequest
  /** The response stream, once the head has arrived. */
  response?: IncomingMessage
  /**
   * Body chunks that arrived before the request object existed.
   *
   * Frames are ordered, but building the request is not synchronous — the
   * browser-session cookie may still be minting — so the first chunks of a
   * `POST` can legitimately arrive first.
   */
  queued: Buffer[]
  /** Whether the relay has sent every body chunk. */
  ended: boolean
  /** Whether this exchange is over, so late frames are dropped. */
  settled: boolean
  /** Whether a response has started, so the body is no longer wanted. */
  answered?: boolean
}

/** One in-flight tunnelled WebSocket. */
interface PendingSocket {
  /** The loopback socket, once the handshake has completed. */
  socket?: WebSocket
  /** Frames the relay sent before the handshake finished. */
  backlog: Array<{ data: string; binary: boolean }>
  /** Set once the relay has been told the stream is over. */
  settled: boolean
}

/**
 * Marks a request that the host is replaying from the tunnel.
 *
 * Set on every replayed request so the harness side can tell a remote caller
 * from the local window.
 */
export const TUNNEL_MARKER = 'x-dsh-remote-control-tunnelled'

/** Request headers that must not cross the tunnel. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'origin',
  'referer',
  'cookie',
  'content-length',
  // Browser fetch metadata describes the browser's view of the relay. Left in
  // place it would trip the harness's `cross-site` refusal on a loopback replay.
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
])

/** Response headers that describe the relay hop rather than the payload. */
const RESPONSE_DROP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  // The cookie is bound to the loopback authority; the browser must never see it.
  'set-cookie',
])

/**
 * Whether a request is a document navigation rather than a subresource.
 *
 * `Accept: text/html` is what a browser sends for a page and what it never sends
 * for a stylesheet, a script or a fetch — so it is the reliable discriminator
 * between "this response may be rewritten" and "this response is payload".
 * @param headers - the request headers, lowercased.
 * @returns true when the browser is asking for a document.
 */
function isDocumentRequest(headers: Record<string, string>): boolean {
  return (headers.accept ?? '').includes('text/html')
}

/** Coerce a `ws` payload to a Buffer. */
function rawToBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data as ArrayBuffer)
}

/** Read a string field off an untrusted frame. */
function stringField(frame: Record<string, unknown>, key: string): string | undefined {
  const value = frame[key]
  return typeof value === 'string' ? value : undefined
}

/** Read a numeric field off an untrusted frame. */
function numberField(frame: Record<string, unknown>, key: string): number | undefined {
  const value = frame[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a header bag off an untrusted frame, keeping only string values. */
function headerBag(frame: Record<string, unknown>, key: string): Record<string, string> {
  const value = frame[key]
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[name.toLowerCase()] = entry
  }
  return out
}

/**
 * Mints and caches the browser-session cookie the harness requires.
 *
 * The harness never exposes the cookie directly: it exposes the *launch URL*
 * that a browser would exchange for one (`ctx.connection.authenticatedUrl`).
 * This class performs that exchange once against loopback and keeps the
 * `Set-Cookie` value, refreshing it on a 401 rather than on a timer.
 */
export class WebCookie {
  private readonly options: {
    host: string
    port: () => number
    launchUrl: () => string | undefined
    logger: ReplayLogger
  }

  private value: string | undefined
  private minting: Promise<string | undefined> | undefined

  /**
   * @param options - loopback target, launch-URL source and logger.
   */
  constructor(options: {
    host: string
    port: () => number
    launchUrl: () => string | undefined
    logger: ReplayLogger
  }) {
    this.options = options
  }

  /** The current cookie, or undefined before the first successful mint. */
  get current(): string | undefined {
    return this.value
  }

  /** Drop the cached cookie so the next read mints a fresh one. */
  invalidate(): void {
    this.value = undefined
  }

  /**
   * Return the cookie, minting it on first use.
   * @returns `name=value`, or undefined when the exchange is impossible.
   */
  async get(): Promise<string | undefined> {
    if (this.value !== undefined) return this.value
    this.minting ??= this.mint().finally(() => { this.minting = undefined })
    return this.minting
  }

  /**
   * Perform the launch-token exchange against loopback.
   * @returns the cookie, or undefined when the harness offers no launch URL.
   */
  private async mint(): Promise<string | undefined> {
    const launchUrl = this.options.launchUrl()
    if (!launchUrl) {
      this.options.logger.warn('[dsh-remote-control] no launch URL: the tunnel will replay unauthenticated')
      return undefined
    }
    const host = this.options.host
    const port = this.options.port()
    // The launch URL names the bound host; re-point it at the loopback literal
    // the replay dials, so the cookie authority matches what we will send.
    let target: URL
    try {
      const original = new URL(launchUrl)
      target = new URL(`http://${host}:${port}${original.pathname}${original.search}`)
    } catch {
      this.options.logger.warn('[dsh-remote-control] launch URL was unparseable; replaying unauthenticated')
      return undefined
    }
    const cookie = await new Promise<string | undefined>((resolve) => {
      const request = httpRequest({
        host,
        port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { host: `${host}:${port}`, 'cache-control': 'no-store' },
      }, (response) => {
        response.resume()
        const raw = response.headers['set-cookie']
        const first = Array.isArray(raw) ? raw[0] : raw
        resolve(first?.split(';')[0]?.trim() || undefined)
      })
      request.on('error', (error) => {
        this.options.logger.warn(`[dsh-remote-control] cookie exchange failed: ${String(error)}`)
        resolve(undefined)
      })
      request.setTimeout(5_000, () => { request.destroy(new Error('cookie exchange timed out')) })
      request.end()
    })
    if (cookie !== undefined) {
      this.value = cookie
      this.options.logger.info('[dsh-remote-control] minted a browser-session cookie for the tunnel')
    }
    return cookie
  }
}

/**
 * Replays tunnelled browser traffic against this host's DSH web server.
 *
 * One instance serves every paired browser. Requests are correlated by the
 * relay-minted id, and the relay draws every id from one counter for the whole
 * session — so a single flat map is enough, even though several browsers share
 * this one host socket.
 */
export class WebReplay {
  private readonly options: WebReplayOptions
  private readonly host: string
  private readonly logger: ReplayLogger
  private readonly maxHtmlBytes: number
  private readonly http = new Map<number, PendingHttp>()
  private readonly sockets = new Map<number, PendingSocket>()
  private disposed = false

  /**
   * @param options - loopback target, cookie source, injection and logger.
   */
  constructor(options: WebReplayOptions) {
    this.options = options
    this.host = options.host ?? '127.0.0.1'
    this.logger = options.logger
    this.maxHtmlBytes = options.maxHtmlBytes ?? 8 * 1024 * 1024
  }

  /** Number of in-flight replays, for diagnostics. */
  get pending(): { http: number; sockets: number } {
    return { http: this.http.size, sockets: this.sockets.size }
  }

  /**
   * Dispatch one tunnel frame from the relay.
   * @param frame - the decoded `msg.payload`.
   * @param sink - destination for the frames this replay produces.
   */
  handle(frame: Record<string, unknown>, sink: TunnelSink): void {
    if (this.disposed) return
    switch (frame.t) {
      case 'http-req':
        this.onRequest(frame, sink)
        return
      case 'http-body':
        this.onRequestBody(frame)
        return
      case 'http-req-end':
        this.onRequestEnd(frame)
        return
      case 'http-abort':
        this.abortRequest(frame)
        return
      case 'ws-open':
        void this.onSocketOpen(frame, sink)
        return
      case 'ws-msg':
        this.onSocketMessage(frame)
        return
      case 'ws-close':
        this.onSocketClose(frame, true)
        return
      default:
        this.logger.debug(`[dsh-remote-control] ignoring unknown tunnel frame ${String(frame.t)}`)
    }
  }

  /** Tear down every in-flight replay and socket. */
  dispose(): void {
    this.disposed = true
    for (const [id, entry] of this.http) this.settleHttp(id, entry)
    for (const entry of this.sockets.values()) entry.socket?.terminate()
    this.sockets.clear()
  }

  /** Abort every in-flight replay, leaving the instance usable. */
  abortAll(): void {
    for (const [id, entry] of this.http) this.settleHttp(id, entry)
    for (const entry of this.sockets.values()) entry.socket?.terminate()
    this.sockets.clear()
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  /**
   * Begin replaying one HTTP request against the local web server.
   *
   * The exchange is registered synchronously — before the cookie is available —
   * so body frames that follow immediately have somewhere to land.
   * @param frame - the `http-req` frame.
   * @param sink - destination for response frames.
   * @param retried - whether the cookie has already been refreshed once for
   *   this exchange. A second 401 is reported rather than retried, so an
   *   unrunnable composition surfaces an honest `401` instead of a loop.
   * @param bodySent - whether the retried exchange's body was already complete.
   *   A rebuilt request has no `http-req-end` coming, so without this it would
   *   be constructed and never sent.
   */
  private onRequest(
    frame: Record<string, unknown>,
    sink: TunnelSink,
    retried = false,
    bodySent = false,
  ): void {
    const id = numberField(frame, 'id')
    const method = stringField(frame, 'method')
    const url = stringField(frame, 'url')
    if (id === undefined || method === undefined || url === undefined) {
      this.logger.warn('[dsh-remote-control] malformed http-req frame')
      return
    }
    const port = this.options.port()
    if (!Number.isInteger(port) || port <= 0) {
      sink({ t: 'http-error', id, code: 'host-unreachable', message: 'the web server has no port' })
      return
    }

    const entry: PendingHttp = { queued: [], ended: bodySent, settled: false }
    this.http.set(id, entry)

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(headerBag(frame, 'headers'))) {
      if (!HOP_BY_HOP.has(name)) headers[name] = value
    }
    headers.host = `${this.host}:${port}`
    // Marks the request as one that arrived through the tunnel rather than from
    // the local window. Both look identical to a loopback listener, and the
    // plugin's own control routes need to be able to tell them apart: a paired
    // browser can reach them, so "who asked" belongs in the audit trail.
    headers[TUNNEL_MARKER] = '1'

    // Compression is dropped for a document navigation and kept for everything
    // else. A navigation's HTML has to be rewritten to carry the display
    // payload, which needs the bytes readable; a subresource is the bulk of a
    // cold page load — tens of bundles — and re-serving those uncompressed over
    // a phone link is the difference between a page that loads and one that
    // does not.
    if (isDocumentRequest(headers)) delete headers['accept-encoding']

    void (async () => {
      const cookie = await this.options.cookie.get()
      if (entry.settled || this.disposed) return
      if (cookie !== undefined) headers.cookie = cookie

      const request = httpRequest({ host: this.host, port, method, path: url, headers }, (response) => {
        // A 401 means the harness no longer accepts our cookie (it restarted
        // with a new launch token, or the credential record was replaced).
        // Mint a fresh one and replay the request once; the browser never sees
        // a sign-in prompt it has no way to answer.
        if (response.statusCode === 401 && !retried && cookie !== undefined) {
          // Drain before re-issuing so the socket returns to the pool, and
          // register the listener first: `resume` may end a small body before
          // a listener attached afterwards would ever see it.
          const complete = entry.ended
          response.on('end', () => {
            this.options.cookie.invalidate()
            this.http.delete(id)
            this.onRequest(frame, sink, true, complete)
          })
          response.on('error', () => {
            this.http.delete(id)
            this.onRequest(frame, sink, true, complete)
          })
          response.resume()
          return
        }
        entry.answered = true
        this.streamResponse(id, response, sink)
      })
      entry.request = request
      request.on('error', (error) => {
        if (entry.settled) return
        this.settleHttp(id, entry)
        if (this.disposed) return
        sink({
          t: 'http-error',
          id,
          code: 'host-unreachable',
          message: error instanceof Error ? error.message : String(error),
        })
      })
      for (const chunk of entry.queued) {
        if (!request.destroyed) request.write(chunk)
      }
      entry.queued.length = 0
      if (entry.ended && !request.destroyed) request.end()
    })()
  }

  /**
   * Forward one request-body chunk to the loopback request.
   * @param frame - the `http-body` frame.
   */
  private onRequestBody(frame: Record<string, unknown>): void {
    const id = numberField(frame, 'id')
    const data = stringField(frame, 'data')
    if (id === undefined || data === undefined) return
    const entry = this.http.get(id)
    if (!entry || entry.settled) return
    const chunk = Buffer.from(data, 'base64')
    // Once a response has started, the origin is no longer reading the body.
    if (entry.answered || entry.request?.destroyed) return
    if (entry.request === undefined) {
      entry.queued.push(chunk)
      return
    }
    entry.request.write(chunk)
  }

  /**
   * Mark the request body complete.
   * @param frame - the `http-req-end` frame.
   */
  private onRequestEnd(frame: Record<string, unknown>): void {
    const id = numberField(frame, 'id')
    if (id === undefined) return
    const entry = this.http.get(id)
    if (!entry || entry.settled) return
    entry.ended = true
    if (entry.request !== undefined && !entry.request.destroyed) entry.request.end()
  }

  /** Forget an exchange and release its response stream. */
  private settleHttp(id: number, entry: PendingHttp): void {
    entry.settled = true
    entry.response?.destroy()
    entry.request?.destroy()
    this.http.delete(id)
  }

  /**
   * Forward a response head and body to the relay.
   * @param id - request id.
   * @param response - the loopback response.
   * @param sink - destination for response frames.
   */
  private streamResponse(id: number, response: IncomingMessage, sink: TunnelSink): void {
    const entry = this.http.get(id)
    if (!entry || entry.settled) {
      response.destroy()
      return
    }
    entry.response = response

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue
      if (RESPONSE_DROP.has(name)) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value)
    }

    const contentType = String(response.headers['content-type'] ?? '')
    // Never touch an encoded body: the one rewrite this class performs needs
    // readable markup, and a mis-splice would be silent corruption.
    const encoded = response.headers['content-encoding'] !== undefined
    const rewrite = !encoded
      && contentType.includes('text/html')
      && this.options.inject !== undefined

    sink({ t: 'http-res', id, status: response.statusCode ?? 502, headers })

    const finish = (): void => {
      entry.settled = true
      this.http.delete(id)
      sink({ t: 'http-end', id })
    }

    if (!rewrite) {
      response.on('data', (chunk: Buffer) => {
        sink({ t: 'http-chunk', id, data: chunk.toString('base64') })
      })
      response.on('end', finish)
      response.on('error', finish)
      return
    }

    // The shell is small enough to hold; anything larger streams untouched
    // rather than being buffered whole.
    const chunks: Buffer[] = []
    let size = 0
    let overflowed = false
    response.on('data', (chunk: Buffer) => {
      if (overflowed) {
        sink({ t: 'http-chunk', id, data: chunk.toString('base64') })
        return
      }
      size += chunk.byteLength
      if (size > this.maxHtmlBytes) {
        overflowed = true
        for (const held of chunks) sink({ t: 'http-chunk', id, data: held.toString('base64') })
        chunks.length = 0
        sink({ t: 'http-chunk', id, data: chunk.toString('base64') })
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => {
      if (!overflowed) {
        const html = Buffer.concat(chunks).toString('utf8')
        const injected = injectIntoHtml(html, this.options.inject?.() ?? {})
        sink({ t: 'http-chunk', id, data: Buffer.from(injected, 'utf8').toString('base64') })
      }
      finish()
    })
    response.on('error', finish)
  }

  /**
   * Abort one in-flight replay.
   * @param frame - the `http-abort` frame.
   */
  private abortRequest(frame: Record<string, unknown>): void {
    const id = numberField(frame, 'id')
    if (id === undefined) return
    const entry = this.http.get(id)
    if (!entry) return
    this.settleHttp(id, entry)
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  /**
   * Open a loopback WebSocket on the relay's behalf.
   * @param frame - the `ws-open` frame.
   * @param sink - destination for socket frames.
   */
  private async onSocketOpen(
    frame: Record<string, unknown>,
    sink: TunnelSink,
  ): Promise<void> {
    const id = numberField(frame, 'id')
    const url = stringField(frame, 'url')
    if (id === undefined || url === undefined) {
      this.logger.warn('[dsh-remote-control] malformed ws-open frame')
      return
    }
    const entry: PendingSocket = { backlog: [], settled: false }
    this.sockets.set(id, entry)

    const port = this.options.port()
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(headerBag(frame, 'headers'))) {
      if (HOP_BY_HOP.has(name) || name.startsWith('sec-websocket')) continue
      headers[name] = value
    }
    const cookie = await this.options.cookie.get()
    if (cookie !== undefined) headers.cookie = cookie
    const protocol = stringField(frame, 'protocol')

    const socket = new WebSocket(`ws://${this.host}:${port}${url}`, protocol ? [protocol] : [], {
      headers,
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    })
    entry.socket = socket

    socket.on('open', () => {
      sink({ t: 'ws-open-ok', id, ...(socket.protocol ? { protocol: socket.protocol } : {}) })
      for (const held of entry.backlog) sink({ t: 'ws-msg', id, ...held })
      entry.backlog.length = 0
    })
    socket.binaryType = 'nodebuffer'
    socket.on('message', (data, isBinary) => {
      const buffer = rawToBuffer(data)
      sink({ t: 'ws-msg', id, data: buffer.toString('base64'), binary: isBinary })
    })
    socket.on('close', (code, reason) => {
      if (entry.settled) return
      entry.settled = true
      this.sockets.delete(id)
      sink({ t: 'ws-close', id, code, reason: reason.toString().slice(0, 200) })
    })
    socket.on('error', (error) => {
      if (entry.settled) return
      entry.settled = true
      this.sockets.delete(id)
      if (socket.readyState === WebSocket.OPEN) return
      sink({
        t: 'ws-error',
        id,
        code: 'host-unreachable',
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /**
   * Forward one browser frame to the loopback socket.
   * @param frame - the `ws-msg` frame.
   */
  private onSocketMessage(frame: Record<string, unknown>): void {
    const id = numberField(frame, 'id')
    const data = stringField(frame, 'data')
    if (id === undefined || data === undefined) return
    const entry = this.sockets.get(id)
    if (!entry) return
    const binary = frame.binary === true
    if (entry.socket?.readyState === WebSocket.OPEN) {
      entry.socket.send(Buffer.from(data, 'base64'), { binary })
      return
    }
    // The handshake may still be in flight; a bounded backlog keeps a fast
    // client from growing this without limit.
    if (entry.backlog.length < 256) entry.backlog.push({ data, binary })
  }

  /**
   * Close one tunnel-indirected socket.
   * @param frame - the `ws-close` frame.
   * @param fromRelay - whether the relay (rather than the host) initiated it.
   */
  private onSocketClose(frame: Record<string, unknown>, fromRelay: boolean): void {
    const id = numberField(frame, 'id')
    if (id === undefined) return
    const entry = this.sockets.get(id)
    if (!entry) return
    entry.settled = true
    this.sockets.delete(id)
    if (!fromRelay) return
    const code = numberField(frame, 'code') ?? 1000
    const reason = stringField(frame, 'reason') ?? ''
    if (entry.socket?.readyState === WebSocket.OPEN) entry.socket.close(code, reason.slice(0, 120))
    else entry.socket?.terminate()
  }
}

/**
 * Splice the display payload into a shell document.
 *
 * The two placements are deliberate. The head fragment carries the viewport
 * rewrite, which has to be in effect before the client measures anything; the
 * body fragment lands after the harness's own boot scripts, so it observes a
 * document the client has already started.
 *
 * Idempotent, and tolerant of a document with no `</head>` or `</body>`: a
 * fragment with nowhere to go is appended rather than dropped.
 *
 * @param html - the response body.
 * @param snippet - the fragments to splice in.
 * @returns the rewritten document, or the original when there is nothing to add.
 */
export function injectIntoHtml(html: string, snippet: { head?: string; body?: string }): string {
  const head = snippet.head ?? ''
  const body = snippet.body ?? ''
  if (head.length === 0 && body.length === 0) return html
  if (html.includes('data-dsh-remote-adapt')) return html
  let out = html
  if (head.length > 0) {
    const at = out.indexOf('</head>')
    out = at === -1 ? `${head}${out}` : `${out.slice(0, at)}${head}${out.slice(at)}`
  }
  if (body.length > 0) {
    const at = out.lastIndexOf('</body>')
    out = at === -1 ? `${out}${body}` : `${out.slice(0, at)}${body}${out.slice(at)}`
  }
  return out
}