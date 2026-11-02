# dsh-remote-control relay

The server half of [`dsh-remote-control`](../README.md). It is the only piece that needs
a public address: your DSH host dials **out** to it, and browsers reach your host
**through** it.

Run it on a VPS, a home server, a Raspberry Pi, anywhere both sides can reach.
It has one dependency (`ws`), keeps one JSON file, and never stores a credential
that can reach your machine.

```
browser ──HTTP/WS──▶ relay ──WebSocket──▶ DSH host ──loopback──▶ dsh web server
```

## What it does and does not know

The relay terminates the browser's HTTP and WebSocket traffic and forwards it,
frame by frame, down the host's socket. It does **not** parse sessions,
messages, tool calls or approvals — see [`PROTOCOL.md`](PROTOCOL.md) §3 for the
whole wire contract.

What it *does* see is the traffic itself, in plaintext, because it is the HTTP
server the browser talks to. Put TLS in front of it (below) if the path between
your browser and the relay is not one you trust.

What it never sees is your Harness credential. The browser-session cookie the
Harness requires is minted on the host, bound to `127.0.0.1:<port>`, and injected
into the loopback replay. The relay only ever handles its own pairing tokens.

## Quick start

```sh
cd relay
npm install --omit=dev
PORT=8080 PUBLIC_ORIGIN=http://relay.example node server.mjs
```

Then put that origin in the **Relay server** field at the top of the Remote
Control panel in the Harness, and press **Save** — it is remembered for the next
start. For a deployment you can instead set it in a profile patch or through the
environment:

```yaml
- id: dsh-remote-control
  name: dsh-remote-control
  config:
    relay: http://relay.example:8080
```

```sh
DSH_REMOTE_RELAY=http://relay.example:8080 dsh --profile web
```

There is deliberately **no default relay**. A relay is somebody's server, so the
plugin ships with none and asks you to name your own; the panel says so until
you do, and the environment variable locks the field rather than being silently
overridden by it.

## Production deploy

`install.sh` does the whole thing on a systemd host — dedicated service account,
`/opt/dsh-relay`, dependencies, environment file, unit, and start:

```sh
sudo ./install.sh --public-origin https://relay.example
```

It prints the origin to enter in the plugin's config when it finishes. Useful
flags: `--prefix`, `--user`, `--port`, `--unit-name`, `--no-start`.

It is idempotent and safe to re-run for an upgrade: it never touches
`state.json`, so already-paired browsers stay paired.

<details>
<summary>Doing it by hand</summary>

```sh
# 1. A service account. Never run a network daemon as a login user.
sudo useradd --system --home-dir /opt/dsh-relay --shell /usr/sbin/nologin dsh-relay

# 2. The program.
sudo mkdir -p /opt/dsh-relay
sudo cp -r server.mjs package.json PROTOCOL.md web /opt/dsh-relay/
cd /opt/dsh-relay && sudo npm install --omit=dev
sudo chown -R dsh-relay:dsh-relay /opt/dsh-relay

# 3. Configuration.
sudo tee /etc/dsh-relay.env >/dev/null <<'EOF'
PORT=80
PUBLIC_ORIGIN=https://relay.example
EOF
sudo chmod 600 /etc/dsh-relay.env

# 4. The unit. The file in this directory is a template: substitute
#    __USER__ / __PREFIX__ / __NODE__ / __ENV__ and install it.
sed -e "s|__USER__|dsh-relay|g" \
    -e "s|__PREFIX__|/opt/dsh-relay|g" \
    -e "s|__NODE__|$(command -v node)|g" \
    -e "s|__ENV__|/etc/dsh-relay.env|g" \
    dsh-remote-relay.service | sudo tee /etc/systemd/system/dsh-remote-relay.service >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now dsh-remote-relay
```

</details>

## Configuration

Everything is an environment variable; the unit reads `/etc/dsh-relay.env`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `80` | listen port |
| `HOST` | `0.0.0.0` | listen address |
| `PUBLIC_ORIGIN` | *(request host)* | origin used to build the pairing URL. **Set this** behind a proxy, or a QR minted from the internal address will not resolve for the browser |
| `STATE_FILE` | `<dir>/state.json` | session table; holds host secrets, keep it `0600` |
| `WEB_ROOT` | `<dir>/web` | the pairing shell |
| `PAIRING_TTL_MS` | `600000` | how long a QR link stays valid |
| `PHONE_TOKEN_LIMIT` | `50` | how many browsers may stay paired to one session. Reaching it drops the least recently used one, and says so in the log |
| `PHONE_TOKEN_FLUSH_MS` | `60000` | how often last-used times are written to `state.json`; recency is what eviction sorts by |
| `BROWSER_IDLE_MS` | `15000` | quiet time before the host is told the browser left |
| `HOST_GRACE_MS` | `30000` | how long a browser's tunnels and in-flight requests survive the host stepping away. A host socket dropping is not a dead pairing — the plugin's own reconnect lands well inside this — so the relay holds the browsers instead of tearing them down, which is what stops a blip from becoming a visible outage. Must exceed the client's reconnect delay |
| `TUNNEL_HEAD_TIMEOUT_MS` | `30000` | how long a tunnelled request may wait for the host's response head |
| `TUNNEL_OPEN_TIMEOUT_MS` | `15000` | how long a tunnelled WebSocket may wait for the host to accept it |
| `PING_TIMEOUT_MS` | `5000` | how long `/_relay/ping` waits for the host's answer |
| `DEBUG` | off | `1` logs every tunnel frame — the first thing to turn on when a page stalls |

