#!/usr/bin/env python3
"""Verify live medsynoza serves the new plan-cards bundle."""
import sys
from pathlib import Path

import paramiko

HOST = "77.237.232.181"
PORT = 2222
USER = "root"
PASSWORD = '*1h*1£7N+oP"'
OUT = Path(__file__).with_name("_verify_plans_live2.txt")

REMOTE = r"""
APP=/home/adminanmkavps/synoza.anmka.com
echo '=== disk index ==='
cat $APP/client/dist/index.html
echo
echo '=== live HTML bundle refs ==='
for host in medsynoza.com synoza.anmka.com; do
  echo "---- $host ----"
  curl -sk --max-time 15 "https://$host/" | grep -oE 'assets/index-[^"]+\.(js|css)' | head -5
done
echo
echo '=== markers in live JS via localhost ==='
# Serve through node app
html=$(curl -s --max-time 10 http://127.0.0.1:5099/)
echo "$html" | grep -oE 'assets/index-[^"]+\.js' | head -2
js=$(echo "$html" | grep -oE 'assets/index-[^"]+\.js' | head -1)
echo "js=$js"
curl -s "http://127.0.0.1:5099/$js" | tr ',' '\n' | grep -E 'Start for Free|EXAM NIGHT PLAN|Student preview|adminPricingPreview|Get Basic Plan|PURCHASE BASIC' | head -20
echo
echo '=== cache headers ==='
curl -sI http://127.0.0.1:5099/ | head -20
curl -sI "http://127.0.0.1:5099/$js" | head -15
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)
_, stdout, stderr = client.exec_command(REMOTE, timeout=90)
out = stdout.read().decode("utf-8", "replace")
err = stderr.read().decode("utf-8", "replace")
text = out + (("\nERR:\n" + err) if err.strip() else "")
OUT.write_text(text, encoding="utf-8")
sys.stdout.buffer.write(text.encode("utf-8", "replace"))
client.close()
