#!/usr/bin/env python3
import paramiko
for pwd in ["shtlIf9LAyf1yk3bKF4J"]:
    try:
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect("77.237.232.181", port=2222, username="root", password=pwd, timeout=20, banner_timeout=60)
        print("SSH_OK")
        _, o, _ = c.exec_command("echo ok", timeout=15)
        print(o.read().decode().strip())
        c.close()
    except Exception as ex:
        print("SSH_FAIL", type(ex).__name__, str(ex)[:120])
