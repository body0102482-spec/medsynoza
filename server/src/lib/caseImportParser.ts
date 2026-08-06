export interface ImportedCaseObject {
  id?: string;
  name?: string;
  specialty?: string;
  difficulty?: string;
  time?: string;
  patient?: {
    name?: string;
    age?: number;
    gender?: string;
    occupation?: string;
    nationality?: string;
    chiefComplaint?: string;
    vitals?: Record<string, string | undefined>;
  };
  history?: {
    presentIllness?: string;
    pastHistory?: string;
    drugHistory?: string;
    familyHistory?: string;
    socialHistory?: string;
  };
  examination?: {
    inspection?: string;
    inspectionImage?: string;
    palpation?: string;
    palpationVideo?: string;
    percussion?: string;
    auscultation?: string;
    auscultationAudio?: string;
    specialTests?: Array<{ name?: string; finding?: string }>;
  };
  investigations?: Array<{ name?: string; result?: string; title?: string; content?: string }>;
  diagnosis?: {
    provisional?: string;
    differentials?: string[];
    management?: string;
  };
  checklist?: Array<{ item?: string; category?: string }>;
  examinerQuestions?: Array<{ id?: string; question?: string; sampleAnswer?: string }>;
}

export interface ExaminerQuestionForm {
  id: string;
  question: string;
  sampleAnswer: string;
}

export interface CaseImportLookups {
  specialties: Array<{ id: string; nameEn: string }>;
  difficulties: Array<{ id: string; nameEn: string; level?: number }>;
  defaultSpecialtyId?: string;
  defaultDifficultyId?: string;
  defaultCategoryId?: string;
}

export interface CaseImportResult {
  titleEn: string;
  titleAr: string;
  specialtyId: string;
  difficultyId: string;
  categoryId: string;
  patientName: string;
  patientAge: number;
  patientGender: string;
  patientNationality: string;
  chiefComplaint: string;
  medicalHistory: string;
  medicationHistory: string;
  surgicalHistory: string;
  familyHistory: string;
  socialHistory: string;
  patientPersonality: string;
  scenarioPrompt: string;
  finalDiagnosis: string;
  teachingPoints: string;
  vitalSigns: {
    bpValue: string;
    bpNote: string;
    hrValue: string;
    hrNote: string;
    rrValue: string;
    rrNote: string;
    tempValue: string;
    tempNote: string;
    spo2Value: string;
    spo2Note: string;
  };
  physicalExam: {
    inspection: string;
    palpation: string;
    percussion: string;
    auscultation: string;
  };
  examImages: Array<{
    id: string;
    url: string;
    caption: string;
    captionAr: string;
    maneuver: 'inspection' | 'palpation' | 'percussion' | 'auscultation' | '';
    mediaType: 'image' | 'video' | 'audio';
  }>;
  labSections: Array<{
    id: string;
    title: string;
    titleAr: string;
    content: string;
    contentAr: string;
  }>;
  rubricItems: Array<{ id: string; item: string; category: string }>;
  examinerQuestions: ExaminerQuestionForm[];
}

function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizePastedSource(source: string): string {
  return source
    .replace(/\uFEFF/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\r\n/g, '\n');
}

function stripLeadingImports(source: string): string {
  let rest = source.trim();
  const importPattern =
    /^import\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+['"][^'"]+['"]|['"][^'"]+['"])\s*;?\s*/;
  while (importPattern.test(rest)) {
    rest = rest.replace(importPattern, '').trim();
  }
  return rest;
}

