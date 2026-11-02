/**
 * The panel's view of the route family.
 *
 * This plugin is where the failure it pins is easiest to see: the tunnel serves
 * the web client at `/s/<sessionId>/`, and an origin-absolute `/api/...`
 * request leaves that scope, so the relay answers it with its own pairing page —
 * a `200 text/html` body that `response.json()` reports as
 * `Unexpected token '<'`. The panel's requests must therefore be
 * document-relative, which is how the harness's own channels address the host.
 *
 * @module dsh-remote-control/test/protocol
 */

import { describe, expect, it } from 'vitest'
import { API, CLIENT_API, MUTATING_ROUTES, clientPath } from '../src/protocol.ts'

/** Where the desktop app and a root-mounted `dsh web` serve the client. */
const AT_ROOT = 'http://127.0.0.1:50603/'

/** Where this plugin's own relay serves the client to a paired browser. */
const UNDER_TUNNEL = 'https://relay.example/s/ab12/'

describe('CLIENT_API', () => {
  it('never begins with a slash, so it resolves against the document', () => {
    for (const path of Object.values(CLIENT_API)) {
      expect(path.startsWith('/')).toBe(false)
    }
  })

  it('reaches the host route when the client is at the origin root', () => {
    for (const [name, path] of Object.entries(CLIENT_API)) {
      const route = API[name as keyof typeof API]
      expect(new URL(path, AT_ROOT).pathname).toBe(route)
    }
  })

  it('stays inside the tunnel scope, which is where the panel is used remotely', () => {
    expect(new URL(CLIENT_API.status, UNDER_TUNNEL).pathname).toBe(
      `/s/ab12${API.status}`,
    )
    expect(new URL(CLIENT_API.qr, UNDER_TUNNEL).pathname).toBe(`/s/ab12${API.qr}`)
  })

  it('derives every client route from its host route', () => {
    for (const [name, path] of Object.entries(CLIENT_API)) {
      expect(path).toBe(clientPath(API[name as keyof typeof API]))
    }
  })
})

describe('the host half', () => {
  it('keeps its route table and its audit list absolute', () => {
    for (const route of MUTATING_ROUTES) expect(route.startsWith('/api/')).toBe(true)
    expect(MUTATING_ROUTES).toContain(API.start)
  })

  it('escapes the tunnel scope when a path is absolute — the regression itself', () => {
    expect(new URL(API.status, UNDER_TUNNEL).pathname).toBe(API.status)
  })
})
