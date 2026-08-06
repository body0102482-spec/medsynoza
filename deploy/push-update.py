#!/usr/bin/env python3
"""Upload synoza-deploy.tar.gz and restart production app. Code-only — never touch DB."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
TAR_PATH = ROOT / "deploy" / "synoza-deploy.tar.gz"
APP_DIR = "/home/adminanmkavps/synoza.anmka.com"

HOST = "77.237.232.181"
PORT = 2222
USER = "root"
PASSWORD = "77z/8(G7&ls)"


def log(msg: str) -> None:
    print(msg, flush=True)


def run(client: paramiko.SSHClient, cmd: str, timeout: int = 900) -> str:
    log(f">>> {cmd[:180].replace(chr(10), ' ')}...")
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        log(out[-8000:])
    if err.strip():
        log("ERR: " + err[-4000:])
    if code != 0:
        raise RuntimeError(f"Command failed ({code}): {cmd[:120]}")
    return out


def main() -> None:
    if not TAR_PATH.exists():
        raise SystemExit(f"Missing package: {TAR_PATH}. Run: npm run deploy:package")

    size = TAR_PATH.stat().st_size
    log(f"Package: {TAR_PATH} ({size / 1e6:.1f} MB)")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    log(f"Connecting {HOST}:{PORT} ...")
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30, banner_timeout=60)
    log("SSH connected.")

    transport = client.get_transport()
    if transport:
        transport.set_keepalive(15)

    remote_tar = "/tmp/synoza-deploy.tar.gz"
    log(f"Uploading -> {remote_tar}")
    sftp = client.open_sftp()
    last = {"t": time.time(), "sent": 0}

    def progress(sent: int, total: int) -> None:
        now = time.time()
        if now - last["t"] < 2 and sent < total:
            return
        elapsed = max(now - last["t"], 0.001)
        delta = sent - last["sent"]
        speed = delta / elapsed / 1e6
        pct = (100.0 * sent / total) if total else 0
        log(f"  upload {pct:5.1f}%  {sent/1e6:.1f}/{total/1e6:.1f} MB  {speed:.2f} MB/s")
        last["t"] = now
        last["sent"] = sent

    sftp.put(str(TAR_PATH), remote_tar, callback=progress)
    sftp.close()
    log("Upload complete. Extracting + restarting (no DB changes)...")

    run(
        client,
        f"""
set -e
APP={APP_DIR}
mkdir -p "$APP"
cd "$APP"
if [ -f server/.env ]; then cp server/.env /tmp/synoza-server.env.bak; fi
# Preserve uploaded media outside the wiped app tree
mkdir -p /home/adminanmkavps/synoza-media/exam/cases
mkdir -p /home/adminanmkavps/synoza-media/knowledge
if [ -d "$APP/client/public/exam/cases" ]; then
  cp -an "$APP/client/public/exam/cases/." /home/adminanmkavps/synoza-media/exam/cases/ 2>/dev/null || true
fi
if [ -d "$APP/client/dist/exam/cases" ]; then
  cp -an "$APP/client/dist/exam/cases/." /home/adminanmkavps/synoza-media/exam/cases/ 2>/dev/null || true
fi
# Never delete /home/adminanmkavps/synoza-media
rm -rf client server deploy start.sh ecosystem.config.cjs 2>/dev/null || true
tar xzf {remote_tar} -C "$APP"
if [ -f /tmp/synoza-server.env.bak ]; then
  cp /tmp/synoza-server.env.bak server/.env
  grep -q '^EMAIL_SITE_URL=' server/.env || echo 'EMAIL_SITE_URL=https://medsynoza.com' >> server/.env
  grep -q '^CLIENT_URL=' server/.env || echo 'CLIENT_URL=https://medsynoza.com' >> server/.env
  grep -q '^SYNOZA_EXAM_MEDIA_ROOT=' server/.env || echo 'SYNOZA_EXAM_MEDIA_ROOT=/home/adminanmkavps/synoza-media/exam' >> server/.env
  grep -q '^SYNOZA_AI_KNOWLEDGE_ROOT=' server/.env || echo 'SYNOZA_AI_KNOWLEDGE_ROOT=/home/adminanmkavps/synoza-media/knowledge' >> server/.env
  sed -i 's|^CLIENT_URL=.*|CLIENT_URL=https://medsynoza.com|' server/.env
  sed -i 's|^EMAIL_SITE_URL=.*|EMAIL_SITE_URL=https://medsynoza.com|' server/.env
fi
cd "$APP/server"
export NODE_ENV=production
export SYNOZA_EXAM_MEDIA_ROOT=/home/adminanmkavps/synoza-media/exam
export SYNOZA_AI_KNOWLEDGE_ROOT=/home/adminanmkavps/synoza-media/knowledge
npm install --omit=dev
npm install prisma @prisma/client tsx --no-save
npx prisma generate
# Code-only deploy: never touch the database.
# Do NOT run: prisma db push / migrate / seed / --accept-data-loss.
cd "$APP"
if [ -d "$APP/client/public/exam/cases" ]; then
  cp -an "$APP/client/public/exam/cases/." /home/adminanmkavps/synoza-media/exam/cases/ 2>/dev/null || true
fi
pm2 delete synoza 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
sleep 3
echo PING=$(curl -s -m 10 http://127.0.0.1:5099/api/ping || echo FAIL)
echo HEALTH=$(curl -s -m 10 http://127.0.0.1:5099/api/health || echo FAIL)
pm2 list | grep synoza || true
# Confirm no migrate/seed ran in this shell history of this script
echo DEPLOY_MODE=code-only
""",
        timeout=900,
    )

    client.close()
    log("Deploy completed.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    main()
