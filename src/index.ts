/**
 * dsh-remote-control — host half.
 *
 * Connects this DSH host to a relay so a browser anywhere can drive the
 * Harness. The browser is not given a cut-down remote control: the relay
 * proxies it to this host's own web server, so it loads the **shipped client**
 * and gets every feature the local GUI has.
 *
 * What this module owns:
 *
 * - the relay link (`HostLink`) — registration, pairing, reconnects;
 * - the page tunnel (`WebReplay`) — loopback HTTP and WebSocket replay, plus
 *   the browser-session cookie that makes the harness accept it;
 * - the display layer (`adaptSnippet`) — the only content the host rewrites,
 *   appended to the shell so a phone can fit the desktop layout;
 * - the operator's local routes (`/api/dsh-remote-control/*`).
 *
 * The link is inert until the operator arms it from the panel (or calls
 * `POST /api/dsh-remote-control/start`), so merely loading the plugin performs no
 * network activity and never exposes a pairing URL.
 *
 * Every registration lives inside `ctx.effect`, whose callback returns the
 * disposer; cordis runs it when the plugin unloads, when the profile patch
 * disables the row, or when the host tears down. A bare `register()` outside an
 * effect leaks that registration past unload.
 *
 * @module dsh-remote-control
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access, appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only imports for the declaration merging that puts these on Context.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { HostLink } from './relay/hostLink.ts'
import type { ConnectionCheck, TestReport } from './protocol.ts'
import { makeRoutes, type RemoteController } from './routes.ts'
import { adaptSnippet, DESIGN_WIDTH } from './web/adapt.ts'
import { WebCookie, WebReplay, type ReplayLogger } from './web/replay.ts'

/** Loader row id; mirrors `cordis.patch.yml`. */
export const name = 'dsh-remote-control'

/**
 * The row's Config.
 *
 * The relay origin is deliberately **not** defaulted here. A relay is somebody's
 * server, and baking one address into the source publishes it to everyone who
 * installs the plugin — so this ships empty and the operator names their own,
 * either in the profile patch or through `DSH_REMOTE_RELAY`. An unset origin is
 * reported by the panel instead of guessed at.
 */
export const Config = z.object({
  /**
   * Relay origin the host dials, e.g. `https://relay.example`.
   *
   * Volatile, which is what makes it **writable at runtime**: the settings
   * service refuses a namespace with no volatile field, and the loader applies
   * a write in place on the running fiber. That is what lets the panel save an
   * origin and have it survive a restart without this plugin keeping a store of
   * its own.
   *
   * `DSH_REMOTE_RELAY` still overrides it, so a deployment can be retargeted
   * without editing a profile.
   */
  relay: z.string().default('').volatile(),
  /**
   * Whether the operator has armed the link.
   *
   * Persisted for the same reason `relay` is: a restart that silently disarms
   * remote control leaves every browser that is already paired staring at the
   * relay's "this computer is offline" page, with nothing on screen to say why.
   * Arming once should mean armed until it is switched off.
   */
  enabled: z.boolean().default(false).volatile(),
  /**
   * Deprecated: the relay secret used to live here.
   *
   * A secret is not configuration — it is a credential, and this document is
   * rewritten by the settings service on every unrelated change, which is a
   * poor place for one. It now lives in its own file (see
   * {@link SECRET_FILE}), read at each use. A value left here by an older build
   * is migrated into that file on load and then never read again.
   */
  secret: z.string().default('').volatile(),
})

/**
 * A volatile config field, in either shape a mount can produce.
 *
 * A volatile field may arrive as a plain value or as a live holder whose `get()`
 * reads the current one; both are accepted so the plugin reads the same way
 * whichever the loader hands it.
 */
export type RelayField = string | { get(): unknown } | undefined

/** A volatile field, in either shape a mount can produce. */
export type VolatileField<T> = T | { get(): unknown } | undefined

/** Resolved config, as the loader hands it to {@link apply}. */
export type RemoteConfig = {
  relay?: RelayField
  enabled?: VolatileField<boolean>
  secret?: RelayField
}

/**
 * Read the relay origin from a volatile field.
 * @param field - the config field, in either shape.
 * @returns the current value, or an empty string.
 */
