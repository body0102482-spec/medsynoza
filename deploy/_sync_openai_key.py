#!/usr/bin/env python3
"""Copy local OPENAI_API_KEY into production server/.env and restart synoza only."""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

import paramiko

HOST = "77.237.232.181"
PORT = 2222
USER = "root"
PASSWORD = "77z/8(G7&ls)"
APP = "/home/adminanmkavps/synoza.anmka.com"
ENV_LOCAL = Path(__file__).resolve().parents[1] / ".env"

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def mask(key: str) -> str:
    if len(key) <= 12:
        return "***"
    return f"{key[:8]}...{key[-4:]}"


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
            chan.close()
            raise TimeoutError(f"timeout; partial={''.join(chunks)[-300:]!r}")
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


def main() -> None:
    text = ENV_LOCAL.read_text(encoding="utf-8")
    m = re.search(r"^OPENAI_API_KEY=(.+)$", text, re.M)
    if not m:
        raise SystemExit(f"OPENAI_API_KEY not found in {ENV_LOCAL}")
    key = m.group(1).strip().strip('"').strip("'")
    if not key or key.startswith("your-") or "****" in key:
        raise SystemExit("Local OPENAI_API_KEY looks like a placeholder")

    print(f"Local key: {mask(key)}")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)

    # Read current remote key (masked only)
    code, out = ssh_run(
        client,
        f"grep -E '^OPENAI_API_KEY=' {APP}/server/.env | head -1 | sed 's/=.*/=***/'",
        timeout=60,
    )
    print("Remote before:", out.strip() or "(none)")

    # Write key via python on remote to avoid shell escaping issues; no DB touch
    # Upload key through SFTP temp file then merge
    sftp = client.open_sftp()
    remote_key_file = "/tmp/synoza-openai-key.txt"
    with sftp.file(remote_key_file, "w") as f:
        f.write(key)
    sftp.close()

    update_cmd = f"""
set -e
APP={APP}
ENVF=$APP/server/.env
KEYF={remote_key_file}
KEY=$(cat "$KEYF")
rm -f "$KEYF"
cp "$ENVF" /tmp/synoza-server.env.openai.bak
python3 - "$ENVF" "$KEY" <<'PY'
import re, sys
path, key = sys.argv[1], sys.argv[2]
raw = open(path, encoding="utf-8", errors="replace").read()
if re.search(r"^OPENAI_API_KEY=", raw, re.M):
    raw = re.sub(r"^OPENAI_API_KEY=.*$", "OPENAI_API_KEY=" + key, raw, count=1, flags=re.M)
else:
    if not raw.endswith("\\n"):
        raw += "\\n"
    raw += "OPENAI_API_KEY=" + key + "\\n"
# Ensure AI_PROVIDER=openai if present or add it
if re.search(r"^AI_PROVIDER=", raw, re.M):
    raw = re.sub(r"^AI_PROVIDER=.*$", "AI_PROVIDER=openai", raw, count=1, flags=re.M)
else:
    raw += "AI_PROVIDER=openai\\n"
open(path, "w", encoding="utf-8").write(raw)
print("UPDATED")
# print masked
print("MASK", key[:8] + "..." + key[-4:])
PY
# Restart synoza without pm2 CLI if overloaded — try soft restart via kill -HUP or pm2 with short timeout
if command -v timeout >/dev/null 2>&1; then
  timeout 45 pm2 restart synoza --update-env || timeout 45 pm2 restart synoza || true
else
  pm2 restart synoza --update-env || pm2 restart synoza || true
fi
sleep 3
echo PING=$(curl -s -m 10 http://127.0.0.1:5099/api/ping || echo FAIL)
echo HEALTH=$(curl -s -m 10 http://127.0.0.1:5099/api/health || echo FAIL)
# Verify env loaded (do not print full key)
grep -E '^OPENAI_API_KEY=' $ENVF | head -1 | awk -F= '{{k=$2; if(length(k)>12) print "REMOTE_KEY=" substr(k,1,8) "..." substr(k,length(k)-3); else print "REMOTE_KEY=***"}}'
grep -E '^AI_PROVIDER=' $ENVF | head -1
echo DONE
"""
    code, out = ssh_run(client, update_cmd, timeout=180)
    print(out)
    if "UPDATED" not in out or "DONE" not in out:
        raise SystemExit(f"Update failed (exit={code})")

    # Quick live key check via curl (no DB touch)
    check_cmd = f"""
KEY=$(grep -E '^OPENAI_API_KEY=' {APP}/server/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
echo KEY_MASK=${{KEY:0:8}}...${{KEY: -4}}
HTTP=$(curl -s -o /tmp/oai.json -w '%{{http_code}}' -m 25 https://api.openai.com/v1/models -H "Authorization: Bearer $KEY")
echo OPENAI_HTTP=$HTTP
if [ "$HTTP" = "200" ]; then echo OPENAI_OK; else head -c 200 /tmp/oai.json; echo; fi
"""
    code2, out2 = ssh_run(client, check_cmd, timeout=60)
    print(out2)
    client.close()
    if "OPENAI_OK" in out2:
        print("OpenAI key accepted by API.")
    else:
        print("WARNING: OpenAI rejected the key (same 401 risk as before).")
        raise SystemExit(2)


if __name__ == "__main__":
    main()
