/**
 * The `/api/dsh-remote-control` route family — the operator's local control surface.
 *
 * Every route carries a loopback-only fence: a LAN-exposed deployment must not
 * serve plugin APIs to other machines. The pairing URL is a credential, so it
 * is served `no-store` and fetched on demand rather than embedded in the panel's
 * initial payload. Handlers own the full response lifecycle.
 *
 * @module dsh-remote-control/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import QRCode from 'qrcode'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { TUNNEL_MARKER } from './web/replay.ts'
import type { AuditEntry } from './index.ts'
import {
  API,
  MUTATING_ROUTES,
  type ErrorPayload,
  type StatusPayload,
  type TestReport,
} from './protocol.ts'

/** Loader row id; mirrors `cordis.patch.yml`. */
const PLUGIN_ID = 'dsh-remote-control'

/** What the routes need from the plugin, so they can be tested without it. */
export interface RemoteController {
  /**
   * Current link state.
   * @returns a detached snapshot.
   */
  getStatus(): Omit<StatusPayload, 'id' | 'pid' | 'time'>
  /**
   * Walk the path from this host to the relay and back.
   * @returns one entry per step, so a failure names the link that broke.
   */
  test(): Promise<TestReport>
  /**
   * Record a call to a mutating route.
   * @param entry - what to record.
   */
  audit(entry: AuditEntry): Promise<void>
  /**
   * Persist a new relay origin and apply it to the running link.
   * @param relay - the origin to dial, or an empty string to clear it.
   * @returns resolves once the value is stored and the link, if armed, has been
   *   restarted against it.
   * @throws when the origin is not an http(s) origin, or cannot be stored.
   */
  setRelay(relay: string): Promise<void>
  /**
   * Read the stored relay secret, for the panel to display and edit.
   * @returns the secret, or an empty string when none is stored.
   */
  getSecret(): string
  /**
   * Store the secret the relay requires before it registers a host.
   * @param secret - the shared secret, or an empty string to clear it.
   */
  setSecret(secret: string): Promise<void>
  /**
   * Arm the link and establish a pairing session.
   * @returns resolves once the first attempt has settled.
   */
  start(): Promise<void>
  /** Disarm the link and close the host socket. */
  stop(): Promise<void>
  /**
   * Mint a fresh pairing token.
   * @returns the URL the QR should encode.
   */
  pair(): Promise<string>
  /**
   * Forget the persisted identity so the next start registers anew.
   * @returns resolves once the identity is cleared.
   */
}

/** Largest settings body accepted, in bytes. */
const MAX_BODY_BYTES = 8 * 1024

/**
 * Read a JSON request body with a size cap.
 *
 * Handlers own their responses, so a malformed body has to be answered rather
 * than thrown at the framework.
 * @param req - incoming request.
 * @returns the parsed body, or undefined when it is absent, oversized or not JSON.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Write one JSON response body. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Write one JSON error body. */
function writeError(res: ServerResponse, status: number, message: string): void {
  const body: ErrorPayload = { error: message }
  writeJson(res, status, body)
}

/**
 * Whether the request arrived over the loopback interface.
 * @param req - incoming request.
 * @returns true when the peer is this machine.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Stamp the plugin's own identity onto a controller snapshot.
 * @param controller - the plugin.
 * @returns the full status payload.
 */
function decorate(controller: RemoteController): StatusPayload {
  return {
    id: PLUGIN_ID,
    pid: process.pid,
    time: new Date().toISOString(),
    ...controller.getStatus(),
  }
}

/**
 * Build every route of the `/api/dsh-remote-control` family.
 * @param controller - the plugin the routes drive.
 * @returns the exact-path routes to register on `ctx.webServer`.
 */
