#!/bin/sh
# Install the DSH remote-control relay as a systemd service.
#
# Idempotent, and safe to re-run for an upgrade: it copies the program and the
# pairing shell, installs dependencies, writes the environment file and the
# unit, then starts the service. It never touches state.json, so browsers that
# are already paired stay paired across an upgrade.
#
# Usage:
#   sudo ./install.sh --public-origin https://relay.example
#
# Options:
#   --public-origin <url>  origin browsers will use (strongly recommended; a
#                          proxy in front of the relay makes it mandatory)
#   --prefix <dir>         install directory            (default /opt/dsh-relay)
#   --user <name>          service account              (default dsh-relay)
#   --port <n>             listen port                  (default 80)
#   --env-file <path>      environment file             (default /etc/dsh-relay.env)
#   --unit-name <name>     systemd unit name            (default dsh-remote-relay)
#   --no-start             install everything, do not start or enable
#
# Environment:
#   NODE                   node executable to pin in the unit (default: `command -v node`)
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PREFIX=/opt/dsh-relay
SERVICE_USER=dsh-relay
PORT=80
ENV_FILE=/etc/dsh-relay.env
UNIT_NAME=dsh-remote-relay
PUBLIC_ORIGIN=
START=yes

while [ $# -gt 0 ]; do
  case "$1" in
    --public-origin) PUBLIC_ORIGIN=${2:?--public-origin needs a value}; shift 2 ;;
    --prefix)        PREFIX=${2:?--prefix needs a value}; shift 2 ;;
    --user)          SERVICE_USER=${2:?--user needs a value}; shift 2 ;;
    --port)          PORT=${2:?--port needs a value}; shift 2 ;;
    --env-file)      ENV_FILE=${2:?--env-file needs a value}; shift 2 ;;
    --unit-name)     UNIT_NAME=${2:?--unit-name needs a value}; shift 2 ;;
    --no-start)      START=no; shift ;;
    -h|--help)       sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh: run me with sudo (it writes $PREFIX and /etc/systemd/system)" >&2
  exit 1
fi

NODE=${NODE:-$(command -v node || true)}
if [ -z "$NODE" ]; then
  echo "install.sh: no node on PATH; install Node.js 20+ or set NODE=/path/to/node" >&2
  exit 1
fi
case "$NODE" in
  /*) : ;;
  *) NODE=$(command -v "$NODE") ;;
esac

for f in server.mjs package.json PROTOCOL.md web/index.html web/pair.js web/pair.css; do
  if [ ! -e "$HERE/$f" ]; then
    echo "install.sh: $HERE/$f is missing — run me from the relay/ directory of the package" >&2
    exit 1
  fi
done

echo "install.sh: node      $NODE"
echo "install.sh: prefix    $PREFIX"
echo "install.sh: user      $SERVICE_USER"

# ── 1. the program ────────────────────────────────────────────────────────────
# state.json is deliberately not in this list: an upgrade must not unpair
# browsers, and the session table is the only thing here that cannot be rebuilt.
mkdir -p "$PREFIX/web"
install -m 0644 "$HERE/server.mjs" "$PREFIX/server.mjs"
install -m 0644 "$HERE/package.json" "$PREFIX/package.json"
install -m 0644 "$HERE/PROTOCOL.md" "$PREFIX/PROTOCOL.md"
install -m 0644 "$HERE/README.md" "$PREFIX/README.md" 2>/dev/null || true
for f in index.html pair.js pair.css; do
  install -m 0644 "$HERE/web/$f" "$PREFIX/web/$f"
done
if [ -e "$PREFIX/verify.mjs" ] || [ -e "$HERE/verify.mjs" ]; then
  install -m 0644 "$HERE/verify.mjs" "$PREFIX/verify.mjs"
fi

echo "install.sh: installing dependencies"
( cd "$PREFIX" && "$NODE" "$(command -v npm || echo /usr/bin/npm)" install --omit=dev --silent ) \
  || ( cd "$PREFIX" && npm install --omit=dev )

# ── 2. the service account ────────────────────────────────────────────────────
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "install.sh: creating service account $SERVICE_USER"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
      || useradd --system --home-dir "$PREFIX" --shell /sbin/nologin "$SERVICE_USER"
  else
    echo "install.sh: no useradd; create $SERVICE_USER yourself and re-run" >&2
    exit 1
  fi
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
# The session table holds host secrets.
chmod 0700 "$PREFIX"
[ -e "$PREFIX/state.json" ] && chmod 0600 "$PREFIX/state.json"

# ── 3. configuration ──────────────────────────────────────────────────────────
if [ -e "$ENV_FILE" ]; then
  echo "install.sh: keeping the existing $ENV_FILE"
else
  echo "install.sh: writing $ENV_FILE"
  {
    echo "# Configuration for $UNIT_NAME. See $PREFIX/README.md."
    echo "PORT=$PORT"
    if [ -n "$PUBLIC_ORIGIN" ]; then
      echo "PUBLIC_ORIGIN=$PUBLIC_ORIGIN"
    else
      echo "# PUBLIC_ORIGIN is unset: pairing URLs will be built from the request"
      echo "# host. Set it if a proxy or tunnel sits in front of this relay."
    fi
  } > "$ENV_FILE"
fi
chmod 0600 "$ENV_FILE"
chown root:root "$ENV_FILE"

# ── 4. the unit ───────────────────────────────────────────────────────────────
sed -e "s|__USER__|$SERVICE_USER|g" \
    -e "s|__PREFIX__|$PREFIX|g" \
    -e "s|__NODE__|$NODE|g" \
    -e "s|__ENV__|$ENV_FILE|g" \
    "$HERE/dsh-remote-relay.service" > "/etc/systemd/system/$UNIT_NAME.service"
chmod 0644 "/etc/systemd/system/$UNIT_NAME.service"
echo "install.sh: wrote /etc/systemd/system/$UNIT_NAME.service"

systemctl daemon-reload

if [ "$START" = no ]; then
  echo "install.sh: --no-start, leaving the service stopped"
else
  systemctl enable --now "$UNIT_NAME"
  sleep 1
  echo "install.sh: $UNIT_NAME is $(systemctl is-active "$UNIT_NAME")"
fi

echo
echo "Relay installed."
echo "  check it : curl -s http://127.0.0.1:$PORT/healthz"
echo "  verify   : node $PREFIX/verify.mjs --relay http://127.0.0.1:$PORT"
echo "  logs     : journalctl -u $UNIT_NAME -f"
echo
if [ -n "$PUBLIC_ORIGIN" ]; then
  echo "Point the plugin at: $PUBLIC_ORIGIN"
  echo
  echo "  - id: dsh-remote-control"
  echo "    name: dsh-remote-control"
  echo "    config:"
  echo "      relay: $PUBLIC_ORIGIN"
else
  echo "Point the plugin at this relay's public origin, in your profile patch:"
  echo
  echo "  - id: dsh-remote-control"
  echo "    name: dsh-remote-control"
  echo "    config:"
  echo "      relay: http://<this-host>:$PORT"
fi