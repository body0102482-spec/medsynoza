#!/usr/bin/env python3
"""Live test: Ascites patient deflects off-scenario questions (knowledge-first policy)."""
from __future__ import annotations

import sys

import paramiko

HOST, PORT, USER, PASSWORD = "77.237.232.181", 2222, "root", "77z/8(G7&ls)"
APP = "/home/adminanmkavps/synoza.anmka.com/server"

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT = r'''
import { PrismaClient } from '@prisma/client';
import { hasPatientAiKnowledge, getRoleKnowledgeContext } from '../dist/services/knowledgeService.js';
import { getPatientResponse } from '../dist/services/aiService.js';

const p = new PrismaClient();

const ascites = await p.case.findFirst({
  where: { titleEn: 'Ascites' },
  include: { category: { select: { id: true, nameEn: true } } },
});
if (!ascites) {
  console.log('NO_ASCITES');
  process.exit(1);
}

console.log('=== ASCITES CASE ===');
console.log('id:', ascites.id);
console.log('title:', ascites.titleEn);
console.log('chiefComplaint:', (ascites.chiefComplaint || '').slice(0, 120));
console.log('scenarioPrompt:', (ascites.scenarioPrompt || '').slice(0, 200));

const has = await hasPatientAiKnowledge({ caseId: ascites.id, categoryId: ascites.categoryId });
console.log('hasPatientAiKnowledge:', has);

const ctx = await getRoleKnowledgeContext({ caseId: ascites.id, categoryId: ascites.categoryId, role: 'patient' });
console.log('knowledgeContextLen:', ctx.length);

const settings = await p.aISettings.findFirst();
console.log('AI_PROVIDER:', process.env.AI_PROVIDER || settings?.provider || 'unset');

// Verify new policy is deployed
import { readFileSync } from 'fs';
const aiSrc = readFileSync('./dist/services/aiService.js', 'utf8');
console.log('deployed PATIENT_KNOWLEDGE_FIRST:', aiSrc.includes('PATIENT RESPONSE POLICY (knowledge-first)'));
console.log('old SYNOZA_PATIENT_CORE active:', aiSrc.includes('SYNOZA PATIENT BEHAVIOR RULES (always follow)'));

const offTopicQuestions = [
  { lang: 'EN', q: 'Do you like football? Who is your favorite team?' },
  { lang: 'EN', q: 'What is your favorite movie?' },
  { lang: 'EN', q: 'Who won the World Cup last year?' },
  { lang: 'EN', q: 'Do you have a pet cat at home?' },
  { lang: 'AR', q: 'إنت بتحب كرة القدم؟ مين فريقك المفضل؟' },
  { lang: 'AR', q: 'إيه فيلمك المفضل؟' },
  { lang: 'AR', q: 'إنت شغال في إيه وبتاخد كام في الشهر؟' },
];

const inScenarioQuestions = [
  { lang: 'EN', q: 'What is bothering you today? Why did you come to the hospital?' },
  { lang: 'AR', q: 'إيه اللي وجعك؟ إيه الشكوى بتاعتك؟' },
];

const history: { role: string; content: string }[] = [];

console.log('\n=== IN-SCENARIO (should answer from case) ===');
for (const { lang, q } of inScenarioQuestions) {
  const reply = await getPatientResponse(ascites, history, q, lang as 'AR' | 'EN');
  history.push({ role: 'STUDENT', content: q });
  history.push({ role: 'PATIENT', content: reply });
  console.log('\nQ [' + lang + ']:', q);
  console.log('A:', reply);
}

console.log('\n=== OFF-SCENARIO (should deflect / stay in persona) ===');
for (const { lang, q } of offTopicQuestions) {
  const reply = await getPatientResponse(ascites, history, q, lang as 'AR' | 'EN');
  history.push({ role: 'STUDENT', content: q });
  history.push({ role: 'PATIENT', content: reply });
  const deflect =
    /not feeling well|talk about that later|later\?|focus on why|rather focus|مش قادر|تعبان|بعدين|مش قادر أفكر|later|unwell|ill right now/i.test(reply);
  console.log('\nQ [' + lang + ']:', q);
  console.log('A:', reply);
  console.log('DEFLECT?', deflect ? 'YES' : 'NO');
}

await p.$disconnect();
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)

sftp = client.open_sftp()
try:
    sftp.mkdir(f"{APP}/scripts")
except OSError:
    pass
with sftp.file(f"{APP}/scripts/_test_ascites_offtopic.ts", "w") as f:
    f.write(SCRIPT)
sftp.close()

print(">>> Running Ascites off-topic live test...")
_, out, err = client.exec_command(f"cd {APP} && npx tsx scripts/_test_ascites_offtopic.ts", timeout=180)
print(out.read().decode("utf-8", "replace"))
e = err.read().decode("utf-8", "replace")
if e.strip():
    print("ERR", e[-3000:])
client.close()
