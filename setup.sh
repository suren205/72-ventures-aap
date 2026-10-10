#!/bin/bash
# 72 Ventures Khata - server setup for Ubuntu (AWS Lightsail).
# Run once on the server:  bash setup.sh
set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/khata-data"

echo "== 1/4 Installing Node.js and Caddy (takes 1-3 minutes) =="
sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y nodejs caddy curl
echo "Node version: $(node -v)"

echo "== 2/4 Starting the app as a service (it restarts by itself) =="
mkdir -p "$DATA_DIR"
sudo tee /etc/systemd/system/khata.service >/dev/null <<EOF
[Unit]
Description=72 Ventures Khata
After=network.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR
Environment=PORT=3000
Environment=DATA_DIR=$DATA_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable khata >/dev/null 2>&1
sudo systemctl restart khata

echo "== 3/4 Setting up HTTPS =="
IP=$(curl -s https://checkip.amazonaws.com)
HOST="$(echo "$IP" | tr . -).sslip.io"
printf '%s {\n\treverse_proxy localhost:3000\n}\n' "$HOST" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl enable caddy >/dev/null 2>&1
sudo systemctl restart caddy

echo "== 4/4 Done =="
sleep 4
echo
echo "  Your app link:  https://$HOST"
echo
if sudo journalctl -u khata --no-pager | grep -q "First start"; then
  echo "  First admin login (copy it now):"
  sudo journalctl -u khata --no-pager | grep -E "Login ID|Password:" | tail -2
fi
echo
echo "  The first time you open the link it can take up to 1 minute (getting the HTTPS certificate)."
