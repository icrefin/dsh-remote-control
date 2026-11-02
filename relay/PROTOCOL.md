# DSH remote control — protocol

A relay on a public host connects a **DSH host** (your machine, running the
`dsh-remote-control` plugin) to a **browser** — phone or desktop. Nothing here is
ZCode-compatible: ZCode's relay was a reference for what a remote control needs
to do, not for how to do it. This protocol is ours, and it is deliberately small.

```
  DSH host  ──WS /ws (role=host)──▶  relay  ◀──HTTP + WS──  browser
 (dsh-remote-control)                                    (the real Harness client)
        │
        └── loopback HTTP/WS ──▶ 127.0.0.1:<port>  (this host's own dsh web server)
```

The relay is a **reverse proxy**, not an interpreter: it terminates the
browser's HTTP and WebSocket traffic and replays it, frame for frame, against
the host's own loopback web server. Application payloads — HTML, JSON, RPC
frames — pass through unread. The one deliberate exception is a single
`text/html` response, whose body it leaves to the host to rewrite (§3.4).

The point of the shape: the browser runs the **shipped Harness client**, not a
reimplementation of it. Every feature the local GUI has — sessions, approvals,
files, terminal, settings, plugins — arrives by construction, and none of it
needs a line of code here.

---

## 1. Pairing

The host owns a long-lived **host secret** so a restart does not invalidate the
browser. Pairing mints a short-lived, single-use **pairing token** that is what
the QR code carries.

```
host                          relay                        browser
 │  POST /_relay/session        │                             │
 │  {hostSecret?}               │                             │
 │ ────────────────────────────▶│                             │
 │  {sessionId, hostSecret,     │                             │
 │   pairingToken, expiresAt,   │                             │
 │   wsUrl}                     │                             │
 │ ◀────────────────────────────│                             │
 │                              │        GET /#/pair?t=<token> │
 │                              │ ◀───────────────────────────│
 │                              │  POST /_relay/pair {token}   │
 │                              │ ◀───────────────────────────│
 │                              │  200 + Set-Cookie: phone     │
 │                              │ ────────────────────────────▶│
 │  WS /ws?role=host            │        GET /  (with cookie)  │
 │    &session=<sessionId>      │ ◀───────────────────────────│
 │    &token=<hostSecret>       │                             │
 │ ────────────────────────────▶│   tunnel: http-req …        │
 │  peer {state:"connected"}    │ ───────────────────────────▶│
 │ ◀────────────────────────────│                             │
```

- `POST /_relay/session` with `{hostSecret}` resumes an existing session;
  without it, a new session and secret are minted. The relay persists sessions to disk so
  a restart keeps browsers paired.
- `pairingToken` is single-use and expires (default 10 min). A phone may reconnect
  to the same session with its `phoneToken`, stored in an `HttpOnly` cookie.
- QR contents: `<publicOrigin>/#/pair?t=<pairingToken>`. The pairing page also
  accepts `?t=` so a link pasted into a chat client works.

### Relay frames (text JSON, over `/ws`)

| Direction | Frame | Meaning |
|---|---|---|
| browser → relay | `{"t":"pair","token":"…"}` | first frame from a browser socket using a pairing token |
| relay → either | `{"t":"peer","state":"connected"\|"disconnected"}` | the other side came or went |
| either → relay | `{"t":"msg","payload":<any>}` | application message |
| relay → other | `{"t":"msg","payload":<any>}` | forwarded verbatim |
| either → relay | `{"t":"ping"}` / relay → `{"t":"pong"}` | application liveness |
| relay → host | `{"t":"ready","sessionId":"…","role":"host"}` | host accepted |
| relay → either | `{"t":"hello","server_ts":…}` | a socket that has not yet identified itself |
| relay → either | `{"t":"error","code":"…","message":"…"}` | refused |

