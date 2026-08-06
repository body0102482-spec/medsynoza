#!/usr/bin/env python3
"""Add openRouterApiKey column + seed OpenRouter key on production via Prisma."""
from __future__ import annotations

import sys

import paramiko

HOST, PORT, USER, PASSWORD = "77.237.232.181", 2222, "root", "77z/8(G7&ls)"
APP = "/home/adminanmkavps/synoza.anmka.com/server"
OPENROUTER_KEY = (
    __import__("os").environ.get("SEED_OPENROUTER_KEY")
    or ""
)
if not OPENROUTER_KEY.startswith("sk-or-"):
    raise SystemExit(
        "Set SEED_OPENROUTER_KEY env var to your sk-or-v1-… key before running this script."
    )

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT = r'''
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'fs';

const KEY = process.env.SEED_OPENROUTER_KEY || '';
if (!KEY.startsWith('sk-or-')) throw new Error('missing SEED_OPENROUTER_KEY');

const prisma = new PrismaClient();

async function ensureColumn() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AISettings' AND COLUMN_NAME = 'openRouterApiKey'`,
  );
  const count = Number((rows as any)[0]?.c ?? 0);
  if (count === 0) {
    await prisma.$executeRawUnsafe(`ALTER TABLE \`AISettings\` ADD COLUMN \`openRouterApiKey\` TEXT NULL`);
    console.log('COLUMN_ADDED');
  } else {
    console.log('COLUMN_EXISTS');
  }
}

async function main() {
  await ensureColumn();
  let settings = await prisma.aISettings.findFirst();
  if (!settings) {
    settings = await prisma.aISettings.create({
      data: {
        provider: 'openrouter',
        openRouterApiKey: KEY,
        patientModel: 'openai/gpt-4o-mini',
        examinerModel: 'openai/gpt-4o-mini',
      },
    });
  } else {
    const patientModel = settings.patientModel.includes('/')
      ? settings.patientModel
      : 'openai/gpt-4o-mini';
    const examinerModel = settings.examinerModel.includes('/')
      ? settings.examinerModel
      : 'openai/gpt-4o-mini';
    settings = await prisma.aISettings.update({
      where: { id: settings.id },
      data: {
        provider: 'openrouter',
        openRouterApiKey: KEY,
        patientModel,
        examinerModel,
      },
    });
  }
  console.log(
    'SAVED',
    settings.provider,
    settings.patientModel,
    settings.examinerModel,
    (settings.openRouterApiKey || '').slice(0, 10) + '…',
  );

  // Keep .env in sync as optional override.
  const envPath = '.env';
  let env = readFileSync(envPath, 'utf8');
  if (/^OPENROUTER_API_KEY=/m.test(env)) {
    env = env.replace(/^OPENROUTER_API_KEY=.*$/m, `OPENROUTER_API_KEY=${KEY}`);
  } else {
    env += `\nOPENROUTER_API_KEY=${KEY}\n`;
  }
  // Comment AI_PROVIDER so admin Settings (DB) can choose openrouter without env override.
  if (/^AI_PROVIDER=/m.test(env) && !/^# AI_PROVIDER=/m.test(env)) {
    env = env.replace(/^AI_PROVIDER=.*$/m, '# AI_PROVIDER managed by Admin Settings (DB)\n# AI_PROVIDER=openai');
  }
  writeFileSync(envPath, env);
  console.log('ENV_UPDATED');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)

sftp = client.open_sftp()
try:
    sftp.mkdir(f"{APP}/scripts")
except OSError:
    pass
with sftp.file(f"{APP}/scripts/_setup_openrouter.ts", "w") as f:
    f.write(SCRIPT)
sftp.close()

cmd = (
    f"cd {APP} && SEED_OPENROUTER_KEY='{OPENROUTER_KEY}' "
    f"npx tsx scripts/_setup_openrouter.ts && pm2 restart synoza --update-env && "
    f"curl -s http://127.0.0.1:5000/api/health || curl -s http://127.0.0.1:3000/api/health || true"
)
print(">>> seeding OpenRouter key via Prisma…")
_, out, err = client.exec_command(cmd, timeout=180)
print(out.read().decode("utf-8", "replace"))
e = err.read().decode("utf-8", "replace")
if e.strip():
    print("ERR", e[-2500:])
client.close()
