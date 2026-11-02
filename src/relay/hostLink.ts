/**
 * Host side of the DSH remote-control relay.
 *
 * Connects this machine to the relay as the session's **host** and carries the
 * page tunnel: every application frame the relay sends is handed to
 * `onFrame`, and whatever `onFrame` writes back is sent over the same socket.
 * The wire contract lives in `relay/PROTOCOL.md`.
 *
 * Three properties are worth stating because they shape the code:
 *
 * - **The host secret is durable.** It is persisted, so restarting the plugin
 *   keeps the same session and already-paired browsers keep working. Only the
 *   pairing token — the thing a QR image carries — is short-lived.
 * - **The relay is untrusted for authorization.** It never sees the harness
 *   credential: the browser-session cookie is minted here and injected into the
 *   loopback replay, and never crosses this socket.
 * - **This class is transport only.** It knows nothing about HTTP, WebSocket or
 *   sessions; the tunnel that does lives in `../web/replay.ts`.
 *
 * @module dsh-remote-control/relay/hostLink
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import WebSocket from 'ws'

/** Minimal logging seam, matching the plugin's logger shape. */
export interface RelayLogger {
  /** Verbose diagnostics, suppressed in normal runs. */
  debug(message: string): void
  /** Lifecycle transitions worth recording. */
  info(message: string): void
  /** Recoverable problems. */
  warn(message: string): void
}

/** Where the link is in its lifecycle. */
export type HostLinkPhase = 'idle' | 'connecting' | 'online' | 'offline'

/** A failure the operator should see, in a stable shape. */
export interface HostLinkFailure {
  /** Machine-readable token. */
  code: string
  /** Human-readable detail. */
  message: string
}

/** Options for {@link HostLink}. */
export interface HostLinkOptions {
  /** Relay origin this host dials, e.g. `https://relay.example`. */
  origin: string
  /**
   * Shared secret the relay requires before it will register a host.
   *
   * Read from the file the plugin keeps it in. Empty is only correct against a
   * relay deliberately run open.
   */
  secret?: string
  /** Label shown to the browser so the user knows which machine this is. */
  hostLabel: string
  /** File holding the durable session id and host secret. */
  statePath: string
  /**
   * Consume one application frame from a paired browser.
   *
   * The relay multiplexes every paired browser onto this one socket, so frames
   * from different browsers interleave; the relay mints their ids from a single
   * counter, which is what keeps them apart.
   *
   * @param payload - the relay's `msg.payload`, unvalidated.
   * @param send - writes one frame back to the originating browser.
   */
  onFrame: (payload: Record<string, unknown>, send: (frame: Record<string, unknown>) => void) => void
  /** Destination for lifecycle logs. */
  logger: RelayLogger
  /** Reconnect backoff bounds. */
  backoff?: { minMs?: number; maxMs?: number }
}

/** Snapshot of the link, as reported by the plugin's local status route. */
export interface HostLinkStatus {
  /** Lifecycle phase. */
  phase: HostLinkPhase
  /** Relay origin in use. */
  origin: string
  /** Pairing session id, once established. */
  sessionId?: string
  /** URL the QR encodes; re-minted on every refresh. */
  pairUrl?: string
  /** When the current pairing token stops working, in unix ms. */
  pairExpiresAt?: number
  /** Whether a phone socket is currently attached. */
  phoneConnected: boolean
  /** Successful reconnects since start. */
  reconnects: number
  /** Requests answered. */
  requests: number
  /** Requests that produced an error reply. */
  errors: number
  /** Last failure, cleared on the next successful connection. */
  failure?: HostLinkFailure
}

/** Persisted session identity. */
interface PersistedState {
  /** Session id assigned by the relay. */
  sessionId?: string
  /** Durable secret proving this host owns the session. */
  hostSecret?: string
}

/** Shape of `POST /api/session`. */
interface SessionResponse {
  sessionId?: string
  hostSecret?: string
  hostLabel?: string
  pairingToken?: string
  expiresAt?: number
  pairUrl?: string
  error?: string
  message?: string
}

/**
 * Connect a DSH host to the relay and serve phone requests.
 *
 * Lifecycle: {@link start} registers (or resumes) a session and opens the
 * socket; {@link stop} tears it down; reconnection is automatic until stopped.
 */