**Heartbeat authority.** WebSocket protocol-level ping/pong (RFC 6455 control
frames) is what the relay uses to detect dead sockets — it pings every 30 s and
terminates anything that misses one. The JSON `ping`/`pong` pair exists for
clients that cannot observe control frames. A client relying on silence
detection should send a JSON `ping` and treat its own unanswered timeout as the
signal.

**Replay.** The relay buffers no HTTP state across reconnects. A browser that
loses its socket retries the request that was in flight, like any HTTP client.

The host authenticates by URL query (`session` + `token`), so it sends no `pair`
frame. A browser authenticating by its cookie also sends no `pair` frame.

---

## 2. HTTP surface of the relay

Everything the relay owns itself lives under `/_relay`, deliberately **not**
under `/api`: that namespace is tunnelled straight through to the harness — its
RPC bridge, its gateway mux — and shadowing any of it would break the client in
ways that are hard to see.

| Route | Method | Purpose |
|---|---|---|
| `/_relay/session` | POST | the host registers or resumes a pairing session |
| `/_relay/probe` | GET | `?session=<id>` — is the host online right now |
| `/_relay/pair` | POST | consume a pairing token, set the browser cookie |
| `/_relay/unpair` | POST | forget this browser's cookie |
| `/healthz` | GET | relay liveness and session counts |
| everything else | any | **tunnelled** (§3) when the browser is paired, else the pairing page |

