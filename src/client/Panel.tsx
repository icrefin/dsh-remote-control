/**
 * The page opened by the sidebar row: arm the relay link, show the pairing QR,
 * and report tunnel health.
 *
 * The component receives its translate seat through props; it never imports the
 * locale service. The host half is reached only through the `/api/dsh-remote-control`
 * routes, so the panel holds no privileged state of its own.
 *
 * @module dsh-remote-control/client/Panel
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { CLIENT_API, type StatusPayload, type TestReport } from '../protocol.ts'
import type { PanelTranslate } from './locales.ts'

/** Props composed by the slot framework for this key of the `main` slot. */
export interface PanelProps {
  /** Framework-injected translate seat bound to this plugin's namespace. */
  t: PanelTranslate
}

/** How often the panel re-reads host status while it is mounted. */
const POLL_MS = 2_000

/**
 * The author credit the style contract prints inside the version chip, to the
 * right of the version itself (`STYLES.md`: `"v" + version + " Author: …"`).
 */
const AUTHOR_CREDIT = 'Author: icrefin [icrefinai@gmail.com]'

/**
 * Call one of the host routes and parse an arbitrary JSON reply.
 *
 * Separate from {@link callHost} only because the connection test answers with
 * a report rather than a status snapshot.
 * @param path - route path.
 * @param method - HTTP method.
 * @param body - JSON body, when the route takes one.
 * @returns the parsed reply.
 * @throws when the host answers with a non-2xx status.
 */
async function callJson<T>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined
      ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (parsed.error) detail = parsed.error
    } catch { /* non-JSON error bodies fall back to the status line */ }
    throw new Error(detail)
  }
  return JSON.parse(text) as T
}