function stripExportWrapper(source: string): string {
  let rest = source.trim();
  // Strip `export const/let/var name: ComplexType =` including generics, unions, imports.
  rest = rest.replace(
    /^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::\s*[^=;{]+)?\s*=\s*(?:as\s+const\s+)?/m,
    '',
  );
  rest = rest.replace(/^export\s+default\s+/m, '');
  // Trailing TypeScript assertions / satisfies after the object.
  rest = rest.replace(/\s+satisfies\s+[\w.<>,\s|&[\]()'"`]+?\s*;?\s*$/m, '');
  rest = rest.replace(/\s+as\s+(?:const|[\w.<>,\s|&[\]()]+)\s*;?\s*$/m, '');
  rest = rest.replace(/;\s*$/, '');
  return rest.trim();
}

function findCaseObjectStart(source: string): number {
  const assignMatch = source.match(/=\s*\{/);
  if (assignMatch && assignMatch.index != null) {
    return source.indexOf('{', assignMatch.index);
  }
  // Bare object literal, or leftover after stripping typed export.
  const bare = source.match(/^\s*\{/);
  if (bare && bare.index != null) return source.indexOf('{', bare.index);
  return source.indexOf('{');
}

function extractObjectLiteral(source: string): string {
  const start = findCaseObjectStart(source);
  if (start === -1) {
    throw new Error('No case object found. Paste export const myCase = { ... };');
  }
  return source.slice(start);
}

function prepareObjectLiteral(source: string): string {
  const normalized = normalizePastedSource(source);
  const withoutImports = stripLeadingImports(normalized);
  const stripped = stripExportWrapper(withoutImports);
  return extractObjectLiteral(stripped);
}

type Bracket = '{' | '[';

function scanBracketState(source: string): Bracket[] {
  const stack: Bracket[] = [];
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') stack.push('{');
    if (ch === '[') stack.push('[');
    if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
    if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
  }

  return stack;
}

/** Auto-close truncated paste (missing trailing brackets). */
function tryCloseObjectLiteral(source: string): string | null {
  const stack = scanBracketState(source);
  if (stack.length === 0) return null;

  const closers: Record<Bracket, string> = { '{': '}', '[': ']' };
  const trimmed = source.replace(/,\s*$/, '');
  const suffix = [...stack].reverse().map((b) => closers[b]).join('');
  return `${trimmed}${suffix}`;
}

function evaluateObjectLiteral(literal: string): unknown {
  const runner = new Function(`"use strict"; return (${literal});`);
  return runner();
}

export function parseImportedCaseSource(source: string): ImportedCaseObject {
  const trimmed = source.trim();
  if (!trimmed) throw new Error('Paste a case object first.');

  let objectLiteral: string;
  try {
    objectLiteral = prepareObjectLiteral(trimmed);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'No case object found.');
  }

  const closed = tryCloseObjectLiteral(objectLiteral);
  const candidates = [objectLiteral, closed].filter(
    (value, index, arr): value is string => !!value && arr.indexOf(value) === index,
  );

  let parsed: unknown;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      parsed = evaluateObjectLiteral(candidate);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (parsed === undefined) {
    const syntaxDetail =
      lastError instanceof Error && lastError.message
        ? ` (${lastError.message.split('\n')[0]})`
        : '';
    console.warn('[case import] parse failed', lastError);
    throw new Error(
      `Could not parse the case object. Check quotes, commas, and brackets.${syntaxDetail} Paste the full export const myCase = { ... }; including the closing };`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Parsed value is not a case object.');
  }

  return parsed as ImportedCaseObject;
}

function parseVitalString(raw: string): { value: string; note: string } {
  const text = raw.trim();
  const match = text.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (match) return { value: match[1].trim(), note: match[2].trim() };
  return { value: text, note: '' };
}

function normalizeMediaUrl(raw: string): string {
  const path = raw.trim();
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('/exam/')) return path;
  if (path.startsWith('/')) return path;
  return `/${path.replace(/^\.?\//, '')}`;
}

function splitMediaPaths(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((part) => normalizeMediaUrl(part))
    .filter(Boolean);
}

function resolveSpecialtyId(name: string | undefined, lookups: CaseImportLookups): string {
  if (!name?.trim()) return lookups.defaultSpecialtyId ?? lookups.specialties[0]?.id ?? '';
  const lower = name.trim().toLowerCase();
  const match = lookups.specialties.find((s) => s.nameEn.toLowerCase() === lower);
  return match?.id ?? lookups.defaultSpecialtyId ?? lookups.specialties[0]?.id ?? '';
}

function resolveDifficultyId(name: string | undefined, lookups: CaseImportLookups): string {
  if (!name?.trim()) return lookups.defaultDifficultyId ?? lookups.difficulties[0]?.id ?? '';
  const lower = name.trim().toLowerCase();
  const aliasLevel =
    lower.includes('hard') || lower.includes('advanced') || lower.includes('difficult')
      ? 3
      : lower.includes('easy') || lower.includes('beginner')
        ? 1
        : lower.includes('inter') || lower.includes('medium')
          ? 2
          : null;

  const byName = lookups.difficulties.find((d) => d.nameEn.toLowerCase() === lower);
  if (byName) return byName.id;

  if (aliasLevel != null) {
    const byLevel = lookups.difficulties.find((d) => d.level === aliasLevel);
    if (byLevel) return byLevel.id;
  }

  return lookups.defaultDifficultyId ?? lookups.difficulties[0]?.id ?? '';
}

function buildScenarioPrompt(data: ImportedCaseObject): string {
  const patient = data.patient ?? {};
  const history = data.history ?? {};
  const diagnosis = data.diagnosis?.provisional ?? '';
  const lines = [
    `You are ${patient.name ?? 'the patient'}, ${patient.age ?? ''} years old, ${patient.gender ?? ''}.`,
    patient.occupation ? `Occupation: ${patient.occupation}.` : '',
    patient.chiefComplaint ? `Chief complaint: ${patient.chiefComplaint}` : '',
    history.presentIllness ? `Present illness: ${history.presentIllness}` : '',
    history.pastHistory ? `Past history: ${history.pastHistory}` : '',
    history.drugHistory ? `Medications: ${history.drugHistory}` : '',
    history.familyHistory ? `Family history: ${history.familyHistory}` : '',
    history.socialHistory ? `Social history: ${history.socialHistory}` : '',
    diagnosis ? `Hidden diagnosis (never reveal): ${diagnosis}` : '',
    'Answer only what the doctor asks. Use natural Egyptian Arabic when the student uses Arabic.',
  ];
  return lines.filter(Boolean).join('\n');
}

function buildTeachingPoints(data: ImportedCaseObject): string {
  const diagnosis = data.diagnosis;
  const parts: string[] = [];
  if (diagnosis?.management?.trim()) parts.push(`Management: ${diagnosis.management.trim()}`);
  if (diagnosis?.differentials?.length) {
    parts.push(`Differentials: ${diagnosis.differentials.join('; ')}`);
  }
  if (data.time?.trim()) parts.push(`Suggested station time: ${data.time.trim()}`);
  return parts.join('\n\n');
}

function buildExamImages(examination: ImportedCaseObject['examination']): CaseImportResult['examImages'] {
  if (!examination) return [];
  const rows: CaseImportResult['examImages'] = [];

  for (const url of splitMediaPaths(examination.inspectionImage)) {
    rows.push({
      id: newId('media'),
      url,
      caption: 'Inspection finding',
      captionAr: 'نتيجة الفحص البصري',
      maneuver: 'inspection',
      mediaType: 'image',
    });
  }

  for (const url of splitMediaPaths(examination.palpationVideo)) {
    rows.push({
      id: newId('media'),
      url,
      caption: 'Palpation',
      captionAr: 'الجس',
      maneuver: 'palpation',
      mediaType: 'video',
    });
  }

  for (const url of splitMediaPaths(examination.auscultationAudio)) {
    rows.push({
      id: newId('media'),
      url,
      caption: 'Auscultation',
      captionAr: 'الاستماع',
      maneuver: 'auscultation',
      mediaType: 'audio',
    });
  }

  return rows;
}

export function importedCaseToForm(
  data: ImportedCaseObject,
  lookups: CaseImportLookups,
): CaseImportResult {
  const patient = data.patient ?? {};
  const history = data.history ?? {};
  const examination = data.examination ?? {};
  const vitals = patient.vitals ?? {};

  const bp = parseVitalString(String(vitals.bp ?? ''));
  const hr = parseVitalString(String(vitals.hr ?? ''));
  const rr = parseVitalString(String(vitals.rr ?? ''));
  const temp = parseVitalString(String(vitals.temp ?? ''));
  const spo2 = parseVitalString(String(vitals.oxygen ?? vitals.spo2 ?? ''));

  const socialParts = [history.socialHistory?.trim() ?? ''];
  if (patient.occupation?.trim() && !socialParts[0].toLowerCase().includes(patient.occupation.toLowerCase())) {
    socialParts.push(`Occupation: ${patient.occupation.trim()}.`);
  }

  const medicalHistory = [history.presentIllness, history.pastHistory].filter(Boolean).join('\n\n');
  const surgicalHistory =
    history.pastHistory?.match(/surg/i) ? history.pastHistory : 'See past medical history in medical history section.';

  const specialTests = examination.specialTests ?? [];
  const specialTestsText = specialTests
    .map((test) => {
      const name = String(test.name ?? '').trim();
      const finding = String(test.finding ?? '').trim();
      if (!name && !finding) return '';
      return name && finding ? `${name}: ${finding}` : name || finding;
    })
    .filter(Boolean)
    .join('\n');
  const auscultationParts = [examination.auscultation?.trim(), specialTestsText].filter(Boolean);

  return {
    titleEn: data.name?.trim() || 'Untitled case',
    titleAr: data.name?.trim() || '',
    specialtyId: resolveSpecialtyId(data.specialty, lookups),
    difficultyId: resolveDifficultyId(data.difficulty, lookups),
    categoryId: lookups.defaultCategoryId ?? '',
    patientName: patient.name?.trim() || '',
    patientAge: Number(patient.age) || 0,
    patientGender: patient.gender?.trim() || '',
    patientNationality: patient.nationality?.trim() || 'Egyptian',
    chiefComplaint: patient.chiefComplaint?.trim() || '',
    medicalHistory,
    medicationHistory: history.drugHistory?.trim() || '',
    surgicalHistory,
    familyHistory: history.familyHistory?.trim() || '',
    socialHistory: socialParts.filter(Boolean).join('\n'),
    patientPersonality:
      'Cooperative patient. Answer naturally in Egyptian Arabic when the student uses Arabic. Do not volunteer the diagnosis.',
    scenarioPrompt: buildScenarioPrompt(data),
    finalDiagnosis: data.diagnosis?.provisional?.trim() || '',
    teachingPoints: buildTeachingPoints(data),
    vitalSigns: {
      bpValue: bp.value,
      bpNote: bp.note,
      hrValue: hr.value,
      hrNote: hr.note,
      rrValue: rr.value,
      rrNote: rr.note,
      tempValue: temp.value,
      tempNote: temp.note,
      spo2Value: spo2.value,
      spo2Note: spo2.note,
    },
    physicalExam: {
      inspection: examination.inspection?.trim() || '',
      palpation: examination.palpation?.trim() || '',
      percussion: examination.percussion?.trim() || '',
      auscultation: auscultationParts.join('\n\n'),
    },
    examImages: buildExamImages(examination),
    labSections: (data.investigations ?? []).map((row, index) => ({
      id: newId('lab'),
      title: String(row.name ?? row.title ?? `Investigation ${index + 1}`),
      titleAr: '',
      content: String(row.result ?? row.content ?? ''),
      contentAr: '',
    })),
    rubricItems: (data.checklist ?? []).map((row, index) => ({
      id: newId('rubric'),
      item: String(row.item ?? '').trim(),
      category: String(row.category ?? 'History').trim() || 'History',
    })),
    examinerQuestions: (data.examinerQuestions ?? []).map((row, index) => ({
      id: String(row.id ?? newId(`viva-${index}`)),
      question: String(row.question ?? '').trim(),
      sampleAnswer: String(row.sampleAnswer ?? '').trim(),
    })),
  };
}

export function parseAndMapImportedCase(source: string, lookups: CaseImportLookups): CaseImportResult {
  const data = parseImportedCaseSource(source);
  return importedCaseToForm(data, lookups);
}