`/_relay/pair` answers `{sessionId, hostLabel, online}` and sets
`dsh-remote-phone=<token>`: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure`
when the request arrived over TLS.

A browser whose cookie the relay does not recognise gets the pairing page — never
an error page, because re-pairing is the remedy. A **WebSocket** upgrade with no
valid cookie is refused with `401`, and one with a valid cookie but no attached
host with `503`.

A paired browser keeps no socket of its own: presence is inferred from tunnelled
traffic. Opening a request or an upgrade tells the host `peer {state:"connected"}`;
`BROWSER_IDLE_MS` (default 15 s) after the last completed exchange, the host is
told `disconnected`.

---

## 3. The page tunnel

Once a browser is paired, every non-API request it makes is tunnelled. Frames
below ride inside the relay's `msg.payload`, in both directions.

**The relay is the HTTP server.** It accepts the browser's request, mints a
request id, forwards the head, streams the body, and writes the replayed
response back. Request bodies are buffered (they are JSON RPC envelopes and
uploads, both bounded by the harness); response bodies stream.

### 3.1 Requests — relay → host

```json
{ "t": "http-req",     "id": 41, "method": "POST", "url": "/api/remote.mux",
  "headers": { "accept": "…", "content-type": "…" } }
{ "t": "http-body",    "id": 41, "data": "<base64>" }
{ "t": "http-req-end", "id": 41 }
```

`url` is origin-form. Header names are lowercased. `id` is relay-minted from one
process-wide counter, so ids stay unique even though several browsers share a
single host socket.

The body **streams**: `http-req` is the head, any number of `http-body` frames
follow, and `http-req-end` closes it — a body-less request still sends
`http-req-end`. That keeps a large upload from being buffered whole anywhere,
and lets the relay forward a request the moment its head arrives.

```json
{ "t": "http-abort", "id": 41 }
```

The browser went away, or the relay gave up. The host must abort the in-flight
replay; a response for an aborted id is dropped.

### 3.2 Responses — host → relay

```json
{ "t": "http-res",   "id": 41, "status": 200, "headers": { "content-type": "…" } }
{ "t": "http-chunk", "id": 41, "data": "<base64>" }
{ "t": "http-end",   "id": 41 }
{ "t": "http-error", "id": 41, "code": "host-unreachable", "message": "…" }
```

Exactly one `http-res` head, then any number of `http-chunk`, then `http-end`.
`http-error` replaces the whole sequence and becomes a `502` at the browser.

`content-length` and `transfer-encoding` are **not** trusted across the tunnel:
the relay frames the body itself. Hop-by-hop headers are dropped by the host.

### 3.3 WebSocket upgrades — both directions

```json
{ "t": "ws-open",    "id": 7, "url": "/api/remote.mux", "headers": { … }, "protocol": "…" }
{ "t": "ws-open-ok", "id": 7, "protocol": "…" }
{ "t": "ws-msg",     "id": 7, "data": "<base64>", "binary": false }
{ "t": "ws-close",   "id": 7, "code": 1000, "reason": "…" }
{ "t": "ws-error",   "id": 7, "code": "host-unreachable", "message": "…" }
```

The relay accepts the browser's upgrade first, then asks the host to open the
matching loopback socket. Until `ws-open-ok` arrives, browser frames are queued
(bounded); a `ws-error` fails the browser's socket with `1011`. `ws-msg` is the
only frame that flows in both directions after the handshake.

The harness keeps **one** such stream open (`/api/remote.mux`) for its whole
lifetime, plus whatever a plugin opens.

### 3.4 The only body the host rewrites

A `text/html` response — in practice, the shell at `/` — is the one place the
host touches application content, and only to append two things before
`</body>`: a stylesheet and a script that let a narrow viewport scale and
reflow the desktop UI (§3.5). Everything else is replayed byte for byte.

The rewrite is idempotent, and it is applied only to responses that pass
through the tunnel: a browser on the host itself is served by the web server
directly and never sees the injected payload.

### 3.5 Remote display adaptation

The shipped client is built for a desktop viewport. It already collapses its
sidebar to a rail when it is narrow, so a phone shows a usable — but cramped —
layout. The injected payload closes that gap without touching the app:

| Concern | What the payload does |
|---|---|
| keyboard | `interactive-widget=resizes-content`, so a soft keyboard shrinks the layout instead of covering the composer |
| scaling | below the design width it offers **Fit** (the whole desktop layout, fitted to the screen) and **Native** (the client's own rail reflow), remembered per device |
| gestures | `touch-action: manipulation` keeps pinch-zoom but drops double-tap zoom and its delay |
| chrome | adds a small display button, `position:fixed` and out of the app's flow, that renders only below the design width |

Switching modes rewrites the viewport meta on the live document rather than
reloading, so the open conversation survives the change. `viewport-fit=contain`
stays in both modes: the client does not handle notch insets, so the browser
keeps content inside the safe area instead of under it.

---

## 4. Errors

`error.code` is a stable machine token; `message` is for display.

| Code | Meaning |
|---|---|
| `unauthorized` | bad or expired token |
| `no-session` | the pair session is unknown |
| `host-offline` | the session exists but no host socket is attached |
| `host-unreachable` | the host could not reach its own web server |
| `bad-request` | params failed validation |
| `timeout` | the host accepted the request but did not answer in time |
| `internal` | the host failed; `message` has the detail |

**Fatal versus transient.** `unauthorized`, `no-session` and `replaced` are
**fatal** for a connection: the credential is gone or another socket claimed the
role, so the client should stop retrying and offer a re-pair. `host-offline` and
`host-unreachable` are **transient** — the right response is to retry.

---

## 5. Why this shape

- **The real client, not a facsimile.** Every earlier attempt here re-implemented
  a slice of the GUI for the phone, and each slice was wrong in a new way:
  the sidebar, the approvals, the streaming transcript. Proxying the actual app
  retires that entire class of bug.
- **One credential, host-side.** The browser session cookie the harness issues is
  minted on the host, bound to `127.0.0.1:<port>`, and injected into the replay.
  The browser and the relay never see it, so a compromised relay cannot replay it
  against the host's API.
- **A dumb middle.** The relay forwards frames; it does not know what a session,
  a message or a tool call is. Adding a harness feature needs no relay change.
- **A long-lived host secret.** Repainting the QR must not require the desktop to
  re-register; only the pairing token is short-lived.
- **Explicit request ids.** A single page load fires dozens of parallel requests;
  ids keep the replies straight.
- **WebSocket passthrough.** The harness streams over one mux socket for its whole
  lifetime. Terminating that at the relay and re-originating it loopback is what
  makes approvals and live token streaming work remotely at all.