function readRelay(field: RelayField): string {
  const value = readVolatile(field)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read a volatile field, in either shape a mount can produce.
 *
 * A volatile field may arrive as a plain value or as a live holder whose `get()`
 * reads the current one; both are accepted so the plugin reads the same way
 * whichever the loader hands it.
 * @param field - the config field.
 * @returns the current value, or undefined.
 */
function readVolatile(field: VolatileField<unknown>): unknown {
  if (field === undefined || field === null) return undefined
  const holder = field as { get?: unknown }
  return typeof holder.get === 'function' ? holder.get() : field
}

/**
 * Services required before this plugin may mount.
 *
 * `connection` is deliberately **not** required: it is what mints the
 * browser-session cookie, and a composition without it (a headless tree with a
 * web server but no client carrier) should still mount and report the problem
 * rather than refuse to load. It is picked up opportunistically.
 */
export const inject = ['webServer']

/** One recorded call to a mutating control route. */
export interface AuditEntry {
  /** Host clock, ISO 8601. */
  at: string
  /** Route path that was called. */
  route: string
  /** True when the caller came through the tunnel rather than the local window. */
  tunnelled: boolean
  /** Caller's user agent, trimmed. */
  agent: string
}

/**
 * The part of a version that has to match across the two halves.
 *
 * `major.minor` is the compatibility line: a change that touches the relay, or
 * the contract between the halves, moves it and both sides move together. A
 * change to one side alone moves only its patch, so any patch may be paired
 * with any other on the same line.
 * @param version - a semver string.
 * @returns `major.minor`, or an empty string when there is nothing to parse.
 */
export function compatibilityLine(version: string): string {
  const parts = version.trim().split('.')
  return parts.length < 2 ? '' : `${parts[0]}.${parts[1]}`
}

/** Where the relay secret is kept, relative to the harness home. */
const SECRET_FILE = 'relay-secret'

/** How long one step of the connection test may take. */
const TEST_TIMEOUT_MS = 5_000

/**
 * The installed version, read from this package's own manifest.
 *
 * Read once at load rather than imported, because the build rewrites the source
 * tree and a JSON import would have to be inlined by the bundler. The panel
 * shows it beside the page title, the way the other plugins here do.
 */
const VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    // A missing manifest is not a reason to fail the plugin; the tag just
    // does not render.
    return ''
  }
})()

/**
 * The harness home this plugin keeps its state in.
 * @returns the absolute path.
 */
function dshHome(): string {
  const home = process.env.DSH_HOME?.trim()
  return home && home.length > 0 ? home : join(homedir(), '.dsh')
}

/**
 * Resolve a path under the DSH home.
 * @param parts - path segments below `<DSH_HOME>/dsh-remote-control`.
 * @returns the absolute path.
 */
/**
 * The file holding the relay secret.
 *
 * Directly under the harness home, not inside this plugin's state directory:
 * it is a credential the operator copies between machines, and it should be
 * findable without knowing where a plugin keeps its bookkeeping.
 * @returns the absolute path.
 */
function secretFile(): string {
  return join(dshHome(), SECRET_FILE)
}

/**
 * Resolve a path under the DSH home.
 * @param parts - path segments below `<DSH_HOME>/dsh-remote-control`.
 * @returns the absolute path.
 */
function underDshHome(...parts: string[]): string {
  return join(dshHome(), 'dsh-remote-control', ...parts)
}

/**
 * The slice of the harness settings service this plugin uses.
 *
 * The plugin's own row Config is its settings namespace, so a value written
 * here lands in the host's settings document and is reapplied to this row on
 * the next boot — which is exactly what "remember my relay across restarts"
 * needs, without this plugin inventing a second store.
 */
interface SettingsLike {
  /**
   * Patch one namespace.
   * @param ns - namespace, which is the loader row id.
   * @param patch - the values to write.
   * @returns resolves once the document is written.
   */
  update(ns: string, patch: Record<string, unknown>): Promise<void>
}

/** The slice of the harness Connection service this plugin uses. */
interface ConnectionLike {
  /**
   * Add this process's launch token to a clean application URL, so a request
   * to it exchanges the token for a browser-session cookie.
   * @param baseUrl - clean URL whose authority and mount are preserved.
   * @returns the same URL carrying the process token.
   */
  authenticatedUrl(baseUrl: string): string
}

