#!/usr/bin/env python3
"""Live production regression for greeting + multipart + case import + STT filters."""
from __future__ import annotations

import sys

import paramiko

HOST, PORT, USER, PASSWORD = "77.237.232.181", 2222, "root", "77z/8(G7&ls)"
APP = "/home/adminanmkavps/synoza.anmka.com/server"

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT = r'''
import { PrismaClient } from '@prisma/client';
import { getPatientResponse } from '../dist/services/aiService.js';
import { looksLikeSttHallucination } from '../dist/services/arabicSttFix.js';
import { parseImportedCaseSource } from '../dist/lib/caseImportParser.js';
import { readFileSync } from 'fs';

const p = new PrismaClient();
let passed = 0;
let failed = 0;

function assert(cond, label, detail) {
  if (cond) {
    passed += 1;
    console.log('  ✓', label);
  } else {
    failed += 1;
    console.error('  ✗', label, detail ? '— ' + detail : '');
  }
}

function dumpsSymptoms(text) {
  return /حمى|سخونية|قشعريرة|صداع|fever|chills|headache|ضيق|تنفس|صدر|أشهر|months|dyspnea/i.test(text || '');
}

const ascites = await p.case.findFirst({ where: { titleEn: 'Ascites' } });
if (!ascites) {
  console.log('NO_ASCITES');
  process.exit(1);
}

console.log('=== PROD CASE ===');
console.log('id:', ascites.id);
console.log('title:', ascites.titleEn);
console.log('chief:', (ascites.chiefComplaint || '').slice(0, 100));

// Confirm deploy contains greeting-only helpers
const aiSrc = readFileSync('./dist/services/aiService.js', 'utf8');
assert(aiSrc.includes('patientGreetingOnlyReply'), 'deployed patientGreetingOnlyReply');
assert(aiSrc.includes('stripEmbeddedEnglishFromArabic'), 'deployed English strip helper');
assert(aiSrc.includes('greeting ONLY') || aiSrc.includes('greetings must never dump'), 'deployed greeting-only policy text');

console.log('\n=== 1. GREETINGS (live AI) ===');
const short = await getPatientResponse(ascites, [], 'السلام عليكم', 'AR');
console.log('short:', short);
assert(/وعليكم السلام|أهلاً|اهلا|السلام/i.test(short), 'short Salam greets back', short);
assert(!dumpsSymptoms(short), 'short Salam no symptom dump', short);

const long = await getPatientResponse(ascites, [], 'السلام عليكم ورحمة الله وبركاته', 'AR');
console.log('long:', long);
assert(/وعليكم السلام|أهلاً|اهلا|السلام/i.test(long), 'long Salam greets back', long);
assert(!dumpsSymptoms(long), 'long Salam no symptom dump', long);

console.log('\n=== 2. MULTIPART (live AI) ===');
const multiQ =
  'قولي اسمك وسنك وساكن فين واتولدت فين وشغلك إيه ومتجوز ولا لا';
const multi = await getPatientResponse(
  ascites,
  [{ role: 'STUDENT', content: 'السلام عليكم' }, { role: 'PATIENT', content: short }],
  multiQ,
  'AR',
);
console.log('multi:', multi);
assert(/اسمي|اسم/i.test(multi) || /\d+\s*سنة|عندي/i.test(multi), 'multipart answers demographics', multi);
assert(!/pharmacy training trip|2-week|Hello doctor I am/i.test(multi), 'multipart no EN hallucination dump', multi);
const latinRuns = (multi.match(/[A-Za-z]{5,}/g) || []).length;
assert(latinRuns <= 3, 'multipart mostly Arabic (few latin leaks)', 'latinRuns=' + latinRuns + ' | ' + multi);

console.log('\n=== 2b. MULTIPART EN (name/weight/age/married) ===');
const multiEn = await getPatientResponse(
  ascites,
  [{ role: 'STUDENT', content: 'hello' }],
  'what is your name, how much do you weigh, how old are you and are you married',
  'EN',
);
console.log('multiEn:', multiEn);
assert(/name is|my name/i.test(multiEn), 'EN multipart has name', multiEn);
assert(/weigh|weight|kg|not sure/i.test(multiEn), 'EN multipart answers weight', multiEn);
assert(/years old|\bage\b|\d+/i.test(multiEn), 'EN multipart has age', multiEn);
assert(/married/i.test(multiEn), 'EN multipart has marital', multiEn);

console.log('\n=== 3. STT FILTERS ===');
assert(looksLikeSttHallucination('Buch.', true), 'Buch.');
assert(looksLikeSttHallucination('Hello, world!', true), 'Hello world');
assert(looksLikeSttHallucination('Sorry, could you clarify?', true), 'clarify');
assert(!looksLikeSttHallucination('I have abdominal swelling', true), 'real EN ok');

console.log('\n=== 4. CASE IMPORT ===');
try {
  const parsed = parseImportedCaseSource(`export const myCase: Case = {
    id: 'prod-typed',
    name: 'Prod Typed',
    specialty: 'Medicine',
    difficulty: 'easy',
    time: '10',
    patient: { name: 'Ali', age: 40, gender: 'male', nationality: 'Egyptian', chiefComplaint: 'pain' },
    history: { presentIllness: 'x', pastHistory: 'x', drugHistory: 'x', familyHistory: 'x', socialHistory: 'x' },
    examination: {},
    investigations: [],
    diagnosis: { provisional: 'x', differentials: [], management: 'x' },
    checklist: [],
    examinerQuestions: [],
  };`);
  assert(!!parsed && (parsed.name === 'Prod Typed' || parsed.id === 'prod-typed'), 'typed Case export parses');
} catch (e) {
  assert(false, 'typed Case export parses', e.message);
}

console.log('\n=== 5. VAD CONSTANTS IN BUILT CLIENT ===');
try {
  const fs = await import('fs');
  const path = await import('path');
  const clientDist = path.resolve('..', 'client', 'dist', 'assets');
  const files = fs.readdirSync(clientDist).filter((f) => f.startsWith('index-') && f.endsWith('.js'));
  const js = fs.readFileSync(path.join(clientDist, files[0]), 'utf8');
  // Bundled numbers: 2200 / 1800 silence thresholds
  assert(js.includes('2200') && js.includes('1800'), 'client bundle includes raised VAD silence (2200/1800)');
} catch (e) {
  assert(false, 'client VAD check', e.message);
}

console.log('\n=== SUMMARY ===');
console.log('Passed:', passed);
console.log('Failed:', failed);
await p.$disconnect();
process.exit(failed > 0 ? 1 : 0);
'''

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)
run = lambda cmd, timeout=60: c.exec_command(cmd, timeout=timeout)
_, o, e = run(f"mkdir -p {APP}/scripts")
o.channel.recv_exit_status()
sftp = c.open_sftp()
remote = APP + "/scripts/_test_feature_fixes_live.ts"
with sftp.file(remote, "w") as f:
    f.write(SCRIPT)
sftp.close()
print("Running live production checks...", flush=True)
_, o, e = c.exec_command(f"cd {APP} && npx tsx scripts/_test_feature_fixes_live.ts", timeout=180)
out = o.read().decode("utf-8", "replace")
err = e.read().decode("utf-8", "replace")
print(out)
if err.strip():
    print("STDERR:", err[-3000:])
code = o.channel.recv_exit_status()
c.close()
sys.exit(code)