export function makeRoutes(controller: RemoteController): WebRoute[] {
  /**
   * Apply the shared fence: loopback only, then the required method.
   * @param req - incoming request.
   * @param res - response to reject on.
   * @param path - route path, which decides the expected method.
   * @returns true when the caller may proceed.
   */
  function guard(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (!isLoopbackRequest(req)) {
      writeError(res, 403, 'forbidden: loopback-only')
      return false
    }
    // Every mutating call is recorded, whichever side made it. A tunnelled
    // request and a local one are indistinguishable at the socket, and when a
    // link starts resetting itself that difference is the whole question.
    if (MUTATING_ROUTES.includes(path)) {
      void controller.audit({
        at: new Date().toISOString(),
        route: path,
        tunnelled: req.headers[TUNNEL_MARKER] === '1',
        agent: String(req.headers['user-agent'] ?? '').slice(0, 120),
      })
    }
    const expected = MUTATING_ROUTES.includes(path) ? 'POST' : 'GET'
    if (req.method !== expected) {
      writeError(res, 405, `method not allowed: ${req.method ?? ''} (expected ${expected})`)
      return false
    }
    return true
  }

  /**
   * Run a mutating handler and answer with the resulting status.
   * @param res - response.
   * @param action - work to perform.
   */
  async function mutate(res: ServerResponse, action: () => Promise<void> | void): Promise<void> {
    try {
      await action()
      writeJson(res, 200, decorate(controller))
    } catch (error) {
      writeError(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  return [
    {
      kind: 'exact',
      path: API.status,
      handler: (req, res) => {
        if (!guard(req, res, API.status)) return
        writeJson(res, 200, decorate(controller))
      },
    },
    {
      kind: 'exact',
      path: API.start,
      handler: (req, res) => {
        if (!guard(req, res, API.start)) return
        void mutate(res, () => controller.start())
      },
    },
    {
      kind: 'exact',
      path: API.stop,
      handler: (req, res) => {
        if (!guard(req, res, API.stop)) return
        // The promise is returned, not discarded: a block body here would
        // resolve immediately and answer with the *pre-stop* status.
        void mutate(res, () => controller.stop())
      },
    },
    {
      kind: 'exact',
      path: API.pair,
      handler: (req, res) => {
        if (!guard(req, res, API.pair)) return
        void (async () => {
          try {
            const pairUrl = await controller.pair()
            writeJson(res, 200, { ...decorate(controller), pairUrl })
          } catch (error) {
            writeError(res, 500, error instanceof Error ? error.message : String(error))
          }
        })()
      },
    },
    {
      kind: 'exact',
      path: API.secret,
      handler: (req, res) => {
        if (!guard(req, res, API.secret)) return
        writeJson(res, 200, { secret: controller.getSecret() })
      },
    },
    {
      kind: 'exact',
      path: API.test,
      handler: (req, res) => {
        if (!guard(req, res, API.test)) return
        void (async () => {
          try {
            writeJson(res, 200, await controller.test())
          } catch (error) {
            writeError(res, 500, error instanceof Error ? error.message : String(error))
          }
        })()
      },
    },
    {
      kind: 'exact',
      path: API.settings,
      handler: (req, res) => {
        if (!guard(req, res, API.settings)) return
        void (async () => {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeError(res, 400, 'body must be JSON')
            return
          }
          // Either field may be sent on its own: the origin and the secret are
          // stored in the same row but are edited in different places.
          if (body.relay !== undefined && typeof body.relay !== 'string') {
            writeError(res, 400, '`relay` must be a string when present')
            return
          }
          if (body.secret !== undefined && typeof body.secret !== 'string') {
            writeError(res, 400, '`secret` must be a string when present')
            return
          }
          if (body.relay === undefined && body.secret === undefined) {
            writeError(res, 400, 'body must carry `relay`, `secret`, or both')
            return
          }
          try {
            if (typeof body.relay === 'string') await controller.setRelay(body.relay)
            if (typeof body.secret === 'string') await controller.setSecret(body.secret)
            writeJson(res, 200, decorate(controller))
          } catch (error) {
            writeError(res, 400, error instanceof Error ? error.message : String(error))
          }
        })()
      },
    },
    {
      kind: 'exact',
      path: API.qr,
      handler: (req, res) => {
        if (!guard(req, res, API.qr)) return
        void (async () => {
          // Re-mint on every request: tokens expire, and a panel left open would
          // otherwise keep showing a QR that no longer works.
          let pairUrl: string
          try {
            pairUrl = await controller.pair()
          } catch (error) {
            writeError(res, 503, error instanceof Error ? error.message : String(error))
            return
          }
          try {
            const svg = await QRCode.toString(pairUrl, { type: 'svg', margin: 1, width: 320 })
            res.writeHead(200, {
              'content-type': 'image/svg+xml; charset=utf-8',
              'content-length': Buffer.byteLength(svg),
              // The pairing URL is a credential; never let it sit in a cache.
              'cache-control': 'no-store',
            })
            res.end(svg)
          } catch (error) {
            writeError(res, 500, error instanceof Error ? error.message : String(error))
          }
        })()
      },
    },
  ]
}