/**
 * Mount the relay link, the page tunnel and the route family.
 * @param ctx - host plugin context.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: RemoteConfig = {}): void {
  ctx.effect(() => {
    const logger: ReplayLogger = {
      debug: (message) => ctx.logger.debug(message),
      info: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message),
    }

    const statePath = underDshHome('relay.json')
    const auditPath = underDshHome('audit.jsonl')

    /** Look the settings service up on demand, as it may activate later. */
    const settings = (): SettingsLike | undefined => ctx.get('settings') as SettingsLike | undefined

    /**
     * Where this host dials, resolved per use.
     *
     * The environment wins, because it is the deployment's own instruction and
     * `DSH_REMOTE_RELAY` exists precisely so a machine can be retargeted without
     * editing a profile. Everything else arrives through the live config field,
     * which the loader keeps in step with the settings document — so there is
     * nothing to merge here and no second store to consult.
     * @returns the origin and where it came from.
     */
    const resolveRelay = (): { origin: string, source: 'env' | 'patch' | 'none' } => {
      const fromEnv = process.env.DSH_REMOTE_RELAY?.trim()
      if (fromEnv) return { origin: fromEnv, source: 'env' }
      const origin = readRelay(config.relay)
      return origin === '' ? { origin: '', source: 'none' } : { origin, source: 'patch' }
    }

    /** The effective origin. */
    const relayOrigin = (): string => resolveRelay().origin

    const secretPath = secretFile()

    /**
     * Read the relay secret from its file.
     *
     * Read on every use rather than cached: the file is the operator's, it is
     * meant to be droppable in by hand or by a provisioning script, and a host
     * that has to be restarted to notice a corrected secret is a host that
     * reports the old one as wrong.
     * @returns the trimmed secret, or an empty string when there is none.
     */
    const readSecretFile = (): string => {
      try {
        return readFileSync(secretPath, 'utf8').trim()
      } catch {
        return ''
      }
    }

    /**
     * The relay secret.
     *
     * From its file and nowhere else. An environment variable was tried and
     * removed: it silently outranked the panel, so an edit in the UI could have
     * no effect — which is a confusing way to be configured, and a credential
     * is better off in one discoverable place.
     * @returns the secret, or an empty string against an open relay.
     */
    const relaySecret = (): string => readSecretFile()

    /**
     * Adopt a secret an older build wrote into the config document.
     *
     * Runs once, only when there is no file yet, so an existing installation
     * keeps working across this change.
     * @returns resolves once the move has been attempted.
     */
    const migrateLegacySecret = async (): Promise<void> => {
      const legacy = readRelay(config.secret)
      if (legacy === '' || readSecretFile() !== '') return
      try {
        await writeFile(secretPath, legacy, { mode: 0o600 })
        await settings()?.update(name, { secret: '' })
        logger.info('[dsh-remote-control] moved the relay secret out of the profile document')
      } catch (error) {
        logger.warn(`[dsh-remote-control] could not migrate the relay secret: ${String(error)}`)
      }
    }

    /**
     * Look the Connection service up on demand.
     *
     * Not captured at mount: this row can activate before the Connection row
     * does, and a service read once is a service missed forever. `ctx.get` is
     * a live lookup, so resolving it per call is both correct and cheap.
     *
     * @returns the service, or undefined in a composition without one.
     */
    const connection = (): ConnectionLike | undefined =>
      ctx.get('connection') as ConnectionLike | undefined

    /**
     * Read the bound web-server port for the tunnel's loopback dials.
     *
     * `WebServer.port` reports `undefined` until the listener binds, which is
     * the state this row can be applied in. The tunnel's own guards already read
     * "no usable port" as a positive integer test — `WebReplay.onRequest`
     * answers `host-unreachable` and `WebCookie.mint` fails the exchange — so
     * the unbound window collapses onto the same sentinel those guards expect
     * rather than leaking `undefined` into a URL.
     *
     * @returns the bound port, or `0` while the server has not bound one.
     */
    const loopbackPort = (): number => ctx.webServer.port ?? 0

    const cookie = new WebCookie({
      host: '127.0.0.1',
      port: loopbackPort,
      launchUrl: () => {
        const service = connection()
        if (!service) {
          logger.warn(
            '[dsh-remote-control] no Connection service in this composition: '
            + 'the tunnel cannot mint a browser session and /api calls will be refused',
          )
          return undefined
        }
        try {
          return service.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`)
        } catch (error) {
          logger.warn(`[dsh-remote-control] could not build a launch URL: ${String(error)}`)
          return undefined
        }
      },
      logger,
    })

    const replay = new WebReplay({
      port: loopbackPort,
      cookie,
      inject: adaptSnippet,
      logger,
    })

    let link: HostLink | undefined

    /**
     * Close the link without ending the pairing.
     *
     * Being unloaded is not a Stop. The plugin is disposed and re-applied on
     * every reconfiguration, reload and shutdown, and ending the pairing there
     * would revoke every browser on the way out of a process that is about to
     * come back: the relay would mark the session dead and the browsers would be
     * sent to pair again, which is exactly what "a restart is not a stop"
     * promises not to happen. So this closes the socket, drops the tunnel
     * backlog and leaves the session, the stored identity and the armed flag
     * exactly as they are — an armed link then resumes the same session on the
     * next load. Revoking is `stop`, and only the panel's Stop calls it.
     * @returns {void}
     */
    const detach = (): void => {
      link?.stop()
      link = undefined
      // A closed link has nothing left to answer, so nothing should be left
      // half-open behind it either.
      replay.abortAll()
    }

    const controller: RemoteController = {
      getStatus: () => {
        const status = link?.getStatus()
        const pending = replay.pending
        const resolved = resolveRelay()
        // An environment override is the deployment's instruction, and a
        // composition with no settings service has nowhere to persist a change.
        const editable = resolved.source !== 'env' && settings() !== undefined
        const secretSet = relaySecret() !== ''
        if (!status) {
          return {
            version: VERSION,
            enabled: false,
            phase: 'idle',
            relayOrigin: resolved.origin,
            relaySource: resolved.source,
            relayEditable: editable,
            secretSet,
            secretPath,
            phoneConnected: false,
            reconnects: 0,
            requests: 0,
            errors: 0,
            pending,
            authenticated: cookie.current !== undefined,
            connectionService: connection() !== undefined,
            designWidth: DESIGN_WIDTH,
          }
        }
        return {
          version: VERSION,
          enabled: true,
          phase: status.phase,
          relayOrigin: resolved.origin || status.origin,
          relaySource: resolved.source,
          relayEditable: editable,
          secretSet,
          secretPath,
          ...(status.sessionId ? { sessionId: status.sessionId } : {}),
          ...(status.pairUrl ? { pairUrl: status.pairUrl } : {}),
          ...(status.pairExpiresAt ? { pairExpiresAt: status.pairExpiresAt } : {}),
          phoneConnected: status.phoneConnected,
          reconnects: status.reconnects,
          requests: status.requests,
          errors: status.errors,
          pending,
          authenticated: cookie.current !== undefined,
          connectionService: connection() !== undefined,
          designWidth: DESIGN_WIDTH,
          ...(status.failure
            ? { failure: { code: status.failure.code, message: status.failure.message } }
            : {}),
        }
      },
      start: async () => {
        const origin = relayOrigin()
        if (origin === '') {
          throw new Error(
            'no relay configured. Set the plugin\'s `relay` config in your profile patch '
            + '(or DSH_REMOTE_RELAY) to the origin of the relay you deployed — see '
            + 'relay/README.md in this package.',
          )
        }
        link ??= new HostLink({
          origin,
          secret: relaySecret(),
          hostLabel: `${hostname()} (DSH)`,
          statePath,
          onFrame: (payload, send) => {
            // The relay's own liveness probe, answered here rather than in the
            // replay: it is a tunnel frame, not a replayed request.
            if (payload.t === 'ping') {
              send({ t: 'pong', id: payload.id })
              return
            }
            replay.handle(payload, send)
          },
          logger,
        })
        await link.start()
        await remember(true)
      },
      test: async () => runConnectionTest(),
      audit: async (entry: AuditEntry) => { await appendAudit(entry) },
      // Stop *is* the revoke: ending the pairing is what stopping means, so it
      // tells the relay the session is finished and discards the identity rather
      // than leaving it for the next Start to silently resume.
      //
      // A restart is not a stop. That resumes the same session, which is why a
      // browser stays paired across one.
      stop: async () => {
        await link?.forgetSession()
        detach()
        await rm(statePath, { force: true })
        await remember(false)
      },
      getSecret: () => relaySecret(),
      setSecret: async (secret: string) => {
        const value = secret.trim()

        // Check the value against the relay *before* storing it. A secret is
        // pasted, not typed, and a partial paste is indistinguishable from a
        // good one in a password field — so without this the panel says
        // "Saved", the operator believes it, and the only symptom is a refusal
        // the next time the host tries to register.
        if (value !== '') {
          const origin = relayOrigin()
          if (origin !== '') {
            try {
              const probe = await fetch(`${origin}/healthz`, {
                headers: { 'x-dsh-relay-secret': value },
                signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
              })
              if (probe.status === 401) {
                throw new Error(
                  `the relay refused that secret (${value.length} characters, `
                  + `sha256 ${createHash('sha256').update(value).digest('hex').slice(0, 12)}). `
                  + 'It is not the value the relay was started with — check for a partial paste.',
                )
              }
            } catch (error) {
              // A relay we cannot reach is not a reason to refuse the edit; the
              // operator may be configuring the origin in the same sitting.
              if (error instanceof Error && error.message.startsWith('the relay refused')) throw error
            }
          }
        }

        // Written here rather than into the config document: this file is the
        // credential's own place, it is not rewritten by unrelated settings
        // changes, and it carries the mode a secret should have.
        await mkdir(dirname(secretPath), { recursive: true }).catch(() => {})
        if (value === '') await rm(secretPath, { force: true })
        else await writeFile(secretPath, value, { mode: 0o600 })
        logger.info(`[dsh-remote-control] relay secret ${value === '' ? 'cleared' : `set in ${secretPath}`}`)
      },
      setRelay: async (relay: string) => {
        const trimmed = relay.trim().replace(/\/+$/u, '')
        if (trimmed !== '') {
          let parsed: URL
          try {
            parsed = new URL(trimmed)
          } catch {
            throw new Error(`\`${trimmed}\` is not a URL. Use an origin such as https://relay.example`)
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`\`${parsed.protocol}\` is not supported. Use http or https.`)
          }
          if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
            throw new Error('give the origin only, with no path — e.g. https://relay.example')
          }
        }

        const service = settings()
        if (!service) {
          throw new Error(
            'this composition has no settings service, so the relay origin cannot be saved. '
            + 'Set the `relay` config in your profile patch instead.',
          )
        }
        if (process.env.DSH_REMOTE_RELAY?.trim()) {
          throw new Error('DSH_REMOTE_RELAY is set in the environment and overrides this setting.')
        }

        // The row id doubles as the settings namespace: an entry's Config is
        // its namespace, so this writes the value the loader reapplies at boot.
        await service.update(name, { relay: trimmed })

        // A link built for the old origin cannot be retargeted in place, so
        // rebuild it. A change made while the link is armed takes effect at
        // once; one made while it is idle waits for the operator. The identity
        // survives — a moved relay is not a Stop.
        const wasEnabled = link !== undefined
        if (link !== undefined && link.origin !== trimmed) detach()
        if (wasEnabled) await controller.start()
        logger.info(`[dsh-remote-control] relay set to ${trimmed === '' ? '(none)' : trimmed}`)
      },
      pair: async () => {
        if (!link) throw new Error('the remote link is not started')
        return link.refreshPairing()
      },
    }

    const disposers = makeRoutes(controller).map((route) => ctx.webServer.register(route))
    /**
     * Ask the relay one question over HTTP, with a deadline.
     *
     * Never throws: a test that cannot reach the relay has to *report* that, not
     * fail to render.
     * @param url - absolute URL to fetch.
     * @param init - fetch options.
     * @returns the status, parsed body where it is JSON, and elapsed time.
     */
    const ask = async (
      url: string,
      init?: { method?: string, body?: string },
    ): Promise<{ status: number, body: Record<string, unknown> | undefined, ms: number, error?: string }> => {
      const started = Date.now()
      try {
        const secret = relaySecret()
        const response = await fetch(url, {
          ...(init?.method ? { method: init.method } : {}),
          headers: {
            ...(secret === '' ? {} : { 'x-dsh-relay-secret': secret }),
            ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(init?.body === undefined ? {} : { body: init.body }),
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        })
        const text = await response.text()
        let body: Record<string, unknown> | undefined
        try {
          const parsed: unknown = JSON.parse(text)
          if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
        } catch { /* a non-JSON answer is reported as its status */ }
        return { status: response.status, body, ms: Date.now() - started }
      } catch (error) {
        const name = (error as { name?: string }).name
        return {
          status: 0,
          body: undefined,
          ms: Date.now() - started,
          error: name === 'TimeoutError' || name === 'AbortError'
            ? `no answer within ${Math.round(TEST_TIMEOUT_MS / 1000)}s`
            : String(error),
        }
      }
    }

    /**
     * Walk the chain from this host to the relay and back, one step at a time.
     *
     * Ordered so that the first failure explains the rest: a relay that cannot
     * be reached makes the later steps meaningless, and saying so is more useful
     * than four identical red rows.
     * @returns the report the panel renders.
     */
    const runConnectionTest = async (): Promise<TestReport> => {
      const checks: ConnectionCheck[] = []
      const resolved = resolveRelay()
      const base = resolved.origin.replace(/\/+$/u, '')
      const sessionId = link?.getStatus().sessionId

      let parsed: URL | undefined
      try {
        parsed = new URL(base)
      } catch { /* reported below */ }
      const wellFormed = parsed !== undefined
        && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      checks.push({
        id: 'configured',
        ok: base !== '' && wellFormed,
        detail: base === ''
          ? 'no relay is configured'
          : wellFormed
            ? `${base} (${resolved.source === 'env' ? 'from DSH_REMOTE_RELAY' : 'saved to your profile'})`
            : `${base} is not an http(s) origin`,
      })

      if (base === '' || !wellFormed) return report(checks, base)

      const health = await ask(`${base}/healthz`)
      const healthOk = health.status === 200 && health.body !== undefined
      checks.push({
        id: 'reachable',
        ok: healthOk,
        detail: healthOk
          ? `the relay answered in ${health.ms} ms`
          : health.status === 401
            ? 'the relay refused this host: its secret is missing or wrong'
            : health.error ?? `the relay answered ${health.status}`,
        ms: health.ms,
      })

      if (!healthOk) {
        for (const id of ['version', 'attached', 'session', 'roundtrip'] as const) {
          checks.push({ id, ok: false, skipped: true, detail: 'not attempted — the relay was unreachable' })
        }
        return report(checks, base)
      }

      const relayVersion = typeof health.body?.version === 'string' ? health.body.version : ''
      // Major.minor is the compatibility line: the two halves must match on it,
      // and are free to differ on the patch. See "Versioning" in README.md.
      const line = compatibilityLine(relayVersion)
      const mine = compatibilityLine(VERSION)
      const versionOk = relayVersion !== '' && line === mine
      checks.push({
        id: 'version',
        ok: versionOk,
        detail: versionOk
          ? relayVersion === VERSION
            ? `relay and plugin are both ${VERSION}`
            : `relay ${relayVersion} and plugin ${VERSION} share ${mine}, the compatibility line`
          : `this plugin needs a relay on ${mine || 'an unknown line'}, but this one is `
            + `${relayVersion || 'unknown'} — deploy a matching relay`,
      })

      const phase = link?.getStatus()
      const online = phase?.phase === 'online'
      checks.push({
        id: 'attached',
        ok: online,
        detail: online
          ? 'this host holds a relay socket'
          : phase?.failure
            ? `${phase.failure.code}: ${phase.failure.message}`
            : 'the link is not armed, or the socket is still connecting',
      })

      if (!online) {
        for (const id of ['session', 'roundtrip'] as const) {
          checks.push({ id, ok: false, skipped: true, detail: 'not attempted — no host socket is attached' })
        }
        return report(checks, base)
      }

      const known = sessionId !== undefined && sessionId !== ''
      const probe = known
        ? await ask(`${base}/_relay/probe?session=${encodeURIComponent(sessionId)}`)
        : { status: 0, body: undefined, ms: 0, error: 'this host has no session id yet' }
      const seen = probe.body?.known === true && probe.body.online === true
      checks.push({
        id: 'session',
        ok: seen,
        detail: seen
          ? `the relay sees session ${sessionId} online`
          : probe.error ?? (probe.body?.known === true
            ? 'the relay knows the session but its host socket is not attached'
            : 'the relay does not know this session'),
        ms: probe.ms,
      })

      // The only step that proves the tunnel carries frames both ways rather
      // than merely having a socket open.
      const auth = readState()
      const ping = auth === undefined
        ? { status: 0, body: undefined, ms: 0, error: 'this host has not stored its relay secret yet' }
        : await ask(`${base}/_relay/ping`, {
          method: 'POST',
          body: JSON.stringify({ session: sessionId, token: auth.hostSecret }),
        })
      const rtt = typeof ping.body?.rttMs === 'number' ? ping.body.rttMs : undefined
      const roundOk = ping.status === 200 && ping.body?.ok === true
      checks.push({
        id: 'roundtrip',
        ok: roundOk,
        detail: roundOk
          ? `a frame reached the relay and came back in ${rtt ?? ping.ms} ms`
          : String(ping.body?.message ?? ping.error ?? `the relay answered ${ping.status}`),
        ...(rtt === undefined ? {} : { ms: rtt }),
      })

      return report(checks, base)
    }

    /**
     * Assemble the report, treating "skipped" as not-a-pass.
     * @param checks - the steps that ran.
     * @param origin - the relay they ran against.
     * @returns the report payload.
     */
    function report(checks: ConnectionCheck[], origin: string): TestReport {
      return {
        ok: checks.every((check) => check.ok),
        checkedAt: new Date().toISOString(),
        origin,
        version: VERSION,
        checks,
      }
    }

    /**
     * Read the persisted relay identity.
     * @returns the stored session and secret, or undefined before first pairing.
     */
    function readState(): { sessionId?: string, hostSecret?: string } | undefined {
      try {
        const raw = readFileSync(statePath, 'utf8')
        const parsed = JSON.parse(raw) as { sessionId?: unknown, hostSecret?: unknown }
        return {
          ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
          ...(typeof parsed.hostSecret === 'string' ? { hostSecret: parsed.hostSecret } : {}),
        }
      } catch {
        return undefined
      }
    }

    /**
     * Append one line to the control-route audit trail.
     *
     * The plugin's mutating routes are reachable from *both* the local window
     * and any paired browser, because a tunnelled request arrives on the same
     * loopback socket. When a link starts resetting itself, the first question
     * is who is asking — and nothing else on the host can answer it.
     * @param entry - what to record.
     * @returns resolves once the write has been attempted.
     */
    const appendAudit = async (entry: AuditEntry): Promise<void> => {
      try {
        await mkdir(dirname(auditPath), { recursive: true }).catch(() => {})
        const line = `${JSON.stringify(entry)}\n`
        await appendFile(auditPath, line).catch(() => {})
      } catch {
        // An unwritable audit trail must never break the control surface.
      }
    }

    /** Last armed state written to settings, so repeats are not written again. */
    let storedArmed = readVolatile(config.enabled) === true

    /**
     * Persist the armed flag, tolerating a composition with no settings service.
     *
     * Idempotent on purpose: Stop and Start are buttons, and buttons get pressed
     * twice. Rewriting the profile document on every repeat would be a write per
     * click for no change, and that document is watched.
     * @param armed - the state to store.
     * @returns resolves once the write has been attempted.
     */
    const remember = async (armed: boolean): Promise<void> => {
      if (armed === storedArmed) return
      storedArmed = armed
      const service = settings()
      if (!service) return
      try {
        await service.update(name, { enabled: armed })
      } catch (error) {
        logger.warn(`[dsh-remote-control] could not persist the armed state: ${String(error)}`)
      }
    }

    void migrateLegacySecret()

    // The link is inert until the operator arms it — but only until then. Coming
    // back armed is what stops a restart from silently cutting off every browser
    // that is already paired.
    if (readVolatile(config.enabled) === true && relayOrigin() !== '') {
      setTimeout(() => {
        void controller.start().catch((error: unknown) => {
          logger.warn(`[dsh-remote-control] could not re-arm the link: ${String(error)}`)
        })
      }, 0).unref?.()
    }

    const configured = relayOrigin()
    ctx.logger.info(configured === ''
      ? '[dsh-remote-control] routes mounted; no relay configured yet (set `relay` or DSH_REMOTE_RELAY)'
      : `[dsh-remote-control] routes mounted; relay ${configured}`)

    // Make sure the state directory exists before a pairing attempt writes to
    // it, and adopt the identity this plugin had before it was renamed: losing
    // it would silently un-pair every browser the operator had already paired.
    void (async () => {
      await mkdir(dirname(statePath), { recursive: true }).catch(() => {})
      const legacy = join(dshHome(), 'dsh-remote', 'relay.json')
      const absent = await access(statePath).then(() => false, () => true)
      if (!absent) return
      await rename(legacy, statePath).catch(() => { /* nothing to migrate */ })
    })()

    return () => {
      // Unloading is not a Stop: the pairing outlives this instance, so an armed
      // link resumes the same session when the plugin comes back and browsers
      // paired to it keep working.
      detach()
      replay.dispose()
      for (const dispose of disposers) dispose()
      ctx.logger.info('[dsh-remote-control] routes unmounted and relay link closed')
    }
  }, 'dsh-remote-control: relay link and page tunnel')
}