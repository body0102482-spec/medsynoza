/**
 * Regression tests for Aug 5 fixes:
 * - Greeting-only / multipart (needs DB; skipped if schema outdated)
 * - STT hallucination filters
 * - Case import typed TS exports
 * - VAD silence constants
 *
 * Run: npx tsx scripts/test-feature-fixes-aug5.ts
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Case } from '@prisma/client';
import { looksLikeSttHallucination } from '../src/services/arabicSttFix.js';
import { parseImportedCaseSource } from '../src/lib/caseImportParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

process.env.AI_PROVIDER = 'mock';

const caseData = {
  id: 'as-mr',
  titleEn: 'AS + MR',
  titleAr: 'AS + MR',
  finalDiagnosis: 'AS + MR',
  categoryId: null,
  patientName: 'Tarek Moustafa El-Haddad',
  patientAge: 17,
  patientGender: 'Male',
  patientNationality: 'Egyptian',
  chiefComplaint:
    'Progressive exertional dyspnea and occasional chest tightness for 6 months. High fever and severe chills with headache.',
  medicalHistory: 'Recurrent tonsillitis in childhood.',
  medicationHistory: 'None',
  surgicalHistory: 'None',
  familyHistory: 'No similar illness.',
  socialHistory:
    'From Shobra El-Kheima. Born in Cairo. Occupation: pharmacy assistant. Non-smoker, no alcohol. Plays football. Unmarried.',
  patientPersonality: 'Cooperative',
  scenarioPrompt: 'Young man with fever, chills, headache and breathlessness.',
} as unknown as Case;

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function dumpsSymptoms(text: string): boolean {
  return /حمى|سخونية|قشعريرة|صداع|fever|chills|headache|ضيق|تنفس|صدر|أشهر|months|dyspnea/i.test(
    text,
  );
}

console.log('\n=== STT hallucination filters ===\n');

assert(looksLikeSttHallucination('Buch.', true), 'rejects Buch.');
assert(looksLikeSttHallucination('Hello, world!', true), 'rejects Hello world');
assert(looksLikeSttHallucination('Sorry, could you clarify?', true), 'rejects clarify phantom');
assert(looksLikeSttHallucination('um', true), 'rejects um filler');
assert(looksLikeSttHallucination('Hi.', true), 'rejects tiny Hi.');
assert(!looksLikeSttHallucination('I have chest pain for two weeks', true), 'allows real EN speech');
assert(!looksLikeSttHallucination('عندك كام سنة', false), 'allows real AR speech');
assert(looksLikeSttHallucination('اشتركوا في القناة', false), 'rejects subscribe AR');

console.log('\n=== Case import typed TS exports ===\n');

const typedSamples = [
  `export const myCase: Case = {
    id: 'typed-1',
    name: 'Typed Case',
    specialty: 'Medicine',
    difficulty: 'easy',
    time: '10',
    patient: { name: 'Ali', age: 40, gender: 'male', nationality: 'Egyptian', chiefComplaint: 'pain' },
    history: { presentIllness: 'x', pastHistory: 'x', drugHistory: 'x', familyHistory: 'x', socialHistory: 'Occupation: teacher.' },
    examination: {},
    investigations: [],
    diagnosis: { provisional: 'x', differentials: [], management: 'x' },
    checklist: [],
    examinerQuestions: [],
  };`,
  `import type { Case } from './types';
export const myCase: Case = {
    id: 'typed-2',
    name: 'Imported Type',
    specialty: 'Medicine',
    difficulty: 'easy',
    time: '10',
    patient: { name: 'Sara', age: 30, gender: 'female', nationality: 'Egyptian', chiefComplaint: 'fever' },
    history: { presentIllness: 'x', pastHistory: 'x', drugHistory: 'x', familyHistory: 'x', socialHistory: 'x' },
    examination: {},
    investigations: [],
    diagnosis: { provisional: 'x', differentials: [], management: 'x' },
    checklist: [],
    examinerQuestions: [],
  };`,
  `export const myCase: Readonly<Case> = {
    id: 'typed-3',
    name: 'Readonly Case',
    specialty: 'Medicine',
    difficulty: 'easy',
    time: '10',
    patient: { name: 'Omar', age: 22, gender: 'male', nationality: 'Egyptian', chiefComplaint: 'cough' },
    history: { presentIllness: 'x', pastHistory: 'x', drugHistory: 'x', familyHistory: 'x', socialHistory: 'x' },
    examination: {},
    investigations: [],
    diagnosis: { provisional: 'x', differentials: [], management: 'x' },
    checklist: [],
    examinerQuestions: [],
  };`,
];

for (const sample of typedSamples) {
  try {
    const parsed = parseImportedCaseSource(sample);
    assert(!!parsed && typeof parsed === 'object', `parses typed export (${parsed.name || parsed.id})`);
  } catch (err) {
    assert(false, 'parses typed export', err instanceof Error ? err.message : String(err));
  }
}

try {
  parseImportedCaseSource('not a case at all');
  assert(false, 'rejects garbage paste');
} catch {
  assert(true, 'rejects garbage paste');
}

console.log('\n=== VAD silence constants (source) ===\n');
{
  const fs = await import('fs');
  const liveCall = fs.readFileSync(
    path.resolve(__dirname, '../../client/src/hooks/useLivePatientCall.ts'),
    'utf8',
  );
  const browserStt = fs.readFileSync(
    path.resolve(__dirname, '../../client/src/lib/browserStt.ts'),
    'utf8',
  );
  assert(
    /SILENCE_MS = IS_MOBILE \? 2200 : 1800/.test(liveCall),
    'useLivePatientCall SILENCE_MS is 2200/1800',
  );
  assert(
    /LIVE_CALL_SILENCE_MS = IS_MOBILE \? 2200 : 1800/.test(browserStt),
    'browserStt LIVE_CALL_SILENCE_MS is 2200/1800',
  );
}

console.log('\n=== Patient greeting + multipart (mock AI) ===\n');
try {
  const { getPatientResponse } = await import('../src/services/aiService.js');

  const shortSalam = await getPatientResponse(caseData, [], 'السلام عليكم', 'AR');
  console.log('  short:', shortSalam);
  assert(/وعليكم السلام|أهلاً|اهلا/i.test(shortSalam), 'short Salam returns greeting');
  assert(!dumpsSymptoms(shortSalam), 'short Salam does NOT dump symptoms', shortSalam);

  const longSalam = await getPatientResponse(
    caseData,
    [],
    'السلام عليكم ورحمة الله وبركاته',
    'AR',
  );
  console.log('  long:', longSalam);
  assert(/وعليكم السلام|أهلاً|اهلا/i.test(longSalam), 'long Salam returns greeting');
  assert(!dumpsSymptoms(longSalam), 'long Salam does NOT dump symptoms', longSalam);

  const salamDoctor = await getPatientResponse(caseData, [], 'السلام عليكم يا دكتور', 'AR');
  assert(!dumpsSymptoms(salamDoctor), 'Salam يا دكتور does NOT dump symptoms', salamDoctor);

  const hello = await getPatientResponse(caseData, [], 'hello', 'EN');
  assert(/hello|peace/i.test(hello), 'English hello returns greeting', hello);
  assert(!/fever|chills|dyspnea|headache/i.test(hello), 'English hello no symptom dump', hello);

  const multi = await getPatientResponse(
    caseData,
    [{ role: 'STUDENT', content: 'السلام عليكم' }],
    'قولي اسمك وسنك وساكن فين واتولدت فين وشغلك إيه ومتجوز ولا لا',
    'AR',
  );
  console.log('  multi:', multi);
  assert(/طارق|اسمي/i.test(multi), 'multipart includes name', multi);
  assert(/17|سنة/i.test(multi), 'multipart includes age', multi);
  assert(/شبرا|القاهرة|من/i.test(multi), 'multipart includes residence/birth', multi);
  assert(/شغل|pharmacy|بشتغل/i.test(multi), 'multipart includes occupation', multi);
  assert(/متجوز/i.test(multi), 'multipart includes marital', multi);
  assert(
    !/[A-Za-z]{4,}\s+[A-Za-z]{4,}\s+[A-Za-z]{4,}/.test(multi),
    'multipart has no English narrative leak',
    multi,
  );
  assert(!/pharmacy training trip|2-week/i.test(multi), 'multipart no hallucinated English trip', multi);

  const singleName = await getPatientResponse(
    caseData,
    [{ role: 'STUDENT', content: 'السلام عليكم' }],
    'اسمك ايه',
    'AR',
  );
  assert(/اسمي|طارق/i.test(singleName), 'single name question still works', singleName);

  const multiEn = await getPatientResponse(
    caseData,
    [{ role: 'STUDENT', content: 'hello' }],
    'what is your name, how much do you weigh, how old are you and are you married',
    'EN',
  );
  console.log('  multiEn:', multiEn);
  assert(/name is|Tarek/i.test(multiEn), 'EN multipart includes name', multiEn);
  assert(/weigh|kg|weight|not sure/i.test(multiEn), 'EN multipart answers weight', multiEn);
  assert(/17|years old/i.test(multiEn), 'EN multipart includes age', multiEn);
  assert(/married/i.test(multiEn), 'EN multipart includes marital', multiEn);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/openRouterApiKey|does not exist|P2022/i.test(msg)) {
    console.log('  ⚠ Skipping patient AI checks — local DB schema outdated (openRouterApiKey).');
    console.log('    Production live test covers greeting + multipart.');
  } else {
    assert(false, 'patient AI checks threw', msg);
  }
}

console.log('\n=== Summary ===\n');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
