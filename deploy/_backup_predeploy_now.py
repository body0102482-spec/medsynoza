#!/usr/bin/env python3
"""Pre-deploy MySQL + media backup. Does not modify the database."""
from __future__ import annotations

import sys
import paramiko

HOST = "77.237.232.181"
PORT = 2222
USER = "root"
PASSWORD = "77z/8(G7&ls)"
APP = "/home/adminanmkavps/synoza.anmka.com"

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

REMOTE = r'''
set -euo pipefail
APP=/home/adminanmkavps/synoza.anmka.com
mkdir -p /root/synoza-backups
STAMP=$(date +%Y%m%d-%H%M%S)
DBDUMP="/root/synoza-backups/synoza-predeploy-${STAMP}.sql.gz"
MEDIADUMP="/root/synoza-backups/synoza-media-predeploy-${STAMP}.tar.gz"

python3 - "$APP" "$DBDUMP" <<'PY'
import gzip, os, re, subprocess, sys, urllib.parse
app, dump_path = sys.argv[1], sys.argv[2]
env_path = os.path.join(app, "server", ".env")
raw = open(env_path, encoding="utf-8", errors="replace").read()
m = re.search(r"^DATABASE_URL=(.+)$", raw, re.M)
if not m:
    raise SystemExit("DATABASE_URL missing in server/.env")
url = m.group(1).strip().strip('"').strip("'")
parsed = urllib.parse.urlparse(url)
user = urllib.parse.unquote(parsed.username or "")
password = urllib.parse.unquote(parsed.password or "")
host = parsed.hostname or "127.0.0.1"
port = str(parsed.port or 3306)
db = (parsed.path or "/").lstrip("/").split("?")[0]
if not user or not db:
    raise SystemExit(f"bad DATABASE_URL parse user={user!r} db={db!r}")
dump_bin = "mariadb-dump" if subprocess.call(["bash", "-lc", "command -v mariadb-dump"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0 else "mysqldump"
print(f"DB backup -> {dump_path} (db={db} host={host} tool={dump_bin})")
cmd = [
    dump_bin,
    f"-h{host}",
    f"-P{port}",
    f"-u{user}",
    f"-p{password}",
    "--single-transaction",
    "--routines",
    "--triggers",
    "--databases",
    db,
]
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
assert proc.stdout is not None
with gzip.open(dump_path, "wb") as out:
    while True:
        chunk = proc.stdout.read(1024 * 256)
        if not chunk:
            break
        out.write(chunk)
err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
code = proc.wait()
filtered = "\n".join(ln for ln in err.splitlines() if "Using a password" not in ln)
if filtered.strip():
    print(filtered[-2000:], file=sys.stderr)
if code != 0:
    raise SystemExit(f"dump failed exit={code}")
sz = os.path.getsize(dump_path)
print(f"DUMP_BYTES {sz}")
if sz < 1000:
    raise SystemExit("dump too small")
PY

ls -lah "$DBDUMP"

echo "Media backup -> $MEDIADUMP"
if [ -d /home/adminanmkavps/synoza-media ]; then
  tar -czf "$MEDIADUMP" -C /home/adminanmkavps synoza-media
else
  tar -czf "$MEDIADUMP" --files-from /dev/null
fi
ls -lah "$MEDIADUMP"
echo "==== recent backups ===="
ls -lahtr /root/synoza-backups/ | tail -12
echo "BACKUP_DONE $DBDUMP"
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print(f"Connecting {HOST}:{PORT} ...")
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)
print("Connected. Starting backup...")
_, stdout, stderr = client.exec_command(REMOTE, timeout=900)
text = stdout.read().decode("utf-8", "replace")
errt = stderr.read().decode("utf-8", "replace")
code = stdout.channel.recv_exit_status()
client.close()

print(text)
if errt.strip():
    print("ERR:", errt[-3000:])
if code != 0 or "BACKUP_DONE" not in text:
    raise SystemExit(f"Backup failed (exit={code})")
print("Backup completed OK.")
