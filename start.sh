#!/usr/bin/env bash
# 弑君者 Regicide —— 一键启动
set -e
cd "$(dirname "$0")"

PORT="${1:-3000}"

if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖…"
  npm install --no-audit --no-fund
fi

if command -v python3 >/dev/null 2>&1; then
  LAN=$(python3 - <<'PY' 2>/dev/null || true
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(("8.8.8.8", 80)); print(s.getsockname()[0])
except Exception:
    pass
finally:
    s.close()
PY
)
fi

echo
echo "════════════════════════════════════════"
echo "   弑君者 Regicide 正在启动…"
echo "════════════════════════════════════════"
node server.js --port "$PORT"
