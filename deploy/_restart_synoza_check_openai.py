#!/usr/bin/env python3
"""Force-restart synoza to load .env, then validate OPENAI_API_KEY (no DB)."""
from __future__ import annotations

import sys
import time

import paramiko

HOST = "77.237.232.181"
PORT = 2222
USER = "root"
PASSWORD = "77z/8(G7&ls)"
APP = "/home/adminanmkavps/synoza.anmka.com"

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def ssh_run(client: paramiko.SSHClient, cmd: str, timeout: int = 180) -> tuple[int, str]:
    transport = client.get_transport()
    if transport:
        transport.set_keepalive(15)
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout, get_pty=True)
    chan = stdout.channel
    chan.settimeout(2.0)
    chunks: list[str] = []
    deadline = time.time() + timeout
    while True:
        if time.time() > deadline:
            try:
                chan.close()
            except Exception:
                pass
            raise TimeoutError(f"timeout; partial={''.join(chunks)[-400:]!r}")
        if chan.recv_ready():
            chunks.append(chan.recv(65536).decode("utf-8", "replace"))
            continue
        if chan.recv_stderr_ready():
            chunks.append(chan.recv_stderr(65536).decode("utf-8", "replace"))
            continue
        if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
            break
        time.sleep(0.2)
    while chan.recv_ready():
        chunks.append(chan.recv(65536).decode("utf-8", "replace"))
    return chan.recv_exit_status(), "".join(chunks)


client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

# Force restart without relying on slow pm2 list: kill listener on 5099, start via ecosystem
cmd = f"""
set -e
APP={APP}
echo BEFORE=$(curl -s -m 5 http://127.0.0.1:5099/api/health || echo FAIL)
# Kill whatever holds :5099
PIDS=$(ss -ltnp 2>/dev/null | awk '/:5099/ {{print}}' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | sort -u)
echo PIDS=$PIDS
for p in $PIDS; do kill -TERM "$p" 2>/dev/null || true; done
sleep 2
for p in $PIDS; do kill -KILL "$p" 2>/dev/null || true; done
# Also try pm2 delete/start with short timeouts
timeout 30 pm2 delete synoza >/dev/null 2>&1 || true
cd "$APP"
timeout 60 pm2 start ecosystem.config.cjs --update-env || timeout 60 pm2 start ecosystem.config.cjs || node "$APP/server/dist/index.js" >/tmp/synoza-manual.log 2>&1 &
sleep 4
echo AFTER=$(curl -s -m 8 http://127.0.0.1:5099/api/health || echo FAIL)
echo PING=$(curl -s -m 8 http://127.0.0.1:5099/api/ping || echo FAIL)
# Validate key with curl (no node/tsx)
KEY=$(grep -E '^OPENAI_API_KEY=' "$APP/server/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
echo KEY_MASK=${{KEY:0:8}}...${{KEY: -4}}
HTTP=$(curl -s -o /tmp/oai.json -w '%{{http_code}}' -m 25 https://api.openai.com/v1/models -H "Authorization: Bearer $KEY")
echo OPENAI_HTTP=$HTTP
head -c 220 /tmp/oai.json; echo
echo RESTART_DONE
"""
code, out = ssh_run(client, cmd, timeout=180)
client.close()
print(out)
if "RESTART_DONE" not in out:
    raise SystemExit(1)
if "OPENAI_HTTP=200" in out:
    print("OpenAI key is valid.")
elif "OPENAI_HTTP=401" in out:
    print("OpenAI key REJECTED (401). Local key is invalid/expired — need a new key.")
    raise SystemExit(2)
else:
    print("OpenAI check inconclusive.")
    raise SystemExit(3)