export class HostLink {
  private readonly options: HostLinkOptions
  private readonly logger: RelayLogger
  private socket: WebSocket | null = null
  private state: PersistedState = {}
  private stopped = false
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private pairUrl: string | undefined
  private pairExpiresAt: number | undefined
  private phoneConnected = false
  private reconnects = 0
  private requests = 0
  private errors = 0
  private failure: HostLinkFailure | undefined

  /**
   * @param options - link configuration.
   */
  constructor(options: HostLinkOptions) {
    this.options = options
    this.logger = options.logger
  }

  /** Relay origin, normalised without a trailing slash. */
  get origin(): string {
    return this.options.origin.replace(/\/+$/u, '')
  }

  /**
   * Register or resume the pairing session and open the socket.
   * @returns resolves once the first connection attempt has settled.
   */
  async start(): Promise<void> {
    this.stopped = false
    await this.loadState()
    // Always re-register, even when a durable identity exists: registration is
    // what mints a fresh pairing token, and a stale QR that cannot work is
    // worse than one extra request. `connect` then reuses the stored identity.
    try {
      await this.register()
    } catch (error) {
      this.recordFailure('relay-unreachable', error)
    }
    await this.connect()
  }

  /** Close the socket and cancel any pending reconnect. */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.removeAllListeners()
      // Swallow whatever the teardown provokes; a socket torn down mid-handshake
      // reports an error we deliberately do not care about.
      socket.on('error', () => { /* shutting down */ })
      try {
        // `close()` on a socket that never finished connecting raises; abort it
        // outright instead so shutdown stays quiet.
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
        else socket.close()
      } catch { /* already gone */ }
    }
  }

  /**
   * Tell the relay this session is finished, before its secret is discarded.
   *
   * Called by Stop. Afterwards the host can no longer name the
   * session, so this is the last chance to tell the relay — and through it
   * every browser still paired to it — that the pairing is over.
   * @returns whether the relay acknowledged it.
   */
  /**
   * The relay-secret header, when one is configured.
   * @returns headers to merge into a relay API call.
   */
  private secretHeader(): Record<string, string> {
    const secret = this.options.secret ?? ''
    return secret === '' ? {} : { 'x-dsh-relay-secret': secret }
  }

  /**
   * Ask the relay whether it will have us, with a deadline.
   * @returns the health payload, or a failure reason.
   */
  async health(): Promise<{ ok: true, body: Record<string, unknown> } | { ok: false, status: number, error?: string }> {
    try {
      const response = await fetch(`${this.origin}/healthz`, {
        headers: this.secretHeader(),
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return { ok: false, status: response.status }
      const body = await response.json() as Record<string, unknown>
      return { ok: true, body }
    } catch (error) {
      return { ok: false, status: 0, error: String(error) }
    }
  }

  async forgetSession(): Promise<boolean> {
    const sessionId = this.state.sessionId
    const hostSecret = this.state.hostSecret
    if (sessionId === undefined || hostSecret === undefined) return false
    try {
      const response = await fetch(`${this.origin}/_relay/forget`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.secretHeader() },
        body: JSON.stringify({ session: sessionId, token: hostSecret }),
        signal: AbortSignal.timeout(5_000),
      })
      return response.ok
    } catch (error) {
      this.logger.warn(`[dsh-remote-control] could not tell the relay the session ended: ${String(error)}`)
      return false
    }
  }

  /**
   * Mint a fresh pairing token and return the new QR URL.
   *
   * Called when the operator opens the pairing panel, so a displayed QR is
   * always current rather than whatever was minted at boot.
   * @returns the URL to encode in the QR image.
   * @throws when the relay refuses to issue a session.
   */
  async refreshPairing(): Promise<string> {
    await this.register()
    if (!this.pairUrl) throw new Error('relay did not return a pairing URL')
    return this.pairUrl
  }

  /**
   * Push one unsolicited frame to every paired browser.
   *
   * Nothing in the tunnel needs this — the relay is the HTTP server, so every
   * reply is correlated — but it stays for diagnostics and for a future
   * out-of-band notice.
   * @param payload - frame body.
   * @returns whether the frame was handed to an open socket.
   */
  notify(payload: Record<string, unknown>): boolean {
    return this.send({ t: 'msg', payload })
  }

  /**
   * Report the link's current state for the local status route.
   * @returns a detached snapshot.
   */
  getStatus(): HostLinkStatus {
    return {
      phase: !this.socket
        ? (this.stopped ? 'idle' : 'connecting')
        : this.socket.readyState === WebSocket.OPEN ? 'online' : 'connecting',
      origin: this.origin,
      ...(this.state.sessionId ? { sessionId: this.state.sessionId } : {}),
      ...(this.pairUrl ? { pairUrl: this.pairUrl } : {}),
      ...(this.pairExpiresAt ? { pairExpiresAt: this.pairExpiresAt } : {}),
      phoneConnected: this.phoneConnected,
      reconnects: this.reconnects,
      requests: this.requests,
      errors: this.errors,
      ...(this.failure ? { failure: this.failure } : {}),
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Read the persisted session identity, ignoring a missing or broken file. */
  private async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.options.statePath, 'utf8')
      const parsed = JSON.parse(raw) as PersistedState
      this.state = {
        ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
        ...(typeof parsed.hostSecret === 'string' ? { hostSecret: parsed.hostSecret } : {}),
      }
      this.logger.debug(`[dsh-remote-control] relay identity loaded (session ${this.state.sessionId ?? 'none'})`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`[dsh-remote-control] relay identity unreadable, starting fresh: ${String(error)}`)
      }
      this.state = {}
    }
  }

  /** Write the session identity so a restart keeps the same pairing. */
  private async saveState(): Promise<void> {
    try {
      await mkdir(dirname(this.options.statePath), { recursive: true })
      await writeFile(this.options.statePath, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    } catch (error) {
      this.logger.warn(`[dsh-remote-control] could not persist relay identity: ${String(error)}`)
    }
  }

  /**
   * Create or resume the relay session and record the resulting QR URL.
   * @throws when the relay is unreachable or refuses the request.
   */
  private async register(): Promise<void> {
    // Under `/_relay`, not `/api`: the `/api` namespace is tunnelled straight
    // through to the harness, and this route belongs to the relay.
    const response = await fetch(`${this.origin}/_relay/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.secretHeader() },
      body: JSON.stringify({
        ...(this.state.hostSecret ? { hostSecret: this.state.hostSecret } : {}),
        hostLabel: this.options.hostLabel,
        // Tell the relay which session we are leaving, if any. When the secret
        // is not recognised this registration mints a new session, and every
        // browser still paired to the old one needs to be told *that* rather
        // than left reloading a link that cannot come back.
        ...(this.state.sessionId ? { previous: this.state.sessionId } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    // Read the body as text first: a relay running an older build answers this
    // route with its own HTML shell and a 200, and "Unexpected token '<'" tells
    // an operator nothing about the actual problem.
    const text = await response.text()
    let body: SessionResponse
    try {
      body = JSON.parse(text) as SessionResponse
    } catch {
      throw new Error(
        `the relay at ${this.origin} did not answer with its API — it is probably `
        + 'running an older build. Deploy relay/ from this package version and restart it.',
      )
    }
    if (!response.ok || !body.sessionId || !body.hostSecret) {
      throw new Error(body.message ?? body.error ?? `relay returned ${response.status}`)
    }
    // A fresh secret means the previous session was unknown to the relay; a
    // resumed one returns the same value we already held.
    const changed = this.state.hostSecret !== body.hostSecret
    if (changed && this.state.sessionId !== undefined && this.state.sessionId !== body.sessionId) {
      this.logger.warn(
        `[dsh-remote-control] registered a new session ${body.sessionId}; `
        + `browsers paired to ${this.state.sessionId} must pair again`,
      )
    }
    this.state = { sessionId: body.sessionId, hostSecret: body.hostSecret }
    if (changed) await this.saveState()
    if (body.pairUrl) this.pairUrl = body.pairUrl
    if (typeof body.expiresAt === 'number') this.pairExpiresAt = body.expiresAt
  }

  /** Register if needed, then open the host socket. */
  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      if (!this.state.sessionId || !this.state.hostSecret) await this.register()
      this.openSocket()
      // `attempt` is deliberately *not* reset here. Opening a socket only means
      // a connection was started, not that it succeeded: a relay that accepts
      // the handshake and then drops it would otherwise reset the backoff on
      // every cycle and retry at the minimum delay forever — the failure mode
      // that turns one flaky link into a reconnect storm. The reset belongs in
      // the `open` handler, the first moment the link is actually up.
    } catch (error) {
      this.recordFailure('relay-unreachable', error)
      this.scheduleReconnect()
    }
  }

  /** Open the WebSocket and wire its handlers. */
  private openSocket(): void {
    const { sessionId, hostSecret } = this.state
    if (!sessionId || !hostSecret) return
    const url = `${this.origin.replace(/^http/u, 'ws')}/ws?role=host`
      + `&session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(hostSecret)}`
    this.logger.info(`[dsh-remote-control] relay connecting ${url.replace(/token=[^&]*/u, 'token=***')}`)
    const socket = new WebSocket(url, { handshakeTimeout: 10_000 })
    this.socket = socket

    socket.on('open', () => {
      this.failure = undefined
      this.attempt = 0
      if (this.reconnects > 0 || this.requests > 0) this.reconnects += 1
      this.logger.info('[dsh-remote-control] relay online')
    })

    socket.on('message', (raw) => { void this.onFrame(raw.toString()) })

    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return
      this.socket = null
      this.phoneConnected = false
      if (this.stopped) return
      this.logger.warn(`[dsh-remote-control] relay closed (${code}${reason.length > 0 ? ` ${reason.toString()}` : ''})`)
      this.scheduleReconnect()
    })

    socket.on('error', (error) => {
      this.logger.warn(`[dsh-remote-control] relay socket error: ${String(error)}`)
    })
  }

  /**
   * Handle one relay frame.
   * @param text - raw frame body.
   */
  private async onFrame(text: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(text) as Record<string, unknown>
    } catch {
      this.logger.warn('[dsh-remote-control] relay sent a non-JSON frame')
      return
    }

    switch (frame.t) {
      case 'ready':
        return

      case 'peer': {
        const state = frame.state === 'connected'
        if (state !== this.phoneConnected) {
          this.phoneConnected = state
          this.logger.info(`[dsh-remote-control] phone ${state ? 'connected' : 'disconnected'}`)
        }
        return
      }

      case 'error': {
        const code = String(frame.code ?? 'error')
        const message = String(frame.message ?? '')
        this.recordFailure(code, message)
        // A rejected host secret cannot be retried: the relay has forgotten the
        // session, so drop the stored identity and register afresh.
        if (code === 'unauthorized' || code === 'no-session') {
          this.logger.warn('[dsh-remote-control] relay rejected our identity; re-registering')
          this.state = {}
          await this.saveState()
          this.socket?.close()
        }
        return
      }

      case 'msg':
        this.onApplicationFrame(frame.payload)
        return

      default:
        return
    }
  }

  /**
   * Handle one application frame from a paired browser.
   *
   * The host no longer interprets any of these itself: they are tunnel frames,
   * and `onFrame` owns their meaning. A malformed frame is dropped rather than
   * answered, because there is no request/response channel left to answer on.
   * @param payload - the `msg` payload.
   */
  private onApplicationFrame(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return
    const record = payload as Record<string, unknown>
    this.requests += 1
    try {
      this.options.onFrame(record, (frame) => { this.send({ t: 'msg', payload: frame }) })
    } catch (error) {
      this.errors += 1
      this.logger.warn(`[dsh-remote-control] tunnel frame failed: ${String(error)}`)
    }
  }

  /**
   * Send one relay frame.
   * @param frame - frame to serialise.
   * @returns whether it was written to an open socket.
   */
  private send(frame: Record<string, unknown>): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  /** Record a failure for the status route. */
  private recordFailure(code: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.failure = { code, message }
    this.logger.warn(`[dsh-remote-control] ${code}: ${message}`)
  }

  /** Reconnect with exponential backoff and jitter. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const min = this.options.backoff?.minMs ?? 1_000
    const max = this.options.backoff?.maxMs ?? 30_000
    const base = Math.min(max, min * 2 ** this.attempt)
    const delay = base / 2 + Math.random() * (base / 2)
    this.attempt += 1
    this.logger.debug(`[dsh-remote-control] reconnecting in ${Math.round(delay)}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }
}