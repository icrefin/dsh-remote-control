/**
 * Wire contract shared by both halves of dsh-remote.
 *
 * Both halves import this module, so a route path or payload field can never
 * drift between the host that serves it and the browser that reads it. Keep it
 * dependency-free: the client bundle inlines it.
 *
 * This describes the **local panel** — the small status surface the plugin
 * mounts on the DSH web server so the operator can pair a browser and watch the
 * link. The protocol between the browser and the host is a separate contract
 * and lives in `relay/PROTOCOL.md`.
 *
 * @module dsh-remote-control/protocol
 */

/** Route paths served by the host half under the web server's route table. */
export const API = {
  /** Current link/pairing status; also the poll target for the panel. */
  status: '/api/dsh-remote-control/status',
  /** Enable the link and start (or reuse) a pairing session. */
  start: '/api/dsh-remote-control/start',
  /** Stop the link and close the host socket. */
  stop: '/api/dsh-remote-control/stop',
  /**
   * Mint a fresh pairing token so the displayed QR is current.
   *
   * Pairing tokens expire; a panel left open past the expiry would otherwise
   * keep showing a QR that no longer works.
   */
  pair: '/api/dsh-remote-control/pair',
  /** Forget the persisted session identity and register again on next start. */
  /**
   * The live pairing URL as an SVG QR code, so the operator can scan it with a
   * phone camera. Rendered on the host: the browser half stays free of a QR
   * encoder, and the URL never has to travel through the client bundle.
   */
  qr: '/api/dsh-remote-control/qr.svg',
  /**
   * The relay origin this host dials.
   *
   * Written through the host's settings service, so the value persists across
   * restarts and is the same one the settings document holds.
   */
  settings: '/api/dsh-remote-control/settings',
  /**
   * Exercise the path from this host to the relay and back.
   *
   * Answers with a {@link TestReport}: one entry per step, so an operator sees
   * *which* link in the chain is broken rather than a single yes/no.
   */
  test: '/api/dsh-remote-control/test',
  /**
   * Read the relay secret, so the panel can show it (masked) and edit it.
   *
   * Its own route rather than a field on the status payload: the status is
   * polled, and a credential does not belong in a reply that repeats every few
   * seconds.
   */
  secret: '/api/dsh-remote-control/secret',
} as const

/**
 * Re-express a host route as the browser half must request it.
 *
 * A route beginning with `/` is origin-absolute, which is correct only while
 * the client is served at the origin root. This plugin's own panel is the
 * clearest case of the problem it causes: the tunnel serves the client at
 * `/s/<sessionId>/`, so an absolute `/api/...` request leaves that scope and is
 * answered by the relay itself — its pairing page, a `200 text/html` body,
 * which `response.json()` reports as `Unexpected token '<'`.
 *
 * Dropping the leading slash makes the request resolve against
 * `document.baseURI`, which is how the harness's own channels address the host;
 * the same page therefore reaches the panel whether it is at `/`, under a
 * reverse-proxy prefix, or behind the tunnel.
 *
 * @param route - a host route path from {@link API}.
 * @returns the same route, relative to the document.
 */