## TLS

The relay speaks plain HTTP, so terminate TLS in front of it and keep the origin
you configure equal to the public one:

```nginx
server {
  listen 443 ssl;
  server_name relay.example;

  ssl_certificate     /etc/letsencrypt/live/relay.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/relay.example/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    # Both of these are required: the tunnel carries a WebSocket, and the
    # pairing flow is a POST that must not be buffered indefinitely.
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_buffering off;
  }
}
```

With this in place set `PUBLIC_ORIGIN=https://relay.example` and bind the relay
to `127.0.0.1:8080`. The `Secure` flag on the browser cookie turns on
automatically when `X-Forwarded-Proto: https` arrives.

## Verifying a deployment

```sh
curl -s https://relay.example/healthz
# {"ok":true,"version":"0.9.1","sessions":1,"hosts":1,"browsers":0,"uptime":42}

node verify.mjs --relay https://relay.example
```

`verify.mjs` is 62 checks against a running relay with no DSH anywhere: the
pairing cookie, single-use and expiry rules, the HTTP proxy, WebSocket upgrade
routing, presence, the tunnel round trip, and both offline pages. A failure
there is always the relay's.

`version` in `/healthz` is what to compare against the plugin's version. The two
halves are one versioned pair — the plugin calls `/_relay/*` and expects the
framing in `PROTOCOL.md` §3 — and a mismatch is the single most common cause of a
pairing page that cannot get past its exchange.

## Upgrading

```sh
sudo ./install.sh --public-origin https://relay.example   # re-run in place
```

`state.json` is left alone, so nothing needs re-pairing. If you deploy by hand
instead, copy `server.mjs`, `package.json` and `web/` — **not** `state.json`.

## One relay, many hosts

A relay serves every host that registers with it, and a browser may be paired
with several at once. Two things make that work:

**Every session has a path.** Its pairing link is `http://relay/s/<session>/#/pair?t=…`,
and once paired, the browser lives at `http://relay/s/<session>/`. The scope is
stripped before the request reaches the host, so the host still sees `/`.

This is not decoration. A browser holds one cookie per name and origin, so with
an unscoped link, pairing a second host **replaced** the first host's cookie and
both windows then showed whichever host was paired last — two pairings, one
machine. Scoping the document is what lets a browser hold several pairings, and
because the Harness client is built entirely from relative URLs (`./assets/…`,
`plugins/??…`, `<link href="./">`), everything it goes on to request stays inside
the scope on its own.

**The pairing cookie is scoped with it** — `Path=/s/<session>` — so pairing again
adds a cookie rather than overwriting one. Pairing is judged against the session
being asked for, not against whichever cookie arrived first, so an extra stale
cookie in the jar cannot misroute a request.

An origin-absolute request that escapes the scope (a client resolving against the
origin rather than the document) is attributed by the **scope in its referer**.
If neither is present the relay shows the pairing shell rather than guessing
between hosts: a wrong guess hands over the wrong machine, which is worse than
asking.

| Request | Attributed by |
|---|---|
| `/s/<session>/…` | the path |
| `/assets/app.js` from a page at `/s/<session>/` | the referer |
| `/` with one pairing cookie | the cookie |
| `/` with several | nothing — the shell is shown |

## Versioning

This relay and the plugin that registers with it share a **compatibility line**:
the first two digits of their versions. A change that touches the relay, or the
contract between the two halves, moves that line and both are released together.
A change to either side alone moves only its patch digit, so the halves are free
to differ on the third: plugin `0.9.1`, `0.9.2` or `0.9.9` all work with relay
`0.9.1`. See the plugin's README for the full rule.

## The browser cookie, and why it can never go stale

A paired browser holds one `HttpOnly` cookie naming a token the relay stores on
the session. Everything the browser asks for is attributed through it, so a
cookie the relay cannot honour is the one failure that used to have no way out:
every request presented it, the relay answered "offline", and reloading changed
nothing. Clearing cookies by hand was the only fix, which is not a fix.

The relay now expires the cookie the moment it knows it is spent, in both cases
where that can happen:

| The browser asks with | Relay does |
|---|---|
| no cookie at all | serves the pairing shell |
| a cookie that resolves to no session | serves nothing — 404 on any path — and expires the root-path cookie |
| a cookie for a session the host ended, or that never had a host | expires it, serves the pairing shell marked `ended` |
| a cookie for a live pairing whose host is away | **keeps** it, serves the retry page |

So a browser can only ever be in one of two states: paired and working (or
briefly waiting), or unpaired and *being offered a way to pair*. The shell says
which, and takes a fresh link by paste as well as by QR.

