/**
 * End-to-end requirements verification for Synoza Phases 1–3 + final polish.
 * Run: npx tsx scripts/test-all-requirements.ts
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Case } from '@prisma/client';
import {
  parseStationConfig,
  mergeStationConfig,
  resolveManeuverLabel,
  resolveManeuverOpeningMessage,
  getSimulationStages,
  getNextMainStageAfter,
  serializeStationConfig,
  serializePartialStationConfig,
} from '../src/lib/stationConfig.js';
import {
  fixArabicSpeechTranscript,
  isValidArabicSessionTranscript,
  shouldForceArabicTranscription,
  looksLikeSttHallucination,
} from '../src/services/arabicSttFix.js';
import { resolveWhisperLanguage, extractPrimaryUtterance } from '../src/services/transcriptionService.js';
import {
  getVivaClosing,
  studentGaveUp,
  buildExaminerVivaOpening,
  pickVivaQuestionsForSession,
  respondToHistoryVivaAnswer,
  VIVA_QUESTIONS_PER_SESSION,
} from '../src/services/examinerVivaService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===\n`);
}

function fileContains(relPath: string, needles: string[], label: string) {
  const full = resolve(ROOT, relPath);
  if (!existsSync(full)) {
    assert(false, label, `missing file ${relPath}`);
    return;
  }
  const text = readFileSync(full, 'utf8');
  const missing = needles.filter((n) => !text.includes(n));
  assert(missing.length === 0, label, missing.length ? `missing: ${missing.join(', ')}` : undefined);
}

// ─── 1. Live Call & Voice Recording (wiring) ─────────────────────────────────
section('1. Live Call & Voice Recording');
fileContains(
  'client/src/hooks/useLivePatientCall.ts',
  ['postVoiceTurn', 'postTextTurn', 'startBrowserStt'],
  'live call hook wires voice turn + browser STT',
);
fileContains(
  'server/src/routes/sessions.ts',
  ['voice-turn', 'processVoiceTurn', 'processTextTurn'],
  'sessions route exposes voice-turn',
);
fileContains(
  'client/src/lib/speechRecognition.ts',
  ['claimSpeechRecognition', 'releaseSpeechRecognition'],
  'shared mic ownership helpers exist',
);

// ─── 2. AI Latency (complete short replies without mid-sentence cuts) ─────────
section('2. AI Latency budgets');
{
  const ai = readFileSync(resolve(ROOT, 'server/src/services/aiService.ts'), 'utf8');
  const voiceTimeout = /VOICE_TIMEOUT_MS\s*=\s*(\d+)/.exec(ai);
  const chatTimeout = /CHAT_TIMEOUT_MS\s*=\s*(\d+)/.exec(ai);
  assert(!!voiceTimeout && Number(voiceTimeout[1]) <= 5000, `voice timeout ≤5000ms`, voiceTimeout?.[1]);
  assert(!!voiceTimeout && Number(voiceTimeout[1]) >= 2500, `voice timeout ≥2500ms for complete replies`, voiceTimeout?.[1]);
  assert(!!chatTimeout && Number(chatTimeout[1]) <= 6000, `chat timeout ≤6000ms`, chatTimeout?.[1]);
  assert(ai.includes('callOpenAIStream'), 'streaming completion path exists');
  assert(ai.includes('stream: true'), 'live turns request streaming');
  assert(ai.includes('formatPatientBehaviorPrompt') || ai.includes('STATION PATIENT BEHAVIOR') || ai.includes('patientBehavior'), 'patient behavior wired into AI prompts');
  // Knowledge-first patient policy seeded into every prompt (chat + voice)
  assert(ai.includes('PATIENT_KNOWLEDGE_FIRST_RULES'), 'knowledge-first patient rules constant defined');
  const coreMatches = ai.match(/\$\{PATIENT_KNOWLEDGE_FIRST_RULES\}/g) || [];
  assert(coreMatches.length >= 2, 'knowledge-first rules injected into both chat and voice prompts', String(coreMatches.length));
  assert(ai.includes('PATIENT RESPONSE POLICY (knowledge-first)'), 'knowledge-first rules block header present');
  for (const rule of [
    'Answer ONLY from CASE BACKGROUND',
    'ADMIN AI KNOWLEDGE',
    'do NOT guess',
    "I'm not feeling well right now, doctor",
    'Respect biological reality',
    'Never invent symptoms',
  ]) {
    assert(ai.includes(rule), `knowledge-first rule present: ${rule}`);
  }
}

// ─── 3. Bilingual / code-switching STT ───────────────────────────────────────
section('3. Bilingual / code-switching STT');
assert(resolveWhisperLanguage('auto') === 'auto', 'Whisper AUTO omits forced language');
assert(resolveWhisperLanguage('ar-EG') === 'ar', 'Whisper AR maps to ar');
assert(resolveWhisperLanguage('en-US') === 'en', 'Whisper EN maps to en');
assert(shouldForceArabicTranscription('AR') === true, 'AR forces Arabic STT');
assert(shouldForceArabicTranscription('AUTO') === false, 'AUTO does not force Arabic');
assert(shouldForceArabicTranscription('EN') === false, 'EN does not force Arabic');
assert(
  isValidArabicSessionTranscript('عندي chest pain من أسبوعين', false),
  'mixed AR+EN accepted in AUTO/EN',
);
assert(
  isValidArabicSessionTranscript('I have chest pain for two weeks', false),
  'pure English accepted in AUTO/EN',
);
assert(
  !isValidArabicSessionTranscript('I have chest pain for two weeks', true),
  'pure English rejected in forced AR',
);
assert(
  fixArabicSpeechTranscript("what's your name?", false, true) === 'اسمك إيه',
  'AUTO code-switch maps known EN mishearing to Arabic',
);
assert(
  fixArabicSpeechTranscript("what's your name?", false, false) === "what's your name?",
  'EN mode keeps English phrase',
);
assert(!looksLikeSttHallucination('Hello doctor how are you', true), 'Latin allowed when code-switch');
assert(
  extractPrimaryUtterance('Hello doctor. What is your name?', true).toLowerCase().includes('name'),
  'English utterance survives extractPrimaryUtterance',
);
assert(
  extractPrimaryUtterance('wat is your neym doctor', true).toLowerCase().includes('neym') ||
    extractPrimaryUtterance('wat is your neym doctor', true).toLowerCase().includes('name'),
  'accented imperfect English accepted',
);
fileContains(
  'client/src/components/SpeechLanguageToggle.tsx',
  ['AUTO', 'AR', 'EN'],
  'SpeechLanguageToggle has Auto/AR/EN',
);
fileContains(
  'server/src/services/localWhisperSttService.ts',
  ["lang === 'auto'", 'arabic', 'english'],
  'local Whisper AUTO tries Arabic then English',
);

// ─── 4–8. Examiner viva logic ────────────────────────────────────────────────
section('4–8. Examiner viva / grading / closing');
{
  const tarek = {
    id: 'case-tarek',
    titleEn: 'Rheumatic Valvular Heart Disease',
    finalDiagnosis: 'severe aortic stenosis',
  } as Case;
  const qs = pickVivaQuestionsForSession('sess-req-1', tarek);
  assert(qs.length === VIVA_QUESTIONS_PER_SESSION, 'picks viva questions');
  const opening = buildExaminerVivaOpening('sess-req-1', tarek);
  assert(!/Question\s+\d+\s+of\s+\d+/i.test(opening), 'no question numbering in opening');
  assert(studentGaveUp("I don't know"), 'IDK English detected');
  assert(studentGaveUp('مش عارف'), 'IDK Arabic detected');
  assert(getVivaClosing('AR').includes('بالتوفيق'), 'Arabic closing has بالتوفيق');
  assert(/good luck|بالتوفيق/i.test(getVivaClosing('EN')), 'English closing is a goodbye');

  const shuntSample = `Causes of a left-to-right shunt include:
- Ventricular septal defect (VSD).
- Atrial septal defect (ASD).
- Patent ductus arteriosus (PDA).`;
  const vsdCase = {
    id: 'case-vsd-req',
    titleEn: 'VSD',
    finalDiagnosis: 'VSD',
    examinerQuestions: JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        id: `q${i + 1}`,
        question: 'What are the causes of a left-to-right shunt?',
        sampleAnswer: shuntSample,
      })),
    ),
  } as Case;
  const vsdOpening = buildExaminerVivaOpening('sess-vsd-req', vsdCase);
  const vsdMsgs = [{ role: 'EXAMINER', stage: 'history:examiner', content: vsdOpening }];
  const partial = await respondToHistoryVivaAnswer(
    'sess-vsd-req',
    vsdCase,
    vsdMsgs,
    'history:examiner',
    'Atrial septal defect (ASD)',
  );
  assert(
    /good|correct/i.test(partial) && /VSD|PDA|ventricular|patent/i.test(partial),
    'partial answer gets progressive feedback',
    partial.slice(0, 160),
  );

  const giveUp = await respondToHistoryVivaAnswer(
    'sess-req-giveup',
    tarek,
    [{ role: 'EXAMINER', stage: 'history:examiner', content: opening }],
    'history:examiner',
    "I don't know",
  );
  assert(
    giveUp.length > 20 && !/Question\s+\d+\s+of/i.test(giveUp),
    'IDK path reveals/advances without numbering',
    giveUp.slice(0, 140),
  );
}

// Examination IDK / partial credit wiring
{
  const ai = readFileSync(resolve(ROOT, 'server/src/services/aiService.ts'), 'utf8');
  assert(ai.includes('studentGaveUpAnswer'), 'examination has IDK handler');
  assert(ai.includes('PARTIAL CREDIT'), 'examination prompts require partial credit');
  assert(ai.includes('getManeuverExaminerResponse'), 'maneuver examiner path exists');
}

fileContains(
  'server/src/routes/sessions.ts',
  ['getManeuverExaminerResponse', 'respondToHistoryVivaAnswer', 'getExaminerVivaResponse'],
  'sessions branches examination vs history viva',
);

// ─── 9. Learn with Examiner ──────────────────────────────────────────────────
section('9. Learn with your Examiner');
fileContains(
  'client/src/pages/SimulationPage.tsx',
  ['learnWithExaminer', 'handleLearnWithExaminer'],
  'SimulationPage has Learn with Examiner',
);
fileContains(
  'client/src/i18n/index.ts',
  ['learnWithExaminer:', 'learnWithExaminerRequest:'],
  'i18n strings for Learn with Examiner',
);

// ─── 10. Language switcher UI ────────────────────────────────────────────────
section('10. Language switcher UI');
fileContains(
  'client/src/pages/SimulationPage.tsx',
  ['SpeechLanguageToggle', 'setLang', 'LiveCall'],
  'toggle next to live call wiring',
);
fileContains(
  'server/src/routes/sessions.ts',
  ['/language', 'AUTO', 'AR', 'EN'],
  'PATCH session language endpoint',
);

// ─── 11. Welcome text / maneuver openings ────────────────────────────────────
section('11. Welcome text control');
{
  const cfg = parseStationConfig(
    JSON.stringify({
      enabledManeuvers: ['inspection'],
      maneuverOpeningMessages: { inspection: 'Custom welcome for Inspection station.' },
    }),
  );
  assert(
    resolveManeuverOpeningMessage('inspection', cfg).includes('Custom welcome'),
    'custom opening message resolved',
  );
  fileContains(
    'client/src/components/admin/AdminCasesTab.tsx',
    ['maneuverOpeningMessages', 'adminCaseManeuverOpeningMessages'],
    'admin UI for opening messages',
  );
}

// ─── 12–17. Admin case UX ────────────────────────────────────────────────────
section('12–17. Admin case UX');
fileContains(
  'client/src/components/admin/AdminCasesTab.tsx',
  [
    'categoryFilter',
    'groupedCases',
    'pagedGroups',
    'form.titleEn.trim()',
    'cancelEdit()',
    'maneuverLabels',
    'stageOrder',
    'undoFormChange',
    'formHistory',
  ],
  'admin cases: category/group, dynamic title, reset, labels, stageOrder, undo',
);

{
  const custom = parseStationConfig(
    JSON.stringify({
      enabledManeuvers: ['inspection', 'palpation'],
      stageOrder: ['examination', 'history', 'diagnosis', 'investigations'],
      enableInvestigations: false,
      maneuverLabels: { inspection: { en: 'Look', ar: 'شوف' } },
    }),
  );
  assert(resolveManeuverLabel('inspection', custom, 'en') === 'Look', 'custom EN label');
  assert(resolveManeuverLabel('inspection', custom, 'ar') === 'شوف', 'custom AR label');
  assert(custom.stageOrder[0] === 'examination', 'custom stageOrder preserved');
  const stages = getSimulationStages(custom);
  assert(!stages.includes('investigations'), 'investigations skipped when disabled');
  assert(getNextMainStageAfter('examination', custom) === 'history', 'next stage follows custom order');

  const merged = mergeStationConfig(custom, {
    stageOrder: ['diagnosis', 'history', 'examination', 'investigations'],
    maneuverLabels: { palpation: { en: 'Feel', ar: 'حس' } },
  });
  assert(merged.stageOrder[0] === 'diagnosis', 'university override stageOrder merges');
  assert(resolveManeuverLabel('palpation', merged, 'en') === 'Feel', 'override label merges');
  assert(serializeStationConfig(merged).includes('maneuverLabels'), 'serialize keeps labels');
  assert(serializePartialStationConfig({ stageOrder: merged.stageOrder }).includes('stageOrder'), 'partial serialize');
}

// ─── 18. Case deletion ───────────────────────────────────────────────────────
section('18. Case deletion');
fileContains(
  'server/src/routes/adminCases.ts',
  [
    'message.deleteMany',
    'result.deleteMany',
    'aiUsageLog.deleteMany',
    'session.deleteMany',
    'caseUniversityOverride.deleteMany',
    'caseAccess.deleteMany',
    'aiKnowledgeEntry.deleteMany',
    'case.delete',
  ],
  'delete clears all dependent rows',
);
fileContains(
  'server/prisma/schema.mysql.prisma',
  ['onDelete: Cascade'],
  'MySQL schema has Session→Case cascade',
);

// ─── 19–20. Save toast / single Save ─────────────────────────────────────────
section('19–20. Save confirmation & single Save');
fileContains('client/src/lib/toast.ts', ['showToast', 'subscribeToToasts'], 'toast helper');
fileContains('client/src/i18n/index.ts', ['toastSaved:'], 'toastSaved i18n key');
fileContains('client/src/components/ToastContainer.tsx', ['ToastContainer'], 'toast UI');
fileContains('client/src/lib/api.ts', ['toastSaved', 'showToast'], 'API interceptor toasts saves');
{
  const admin = readFileSync(resolve(ROOT, 'client/src/components/admin/AdminCasesTab.tsx'), 'utf8');
  const saveButtons = admin.match(/onClick=\{saveCase\}/g) || [];
  assert(saveButtons.length === 1, 'exactly one saveCase button', String(saveButtons.length));
}

// ─── 21. University Qbank ────────────────────────────────────────────────────
section('21. University-specific Qbank');
fileContains(
  'server/src/lib/universityScope.ts',
  ['qbankModuleUniversityFilter', 'university'],
  'universityScope filter helpers',
);
fileContains(
  'client/src/components/admin/AdminQbankTab.tsx',
  ['universityIds', 'adminQbankModuleUniversities'],
  'admin qbank university UI',
);

// ─── 22. Pricing tiers ───────────────────────────────────────────────────────
section('22. Pricing tiers layout');
fileContains(
  'client/src/i18n/index.ts',
  ['planTier0', 'planTier1', 'planTier2', 'planTier3', 'planNameFree', 'planNameBasic', 'planNamePro', 'planNamePremium'],
  'pricing tier i18n keys',
);
fileContains(
  'client/src/components/SubscriptionPlansSection.tsx',
  ['planTier', 'PACKAGE_', 'Free'],
  'subscription plans section',
);

// ─── Extra polish checks ─────────────────────────────────────────────────────
section('Polish');
fileContains('client/src/i18n/index.ts', ['examinerBox: "صندوق الممتحن"'], 'AR examinerBox fixed');
assert(
  extractPrimaryUtterance('اسمك إيه؟ عندك كام سنة؟').includes('سنة') ||
    extractPrimaryUtterance('اسمك إيه؟ عندك كام سنة؟').includes('كام'),
  'primary utterance keeps last question',
);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n=== Summary ===\n');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