/** An eye: "show what I typed". */
function Eye(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** The same eye, struck through: "hide it again". */
function EyeOff(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.4 2.4 13.6 13.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Human-readable form of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Call one of the host routes.
 * @param path - route path.
 * @param method - HTTP method.
 * @returns the parsed status payload.
 * @throws when the host answers with a non-2xx status.
 */
async function callHost(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<StatusPayload> {
  const response = await fetch(path, {
    method,
    headers: body === undefined
      ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (parsed.error) detail = parsed.error
    } catch {
      // Non-JSON error bodies fall back to the status line.
    }
    throw new Error(detail)
  }
  return JSON.parse(text) as StatusPayload
}

/**
 * Render a remaining lifetime compactly.
 * @param expiresAt - unix ms, or undefined when no token is live.
 * @returns a short human string.
 */
function remaining(expiresAt: number | undefined): string {
  if (!expiresAt) return '—'
  const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
  if (seconds === 0) return 'expired'
  if (seconds < 60) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

/**
 * Render the panel.
 * @param props - the framework-injected translate seat.
 * @returns the panel element tree.
 */
export function Panel({ t }: PanelProps): ReactElement {
  const [status, setStatus] = useState<StatusPayload | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<'start' | 'stop' | 'pair' | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [qrNonce, setQrNonce] = useState(0)
  /** Draft in the relay field. Seeded from the host, then owned by the user. */
  const [relayDraft, setRelayDraft] = useState<string | undefined>(undefined)
  const [relayBusy, setRelayBusy] = useState(false)
  const [relayNote, setRelayNote] = useState<string | undefined>(undefined)
  const [secretDraft, setSecretDraft] = useState<string | undefined>(undefined)
  /** A masked field hides a mistyped or truncated paste as well as the value. */
  const [revealSecret, setRevealSecret] = useState(false)
  const [secretNote, setSecretNote] = useState<string | undefined>(undefined)
  const [report, setReport] = useState<TestReport | undefined>(undefined)
  const [testing, setTesting] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await callHost(CLIENT_API.status)
      setStatus(next)
      setError(undefined)
      // Only seed the field while the user has not typed in it, so a poll
      // cannot overwrite an edit in progress.
      setRelayDraft((current) => current ?? next.relayOrigin)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

  const runTest = useCallback(async (): Promise<void> => {
    setTesting(true)
    setError(undefined)
    try {
      setReport(await callJson<TestReport>(CLIENT_API.test, 'POST'))
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setTesting(false)
    }
  }, [])

  // Load the stored value once so the field shows what is actually in use —
  // blank tells the operator nothing, and an empty box is indistinguishable
  // from a cleared secret.
  const loadSecret = useCallback(async (): Promise<void> => {
    try {
      const body = await callJson<{ secret: string }>(CLIENT_API.secret)
      setSecretDraft(body.secret)
    } catch {
      setSecretDraft('')
    }
  }, [])

  useEffect(() => { void loadSecret() }, [loadSecret])

  const saveSecret = useCallback(async (): Promise<void> => {
    setSecretNote(undefined)
    try {
      // Written on its own so an empty value clears it rather than being
      // mistaken for "leave it alone".
      setStatus(await callHost(CLIENT_API.settings, 'POST', { secret: secretDraft ?? '' }))
      setSecretNote(t('relaySaved'))
    } catch (caught) {
      setSecretNote(`${t('failed')}: ${messageOf(caught)}`)
    }
  }, [secretDraft, t])

  const saveRelay = useCallback(async (): Promise<void> => {
    setRelayBusy(true)
    setError(undefined)
    setRelayNote(undefined)
    try {
      const next = await callHost(CLIENT_API.settings, 'POST', { relay: relayDraft ?? '' })
      setStatus(next)
      setRelayDraft(next.relayOrigin)
      setRelayNote(t('relaySaved'))
      if (next.enabled) setQrNonce((value) => value + 1)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setRelayBusy(false)
    }
  }, [relayDraft, t])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  const act = useCallback(
    async (kind: 'start' | 'stop'): Promise<void> => {
      setBusy(kind)
      setError(undefined)
      try {
        const path = kind === 'start' ? CLIENT_API.start : CLIENT_API.stop
        setStatus(await callHost(path, 'POST'))
        // A new link means a new token, so the QR image must be re-fetched.
        if (kind !== 'stop') setQrNonce((value) => value + 1)
      } catch (caught) {
        setError(messageOf(caught))
      } finally {
        setBusy(undefined)
      }
    },
    [],
  )

  const mintToken = useCallback(async (): Promise<void> => {
    setBusy('pair')
    setError(undefined)
    try {
      setStatus(await callHost(CLIENT_API.pair, 'POST'))
      setQrNonce((value) => value + 1)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(undefined)
    }
  }, [])

  const copyLink = useCallback(async (): Promise<void> => {
    const link = status?.pairUrl
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1_500)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [status?.pairUrl])

  const enabled = status?.enabled ?? false
  const online = status?.phase === 'online'
  const phoneConnected = status?.phoneConnected ?? false

  /** The house button classes; `primary` is the filled one. */
  const buttonClass = (primary: boolean): string =>
    `dsh-remote-control-button${primary ? ' dsh-remote-control-primary' : ''}`

  return (
    <div className="dsh-remote-control-page">
      <div className="dsh-remote-control-head">
        <div>
          <h1 className="dsh-remote-control-title">
            {t('title')}
            {status?.version ? (
              <span className="dsh-remote-control-version">{`v${status.version} ${AUTHOR_CREDIT}`}</span>
            ) : null}
          </h1>
          <p className="dsh-remote-control-description">{t('description')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className={buttonClass(!enabled)}
            disabled={busy !== undefined}
            onClick={() => void act(enabled ? 'stop' : 'start')}
          >
            {busy === 'start' || busy === 'stop' ? t('starting') : enabled ? t('disable') : t('enable')}
          </button>
          <button
            type="button"
            className={buttonClass(false)}
            disabled={testing}
            onClick={() => void runTest()}
          >
            {testing ? t('testing') : t('test')}
          </button>
          <button type="button" className={buttonClass(false)} onClick={() => void refresh()}>
            {t('refresh')}
          </button>
        </div>
      </div>

      {error === undefined ? null : (
        <div className="dsh-remote-control-error">
          {t('failed')}: {error}
        </div>
      )}

      {status?.failure === undefined ? null : (
        <div className="dsh-remote-control-error">
          {status.failure.code}: {status.failure.message}
        </div>
      )}

      {report === undefined ? null : (
        <section className="dsh-remote-control-card dsh-remote-control-test">
          <h2 className="dsh-remote-control-check-heading">{t('testTitle')}</h2>
          <p className="dsh-remote-control-check-summary" data-ok={report.ok}>
            {report.ok ? t('testPassed') : t('testFailed')}
          </p>
          <ul className="dsh-remote-control-checks">
            {report.checks.map((check) => (
              <li
                key={check.id}
                className={`dsh-remote-control-check ${
                  check.ok ? 'dsh-remote-control-check-ok' : 'dsh-remote-control-check-bad'}`}
                data-skipped={check.skipped === true}
              >
                <span className="dsh-remote-control-check-mark" aria-hidden="true">
                  {check.skipped === true ? '–' : check.ok ? '\u2713' : '\u2717'}
                </span>
                <span className="dsh-remote-control-check-body">
                  <span className="dsh-remote-control-check-name">{t(`check_${check.id}`)}</span>
                  <span className="dsh-remote-control-check-detail">
                    {check.detail}
                    {check.skipped === true ? ` (${t('checkSkipped')})` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="dsh-remote-control-field">
        <label className="dsh-remote-control-label" htmlFor="dsh-remote-control-secret">
          {t('secretSetting')}{' '}
          <span className="dsh-remote-control-hint">
            {status?.secretSet ? t('secretSet') : t('secretUnset')}
          </span>
        </label>
        <div className="dsh-remote-control-row">
          <div className="dsh-remote-control-inputwrap">
            <input
              id="dsh-remote-control-secret"
              className="dsh-remote-control-input"
              type={revealSecret ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('secretPlaceholder')}
              value={secretDraft ?? ''}
              onChange={(event) => { setSecretDraft(event.target.value) }}
            />
            <button
              type="button"
              className="dsh-remote-control-eye"
              aria-label={revealSecret ? t('secretHide') : t('secretShow')}
              aria-pressed={revealSecret}
              title={revealSecret ? t('secretHide') : t('secretShow')}
              onClick={() => { setRevealSecret(!revealSecret) }}
            >
              {revealSecret ? <EyeOff /> : <Eye />}
            </button>
          </div>
          <button
            type="button"
            className={buttonClass(false)}
            onClick={() => void saveSecret()}
          >
            {t('secretSave')}
          </button>
        </div>
        <p className="dsh-remote-control-field-hint">
          {secretNote ?? (status?.secretSet
            ? t('secretHint')
            : t('secretMissing'))}
        </p>
      </div>

      {status !== undefined && status.relayOrigin === '' ? (
        <div className="dsh-remote-control-error">{t('relayMissing')}</div>
      ) : null}

      <div className="dsh-remote-control-field">
        <label className="dsh-remote-control-label" htmlFor="dsh-remote-control-relay">
          {t('relaySetting')}
        </label>
        <div className="dsh-remote-control-row">
          <input
            id="dsh-remote-control-relay"
            className="dsh-remote-control-input"
            type="text"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={t('relayPlaceholder')}
            value={relayDraft ?? ''}
            disabled={relayBusy || status?.relayEditable === false}
            onChange={(event) => {
              setRelayDraft(event.target.value)
              setRelayNote(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && status?.relayEditable !== false) void saveRelay()
            }}
          />
          <button
            type="button"
            className={buttonClass(true)}
            disabled={relayBusy || status?.relayEditable === false}
            onClick={() => void saveRelay()}
          >
            {relayBusy ? t('relaySaving') : relayNote ?? t('relaySave')}
          </button>
        </div>
        <p className="dsh-remote-control-field-hint">{t('relaySettingHint')}</p>
        {status?.relayEditable === false ? (
          <p className="dsh-remote-control-field-hint">
            {status.relaySource === 'env' ? t('relayLockedByEnv') : t('relayLockedByComposition')}
          </p>
        ) : null}
      </div>

      <div className="dsh-remote-control-card">
        <div className="dsh-remote-control-key">{t('relay')}</div>
        <div className="dsh-remote-control-value">
          {status?.relayOrigin || '—'}
          {status === undefined || status.relaySource === 'none'
            ? null
            : ` · ${t(status.relaySource === 'env' ? 'relaySourceEnv' : 'relaySourcePatch')}`}
        </div>
        <div className="dsh-remote-control-key">{t('phase')}</div>
        <div className="dsh-remote-control-value">{status?.phase ?? '—'}</div>
        <div className="dsh-remote-control-key">{t('session')}</div>
        <div className="dsh-remote-control-value">{status?.sessionId || '—'}</div>
        <div className="dsh-remote-control-key">{t('browser')}</div>
        <div className="dsh-remote-control-value">{phoneConnected ? t('connected') : t('disconnected')}</div>
        <div className="dsh-remote-control-key">{t('tokenExpires')}</div>
        <div className="dsh-remote-control-value">{remaining(status?.pairExpiresAt)}</div>
      </div>

      {status !== undefined && !status.connectionService ? (
        <div className="dsh-remote-control-error">{t('authMissingHint')}</div>
      ) : null}

      {enabled ? null : (
        <p className="dsh-remote-control-hint">{t('idleHint')}</p>
      )}

      {online ? (
        <div className="dsh-remote-control-pair">
          <p className="dsh-remote-control-pair-hint">
            {phoneConnected ? t('pairedHint') : t('waitingHint')}
          </p>
          <img
            className="dsh-remote-control-qr"
            alt={t('scanHint')}
            src={`${CLIENT_API.qr}?v=${qrNonce}`}
            width={320}
            height={320}
          />
          <p className="dsh-remote-control-hint">{t('scanHint')}</p>
          <p className="dsh-remote-control-hint dsh-remote-control-lifetime">{t('linkLifetime')}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <code className="dsh-remote-control-link">{status?.pairUrl ?? '—'}</code>
            <button
              type="button"
              className={buttonClass(false)}
              disabled={busy !== undefined}
              onClick={() => void mintToken()}
            >
              {busy === 'pair' ? t('starting') : t('newToken')}
            </button>
            <button
              type="button"
              className={buttonClass(false)}
              disabled={status?.pairUrl === undefined}
              onClick={() => void copyLink()}
            >
              {copied ? t('copied') : t('copyLink')}
            </button>
          </div>
          <p className="dsh-remote-control-warning">{t('trustNote')}</p>
        </div>
      ) : null}

      {status && (status.requests > 0 || status.errors > 0) ? (
        <>
          <h3 style={{ fontSize: 14, margin: '22px 0 6px' }}>{t('messages')}</h3>
          <div className="dsh-remote-control-card">
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="dsh-remote-control-key" style={{ flex: '0 0 240px' }}>{t('requests')}</div>
              <div className="dsh-remote-control-value">{status.requests}</div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="dsh-remote-control-key" style={{ flex: '0 0 240px' }}>{t('errors')}</div>
              <div className="dsh-remote-control-value">{status.errors}</div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="dsh-remote-control-key" style={{ flex: '0 0 240px' }}>{t('reconnects')}</div>
              <div className="dsh-remote-control-value">{status.reconnects}</div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="dsh-remote-control-key" style={{ flex: '0 0 240px' }}>{t('authenticated')}</div>
              <div className="dsh-remote-control-value">
                {status.authenticated ? t('authenticatedYes') : t('authenticatedNo')}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="dsh-remote-control-key" style={{ flex: '0 0 240px' }}>{t('inFlight')}</div>
              <div className="dsh-remote-control-value">
                {status.pending.http} / {status.pending.sockets}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}