The last row is the one that must not be collapsed into the others. A host that
has stepped away is not a dead pairing, and expiring a working cookie would
force a re-pair for a machine that is merely restarting.

### How many browsers, and which one goes

A session keeps one token per browser that has paired with it. When a new one
arrives and the list is already at `PHONE_TOKEN_LIMIT`, the relay drops the token
that has gone longest without **presenting itself** — not the one that was paired
longest. Recency is refreshed by every request a token authenticates, so a
browser that is actually in use is never the one dropped, and a drop is logged
with when that token was last seen:

```
2026-10-08T21:04:11.902Z session 3fKq2mB1: dropped browser token last used
2026-08-14T09:31:07.114Z; 50 still paired
```

Trimming the front of the list instead — insertion order — is what made a browser
that had worked for months stop one day with nothing on screen or in the log to
explain it: the browser paired longest ago went first, and that is usually the
one being used every day.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Pairing page says the relay answered with a page instead of its API | the relay is an older build than the plugin. Compare `version` in `/healthz` against the plugin version, redeploy, restart |
| Pairing page says the link was already used | pairing tokens are single-use, and the page keeps the token in its address bar. Open a fresh link from the panel — reloading the old one will not work |
| Pairing page waits, then reports the host never came online | the host is not attached: arm Remote Control in the panel, or `curl` `/healthz` and look at `hosts` |
| The page says the pairing is **no longer in use** | the host said so — it ended the pairing with Stop, or it re-registered — or no host has ever attached to that session. The host tells the relay explicitly in both cases, so this is not a guess. Reloading cannot fix it; press Start and scan the new QR |
| The page says **this browser is not paired with this host** | the relay still knows the session, but this request carried no token for it. Either the browser's cookie is gone — cleared, a year old, a different browser or hostname than the one that paired — or its token was evicted when the session reached `PHONE_TOKEN_LIMIT` (see *How many browsers, and which one goes*; the log names the drop). Pair again from the panel |
| The page says the computer is **offline** | the host had been attached and has gone away. A blip shorter than `HOST_GRACE_MS` is invisible — the relay holds the browser's requests and replays them when the host returns. Past that window the page waits on `/_relay/probe` and reloads itself the moment the host is back, so a recovery costs one reload rather than a reload every few seconds |
| A browser's conversation keeps resetting, or answers already given are lost | the tunnel is being rebuilt often enough to disturb the client. Check `HOST_GRACE_MS` covers the host's reconnect delay, and look for a host that drops repeatedly — the host log's `relay closed (<code>)` names why. A 1006 usually means an idle proxy in front of the relay; see `proxy_read_timeout` in the deployment example |
| A page reconnects on a timer — every 15 seconds or so, even while the host is attached and idle | the tunnel's open deadline is not being released after the host accepts the stream, so the relay tears every tunnelled WebSocket down with `TUNNEL_OPEN_TIMEOUT_MS` ("the host did not accept the stream") while the host in fact answered `ws-open-ok`. The two logs disagreeing is the tell: a clean `ws-open`/`ws-open-ok` exchange on the host side, and a 1011 close on the browser side 15 s later. The deadline is released with `clearTimeout(socketCtx.timer)` on `ws-open-ok` — `socketCtx.timer?.clear?.()` looks equivalent but is a silent no-op, because a Node `Timeout` has `unref`/`ref`/`refresh` and no `clear`. Each reconnect takes the client's live streams with it, so the page looks like it is flapping for no reason |
| A page loads but stays blank, or a request hangs | restart the relay with `DEBUG=1` and watch the frames. `hosts: 0` while the panel says *online* means the host is on a different session |
| `hosts` is 1 but pairing still says offline | the host socket is attached to a *different* session than the QR names. Reset pairing in the panel |

## Security notes

- The pairing URL is a credential for as long as it lives. Keep the TTL short
  (`PAIRING_TTL_MS`) and treat a screenshot of the QR as a secret.
- `state.json` holds a host secret per session. It is written `0600` and the unit
  restricts access to the service account; back it up only somewhere you would
  keep a key.
- Nothing in this directory trusts the browser. Every tunnelled request is
  authenticated by the host against its own loopback fence; a forged cookie gets
  a `401` from the Harness, not from here.
- The relay is deliberately not a general-purpose proxy: it forwards only to the
  host socket that authenticated with a session secret, and only for that
  session's browsers.

## What is in this directory

| File | Role |
|---|---|
| `server.mjs` | the whole relay: session table, pairing, reverse proxy, WebSocket routing |
| `web/` | the pairing shell served to an unpaired browser — `index.html`, `pair.js`, `pair.css` |
| `PROTOCOL.md` | the wire contract, including the tunnel framing |
| `install.sh` | systemd deployment helper |
| `dsh-remote-relay.service` | unit template (`__USER__`, `__PREFIX__`, `__NODE__`, `__ENV__`) |
| `verify.mjs` | 27 checks against a running relay, no DSH needed |
| `e2e.mjs` | drives a real browser through a real relay against a real `dsh web` (run from the package root) |