export function clientPath(route: string): string {
  return route.replace(/^\//, '')
}

/**
 * The {@link API} routes as the browser half requests them.
 *
 * Derived rather than re-typed, so the two halves cannot drift.
 */
export const CLIENT_API = {
  status: clientPath(API.status),
  start: clientPath(API.start),
  stop: clientPath(API.stop),
  pair: clientPath(API.pair),
  qr: clientPath(API.qr),
  settings: clientPath(API.settings),
  test: clientPath(API.test),
  secret: clientPath(API.secret),
} as const

/** Route paths that mutate state and therefore demand a POST. */
export const MUTATING_ROUTES: readonly string[] = [
  API.start,
  API.stop,
  API.pair,
  API.settings,
  API.test,
]

/** Where the host link is in its lifecycle. */
export type RemotePhase = 'idle' | 'connecting' | 'online' | 'offline'

/** A failure worth showing the operator. */
export interface RemoteFailure {
  /** Stable machine-readable token. */
  code: string
  /** Human-readable detail, already safe to display. */
  message: string
}

/** Body of a successful `GET API.status`. */
export interface StatusPayload {
  /** Loader row id, so the panel can prove which plugin answered. */
  id: string
  /** Installed plugin version, shown beside the page title. */
  version: string
  /** Host process id. */
  pid: number
  /**
   * Host clock, ISO 8601.
   * @example "2026-10-03T01:00:00.000Z"
   */
  time: string
  /** Whether the operator has armed the link. */
  enabled: boolean
  /** Current link phase. */
  phase: RemotePhase
  /** Relay origin the host is attached to, or an empty string when unset. */
  relayOrigin: string
  /**
   * Where {@link StatusPayload.relayOrigin} came from.
   *
   * `env` is a deployment override and cannot be edited from the panel. `patch`
   * is the profile's own user layer — the same place the settings service
   * writes, so a value saved from the panel and one typed into the profile
   * patch are deliberately indistinguishable: they *are* the same value.
   */
  relaySource: 'env' | 'patch' | 'none'
  /**
   * Whether the panel may change the relay origin.
   *
   * False when `DSH_REMOTE_RELAY` pins it, or when this composition has no
   * settings service to persist a change in.
   */
  relayEditable: boolean
  /** True when a relay secret is configured. Read it from {@link API.secret}. */
  secretSet: boolean
  /** Path of the file the secret is kept in, shown so it can be found. */
  secretPath: string
  /** Pairing session id, once the relay has issued one. */
  sessionId?: string
  /** URL the QR encodes, when a pairing token is live. */
  pairUrl?: string
  /** When the current pairing token stops working, in unix ms. */
  pairExpiresAt?: number
  /** Whether a phone is currently paired. */
  phoneConnected: boolean
  /** Successful reconnects since the plugin mounted. */
  reconnects: number
  /** Requests the phone has made. */
  requests: number
  /** Requests that produced an error reply. */
  errors: number
  /** Last failure, cleared on the next successful connection. */
  failure?: RemoteFailure
  /** Tunnel replays in flight right now. */
  pending: { http: number; sockets: number }
  /**
   * Whether the tunnel holds a browser-session cookie.
   *
   * Only meaningful once traffic has been replayed: the cookie is minted on the
   * first tunnelled request, so this is false on an idle link that is perfectly
   * healthy. Use {@link StatusPayload.connectionService} to detect a composition
   * that cannot mint one at all.
   */
  authenticated: boolean
  /**
   * Whether this composition provides the harness Connection service.
   *
   * False means the tunnel can never mint the browser session the harness
   * requires, so tunnelled `/api` calls will be refused even though pages load.
   */
  connectionService: boolean
  /** Layout width below which the display layer offers its "Fit" mode. */
  designWidth: number
}

/** One step of a connection test. */
export interface ConnectionCheck {
  /** Stable step id, so the panel can label it without matching prose. */
  id: 'configured' | 'reachable' | 'version' | 'attached' | 'session' | 'roundtrip'
  /** Whether the step passed. */
  ok: boolean
  /** Outcome in the operator's terms, safe to display as-is. */
  detail: string
  /** Round-trip time, where the step measured one. */
  ms?: number
  /** True when an earlier step failed, so this one was not attempted. */
  skipped?: boolean
}

/** Body of `POST API.test`. */
export interface TestReport {
  /** Whether every attempted step passed. */
  ok: boolean
  /** Host clock, ISO 8601. */
  checkedAt: string
  /** The relay the test ran against. */
  origin: string
  /** Installed plugin version, for the skew check. */
  version: string
  /** Steps, in the order they ran. */
  checks: ConnectionCheck[]
}

/** Body of any failed request. */
export interface ErrorPayload {
  error: string
}