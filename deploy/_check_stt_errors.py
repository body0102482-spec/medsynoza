#!/usr/bin/env python3
"""Check Synoza STT config + recent voice-turn errors on production."""
import paramiko
import sys

HOST, PORT, USER, PASSWORD = "77.237.232.181", 2222, "root", "77z/8(G7&ls)"
APP = "/home/adminanmkavps/synoza.anmka.com/server"

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)

cmds = [
    f"grep -E '^(STT_PROVIDER|OPENAI_WHISPER_MODEL|AI_PROVIDER|OPENAI_API_KEY)=' {APP}/.env | sed 's/OPENAI_API_KEY=.*/OPENAI_API_KEY=***/'",
    "pm2 logs synoza --lines 80 --nostream 2>/dev/null | grep -iE 'voice-turn|transcri|whisper|stt|recording|422|500' | tail -40",
    f"grep -n 'extractPrimaryUtterance\\|allowLatinOnly\\|accented' {APP}/dist/services/transcriptionService.js | head -20",
]
for cmd in cmds:
    print(">>>", cmd[:120])
    _, o, e = c.exec_command(cmd, timeout=60)
    print(o.read().decode("utf-8", "replace")[-5000:])
    err = e.read().decode("utf-8", "replace")
    if err.strip():
        print("ERR", err[-1500:])
c.close()
