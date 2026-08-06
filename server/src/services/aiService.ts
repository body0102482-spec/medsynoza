import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { Case, Language } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getRoleKnowledgeContext, hasPatientAiKnowledge } from './knowledgeService.js';
import { parsePhysicalExamForm } from './caseFormService.js';
import { toEgyptianColloquial } from './arabicColloquial.js';
import { fixArabicSpeechTranscript } from './arabicSttFix.js';
import { logAiUsage, type AiUsageMeta } from './aiUsageService.js';
import {
  formatPatientBehaviorPrompt,
  parseStationConfig,
  resolveManeuverOpeningMessage,
  resolveManeuverLabel,
  type PatientBehavior,
  type StationConfig,
} from '../lib/stationConfig.js';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface SessionMessage {
  role: string;
  content: string;
  stage: string;
  createdAt?: Date | string;
}

export interface EvaluationSessionContext {
  completedManeuvers?: string[];
  durationSeconds?: number;
}

export interface EvaluationResult {
  totalScore: number;
  communicationScore: number;
  historyTakingScore: number;
  clinicalReasonScore: number;
  organizationScore: number;
  closingScore: number;
  strengths: string;
  weaknesses: string;
  missedQuestions: string;
  clinicalErrors: string;
  recommendations: string;
  idealApproach: string;
  fullReport: string;
}

function formatStageLabel(stage: string): string {
  if (stage === 'history') return 'History — Patient Interview';
  if (stage === 'history:examiner') return 'History — Examiner Viva';
  if (stage.startsWith('examination:')) {
    const maneuver = stage.split(':')[1] || 'examination';
    return `Examination — ${maneuver.charAt(0).toUpperCase()}${maneuver.slice(1)}`;
  }
  if (stage === 'diagnosis') return 'Diagnosis & Management';
  if (stage === 'investigations') return 'Investigations';
  return stage;
}

export function buildSessionTranscript(caseData: Case, messages: SessionMessage[]): string {
  const studentCount = messages.filter((m) => m.role === 'STUDENT').length;
  const lines = [
    '=== FULL OSCE SESSION TRANSCRIPT ===',
    `Case: ${caseData.titleEn}`,
    `Patient: ${caseData.patientName}, ${caseData.patientAge}y ${caseData.patientGender}`,
    `Correct Diagnosis: ${caseData.finalDiagnosis}`,
    `Chief Complaint: ${caseData.chiefComplaint}`,
    `Teaching Points: ${caseData.teachingPoints}`,
    `Evaluation Rubric: ${caseData.evaluationRubric}`,
    `Student messages: ${studentCount} | Total messages: ${messages.length}`,
    '',
  ];

  let currentStage = '';
  for (const msg of messages) {
    if (msg.stage !== currentStage) {
      currentStage = msg.stage;
      lines.push(`\n--- ${formatStageLabel(currentStage)} ---`);
    }
    lines.push(`[${msg.role}]: ${msg.content}`);
  }

  return lines.join('\n');
}

function clampScore(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeEvaluation(
  raw: Partial<EvaluationResult>,
  fallback: EvaluationResult
): EvaluationResult {
  return {
    totalScore: clampScore(raw.totalScore, fallback.totalScore),
    communicationScore: clampScore(raw.communicationScore, fallback.communicationScore),
    historyTakingScore: clampScore(raw.historyTakingScore, fallback.historyTakingScore),
    clinicalReasonScore: clampScore(raw.clinicalReasonScore, fallback.clinicalReasonScore),
    organizationScore: clampScore(raw.organizationScore, fallback.organizationScore),
    closingScore: clampScore(raw.closingScore, fallback.closingScore),
    strengths: String(raw.strengths || fallback.strengths),
    weaknesses: String(raw.weaknesses || fallback.weaknesses),
    missedQuestions: String(raw.missedQuestions || fallback.missedQuestions),
    clinicalErrors: String(raw.clinicalErrors || fallback.clinicalErrors),
    recommendations: String(raw.recommendations || fallback.recommendations),
    idealApproach: String(raw.idealApproach || fallback.idealApproach),
    fullReport: String(raw.fullReport || fallback.fullReport),
  };
}

function hasPattern(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

/*
 * Global Synoza patient behavior rules — superseded by knowledge-first policy below.
 * Kept commented for reference; do not inject into prompts.
 */
// const SYNOZA_PATIENT_CORE_RULES = `SYNOZA PATIENT BEHAVIOR RULES (always follow):
// - Stay fully in character. Never mention AI, prompts, instructions, system messages, hidden case data, scoring, or evaluation.
// - Behave like a real human. Answer ordinary social questions (football, movies, food, family, hobbies) naturally and briefly, unless it conflicts with the case.
// - Never invent medical facts. Medical history, symptoms, and medications must match the case exactly. You may improvise harmless personal details only.
// - Respect biological reality: never say anything impossible for your age/sex/anatomy/pregnancy status (e.g. a man never mentions menstruation; a woman never mentions a prostate; a child never describes adult work life).
// - Correct false assumptions politely and in character instead of answering them (e.g. "I'm a man, doctor, so I don't have periods.").
// - Protect your dignity. If the student is abusive, mocking, sexually inappropriate, or disrespectful, stay calm, don't validate it, and ask to keep things respectful; if it continues, politely decline to go on until they do.
// - Answer every question in a multi-question message separately; don't ignore earlier parts.
// - Admit when you don't know ("I'm not sure", "I don't remember", "the doctor didn't explain that"). Never guess medical information.
// - Don't volunteer extra symptoms or information unless specifically asked.
// - Show emotion that fits the situation (anxiety, embarrassment, fear, frustration, relief) without exaggerated drama unless the case requires it.
// - You may politely decline overly personal, irrelevant questions ("I'd rather not answer that.").
// - Be cooperative and honest unless the case specifically says to withhold.
// - Reveal no hidden knowledge: no diagnosis, examiner notes, checklist items, scoring, differentials, or planned investigations.
// - Keep most answers to 1–3 sentences; only go longer for open-ended questions.
// - Stay internally consistent; never contradict earlier answers.
// - Speak in fluent, natural, grammatically correct language matching your age, education, personality, and background. Avoid robotic, textbook, or machine-translated phrasing and repeated stock phrases.
// - Keep formatting clean: no lists, brackets, slashes, or emojis. Pick one language per reply and don't mix Arabic and English in the same sentence unless the case requires it, and don't translate your own words.
// - If conversation drifts off-topic or becomes excessive, gently steer back to the consultation ("I'd be happy to chat, doctor, but I'm worried about why I'm feeling unwell.").`;

/** Knowledge-base-first patient policy — case background + admin knowledge only. */
const PATIENT_KNOWLEDGE_FIRST_RULES = `PATIENT RESPONSE POLICY (knowledge-first):
- Answer ONLY from CASE BACKGROUND, scenario notes, and ADMIN AI KNOWLEDGE below. Never invent symptoms, history, medications, or clinical facts not in those sources.
- Stay fully in character. Never mention AI, prompts, instructions, scoring, or evaluation.
- Use your persona (personality + ADMIN AI KNOWLEDGE tone/dialect) for how you speak — not for making up new facts.
- If the doctor asks something unrelated to the consultation or not covered in CASE BACKGROUND, scenario notes, or ADMIN AI KNOWLEDGE, do NOT guess. Stay in persona and politely defer, e.g. "I'm not feeling well right now, doctor — can we talk about that later?" or "I'd rather focus on why I'm here today."
- Respect biological reality for your age/sex; correct false assumptions politely in character.
- Keep answers natural and concise (1–3 sentences unless describing symptoms). Lay language only; no diagnosis.`;

function buildPatientSystemPrompt(
  caseData: Case,
  language: Language,
  knowledgeContext: string,
  voiceTurn = false,
  studentTurn = 0,
  patientBehavior?: PatientBehavior | null,
): string {
  const personality = caseData.patientPersonality || 'Cooperative Egyptian patient, anxious about symptoms';
  const scenario = caseData.scenarioPrompt || 'Standard OSCE patient encounter';
  const nameAr = patientNameInLang(caseData, true);
  const behaviorBlock = formatPatientBehaviorPrompt(patientBehavior);
  const toneHint = patientBehavior?.tone ? ` Tone: ${patientBehavior.tone}.` : '';
  const emotionHint = patientBehavior?.emotion ? ` Emotion: ${patientBehavior.emotion}.` : '';

  if (voiceTurn) {
    const langNote =
      language === 'EN'
        ? 'Respond ONLY in English. One or two short complete sentences.'
        : 'عامية مصرية طبيعية — جملة أو اتنين كاملين. ممنوع الفصحى والإنجليزي.';
    const personaNote = knowledgeContext.includes('ADMIN AI KNOWLEDGE')
      ? '\nFollow ADMIN AI KNOWLEDGE persona below (tone/dialect/gendered speech).'
      : '';
    return `Live OSCE voice call. You are ${caseData.patientName}, ${caseData.patientAge}y, ${caseData.patientGender}.
Chief complaint: ${caseData.chiefComplaint}
Personality: ${personality}.${toneHint}${emotionHint}
Medical history: ${caseData.medicalHistory}
Scenario: ${scenario}
${langNote}${personaNote}${behaviorBlock}
${PATIENT_KNOWLEDGE_FIRST_RULES}
Rules: if the doctor asks several short factual questions together (name, age, where you live), answer all briefly in 1–2 sentences; otherwise focus on the main question; never state diagnosis (${caseData.finalDiagnosis}); lay language only; finish every sentence; never invent facts outside CASE BACKGROUND or ADMIN AI KNOWLEDGE.${knowledgeContext}`;
  }

  const langNote =
    language === 'AR'
      ? voiceTurn
        ? `VOICE CALL — مريض مصري في مكالمة صوتية. افهم المعنى مش الكلمات الحرفية. عامية مصرية طبيعية، جملة أو اتنين. ممنوع الفصحى والإنجليزي.`
        : `اكتب بعامية مصرية طبيعية زي مريض حقيقي قاعد قدام الدكتور في العيادة — مش روبوت ولا فصحى.
أمثلة على الأسلوب المطلوب (المحتوى لازم ييجي من بيانات الحالة فقط):
- "صباح النور يا دكتور. والله يا دكتور أنا تعبان أوي، [اذكر الشكوى من بيانات الحالة]."
- "الله يسلمك يا دكتور، تسلم. [ثم اذكر تأثير المرض على حياتك من بيانات الحالة]."
- "اسمي ${nameAr}."
استخدم كلمات طبيعية: والله، أوي، يا دكتور، مش، عشان، كده.
٢–٤ جمل لما تحكي عن أعراضك أو مشاعرك؛ جملة أو اتنين للأسئلة الواقعية (الاسم، السن، السكن).`
      : language === 'EN'
        ? voiceTurn
          ? 'Respond ONLY in English. One or two short sentences.'
          : 'Respond ONLY in English. Sound like a real patient (2–4 sentences when describing symptoms).'
        : 'Match the doctor language: Egyptian Arabic or English, natural spoken style.';

  const phaseNote =
    studentTurn === 0
      ? `FIRST CONTACT: If the doctor only greets (السلام عليكم / hello / good morning), reply with a warm greeting ONLY (e.g. وعليكم السلام يا دكتور / Hello doctor). Do NOT list symptoms, fever, chills, headache, duration, or history yet — wait until they ask.`
      : `ONGOING INTERVIEW: Answer the doctor's current question directly in natural spoken Arabic. You may use 2–4 sentences when describing symptoms, daily impact, or feelings. For simple facts (name, age, yes/no) keep it short but still natural.`;

  const voiceRules = voiceTurn
    ? `VOICE RULES:
- Very brief: 1–2 sentences max.
- One topic per answer.`
    : `CHAT RULES:
- Sound human — vary tone with personality: ${personality}
- When the doctor shows empathy (سلامة، ربنا يشفيك) → thank them warmly; you may add one sentence about how illness affects your life.
- The doctor speaks natural Egyptian colloquial Arabic (عامية): understand "هيلو/أهلاً" as greeting, "عامل إيه/إزيك/ايه الأخبار" as asking how you feel, "اسمك ايه" as name, etc.
- If the doctor asks multiple questions in one message (e.g. name + age + where you live + complaint), answer ALL of them naturally in ONE reply. Never answer only the first one or two and wait for "complete the answer".
- Only if the question is truly unclear (single word like "أيه" alone) → "مش فاهم قصدك يا دكتور، ممكن توضّح سؤالك؟"
- Never ask the doctor questions back. Never state the diagnosis (${caseData.finalDiagnosis}).`;

  const personaOverride = knowledgeContext.includes('ADMIN AI KNOWLEDGE')
    ? `
PERSONA PRIORITY (from ADMIN AI KNOWLEDGE below):
- Follow ADMIN AI KNOWLEDGE for speech style, dialect, gendered Arabic forms, tone, and elderly/woman/man persona.
- Persona rules override default presentation; keep clinical facts (symptoms, duration, history) from CASE BACKGROUND only.
- Answer the doctor's CURRENT question directly (e.g. "where is the pain?" → say the body location in character).
`
    : '';

  return `You are a simulated Egyptian patient in an OSCE clinical examination. Stay fully in character as ${caseData.patientName}, ${caseData.patientAge} years old.
${personaOverride}${behaviorBlock}

CASE BACKGROUND (use when relevant to the question — do not recite everything at once):
- Chief complaint: ${caseData.chiefComplaint}
- Medical history: ${caseData.medicalHistory}
- Medications: ${caseData.medicationHistory}
- Surgical history: ${caseData.surgicalHistory}
- Family history: ${caseData.familyHistory}
- Social history: ${caseData.socialHistory}
- Personality: ${personality}.${toneHint}${emotionHint}
- Scenario notes: ${scenario}

${phaseNote}

${voiceRules}
- CRITICAL: Only reveal facts from CASE BACKGROUND, scenario notes, and ADMIN AI KNOWLEDGE below. Never invent symptoms, history, medications, or details not configured for this case. If asked about something not in those sources, defer politely in character (e.g. you are too unwell to discuss it now).
- When speaking Arabic, never leak English admin field text — paraphrase into natural Egyptian Arabic.
- Avoid repeating the same complaint sentence if you already said it; add a new detail from CASE BACKGROUND or how it affects daily life.
- Lay language only — no medical jargon or English disease terms.
- ${langNote}

${PATIENT_KNOWLEDGE_FIRST_RULES}
${knowledgeContext}`;
}

function pickLang(en: string, ar: string, lang: 'AR' | 'EN'): string {
  return lang === 'AR' ? ar : en;
}

function textHasArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function mergeEvaluationWithLanguage(
  ai: EvaluationResult,
  localized: EvaluationResult,
  lang: 'AR' | 'EN'
): EvaluationResult {
  if (lang === 'EN') return ai;

  const pick = (aiText: string, localizedText: string) =>
    textHasArabic(aiText) ? aiText : localizedText;

  return {
    ...ai,
    strengths: pick(ai.strengths, localized.strengths),
    weaknesses: pick(ai.weaknesses, localized.weaknesses),
    missedQuestions: pick(ai.missedQuestions, localized.missedQuestions),
    clinicalErrors: pick(ai.clinicalErrors, localized.clinicalErrors),
    recommendations: pick(ai.recommendations, localized.recommendations),
    idealApproach: pick(ai.idealApproach, localized.idealApproach),
    fullReport: pick(ai.fullReport, localized.fullReport),
  };
}

export function resolveEvaluationLanguage(
  sessionLang: Language,
  messages: SessionMessage[],
  uiLang?: string
): 'AR' | 'EN' {
  if (uiLang === 'AR' || uiLang === 'EN') return uiLang;
  if (sessionLang === 'AR') return 'AR';
  if (sessionLang === 'EN') return 'EN';
  const studentText = messages
    .filter((m) => m.role === 'STUDENT')
    .map((m) => m.content)
    .join(' ');
  return /[\u0600-\u06FF]/.test(studentText) ? 'AR' : 'EN';
}

function buildExaminerEvaluationPrompt(
  caseData: Case,
  knowledgeContext: string,
  lang: 'AR' | 'EN'
): string {
  const langRule =
    lang === 'AR'
      ? '7. Write ALL string fields (strengths, weaknesses, missedQuestions, clinicalErrors, recommendations, idealApproach, fullReport) ONLY in Arabic (Egyptian medical Arabic when appropriate).'
      : '7. Write ALL string fields (strengths, weaknesses, missedQuestions, clinicalErrors, recommendations, idealApproach, fullReport) ONLY in English.';

  const caseTitle = lang === 'AR' ? caseData.titleAr || caseData.titleEn : caseData.titleEn;

  return `You are a senior OSCE clinical examiner. You will receive the COMPLETE transcript of a student's OSCE session (history, examination viva, diagnosis, and all examiner interactions).

CASE CONTEXT:
- Title: ${caseTitle}
- Correct Diagnosis: ${caseData.finalDiagnosis}
- Chief Complaint: ${caseData.chiefComplaint}
- Key Teaching Points: ${caseData.teachingPoints}
- Scoring Rubric: ${caseData.evaluationRubric}
- Physical Exam Findings (expected): ${caseData.physicalExam}

INSTRUCTIONS:
1. Read EVERY [STUDENT] message across ALL stages before scoring.
2. Score based on what the student ACTUALLY did — not generic defaults.
3. Compare their history questions, exam descriptions, and final diagnosis against the case data.
4. Identify specific missed questions, clinical errors, and strengths from the transcript.
5. Write the fullReport as a detailed markdown evaluation referencing specific student actions.
6. Return ONLY valid JSON — no markdown fences, no extra text.
${langRule}

JSON structure (all scores 0-100 integers):
{
  "totalScore": number,
  "communicationScore": number,
  "historyTakingScore": number,
  "clinicalReasonScore": number,
  "organizationScore": number,
  "closingScore": number,
  "strengths": "string — specific strengths from transcript",
  "weaknesses": "string — specific gaps observed",
  "missedQuestions": "string — questions they should have asked but did not",
  "clinicalErrors": "string — errors or unsafe reasoning",
  "recommendations": "string — actionable study recommendations",
  "idealApproach": "string — how an excellent candidate would approach this case",
  "fullReport": "string — comprehensive markdown report covering history, exam, diagnosis, and overall performance"
}${knowledgeContext ? `\n\nDomain knowledge for scoring:\n${knowledgeContext}` : ''}`;
}

async function getAISettings() {
  const defaultModel = process.env.OPENAI_MODEL || 'gpt-5-mini';
  let settings = await prisma.aISettings.findFirst();
  if (!settings) {
    settings = await prisma.aISettings.create({
      data: {
        provider: process.env.AI_PROVIDER || 'openai',
        patientModel: defaultModel,
        examinerModel: defaultModel,
      },
    });
  }

  // One-time migrate legacy prompts → patient prompts
  if (
    (settings.systemPromptAr || settings.systemPromptEn) &&
    !settings.patientSystemPromptAr &&
    !settings.patientSystemPromptEn
  ) {
    settings = await prisma.aISettings.update({
      where: { id: settings.id },
      data: {
        patientSystemPromptAr: settings.systemPromptAr,
        patientSystemPromptEn: settings.systemPromptEn,
      },
    });
  }

  return {
    ...settings,
    // Admin dashboard provider wins over env so OpenRouter can be selected in Settings.
    provider: settings.provider || process.env.AI_PROVIDER || 'openai',
    patientModel:
      process.env.OPENAI_PATIENT_MODEL ||
      settings.patientModel ||
      'gpt-4o-mini',
    examinerModel: process.env.OPENAI_EXAMINER_MODEL || process.env.OPENAI_MODEL || settings.examinerModel || defaultModel,
    maxContextMessages: settings.maxContextMessages ?? 12,
    openRouterApiKey:
      process.env.OPENROUTER_API_KEY?.trim() ||
      (settings as { openRouterApiKey?: string | null }).openRouterApiKey?.trim() ||
      null,
  };
}

let aiSettingsCache: { value: Awaited<ReturnType<typeof getAISettings>>; expiresAt: number } | null = null;

export function clearAISettingsCache() {
  aiSettingsCache = null;
}

async function getAISettingsCached() {
  const now = Date.now();
  if (aiSettingsCache && aiSettingsCache.expiresAt > now) {
    return aiSettingsCache.value;
  }
  const value = await getAISettings();
  aiSettingsCache = { value, expiresAt: now + 60_000 };
  return value;
}

function adminSystemPromptSuffix(
  settings: Awaited<ReturnType<typeof getAISettings>>,
  lang: 'AR' | 'EN',
  role: 'patient' | 'examiner' = 'patient',
): string {
  let custom: string | null | undefined;
  if (role === 'examiner') {
    custom = lang === 'AR' ? settings.examinerSystemPromptAr : settings.examinerSystemPromptEn;
  } else {
    custom =
      (lang === 'AR' ? settings.patientSystemPromptAr : settings.patientSystemPromptEn) ||
      (lang === 'AR' ? settings.systemPromptAr : settings.systemPromptEn);
  }
  return custom?.trim() ? `\n\nADMIN SYSTEM PROMPT:\n${custom.trim()}` : '';
}

function contextWindow(history: { role: string; content: string }[], maxMessages: number) {
  const n = Math.max(2, Math.min(maxMessages || 12, 100));
  return history.slice(-n);
}

/** Tighter window for live chat turns — less input tokens, faster responses. */
const CHAT_CONTEXT_CAP = 8;
const VOICE_CONTEXT_CAP = 6;
/** Default chat reply budget — raised so multi-part demographic answers are not cut off. */
const CHAT_PATIENT_MAX_TOKENS = 220;
const CHAT_PATIENT_MULTI_MAX_TOKENS = 360;
const CHAT_EXAMINER_MAX_TOKENS = 64;
const VOICE_PATIENT_MAX_TOKENS = 96;
/** Live voice AI budget — long enough for a complete short reply without mid-sentence cuts. */
const VOICE_TIMEOUT_MS = 3500;
/** Non-voice chat: allow a bit more time for multi-part answers. */
const CHAT_TIMEOUT_MS = 3500;
const CHAT_MULTI_TIMEOUT_MS = 5500;

function chatContextWindow(history: { role: string; content: string }[], maxMessages: number, voiceTurn = false) {
  return contextWindow(history, Math.min(maxMessages, voiceTurn ? VOICE_CONTEXT_CAP : CHAT_CONTEXT_CAP));
}

function usesMaxCompletionTokens(model: string): boolean {
  const m = model.toLowerCase();
  return /^(gpt-5|o1|o3|o4)/.test(m);
}

function supportsCustomTemperature(model: string): boolean {
  const m = model.toLowerCase();
  return !/^(gpt-5|o1|o3|o4)/.test(m);
}

function effectiveCompletionBudget(model: string, maxTokens: number, fastChat = false): number {
  // Reasoning models (gpt-5, o-series) may consume budget internally before visible text.
  if (usesMaxCompletionTokens(model)) {
    return fastChat ? Math.max(maxTokens, 160) : Math.max(maxTokens, 512);
  }
  return maxTokens;
}

function isReasoningModel(model: string): boolean {
  return usesMaxCompletionTokens(model);
}

/** Realtime models are not valid for text chat completions — avoid a slow failed-then-fallback round trip. */
function chatPatientModel(settings: Awaited<ReturnType<typeof getAISettings>>): string {
  const configured = settings.patientModel;
  if (!/realtime/i.test(configured)) return configured;
  return (
    process.env.OPENAI_PATIENT_MODEL ||
    process.env.OPENAI_MODEL ||
    settings.examinerModel ||
    'gpt-4o-mini'
  );
}

function extractCompletionText(response: ChatCompletion): string {
  return response.choices[0]?.message?.content?.trim() || '';
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function isOpenRouterProvider(provider: string): boolean {
  return /^open.?router$/i.test(provider.trim());
}

async function createChatClient(settings?: Awaited<ReturnType<typeof getAISettingsCached>>) {
  const cfg = settings ?? (await getAISettingsCached());
  const provider = (cfg.provider || process.env.AI_PROVIDER || 'openai').toLowerCase();

  if (isOpenRouterProvider(provider)) {
    const apiKey =
      process.env.OPENROUTER_API_KEY?.trim() ||
      cfg.openRouterApiKey?.trim() ||
      '';
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');
    return {
      client: new OpenAI({
        apiKey,
        baseURL: OPENROUTER_BASE_URL,
        defaultHeaders: {
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://medsynoza.com',
          'X-Title': process.env.OPENROUTER_APP_NAME || 'Synoza OSCE',
        },
      }),
      provider: 'openrouter' as const,
      fallbackModel:
        process.env.OPENROUTER_FALLBACK_MODEL ||
        process.env.OPENAI_FALLBACK_MODEL ||
        'openai/gpt-4o-mini',
    };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  return {
    client: new OpenAI({ apiKey }),
    provider: 'openai' as const,
    fallbackModel: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini',
  };
}

async function callOpenAI(
  messages: ChatMessage[],
  model: string,
  temperature: number,
  maxTokens: number,
  usageMeta?: AiUsageMeta,
) {
  const { client: openai, fallbackModel } = await createChatClient();

  const run = (activeModel: string, tokenBudget: number, fastChat = true) =>
    openai.chat.completions.create({
      model: activeModel,
      messages,
      ...(supportsCustomTemperature(activeModel) ? { temperature } : {}),
      ...(usesMaxCompletionTokens(activeModel)
        ? {
            max_completion_tokens: effectiveCompletionBudget(activeModel, tokenBudget, fastChat),
            ...(fastChat && isReasoningModel(activeModel)
              ? {
                  reasoning_effort: 'minimal' as 'low',
                  verbosity: 'low' as const,
                }
              : {}),
          }
        : { max_tokens: tokenBudget }),
    } as Parameters<typeof openai.chat.completions.create>[0]);

  const record = (activeModel: string, response: ChatCompletion, success: boolean, error?: string) => {
    if (!usageMeta) return;
    void logAiUsage({
      feature: usageMeta.feature,
      model: activeModel,
      usage: response.usage,
      userId: usageMeta.userId,
      sessionId: usageMeta.sessionId,
      success,
      error,
    });
  };

  try {
    let response = (await run(model, maxTokens)) as ChatCompletion;
    let text = extractCompletionText(response);
    if (!text && model !== fallbackModel) {
      response = (await run(fallbackModel, Math.max(maxTokens, 220))) as ChatCompletion;
      text = extractCompletionText(response);
      record(fallbackModel, response, !!text, text ? undefined : 'empty model response');
    } else {
      record(model, response, !!text, text ? undefined : 'empty model response');
    }
    return text;
  } catch (error) {
    if (model !== fallbackModel && /realtime|gpt-5/i.test(model)) {
      const response = (await run(fallbackModel, Math.max(maxTokens, 220))) as ChatCompletion;
      record(fallbackModel, response, true);
      return extractCompletionText(response);
    }
    if (usageMeta) {
      void logAiUsage({
        feature: usageMeta.feature,
        model,
        userId: usageMeta.userId,
        sessionId: usageMeta.sessionId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

async function callOpenAIStream(
  messages: ChatMessage[],
  model: string,
  temperature: number,
  maxTokens: number,
  timeoutMs: number,
  usageMeta?: AiUsageMeta,
): Promise<string> {
  const { client: openai, fallbackModel } = await createChatClient();
  const activeModel = /realtime|gpt-5/i.test(model) ? fallbackModel : model;
  const started = Date.now();

  const stream = (await openai.chat.completions.create({
    model: activeModel,
    messages,
    stream: true as const,
    ...(supportsCustomTemperature(activeModel) ? { temperature } : {}),
    ...(usesMaxCompletionTokens(activeModel)
      ? {
          max_completion_tokens: effectiveCompletionBudget(activeModel, maxTokens, true),
          ...(isReasoningModel(activeModel)
            ? {
                reasoning_effort: 'minimal' as 'low',
                verbosity: 'low' as const,
              }
            : {}),
        }
      : { max_tokens: maxTokens }),
  })) as AsyncIterable<{ choices: Array<{ delta?: { content?: string | null } }> }>;

  let text = '';
  for await (const chunk of stream) {
    if (Date.now() - started >= timeoutMs) break;
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) text += delta;
    // Early-return once we have a short complete spoken sentence.
    const trimmed = text.trim();
    if (
      trimmed.length >= 24 &&
      /[.!?؟]\s*$/u.test(trimmed) &&
      (trimmed.match(/[.!?؟]/g) || []).length >= 1
    ) {
      break;
    }
  }

  const finalText = text.trim();
  if (usageMeta) {
    void logAiUsage({
      feature: usageMeta.feature,
      model: activeModel,
      userId: usageMeta.userId,
      sessionId: usageMeta.sessionId,
      success: !!finalText,
      error: finalText ? undefined : 'empty stream response',
    });
  }
  return finalText;
}

function logAiFallback(context: string, error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  console.warn(`[AI] ${context} — OpenAI unavailable, using mock fallback: ${msg}`);
}

async function callOpenAISafe(
  messages: ChatMessage[],
  model: string,
  temperature: number,
  maxTokens: number,
  fallback: () => string,
  usageMeta?: AiUsageMeta,
  options?: { timeoutMs?: number; stream?: boolean },
): Promise<string> {
  const started = Date.now();
  const timeoutMs = options?.timeoutMs;
  const useStream = !!options?.stream && !!timeoutMs;
  try {
    const text = (
      useStream
        ? await callOpenAIStream(messages, model, temperature, maxTokens, timeoutMs!, usageMeta)
        : timeoutMs
          ? await Promise.race([
              callOpenAI(messages, model, temperature, maxTokens, usageMeta),
              new Promise<string>((_, reject) => {
                setTimeout(() => reject(new Error('ai-timeout')), timeoutMs);
              }),
            ])
          : await callOpenAI(messages, model, temperature, maxTokens, usageMeta)
    ).trim();
    const elapsed = Date.now() - started;
    if (elapsed > VOICE_TIMEOUT_MS) {
      console.warn(`[AI] slow completion ${elapsed}ms feature=${usageMeta?.feature ?? 'unknown'}`);
    }
    if (!text) {
      logAiFallback('chat completion', new Error('empty model response'));
      return fallback();
    }
    return text;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logAiFallback(reason === 'ai-timeout' ? 'chat completion timeout' : 'chat completion', error);
    return fallback();
  }
}

function resolvePatientLanguage(language: Language, userMessage: string): boolean {
  if (language === 'AR') return true;
  if (language === 'EN') return false;
  return /[\u0600-\u06FF]/.test(userMessage);
}

function effectivePatientLanguage(language: Language, userMessage: string): 'AR' | 'EN' {
  return resolvePatientLanguage(language, userMessage) ? 'AR' : 'EN';
}

function resolveExaminerLanguage(sessionLang: Language, studentMessage: string): 'AR' | 'EN' {
  if (sessionLang === 'EN') return 'EN';
  if (sessionLang === 'AR') return 'AR';
  return /[\u0600-\u06FF]/.test(studentMessage) ? 'AR' : 'EN';
}

/** Physical examination viva — examiner always speaks English. */
function examinationExaminerLanguage(): 'EN' {
  return 'EN';
}

function examinerLangRule(lang: 'AR' | 'EN'): string {
  return lang === 'AR'
    ? 'ردّ فقط بالعامية المصرية الطبية الطبيعية، مش فصحى. جمل قصيرة 2–4. ممنوع الإنجليزي إلا لمصطلحات طبية لاتينية ضرورية بين قوسين.'
    : 'Respond ONLY in English (2–4 sentences).';
}

function isMostlyEnglish(text: string): boolean {
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  return latin >= 3 && arabic === 0;
}

function containsEnglishMedicalLeak(text: string): boolean {
  return /progressive|exertional|dyspnea|tightness|shortness|breath|swelling|chest pain|months|pharmacy|training|trip/i.test(
    text,
  );
}

/** Strip embedded Latin phrases that leak into Arabic patient replies (multipart collapse). */
function stripEmbeddedEnglishFromArabic(text: string): string {
  const trimmed = text.trim();
  const arabic = (trimmed.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (trimmed.match(/[a-zA-Z]/g) || []).length;
  // Only scrub mixed Arabic+English dumps — leave pure Arabic / short Latin alone.
  if (arabic < 6 || latin < 10) return trimmed;

  let cleaned = trimmed
    .replace(/[A-Za-z][A-Za-z0-9]*(?:[\s,',.\-/]+[A-Za-z0-9]+)+[A-Za-z0-9.]*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([،,.!?؟])/g, '$1')
    .trim();
  const arabicLeft = (cleaned.match(/[\u0600-\u06FF]/g) || []).length;
  if (arabicLeft < 4) return trimmed;
  return cleaned;
}

function finalizePatientReply(
  caseData: Case,
  userMessage: string,
  response: string,
  lang: Language,
  history: { role: string; content: string }[] = [],
  voiceTurn = false,
): string {
  const multi = !voiceTurn && isMultiPartPatientQuestion(userMessage);
  const maxSentences = voiceTurn ? 2 : multi ? 12 : 5;
  if (lang === 'EN') return truncatePatientAnswer(response.trim(), maxSentences);

  let text = truncatePatientAnswer(response.trim(), maxSentences);
  text = stripEmbeddedEnglishFromArabic(text);

  if (!voiceTurn && (isMostlyEnglish(text) || containsEnglishMedicalLeak(text))) {
    const fallback = getDeterministicPatientResponse(caseData, userMessage, 'AR', history, false);
    if (fallback) return fallback;
    if (asksWellbeing(userMessage)) return patientWellbeingReply(caseData, true, false);
    if (asksAboutSymptoms(userMessage)) return patientComplaintPhrase(caseData, true);
    if (asksName(userMessage)) return `اسمي ${patientNameInLang(caseData, true)}.`;
    if (isGreetingOnly(userMessage) || isDoctorIntroduction(userMessage)) {
      return patientGreetingOnlyReply(caseData, true, userMessage);
    }
    return 'مش فاهم، ممكن توضّح سؤالك؟';
  }

  text = enforcePatientLanguage(text, true);
  if (caseData.patientName && text.includes(caseData.patientName)) {
    text = text.replaceAll(caseData.patientName, patientNameInLang(caseData, true));
  }
  return toEgyptianColloquial(text);
}

/** Unwrap accidental model JSON like {"text":"..."} or {"feedback":"..."} into plain chat text. */
export function unwrapExaminerPlainText(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';

  // Whole message is a JSON object with a text/feedback/reply/message field.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ['text', 'feedback', 'reply', 'message', 'content', 'answer']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) {
          return unwrapExaminerPlainText(value.trim());
        }
      }
    } catch {
      /* keep original */
    }
  }

  // Prefix junk: some models return `{"text": "..."}` embedded in a longer string.
  const embedded = trimmed.match(/^\s*\{\s*"(?:text|feedback|reply|message|content)"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}\s*$/s);
  if (embedded?.[1]) {
    try {
      return JSON.parse(`"${embedded[1]}"`) as string;
    } catch {
      return embedded[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
  }

  return trimmed;
}

function finalizeExaminerReply(text: string, lang: 'AR' | 'EN'): string {
  const trimmed = unwrapExaminerPlainText(text);
  if (!trimmed || lang === 'EN') return trimmed;
  return toEgyptianColloquial(trimmed);
}

export function normalizeStudentMessage(message: string, sessionLang: Language): string {
  const trimmed = message.trim();
  if (sessionLang === 'EN') return trimmed;
  const sttFixed = fixArabicSpeechTranscript(trimmed, true);
  return normalizeEgyptianColloquialInput(sttFixed);
}

function normalizeEgyptianColloquialInput(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return t;

  const fixes: Array<[RegExp, string]> = [
    [/^(هيلو|هالو|حيلو|هلو|هلا)\s*(يا\s*)?(دكتور)?[!.?؟]*$/i, 'اهلا دكتور'],
    [/^(هاي|hi|hello|hey)\s*(يا\s*)?(دكتور|doctor)?[!.?؟]*$/i, 'اهلا دكتور'],
    [/^(عامل|عاملة)\s*(ايه|إيه|أي|eh|eih)\s*(يا\s*)?(دكتور)?[!.?؟]*$/i, 'عامل إيه'],
    [/^(ازيك|إزيك|ازي|إزي)\s*(يا\s*)?(دكتور)?[!.?؟]*$/i, 'إزيك'],
    [/^(ايه|إيه|اي)\s*(الاخبار|الأخبار|اخبارك|أخبارك)\s*(يا\s*)?(دكتور)?[!.?؟]*$/i, 'إيه الأخبار'],
  ];

  for (const [pattern, replacement] of fixes) {
    if (pattern.test(t)) return replacement;
  }

  return t;
}

function patientNameInLang(caseData: Case, isArabic: boolean): string {
  if (!isArabic) return caseData.patientName;
  const lower = caseData.patientName.toLowerCase();
  if (lower.includes('tarek')) return 'طارق مصطفى الحداد';
  if (lower.includes('samira')) return 'سميرة عبد الرحمن';
  if (lower.includes('ahmed')) return 'أحمد';
  if (lower.includes('fatma') || lower.includes('fatima')) return 'فاطمة';
  if (lower.includes('mohamed') || lower.includes('mohammed')) return 'محمد';
  return caseData.patientName.split(' ').slice(0, 2).join(' ');
}

function patientComplaintPhrase(caseData: Case, isArabic: boolean): string {
  if (!isArabic) return caseData.chiefComplaint.split('.')[0].trim();

  const c = caseData.chiefComplaint.toLowerCase();
  const months = c.match(/(\d+)\s*months?/);
  const weeks = c.match(/(\d+)\s*-?\s*weeks?/);
  const duration = months
    ? `من ${months[1]} شهور`
    : weeks
      ? `من ${weeks[1]} أسابيع`
      : /أسبوع|اسبوع|week/i.test(c)
        ? 'من أسبوعين'
        : 'من فترة';

  const symptomMaps: Array<[RegExp, string]> = [
    [/dyspnea|breath|shortness|exertional|ضيق|تنفس|نفس/i, 'بحس بضيق نفس مع المجهود'],
    [
      /chest|tight|صدر|(?:ألم|الم|وجع|pain)\s*(?:في|فى|of)?\s*(?:ال)?صدر/i,
      'عندي ألم أو تقل في الصدر',
    ],
    [/epigastr|بطن|abdomen|stomach|gastro|ulcer|قرحة|حرقان/i, 'عندي ألم أو حرقان في فم المعدة'],
    [/haemat?uria|hematuria|blood in (?:the )?urine|دم\s*(?:في|فى)\s*(?:ال)?بول|بول\s*دم/i, 'بلاقي دم في البول'],
    [/dysuria|burning.*urin|حرقان.*بول|ألم.*تبول/i, 'بحس بحرقان وألم مع التبول'],
    [/frequency|nocturia|يبول\s*كتير|تبول\s*متكرر/i, 'بروح الحمام كتير'],
    [/fever|سخون|حرارة|pyrexia/i, 'عندي سخونية'],
    [/itch|prurit|حكة|هرش/i, 'عندي حكة'],
    [/jaundice|صفرا|اصفرار/i, 'لاحظت اصفرار في جسمي'],
    [/fatigue|weakness|malaise|تعب|إعياء|اجهاد/i, 'تعبان ومش قادر أتحرك كويس'],
    [/nausea|vomiting|قيء|غثيان|استفراغ/i, 'بحس بغثيان وأوقات بستفرغ'],
    [/diarrhea|diarrhoea|إسهال|اسهال/i, 'عندي إسهال'],
    [/cough|كحة|سعال/i, 'عندي كحة'],
    [/swell|edema|تورم|انتفاخ/i, 'عندي تورم'],
    [/headache|صداع/i, 'عندي صداع'],
    [/flank|loins?|جنب|خاصرة/i, 'عندي ألم في الجنب'],
    [/bilharz|schistosom/i, 'عندي مشكلة في البول من زمان'],
  ];

  for (const [pattern, phrase] of symptomMaps) {
    if (pattern.test(c)) {
      // Skip chest mapping when the complaint is clearly abdominal.
      if (pattern.source.includes('chest') && /epigastr|بطن|abdomen|stomach|gastro|ulcer|قرحة/i.test(c)) {
        continue;
      }
      return `${duration} ${phrase}.`;
    }
  }

  if (/[\u0600-\u06FF]/.test(caseData.chiefComplaint)) {
    return `${duration} ${caseData.chiefComplaint.split('.')[0].trim()}.`;
  }

  // Never return the empty "عندي شكوى" loop — use the case chief complaint text.
  const first = caseData.chiefComplaint.split('.')[0].trim();
  if (first.length >= 8) {
    return `${duration} المشكلة عندي: ${first}.`;
  }
  return `${duration} مش مرتاح وفي حاجة تعباني.`;
}

/** Richer symptom answer for follow-ups ("بالظبط بتحس بإيه؟"). */
function patientDetailedComplaint(caseData: Case, isArabic: boolean): string {
  const chief = caseData.chiefComplaint?.trim() || '';
  const history = caseData.medicalHistory?.trim() || '';
  const scenario = caseData.scenarioPrompt?.trim() || '';

  if (!isArabic) {
    const parts = [chief, history, scenario].filter(Boolean);
    return firstSentences(parts.join(' '), 3) || patientComplaintPhrase(caseData, false);
  }

  const arabicBlock = pickArabicCaseText(scenario, chief, history);
  if (arabicBlock) {
    return `والله يا دكتور ${firstSentences(arabicBlock, 3)}`;
  }

  const brief = patientComplaintPhrase(caseData, true).replace(/\.\s*$/, '');
  const extraBits: string[] = [];
  const histLower = history.toLowerCase();
  if (/tonsill|لوز/i.test(histLower)) extraBits.push('وقبل كده كان عندي مشاكل في اللوز');
  if (/hypertens|ضغط/i.test(histLower)) extraBits.push('وعندي ضغط');
  if (/diabet|سكر/i.test(histLower)) extraBits.push('وعندي سكر');
  if (history && extraBits.length === 0) {
    const histFirst = history.split('.')[0].trim();
    // Only append Arabic case text — never leak English admin notes into chat.
    if (
      histFirst.length > 10 &&
      histFirst.length < 120 &&
      /[\u0600-\u06FF]/.test(histFirst)
    ) {
      extraBits.push(`وكمان ${histFirst}`);
    }
  }

  if (extraBits.length > 0) {
    return `${brief}، ${extraBits.join('، ')}.`;
  }

  // Add a second clinical angle from the chief complaint when available.
  const chiefLower = chief.toLowerCase();
  if (/dysuria|burning|حرقان/i.test(chiefLower) && !/حرقان|تبول/.test(brief)) {
    return `${brief}، وكمان بحس بحرقان مع التبول.`;
  }
  if (/frequency|nocturia|كتير/i.test(chiefLower) && !/حمام|كتير/.test(brief)) {
    return `${brief}، وبروح الحمام أكتر من الأول.`;
  }
  if (/pain|ألم|وجع/i.test(chiefLower) && !/ألم|وجع/.test(brief)) {
    return `${brief}، والألم ده مضايقني أوي.`;
  }
  return `${brief}، وده اللي مضايقني أكتر حاجة دلوقتي.`;
}

function asksSymptomDetails(text: string): boolean {
  return /بالظبط|بالضبط|بتحسي|بتحس|تحسي|تحس|تصف|وصف|يعني\s*(?:إيه|ايه)|إيه\s*هي|ايه\s*هي|إيه\s*عبار|ايه\s*عبار|التفاصيل|اكتر|أكثر|وض[ّ']?ح|صف.?لي|what exactly|describe|tell me more|more detail|what do you feel|how does it feel/i.test(
    text,
  );
}

function normalizeReplyForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNearDuplicatePatientReply(
  candidate: string,
  history: { role: string; content: string }[],
): boolean {
  const needle = normalizeReplyForCompare(candidate);
  if (needle.length < 12) return false;
  const recent = history
    .filter((m) => m.role === 'PATIENT' || m.role === 'assistant')
    .slice(-4)
    .map((m) => normalizeReplyForCompare(m.content));
  return recent.some(
    (prev) =>
      prev === needle ||
      (prev.length > 20 && needle.includes(prev)) ||
      (needle.length > 20 && prev.includes(needle)),
  );
}

function isVagueStudentMessage(text: string): boolean {
  const t = text.trim();
  return /^(أ?ييه|ايه|إيه|اي|eh|eih|أيه)\s*[؟?.!]*$/i.test(t) || t.length < 3;
}

function isEmpathyOrBlessing(text: string): boolean {
  const t = text.trim();
  return /الف\s*(مليون\s*)?سلام|مليون\s*سلام|سلام[ةه]\s*(عليك|عليكي)?|سلامتك|ربنا\s*يخليك|ربنا\s*يشفيك|الله\s*يسلمك|get\s*well|bless\s*you/i.test(
    t,
  );
}

function isGreetingOnly(text: string): boolean {
  const t = text
    .trim()
    .replace(/[!.?؟،,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/أهلاً|أهلا|اهلاً/gi, 'اهلا')
    .trim();
  if (!t || t.length > 120) return false;

  // Islamic / Arabic clinic greetings — with or without the longer blessing form.
  if (
    /^(السلام عليكم|سلام عليكم)(\s+ورحمة\s*الله(\s+وبركاته)?)?(\s+(يا\s*)?دكتور)?$/i.test(
      t,
    )
  ) {
    return true;
  }

  if (
    /^(صباح الخير|مساء الخير|good morning|good afternoon|good evening|peace be upon you)(\s+(يا\s*)?دكتور|\s+doctor)?$/i.test(
      t,
    )
  ) {
    return true;
  }

  const core = t.replace(/\s*(يا\s+)?دكتور\s*$/i, '').trim() || t;
  const words = core.split(' ').filter(Boolean);
  const wordGreeting =
    /^(أ?هلا|اهلا|مرحبا?|مرحب|سلام|السلام|عليكم|ورحمة|الله|وبركاته|هاي|hi|hello|hey|هيلو|هالو|حيلو|هلو|هلا)$/i;
  // Allow up to 8 tokens so "السلام عليكم ورحمة الله وبركاته" counts as greeting-only.
  return words.length > 0 && words.length <= 8 && words.every((w) => wordGreeting.test(w));
}

function quickSocialPatientReply(
  caseData: Case,
  userMessage: string,
  lang: Language,
  history: { role: string; content: string }[],
  voiceTurn: boolean,
): string | null {
  const isArabic = resolvePatientLanguage(lang, userMessage);
  const studentTurn = history.filter((m) => m.role === 'STUDENT').length;

  if (isEmpathyOrBlessing(userMessage)) {
    return patientEmpathyReply(caseData, isArabic);
  }

  if (isGreetingOnly(userMessage) || isDoctorIntroduction(userMessage)) {
    if (studentTurn === 0) {
      // Pure greeting → greet back only. Do not dump medical history yet.
      if (isGreetingOnly(userMessage) && !asksAboutSymptoms(userMessage) && !asksWellbeing(userMessage)) {
        return patientGreetingOnlyReply(caseData, isArabic, userMessage);
      }
      return voiceTurn
        ? patientWellbeingReply(caseData, isArabic, true)
        : patientOpeningReply(caseData, isArabic);
    }
    return isGreetingOnly(userMessage)
      ? patientGreetingOnlyReply(caseData, isArabic, userMessage)
      : isArabic
        ? 'أهلاً يا دكتور.'
        : 'Hello doctor.';
  }

  if (asksWellbeing(userMessage)) {
    // If the doctor mixed wellbeing with other questions (name/age/...),
    // don't answer wellbeing alone — let the multi-intent combiner handle it.
    const intents = resolvePatientQuestionIntents(userMessage);
    const hasOtherFacts = intents.some(
      (intent) =>
        intent !== 'wellbeing' &&
        intent !== 'greeting' &&
        intent !== 'empathy',
    );
    if (hasOtherFacts) return null;
    return patientWellbeingReply(caseData, isArabic, voiceTurn);
  }

  return null;
}

function firstSentences(text: string, max = 2): string {
  const cleaned = text.trim();
  if (!cleaned) return '';
  const parts = cleaned.split(/(?<=[.!?؟])\s+/).filter(Boolean);
  return parts.slice(0, max).join(' ').trim();
}

function pickArabicCaseText(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && /[\u0600-\u06FF]/.test(value)) return value;
  }
  return '';
}

/** Case-specific patient narrative from admin fields — no hardcoded persona scripts. */
function patientScenarioSnippet(caseData: Case, isArabic: boolean): string {
  const scenario = caseData.scenarioPrompt?.trim() ?? '';
  const chief = caseData.chiefComplaint?.trim() ?? '';
  const social = caseData.socialHistory?.trim() ?? '';
  const personality = caseData.patientPersonality?.trim() ?? '';

  if (isArabic) {
    const arabicBlock = pickArabicCaseText(scenario, chief, social, personality);
    if (arabicBlock) return firstSentences(arabicBlock, 2);

    const complaint = patientComplaintPhrase(caseData, true);
    const socialSnippet = /[\u0600-\u06FF]/.test(social) ? firstSentences(social, 1) : '';
    return [complaint, socialSnippet].filter(Boolean).join(' ').trim();
  }

  return (
    firstSentences(scenario, 2) ||
    firstSentences(chief, 2) ||
    patientComplaintPhrase(caseData, false)
  );
}

function patientRichComplaint(caseData: Case, isArabic: boolean): string {
  if (!isArabic) {
    return patientScenarioSnippet(caseData, false) || patientComplaintPhrase(caseData, false);
  }

  const narrative = patientScenarioSnippet(caseData, true);
  if (!narrative) {
    return `والله يا دكتور مش في أحسن حالي. ${patientComplaintPhrase(caseData, true)}`;
  }
  if (/^والله/i.test(narrative)) return narrative;
  return `والله يا دكتور ${narrative}`;
}

function patientWellbeingReply(caseData: Case, isArabic: boolean, voiceTurn: boolean): string {
  if (!isArabic) return voiceTurn ? 'Not great, doctor.' : 'Honestly doctor, I have not been feeling well lately.';
  if (voiceTurn) return 'مش في أحسن حالي دكتور.';
  const hint = patientComplaintPhrase(caseData, true);
  return `والله يا دكتور مش في أحسن حالي، تعبان${caseData.patientGender.toLowerCase().startsWith('f') ? 'ة' : ''} أوي. ${hint}`;
}

function patientGreetingOnlyReply(caseData: Case, isArabic: boolean, userMessage = ''): string {
  const msg = userMessage.trim();
  if (!isArabic) {
    if (/peace|salam|assalam/i.test(msg)) return 'Peace be upon you too, doctor.';
    return 'Hello doctor.';
  }
  if (/السلام|سلام عليكم/i.test(msg)) return 'وعليكم السلام يا دكتور.';
  if (/صباح/i.test(msg)) return 'صباح النور يا دكتور.';
  if (/مساء/i.test(msg)) return 'مساء النور يا دكتور.';
  return 'أهلاً يا دكتور.';
}

function patientOpeningReply(caseData: Case, isArabic: boolean): string {
  // Greeting-phase: acknowledge the doctor and that you feel unwell — do NOT dump
  // chief complaint / scenario / full history until the doctor asks.
  if (!isArabic) {
    return 'Hello doctor. I have not been feeling well.';
  }
  return 'أهلاً يا دكتور، وعليكم السلام. والله مش في أحسن حالي.';
}

function patientEmpathyReply(caseData: Case, isArabic: boolean): string {
  if (!isArabic) {
    const snippet = patientScenarioSnippet(caseData, false);
    return snippet ? `Thank you, doctor. ${snippet}` : 'Thank you, doctor. I really appreciate it.';
  }

  const thanks = caseData.patientGender.toLowerCase().startsWith('f')
    ? 'الله يسلمك يا دكتور، تسلمي.'
    : 'الله يسلمك يا دكتور، تسلم.';
  const narrative = patientScenarioSnippet(caseData, true);
  if (!narrative) return thanks;
  if (/^والله/i.test(narrative)) return `${thanks} ${narrative}`;
  return `${thanks} ${narrative}`;
}

function truncatePatientAnswer(text: string, maxSentences = 2): string {
  const cleaned = text.trim();
  if (!cleaned) return cleaned;
  const parts = cleaned.split(/(?<=[.!?؟])\s+/).filter(Boolean);
  if (parts.length <= maxSentences) return cleaned;
  return parts.slice(0, maxSentences).join(' ').trim();
}

function enforcePatientLanguage(text: string, isArabic: boolean): string {
  const trimmed = text.trim();
  if (!trimmed || !isArabic) return trimmed;

  const scrubbed = stripEmbeddedEnglishFromArabic(trimmed);
  const latin = (scrubbed.match(/[a-zA-Z]/g) || []).length;
  const arabic = (scrubbed.match(/[\u0600-\u06FF]/g) || []).length;
  if (latin >= 3 && arabic === 0) {
    return 'مش فاهم، ممكن توضّح سؤالك؟';
  }
  return scrubbed;
}

function isDoctorIntroduction(text: string): boolean {
  return /^(good\s+(morning|afternoon|evening)|nice to meet|pleased to meet|i'?m\s+(dr|doctor)|my name is.*(dr|doctor)|أنا\s+(د|دكتور)|اسمي\s+(د|دكتور)|تشرفنا|نورت)/i.test(
    text.trim(),
  );
}

function asksAboutSymptoms(text: string): boolean {
  if (isVagueStudentMessage(text)) return false;
  // Do NOT block when the same message also asks name/age — collective OSCE
  // questions routinely mix demographics with the chief complaint.
  return /why|what brought|what brings|present|complain|symptom|problem|chief|feel|wrong|happening|issue|breath|dyspnea|swell|pain|chest|tell me about|describe|history of|ليه|سبب|شكو|شكوى|شكواك|شكوتك|شكوايتك|بتشتكي|بتشكو|تشتكي|اشتكي|اشتكيت|بتشكو|عرض|وجع|ألم|الم|ضيق|تنفس|تورم|حاس|حاسس|بتعاني|تعاني من|مشكل|إيه اللي جابك|إيه الحاجة|الحاجة اللي|إيه المشكلة|إيه مشكل|إيه جابك|جابك هنا|جيت ليه|ليه جيت|وديجتي|ودجتي|وش جيت|عندك إيه|عندك ايه|إيه اللي عندك|ما الذي|شكو.*من|بتشتكي\s*من|تشتكي\s*من|what.*wrong|what.*problem|what.*matter|what.*complain|الحكاية|القصة|بدأت|اتطورت|ازاي\s*بدأت/i.test(
    text,
  );
}

function asksSmokingOrAlcohol(text: string): boolean {
  return /دخن|تدخين|تدخن|سجاير|سجائر|تشرب|بتشرب|خمر|كحول|حشيش|smoke|smok|alcohol|drink|drinking|cigarette/i.test(
    text,
  );
}

function asksBirthPlace(text: string): boolean {
  return /اتولد|اتولدت|اتولدتي|مولود|مكان\s*الميلاد|where\s+(?:were|are)\s+you\s+born|birth\s*place|born\s+where/i.test(
    text,
  );
}

function asksHobbiesOrSport(text: string): boolean {
  return /كره|كرة|فوتبول|football|soccer|hobby|hobbies|رياضة|sport|interest|هواي/i.test(text);
}

function asksName(text: string): boolean {
  return /(?:name|your name|اسم|اسمك|who are you|مين|من انت|may i have your name|what is your name|اسمك\s*إ?يه|اسمك\s*ايه|اسم حضرتك)/i.test(
    text,
  );
}

function asksAge(text: string): boolean {
  return /(?:how\s*old|years?\s*old|your\s*age)|(?:عمرك|سنك|(?:كم|كام)\s*عمر|(?:كم|كام)\s*سنة|(?:كم|كام)\s*سن|عندك\s*(?:كم|كام)\s*سنة|عندك\s*(?:كم|كام)\s*سن)/i.test(
    text,
  );
}

function asksPriorDoctorVisit(text: string): boolean {
  return /روحت.*دكتور|رحت.*دكتور|زرت.*دكتور|دكتور قبل|مستشفى قبل|seen a doctor|doctor before|visited.*doctor|hospital before|previous doctor/i.test(
    text,
  );
}

function asksResidence(text: string): boolean {
  return /ساكن فين|ساكنة فين|عايش فين|عايشة فين|ساكن في|منين|من فين|where.*live|where do you live|your address|بتسكن/i.test(
    text,
  );
}

function asksOccupation(text: string): boolean {
  return /(?:occupation|job|work|what do you do|your work)|(?:شغلك|شغلك\s*إ?يه|بتشتغل|بتعمل\s*إ?يه|مهنتك|وظيفتك|بتاع\s*إ?يه)/i.test(
    text,
  );
}

function patientPriorDoctorPhrase(caseData: Case, isArabic: boolean): string {
  const history = caseData.medicalHistory;
  if (/tonsillitis|التهاب لوز/i.test(history)) {
    return isArabic
      ? 'آه، رحت دكتور ومستشفى قبل كده لالتهاب اللوز.'
      : 'Yes, I saw doctors and went to hospital for tonsillitis before.';
  }
  if (/denies|never|no prior/i.test(history.toLowerCase())) {
    return isArabic ? 'لا، مروحتش دكتور قبل كده.' : 'No, I have not seen a doctor before for this.';
  }
  return isArabic ? 'آه، رحت دكتور قبل كده.' : 'Yes, I have seen a doctor before.';
}

function patientResidencePhrase(caseData: Case, isArabic: boolean): string {
  const social = caseData.socialHistory;
  if (isArabic) {
    if (/shobra|شبرا/i.test(social)) return 'من شبرا الخيمة.';
    const fromMatch = social.match(/from\s+([^,]+)/i);
    if (fromMatch) return `من ${fromMatch[1].trim()}.`;
    return 'من القاهرة.';
  }
  const fromMatch = social.match(/from\s+([^,]+)/i);
  return fromMatch ? `I am from ${fromMatch[1].trim()}.` : social.split('.')[0].trim();
}

function patientOccupationPhrase(caseData: Case, isArabic: boolean): string {
  const social = caseData.socialHistory || '';
  const occMatch =
    social.match(/occupation\s*:\s*([^.;\n]+)/i) ||
    social.match(/works?\s+as\s+(?:a\s+|an\s+)?([^.;,\n]+)/i) ||
    social.match(/job\s*:\s*([^.;\n]+)/i) ||
    social.match(/مهنة\s*:\s*([^.;\n]+)/i) ||
    social.match(/وظيفة\s*:\s*([^.;\n]+)/i);
  const raw = occMatch?.[1]?.trim();
  if (raw) {
    return isArabic ? `بشتغل ${raw}.` : `I work as ${raw}.`;
  }
  return isArabic ? 'بشتغل شغل عادي.' : 'I have a regular job.';
}

function asksWellbeing(text: string): boolean {
  return /how are you|how r u|what'?s up|عامل\s*(إيه|ايه|أي|eh|eih)?|عاملة\s*(إيه|ايه|أي|eh|eih)?|إزيك|ازيك|إزي|ازي|كيف حال|حالك|عامل إيه|عاملة إيه|إيه الأخبار|ايه الاخبار|ايه الأخبار|الأخبار|أخبارك|اخبارك|إيه أخبارك|ايه اخبارك|إيه الحال|ايه الحال|إنت عامل|انت عامل|إنتي عاملة|انتي عاملة|عامله\s*ايه|عامله\s*إيه/i.test(
    text,
  );
}

function asksNationality(text: string): boolean {
  return /nationalit|egyptian|مصري|جنسيت|بلدك|منين|من فين|where.*from|which countr|عربي أم/i.test(
    text,
  );
}

function asksMaritalStatus(text: string): boolean {
  return /marri|married|single|متجوز|متزوج|متجوزة|اعزب|عانس|جواز|زوجت|زوج\b/i.test(text);
}

function asksGender(text: string): boolean {
  // Avoid matching "اتولدت" / birth-place questions as gender.
  if (/اتولد|مولود|born/i.test(text) && !/\b(male|female|gender|ذكر|أنثى|جنس)/i.test(text)) {
    return false;
  }
  return /\b(male|female|gender)\b|ذكر|أنثى|جنس(?:ك)?|ولد ولا بنت|انت ولد|انتي بنت/i.test(text);
}

type PatientQuestionIntent =
  | 'greeting'
  | 'empathy'
  | 'symptoms'
  | 'name'
  | 'age'
  | 'residence'
  | 'birthPlace'
  | 'occupation'
  | 'nationality'
  | 'marital'
  | 'gender'
  | 'priorDoctor'
  | 'wellbeing'
  | 'socialHabits'
  | 'hobbies'
  | 'allergy'
  | 'medication'
  | 'familyHistory';

/** Split merged phrases (STT or typed) into separate questions when possible. */
function messageQuestionParts(message: string): string[] {
  const trimmed = message.trim();
  const punctParts = trimmed
    .split(/[؟?،,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  if (punctParts.length > 1) return punctParts;

  const inlineMarkers = [
    /\s+(?=اسمك\s*(?:إ?يه|ايه|eh)\b)/i,
    /\s+(?=اسم\s*حضرتك)/i,
    /\s+(?=what\s+is\s+your\s+name)/i,
    /\s+(?=عندك\s*(?:كم|كام)\s*سنة)/i,
    /\s+(?=عندك\s*(?:كم|كام)\s*سن)/i,
    /\s+(?=عمرك\s*(?:كم|كام)?)/i,
    /\s+(?=how\s*old\b)/i,
    /\s+(?=ساكن(?:ة)?\s*فين)/i,
    /\s+(?=عايش(?:ة)?\s*فين)/i,
    /\s+(?=where\s+do\s+you\s+live)/i,
    /\s+(?=شغلك|بتشتغل|مهنتك|وظيفتك|what\s+do\s+you\s+do|occupation)/i,
    /\s+(?=اتولد(?:ت|تي)?\s*فين)/i,
    /\s+(?=متجوز|متزوج|اعزب)/i,
    /\s+(?=بتدخن|تدخين|بتشرب)/i,
    /\s+(?=إزيك|ازيك|عامل(?:ة)?\s*(?:إيه|ايه|أي|eh|eih)|ايه\s*الأخبار|إيه\s*الأخبار)/i,
    /\s+(?=how\s+are\s+you)/i,
    /\s+(?=بتشتكي|تشتكي|شكواك|شكواكي|الحكاية|القصة)/i,
    /\s+(?=كره|كرة|football)/i,
  ];

  let inlineParts = [trimmed];
  for (const marker of inlineMarkers) {
    const next: string[] = [];
    for (const part of inlineParts) {
      const split = part
        .split(marker)
        .map((s) => s.trim())
        .filter((s) => s.length > 1);
      next.push(...(split.length > 1 ? split : [part]));
    }
    inlineParts = next;
  }
  if (inlineParts.length > 1) return inlineParts;

  // Collective Arabic questions often use "و" without commas.
  const andParts = trimmed
    .split(/\s+و\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  if (andParts.length >= 3) return andParts;

  const tailPatterns = [
    /(?:اسمك\s*إ?يه|اسمك\s*ايه|اسم حضرتك|what is your name)\s*$/i,
    /(?:عندك\s*(?:كم|كام)\s*سنة|عمرك\s*(?:كم|كام)|how\s*old)\s*$/i,
    /(?:ساكن فين|ساكنة فين|عايش فين|where do you live)\s*$/i,
    /(?:روحت.*دكتور|زرت.*دكتور|seen a doctor)\s*$/i,
    /(?:إيه الأخبار|ايه الاخبار|إيه أخبارك|ايه اخبارك|إزيك|ازيك|عامل إيه|how are you)\s*$/i,
  ];

  for (const pattern of tailPatterns) {
    const match = trimmed.match(pattern);
    if (match?.index !== undefined && match.index > 0) {
      const tail = trimmed.slice(match.index).trim();
      const head = trimmed.slice(0, match.index).trim();
      const parts = [head, tail].filter((p) => p.length > 1);
      if (parts.length > 1) return parts;
    }
  }

  return [trimmed];
}

function intentForQuestionPart(part: string): PatientQuestionIntent | null {
  if (isEmpathyOrBlessing(part)) return 'empathy';
  if (asksAboutSymptoms(part)) return 'symptoms';
  if (asksName(part)) return 'name';
  if (asksAge(part)) return 'age';
  if (asksBirthPlace(part)) return 'birthPlace';
  if (asksResidence(part)) return 'residence';
  if (asksOccupation(part)) return 'occupation';
  if (asksPriorDoctorVisit(part)) return 'priorDoctor';
  if (asksNationality(part)) return 'nationality';
  if (asksMaritalStatus(part)) return 'marital';
  if (asksSmokingOrAlcohol(part)) return 'socialHabits';
  if (asksHobbiesOrSport(part)) return 'hobbies';
  if (asksGender(part)) return 'gender';
  if (asksWellbeing(part)) return 'wellbeing';
  if (isGreetingOnly(part) || isDoctorIntroduction(part)) return 'greeting';
  return null;
}

function resolvePatientQuestionIntents(message: string): PatientQuestionIntent[] {
  const parts = messageQuestionParts(message);
  const intents: PatientQuestionIntent[] = [];
  const seen = new Set<PatientQuestionIntent>();
  for (const part of parts) {
    const intent = intentForQuestionPart(part);
    if (intent && !seen.has(intent)) {
      seen.add(intent);
      intents.push(intent);
    }
  }

  // Catch intents still present in the full message when splitting merges phrases
  // like "اسمك ايه عامل ايه".
  const detectors: Array<[PatientQuestionIntent, (text: string) => boolean]> = [
    ['name', asksName],
    ['age', asksAge],
    ['residence', asksResidence],
    ['occupation', asksOccupation],
    ['birthPlace', asksBirthPlace],
    ['wellbeing', asksWellbeing],
    ['priorDoctor', asksPriorDoctorVisit],
    ['nationality', asksNationality],
    ['marital', asksMaritalStatus],
    ['gender', asksGender],
    ['socialHabits', asksSmokingOrAlcohol],
    ['hobbies', asksHobbiesOrSport],
    ['symptoms', asksAboutSymptoms],
  ];
  for (const [intent, detect] of detectors) {
    if (!seen.has(intent) && detect(message)) {
      seen.add(intent);
      intents.push(intent);
    }
  }

  if (intents.length === 0) {
    const fallback = intentForQuestionPart(message);
    if (fallback) intents.push(fallback);
  }
  return intents;
}

function isMultiPartPatientQuestion(message: string): boolean {
  const intents = resolvePatientQuestionIntents(message);
  if (intents.length >= 2) return true;
  return messageQuestionParts(message).length >= 2;
}

function resolvePrimaryPatientQuestionIntent(message: string): PatientQuestionIntent | null {
  const intents = resolvePatientQuestionIntents(message);
  return intents.length > 0 ? intents[intents.length - 1] : null;
}

function asksFamilyHistory(text: string): boolean {
  return /(family history|family.*(history|disease|problem)|تاريخ.*(عائلي|عيلة)|العيلة|عيلتك|أهل.*(مرض|زي|نفس)|history of.*family)/i.test(
    text,
  );
}

function patientSocialHabitsPhrase(caseData: Case, isArabic: boolean): string {
  const social = (caseData.socialHistory || '').toLowerCase();
  const smokes = /smok|cigarette|يدخن|تدخين/.test(social) && !/non-?smok|never smok|لا\s*يدخن|مش\s*بدخن|non smoker/i.test(social);
  const drinks = /alcohol|drink|يشرب|خمر/.test(social) && !/no alcohol|never drink|لا\s*يشرب|مش\s*بشرب|non-?drink/i.test(social);
  if (isArabic) {
    if (!smokes && !drinks) return 'لا، مش بدخن ومش بشرب.';
    if (smokes && !drinks) return 'بدخن، بس مش بشرب.';
    if (!smokes && drinks) return 'مش بدخن، بس بشرب أحيانًا.';
    return 'بدخن وبشرب أحيانًا.';
  }
  if (!smokes && !drinks) return 'I do not smoke or drink alcohol.';
  if (smokes && !drinks) return 'I smoke, but I do not drink alcohol.';
  if (!smokes && drinks) return 'I do not smoke, but I drink occasionally.';
  return 'I smoke and drink occasionally.';
}

function patientBirthPlacePhrase(caseData: Case, isArabic: boolean): string {
  const social = caseData.socialHistory || '';
  const bornMatch = social.match(/born\s+in\s+([^,.]+)/i);
  if (bornMatch) {
    return isArabic ? `اتولدت في ${bornMatch[1].trim()}.` : `I was born in ${bornMatch[1].trim()}.`;
  }
  return patientResidencePhrase(caseData, isArabic);
}

function patientOffTopicDeflectionPhrase(isArabic: boolean): string {
  return isArabic
    ? 'والله مش قادر أفكر في ده دلوقتي، أنا تعبان — ممكن نتكلم في ده بعدين؟'
    : "I'm not feeling well right now, doctor — can we talk about that later?";
}

function patientHobbiesPhrase(caseData: Case, isArabic: boolean): string {
  const social = caseData.socialHistory || '';
  if (/football|soccer|كره|كرة/i.test(social)) {
    return isArabic ? 'بحب كرة القدم.' : 'I like football.';
  }
  if (/sport|رياض/i.test(social)) {
    return isArabic ? 'بحب الرياضة.' : 'I like sports.';
  }
  return patientOffTopicDeflectionPhrase(isArabic);
}

function deterministicReplyForIntent(
  caseData: Case,
  intent: PatientQuestionIntent,
  isArabic: boolean,
  voiceTurn = true,
  userMessage = '',
  history: { role: string; content: string }[] = [],
): string | null {
  const name = caseData.patientName;
  const briefComplaint = voiceTurn
    ? patientComplaintPhrase(caseData, isArabic)
    : patientRichComplaint(caseData, isArabic);

  switch (intent) {
    case 'greeting':
      return patientGreetingOnlyReply(caseData, isArabic, userMessage);
    case 'empathy':
      return patientEmpathyReply(caseData, isArabic);
    case 'wellbeing':
      return patientWellbeingReply(caseData, isArabic, voiceTurn);
    case 'age':
      return isArabic
        ? `عندي ${caseData.patientAge} سنة.`
        : `I am ${caseData.patientAge} years old.`;
    case 'name':
      return isArabic ? `اسمي ${patientNameInLang(caseData, true)}.` : `My name is ${name}.`;
    case 'nationality': {
      const nat = caseData.patientNationality;
      if (isArabic) return /egypt/i.test(nat) ? 'مصري.' : `أنا ${nat}.`;
      return `I am ${nat}.`;
    }
    case 'marital': {
      const social = caseData.socialHistory.toLowerCase();
      const unmarried = /unmarried|not married|single|اعزب|مش متجوز|غير متزوج/i.test(social);
      const married =
        !unmarried && /(?:\bmarried\b|wife|husband|زوجة|زوج[^ا]|متجوز|متزوج)/i.test(social);
      return isArabic
        ? married
          ? 'آه، متجوز.'
          : 'لا، مش متجوز.'
        : married
          ? 'Yes, I am married.'
          : 'No, I am not married.';
    }
    case 'gender': {
      const g = caseData.patientGender.toLowerCase();
      return isArabic ? (g.startsWith('m') ? 'ذكر.' : 'أنثى.') : caseData.patientGender;
    }
    case 'priorDoctor':
      return patientPriorDoctorPhrase(caseData, isArabic);
    case 'residence':
      return patientResidencePhrase(caseData, isArabic);
    case 'occupation':
      return patientOccupationPhrase(caseData, isArabic);
    case 'birthPlace':
      return patientBirthPlacePhrase(caseData, isArabic);
    case 'socialHabits':
      return patientSocialHabitsPhrase(caseData, isArabic);
    case 'hobbies':
      return patientHobbiesPhrase(caseData, isArabic);
    case 'symptoms': {
      // Follow-ups after the vague/brief complaint must add detail — never loop the same line.
      if (
        asksSymptomDetails(userMessage) ||
        isNearDuplicatePatientReply(briefComplaint, history) ||
        isNearDuplicatePatientReply(patientComplaintPhrase(caseData, isArabic), history)
      ) {
        const detailed = patientDetailedComplaint(caseData, isArabic);
        if (!isNearDuplicatePatientReply(detailed, history)) return detailed;
        return null;
      }
      return briefComplaint;
    }
    default:
      return null;
  }
}

function deterministicReplyForIntents(
  caseData: Case,
  intents: PatientQuestionIntent[],
  isArabic: boolean,
  voiceTurn = true,
  userMessage = '',
  history: { role: string; content: string }[] = [],
): string | null {
  if (intents.length === 0) return null;
  if (intents.length === 1) {
    return deterministicReplyForIntent(
      caseData,
      intents[0],
      isArabic,
      voiceTurn,
      userMessage,
      history,
    );
  }

  const replies = intents
    .map((intent) =>
      deterministicReplyForIntent(caseData, intent, isArabic, voiceTurn, userMessage, history),
    )
    .filter((reply): reply is string => !!reply?.trim());

  // Drop exact duplicates (e.g. birth place falling back to residence).
  const unique: string[] = [];
  const seenReplies = new Set<string>();
  for (const reply of replies) {
    const key = reply.replace(/\.\s*$/, '').trim();
    if (seenReplies.has(key)) continue;
    seenReplies.add(key);
    unique.push(reply);
  }

  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];

  if (isArabic) {
    return `${unique.map((reply) => reply.replace(/\.\s*$/, '').trim()).join('، ')}.`;
  }
  return unique.join(' ');
}

function sanitizePatientResponse(
  caseData: Case,
  userMessage: string,
  response: string,
  language: Language,
  voiceTurn = false,
): string {
  const isArabic = resolvePatientLanguage(language, userMessage);
  const trimmed = response.trim();
  if (!trimmed) return trimmed;

  if (voiceTurn) {
    let text = enforcePatientLanguage(truncatePatientAnswer(trimmed, 2), isArabic);
    if (caseData.patientName && text.includes(caseData.patientName)) {
      text = text.replaceAll(caseData.patientName, patientNameInLang(caseData, true));
    }
    return toEgyptianColloquial(text);
  }

  let text = enforcePatientLanguage(truncatePatientAnswer(trimmed, 5), isArabic);
  if (caseData.patientName && text.includes(caseData.patientName)) {
    text = text.replaceAll(caseData.patientName, patientNameInLang(caseData, true));
  }

  const intent = resolvePrimaryPatientQuestionIntent(userMessage);
  if (
    (intent === 'greeting' || isGreetingOnly(userMessage)) &&
    !asksAboutSymptoms(userMessage) &&
    !asksWellbeing(userMessage)
  ) {
    // Model (or cached opening) dumped symptoms on a pure greeting — strip to greeting only.
    const complaintSnippet = caseData.chiefComplaint.toLowerCase().slice(0, 24);
    const responseLower = text.toLowerCase();
    const dumpedComplaint =
      complaintSnippet.length > 8 && responseLower.includes(complaintSnippet.slice(0, 12));
    const dumpedMedical =
      /حمى|سخونية|قشعريرة|صداع|fever|chills|headache|ألم|وجع|ضيق|تنفس|تورم/i.test(text);
    if (dumpedComplaint || dumpedMedical) {
      return toEgyptianColloquial(patientGreetingOnlyReply(caseData, isArabic, userMessage));
    }
  }

  return toEgyptianColloquial(stripEmbeddedEnglishFromArabic(text));
}

function getDeterministicPatientResponse(
  caseData: Case,
  userMessage: string,
  language: Language,
  history: { role: string; content: string }[] = [],
  voiceTurn = false,
): string | null {
  const isArabic = resolvePatientLanguage(language, userMessage);
  const text = userMessage.trim().toLowerCase();
  const intents = resolvePatientQuestionIntents(userMessage);

  if (intents.length > 0) {
    const intentReply = deterministicReplyForIntents(
      caseData,
      intents,
      isArabic,
      voiceTurn,
      userMessage,
      history,
    );
    if (intentReply) {
      // Never replay the exact same canned line the patient just said.
      if (isNearDuplicatePatientReply(intentReply, history)) {
        if (intents.includes('symptoms')) {
          const detailed = patientDetailedComplaint(caseData, isArabic);
          if (detailed && !isNearDuplicatePatientReply(detailed, history)) return detailed;
          const rich = patientRichComplaint(caseData, isArabic);
          if (rich && !isNearDuplicatePatientReply(rich, history)) return rich;
        }
        // Prefer a varied case-grounded line over falling through to generic clarify.
        const alternates = isArabic
          ? [
              'والله يا دكتور أنا لسه مش مرتاح، الموضوع بيأثر عليا في يومي.',
              'بصراحة لسه نفس التعب، ومش لاقي راحة زي الأول.',
              'الموضوع مستمر معايا، وبحس إنّه بيضايقني أكتر مع اليوم.',
            ]
          : [
              'I am still not feeling well, doctor — it keeps affecting my day.',
              'Honestly I still have the same discomfort and cannot rest like before.',
              'It is ongoing and bothers me more as the day goes on.',
            ];
        for (const alternate of alternates) {
          if (!isNearDuplicatePatientReply(alternate, history)) return alternate;
        }
      }
      return intentReply;
    }
  }

  if (isEmpathyOrBlessing(userMessage)) {
    return patientEmpathyReply(caseData, isArabic);
  }

  if (/allerg|حساس|حساسية/i.test(text)) {
    return isArabic ? 'لا، مفيش حساسية عندي.' : 'No, I have no known drug allergies.';
  }

  if (/medic|drug|tablet|دوا|أدوية|ادوية/i.test(text)) {
    return isArabic ? 'مش باخد أدوية بانتظام دلوقتي.' : 'I am not on regular medications currently.';
  }

  if (asksFamilyHistory(text)) {
    if (isArabic) {
      if (/hypertension|high blood pressure|ضغط/i.test(caseData.familyHistory)) {
        return 'ماما عندها ضغط.';
      }
      if (/no family|no similar|none/i.test(caseData.familyHistory.toLowerCase())) {
        return 'مفيش حد في العيلة عنده نفس المشكلة.';
      }
      return 'مفيش تاريخ مرضي مهم في العيلة.';
    }
    return `${caseData.familyHistory.split('.')[0].trim()}.`;
  }

  if (asksAboutSymptoms(text)) {
    const reply =
      asksSymptomDetails(text) ||
      isNearDuplicatePatientReply(patientComplaintPhrase(caseData, isArabic), history)
        ? patientDetailedComplaint(caseData, isArabic)
        : patientRichComplaint(caseData, isArabic);
    if (isNearDuplicatePatientReply(reply, history)) return null;
    return reply;
  }

  return null;
}

function mockPatientResponse(
  caseData: Case,
  userMessage: string,
  language: Language,
  history: { role: string; content: string }[] = [],
): string {
  const isArabic = resolvePatientLanguage(language, userMessage);
  const studentTurn = history.filter((m) => m.role === 'STUDENT').length;

  if (isEmpathyOrBlessing(userMessage)) {
    return patientEmpathyReply(caseData, isArabic);
  }

  if (isGreetingOnly(userMessage) || isDoctorIntroduction(userMessage)) {
    if (studentTurn === 0) return patientOpeningReply(caseData, isArabic);
    return isArabic ? 'أهلاً يا دكتور.' : 'Hello doctor.';
  }

  const intent = resolvePrimaryPatientQuestionIntent(userMessage);

  if (intent === 'wellbeing') {
    return patientWellbeingReply(caseData, isArabic, false);
  }
  if (intent === 'symptoms' || asksAboutSymptoms(userMessage)) {
    const brief = patientRichComplaint(caseData, isArabic);
    if (
      asksSymptomDetails(userMessage) ||
      isNearDuplicatePatientReply(brief, history) ||
      isNearDuplicatePatientReply(patientComplaintPhrase(caseData, isArabic), history)
    ) {
      const detailed = patientDetailedComplaint(caseData, isArabic);
      if (!isNearDuplicatePatientReply(detailed, history)) return detailed;
      // Rotate last-resort variety so mock mode does not loop the same line.
      const variants = isArabic
        ? [
            'الشكوى دي مستمرة معايا، وبتتعبني أكتر مع اليوم، ومش عارف أرتاح.',
            'بصراحة يا دكتور الموضوع بيأثر على نومي وشغلي، ومش لاقي راحة.',
            'لسه نفس المشكلة، وبحس إن الوضع مش بيتحسن زي ما كنت متوقع.',
          ]
        : [
            'The problem is still going on and it bothers me more through the day.',
            'Honestly doctor, it is affecting my sleep and work, and I cannot rest.',
            'It is the same problem, and I do not feel it is improving.',
          ];
      for (let i = 0; i < variants.length; i++) {
        const candidate = variants[(studentTurn + i) % variants.length];
        if (!isNearDuplicatePatientReply(candidate, history)) return candidate;
      }
      return variants[studentTurn % variants.length];
    }
    return brief;
  }
  if (intent === 'name') {
    return isArabic
      ? `اسمي ${patientNameInLang(caseData, true)}.`
      : `My name is ${caseData.patientName}.`;
  }

  const deterministic = getDeterministicPatientResponse(caseData, userMessage, language, history, false);
  if (deterministic !== null) return deterministic;

  if (isVagueStudentMessage(userMessage)) {
    return isArabic ? 'مش فاهم قصدك يا دكتور، ممكن توضّح سؤالك؟' : 'Could you clarify your question, doctor?';
  }

  const fallbacks = isArabic
    ? [
        'ممكن توضّح سؤالك أكتر يا دكتور؟',
        'مش فاهم قصدك، ممكن تسأل بطريقة أوضح؟',
        'أنا هنا — اسألني اللي محتاج تعرفه.',
      ]
    : [
        'Could you clarify your question?',
        'I am not sure what you mean — please ask more specifically.',
        'I am here — please ask what you need to know.',
      ];

  return fallbacks[studentTurn % fallbacks.length];
}

function buildZeroParticipationEvaluation(
  caseData: Case,
  messages: SessionMessage[],
  lang: 'AR' | 'EN' = 'EN'
): EvaluationResult {
  const caseTitle = lang === 'AR' ? caseData.titleAr || caseData.titleEn : caseData.titleEn;
  const reportTitle = pickLang('OSCE Evaluation Report', 'تقرير تقييم OSCE', lang);
  const perfSummary = pickLang('Performance Summary', 'ملخص الأداء', lang);
  const commLabel = pickLang('Communication', 'التواصل', lang);
  const histLabel = pickLang('History Taking', 'أخذ التاريخ', lang);
  const reasonLabel = pickLang('Clinical Reasoning', 'التفكير السريري', lang);
  const orgLabel = pickLang('Organization', 'التنظيم', lang);
  const closeLabel = pickLang('Closing', 'الختام', lang);
  const overallLabel = pickLang('Overall Score', 'الدرجة الإجمالية', lang);
  const caseLabel = pickLang('Case', 'الحالة', lang);
  const noAttempt = pickLang(
    'No attempt: the station was ended without any interaction with the patient or examiner.',
    'لا توجد محاولة: تم إنهاء المحطة دون أي تفاعل مع المريض أو الممتحن.',
    lang
  );

  return {
    totalScore: 0,
    communicationScore: 0,
    historyTakingScore: 0,
    clinicalReasonScore: 0,
    organizationScore: 0,
    closingScore: 0,
    strengths: pickLang(
      'None recorded — no part of the station was attempted.',
      'لا يوجد — لم تتم محاولة أي جزء من المحطة.',
      lang
    ),
    weaknesses: noAttempt,
    missedQuestions: pickLang(
      'The entire station was missed: history, examination, diagnosis, and management were not attempted.',
      'فاتت المحطة بالكامل: لم تتم محاولة التاريخ أو الفحص أو التشخيص أو الإدارة.',
      lang
    ),
    clinicalErrors: pickLang(
      'Not applicable — no clinical actions were taken.',
      'لا ينطبق — لم تُتخذ أي إجراءات سريرية.',
      lang
    ),
    recommendations: pickLang(
      'Attempt the station: introduce yourself, take a focused history, perform the examination, then give a diagnosis and management plan.',
      'حاول إكمال المحطة: قدّم نفسك، خذ تاريخاً مركزاً، أجرِ الفحص، ثم قدّم التشخيص وخطة الإدارة.',
      lang
    ),
    idealApproach: pickLang(
      `Introduce yourself, confirm identity, explore ${caseData.chiefComplaint} using SOCRATES with exertional symptoms, ask about rheumatic fever and penicillin prophylaxis, complete examination with murmur description, then state ${caseData.finalDiagnosis} with echo referral and management plan.`,
      `قدّم نفسك، تأكد من الهوية، استكشف ${caseData.chiefComplaint} بـ SOCRATES مع أعراض المجهود، اسأل عن الحمى الروماتيزمية والبروفيلاكس بالبنسلين، أكمل الفحص مع وصف الـ murmur، ثم اذكر ${caseData.finalDiagnosis} مع إحالة echo وخطة إدارة.`,
      lang
    ),
    fullReport: `## ${reportTitle}\n\n**${caseLabel}:** ${caseTitle}\n**${overallLabel}:** 0/100\n\n> ${noAttempt}\n\n### ${perfSummary}\n- ${commLabel}: 0/100\n- ${histLabel}: 0/100\n- ${reasonLabel}: 0/100\n- ${orgLabel}: 0/100\n- ${closeLabel}: 0/100`,
  };
}

function mockExaminerEvaluation(
  caseData: Case,
  messages: SessionMessage[],
  lang: 'AR' | 'EN' = 'EN',
  context: EvaluationSessionContext = {}
): EvaluationResult {
  const studentMessages = messages.filter((m) => m.role === 'STUDENT');
  const studentText = studentMessages.map((m) => m.content).join(' ').toLowerCase();
  const studentWordCount = studentText.split(/\s+/).filter((w) => w.length > 1).length;
  const completedManeuversEarly = context.completedManeuvers ?? [];

  // No participation at all → a genuine zero. The student did nothing, so every
  // dimension must score 0 rather than inheriting the base constants below.
  if (studentWordCount === 0 && completedManeuversEarly.length === 0) {
    return buildZeroParticipationEvaluation(caseData, messages, lang);
  }

  const historyMsgCount = studentMessages.filter(
    (m) => m.stage === 'history' || m.stage === 'history:examiner'
  ).length;
  const examMsgCount = studentMessages.filter((m) => m.stage.startsWith('examination:')).length;
  const diagnosisMsgCount = studentMessages.filter((m) => m.stage === 'diagnosis').length;
  const stagesCovered = new Set(studentMessages.map((m) => m.stage)).size;
  const completedManeuvers = context.completedManeuvers ?? [];
  const checklistHits = [
    hasPattern(studentText, /\b(introduc|my name|hello|good (morning|afternoon|evening)|اسم|أنا د|مرحب)/i),
    hasPattern(studentText, /\b(pain|breath|dyspnea|chest|symptom|complaint|ألم|ضيق|تنفس|عرض)/i),
    hasPattern(studentText, /\b(rheumatic|fever|penicillin|prophylaxis|حمى)/i),
    hasPattern(studentText, /\b(medication|medicine|drug|دواء|علاج)/i),
    hasPattern(studentText, /\b(family|عيل|أهل)/i),
    hasPattern(studentText, /\b(syncope|palpitation|orthopnea|إغماء|خفقان)/i),
    hasPattern(studentText, /\b(exertion|exercise|sport|football|مجهود|رياض)/i),
    hasPattern(studentText, /\b(murmur|apex|scar|auscult|palpat|percuss|inspect|صمام|ذرو|ندبة)/i),
  ].filter(Boolean).length;

  const historyText = studentMessages
    .filter((m) => m.stage === 'history' || m.stage === 'history:examiner')
    .map((m) => m.content)
    .join(' ')
    .toLowerCase();
  const examText = studentMessages
    .filter((m) => m.stage.startsWith('examination:'))
    .map((m) => m.content)
    .join(' ')
    .toLowerCase();
  const diagnosisText = studentMessages
    .filter((m) => m.stage === 'diagnosis')
    .map((m) => m.content)
    .join(' ')
    .toLowerCase();

  const askedIntroduction = hasPattern(studentText, /\b(introduc|my name|hello|good (morning|afternoon|evening)|اسم|أنا د|مرحب)/i);
  const askedComplaint = hasPattern(historyText, /\b(pain|breath|dyspnea|chest|symptom|complaint|when|how long|duration|ألم|ضيق|تنفس|عرض)/i);
  const askedRheumatic = hasPattern(historyText, /\b(rheumatic|fever|rheumatic fever|childhood illness|penicillin|prophylaxis|حمى)/i);
  const askedMeds = hasPattern(historyText, /\b(medication|medicine|drug|compliance|prophylaxis|دواء|علاج)/i);
  const askedFamily = hasPattern(historyText, /\b(family|hereditary|genetic|عيل|أهل|family history)/i);
  const askedRedFlags = hasPattern(historyText, /\b(syncope|palpitation|orthopnea|pnd|night sweat|weight|fever|red flag|إغماء|خفقان)/i);
  const askedExertional = hasPattern(historyText, /\b(exertion|exercise|effort|sport|football|activity|مجهود|رياض)/i);
  const describedExam = hasPattern(examText, /\b(murmur|apex|scar|auscult|palpat|percuss|inspect|thrill|heave|صمام|ذرو|ندبة)/i);
  const correctDiagnosis = hasPattern(
    diagnosisText,
    /\b(aortic stenosis|mitral regurg|rheumatic|as\s*\+\s*mr|combined.*stenosis|تضيق.*أورط|قصور.*mitral|rheumatic heart)/i
  );
  const partialDiagnosis = !correctDiagnosis && hasPattern(diagnosisText, /\b(heart|cardiac|valve|murmur|valvular|قلب|صمام)/i);
  const gaveManagement = hasPattern(diagnosisText, /\b(manage|treat|refer|echo|echocardi|follow.?up|penicillin|surgery|intervention|إدارة|علاج|متابعة)/i);

  let communicationScore =
    20 +
    Math.min(25, historyMsgCount * 6) +
    Math.min(20, Math.floor(studentWordCount / 8)) +
    Math.min(15, stagesCovered * 4);
  if (askedIntroduction) communicationScore += 12;
  communicationScore = Math.min(100, communicationScore);

  let historyTakingScore =
    15 +
    Math.min(20, historyMsgCount * 5) +
    checklistHits * 6;
  if (askedComplaint) historyTakingScore += 12;
  if (askedExertional) historyTakingScore += 8;
  if (askedRheumatic) historyTakingScore += 12;
  if (askedMeds) historyTakingScore += 8;
  if (askedFamily) historyTakingScore += 6;
  if (askedRedFlags) historyTakingScore += 10;
  historyTakingScore = Math.min(100, historyTakingScore);

  let clinicalReasonScore =
    10 +
    completedManeuvers.length * 12 +
    Math.min(20, examMsgCount * 8) +
    Math.min(15, diagnosisMsgCount * 10);
  if (describedExam) clinicalReasonScore += 15;
  if (correctDiagnosis) clinicalReasonScore += 35;
  else if (partialDiagnosis) clinicalReasonScore += 16;
  if (gaveManagement) clinicalReasonScore += 12;
  clinicalReasonScore = Math.min(100, clinicalReasonScore);

  const organizationScore = Math.min(
    100,
    18 +
      stagesCovered * 10 +
      Math.min(20, historyMsgCount * 4) +
      (askedIntroduction ? 12 : 0) +
      (askedComplaint ? 10 : 0) +
      completedManeuvers.length * 6
  );
  const closingScore = Math.min(
    100,
    12 +
      Math.min(25, diagnosisMsgCount * 12) +
      Math.min(15, Math.floor(diagnosisText.length / 40)) +
      (correctDiagnosis ? 40 : partialDiagnosis ? 18 : 0) +
      (gaveManagement ? 18 : 0)
  );

  const totalScore = Math.round(
    communicationScore * 0.2 +
      historyTakingScore * 0.3 +
      clinicalReasonScore * 0.25 +
      organizationScore * 0.15 +
      closingScore * 0.1
  );

  const strengths: string[] = [];
  if (askedIntroduction) {
    strengths.push(
      pickLang('Opened with a professional introduction.', 'بدأ بمقدمة مهنية واضحة.', lang)
    );
  }
  if (askedComplaint) {
    strengths.push(
      pickLang('Explored the presenting complaint.', 'استكشف الشكوى الرئيسية.', lang)
    );
  }
  if (askedRheumatic) {
    strengths.push(
      pickLang(
        'Asked about rheumatic fever history — key for this case.',
        'سأل عن تاريخ الحمى الروماتيزمية — مهم جداً في الحالة دي.',
        lang
      )
    );
  }
  if (askedExertional) {
    strengths.push(
      pickLang(
        'Explored exertional symptoms appropriately.',
        'استكشف أعراض المجهود بشكل مناسب.',
        lang
      )
    );
  }
  if (describedExam) {
    strengths.push(
      pickLang(
        'Provided examination findings during the viva.',
        'قدّم ملاحظات فحص سريري أثناء الـ viva.',
        lang
      )
    );
  }
  if (correctDiagnosis) {
    strengths.push(
      pickLang(
        `Correctly identified the diagnosis (${caseData.finalDiagnosis}).`,
        `حدّد التشخيص بشكل صحيح (${caseData.finalDiagnosis}).`,
        lang
      )
    );
  }
  if (strengths.length === 0) {
    strengths.push(
      pickLang(
        'Engaged with the simulated patient and attempted the station.',
        'تفاعل مع المريض المحاكى وحاول إكمال المحطة.',
        lang
      )
    );
  }

  const weaknesses: string[] = [];
  if (!askedIntroduction) {
    weaknesses.push(
      pickLang(
        'Did not clearly introduce themselves or establish rapport.',
        'لم يقدّم نفسه بوضوح أو يبني rapport مع المريض.',
        lang
      )
    );
  }
  if (!askedRheumatic) {
    weaknesses.push(
      pickLang(
        'Did not explore history of rheumatic fever — critical for this case.',
        'لم يسأل عن تاريخ الحمى الروماتيزمية — نقطة حاسمة في الحالة دي.',
        lang
      )
    );
  }
  if (!askedMeds) {
    weaknesses.push(
      pickLang(
        'Insufficient exploration of medication history / penicillin prophylaxis.',
        'استكشاف غير كافٍ لتاريخ الأدوية / البروفيلاكس بالبنسلين.',
        lang
      )
    );
  }
  if (!askedRedFlags) {
    weaknesses.push(
      pickLang(
        'Missed important red-flag screening questions.',
        'فاتته أسئلة مهمّة عن red flags.',
        lang
      )
    );
  }
  if (!describedExam) {
    weaknesses.push(
      pickLang(
        'Limited or no structured examination findings documented.',
        'ملاحظات الفحص السريري محدودة أو غير منظمة.',
        lang
      )
    );
  }
  if (!correctDiagnosis && !partialDiagnosis) {
    weaknesses.push(
      pickLang(
        'Final diagnosis was absent or not clinically supported.',
        'التشخيص النهائي غائب أو غير مدعوم سريرياً.',
        lang
      )
    );
  }
  if (weaknesses.length === 0) {
    weaknesses.push(
      pickLang(
        'Minor refinements needed in systematic coverage and closing summary.',
        'محتاج تحسينات بسيطة في التغطية المنهجية والملخص الختامي.',
        lang
      )
    );
  }

  const missed: string[] = [];
  if (!askedRheumatic) {
    missed.push(
      pickLang(
        'History of rheumatic fever and penicillin prophylaxis compliance',
        'تاريخ الحمى الروماتيزمية والالتزام بالبروفيلاكس بالبنسلين',
        lang
      )
    );
  }
  if (!askedExertional) {
    missed.push(
      pickLang(
        'Exertional dyspnea progression and functional limitation',
        'تطور ضيق النفس مع المجهود والقصور الوظيفي',
        lang
      )
    );
  }
  if (!askedRedFlags) {
    missed.push(
      pickLang('Syncope, palpitations, orthopnea/PND', 'الإغماء، الخفقان، orthopnea/PND', lang)
    );
  }
  if (!askedFamily) {
    missed.push(
      pickLang('Relevant family cardiac history', 'التاريخ العائلي القلبي relevant', lang)
    );
  }
  if (missed.length === 0) {
    missed.push(
      pickLang(
        'Consider deeper exploration of differential diagnoses and investigation planning.',
        'فكّر في استكشاف أعمق للتشخيصات التفاضلية وخطة التحاليل.',
        lang
      )
    );
  }

  const errors: string[] = [];
  if (!correctDiagnosis && diagnosisText.length > 0) {
    errors.push(
      pickLang(
        `Submitted diagnosis did not match the expected: ${caseData.finalDiagnosis}.`,
        `التشخيص المقدّم لا يطابق المتوقع: ${caseData.finalDiagnosis}.`,
        lang
      )
    );
  }
  if (!askedMeds && /penicillin|prophylaxis/i.test(caseData.medicationHistory)) {
    errors.push(
      pickLang(
        'Did not assess penicillin prophylaxis adherence despite it being relevant to the case.',
        'لم يقيّم الالتزام بالبروفيلاكس بالبنسلين رغم أهميته في الحالة.',
        lang
      )
    );
  }
  if (errors.length === 0) {
    errors.push(
      pickLang(
        'No major clinical safety errors identified from the transcript.',
        'لم تُرصد أخطاء سريرية خطيرة في المحادثة.',
        lang
      )
    );
  }

  const caseTitle = lang === 'AR' ? caseData.titleAr || caseData.titleEn : caseData.titleEn;
  const reportTitle = pickLang('OSCE Evaluation Report', 'تقرير تقييم OSCE', lang);
  const perfSummary = pickLang('Performance Summary', 'ملخص الأداء', lang);
  const strengthsTitle = pickLang('Strengths', 'نقاط القوة', lang);
  const improveTitle = pickLang('Areas for Improvement', 'مجالات التحسين', lang);
  const missedTitle = pickLang('Missed Key Questions', 'أسئلة مهمة فاتت', lang);
  const errorsTitle = pickLang('Clinical Errors', 'أخطاء سريرية', lang);
  const commLabel = pickLang('Communication', 'التواصل', lang);
  const histLabel = pickLang('History Taking', 'أخذ التاريخ', lang);
  const reasonLabel = pickLang('Clinical Reasoning', 'التفكير السريري', lang);
  const orgLabel = pickLang('Organization', 'التنظيم', lang);
  const closeLabel = pickLang('Closing', 'الختام', lang);
  const studentMsgsLabel = pickLang('Student messages analyzed', 'رسائل الطالب المحلّلة', lang);
  const overallLabel = pickLang('Overall Score', 'الدرجة الإجمالية', lang);
  const caseLabel = pickLang('Case', 'الحالة', lang);
  const reportFooter = pickLang(
    `Report generated from full session transcript (${messages.length} messages).`,
    `التقرير مُولَّد من محادثة الجلسة الكاملة (${messages.length} رسالة).`,
    lang
  );

  return {
    totalScore,
    communicationScore,
    historyTakingScore,
    clinicalReasonScore,
    organizationScore,
    closingScore,
    strengths: strengths.join(lang === 'AR' ? ' ' : ' '),
    weaknesses: weaknesses.join(lang === 'AR' ? ' ' : ' '),
    missedQuestions: missed.join(lang === 'AR' ? '؛ ' : '; '),
    clinicalErrors: errors.join(lang === 'AR' ? ' ' : ' '),
    recommendations: pickLang(
      'Review systematic cardiac history (SOCRATES + red flags), rheumatic heart disease features, and structured OSCE closing with diagnosis and management plan.',
      'راجع أخذ التاريخ القلبي المنهجي (SOCRATES + red flags)، وسمات مرض القلب الروماتيزمي، وختام OSCE منظم بالتشخيص وخطة الإدارة.',
      lang
    ),
    idealApproach: pickLang(
      `Introduce yourself, confirm identity, explore ${caseData.chiefComplaint} using SOCRATES with exertional symptoms, ask about rheumatic fever and penicillin prophylaxis, complete examination with murmur description, then state ${caseData.finalDiagnosis} with echo referral and management plan.`,
      `قدّم نفسك، تأكد من الهوية، استكشف ${caseData.chiefComplaint} بـ SOCRATES مع أعراض المجهود، اسأل عن الحمى الروماتيزمية والبروفيلاكس بالبنسلين، أكمل الفحص مع وصف الـ murmur، ثم اذكر ${caseData.finalDiagnosis} مع إحالة echo وخطة إدارة.`,
      lang
    ),
    fullReport: `## ${reportTitle}\n\n**${caseLabel}:** ${caseTitle}\n**${studentMsgsLabel}:** ${studentMessages.length}\n**${overallLabel}:** ${totalScore}/100\n\n### ${perfSummary}\n- ${commLabel}: ${communicationScore}/100\n- ${histLabel}: ${historyTakingScore}/100\n- ${reasonLabel}: ${clinicalReasonScore}/100\n- ${orgLabel}: ${organizationScore}/100\n- ${closeLabel}: ${closingScore}/100\n\n### ${strengthsTitle}\n${strengths.map((s) => `- ${s}`).join('\n')}\n\n### ${improveTitle}\n${weaknesses.map((w) => `- ${w}`).join('\n')}\n\n### ${missedTitle}\n${missed.map((m) => `- ${m}`).join('\n')}\n\n### ${errorsTitle}\n${errors.map((e) => `- ${e}`).join('\n')}\n\n---\n*${reportFooter}*`,
  };
}

export async function getExaminerEvaluation(
  caseData: Case,
  messages: SessionMessage[],
  lang: 'AR' | 'EN' = 'EN',
  context: EvaluationSessionContext = {},
  usageMeta?: Omit<AiUsageMeta, 'feature'>,
): Promise<EvaluationResult> {
  const transcript = buildSessionTranscript(caseData, messages);
  const mockResult = mockExaminerEvaluation(caseData, messages, lang, context);
  const settings = await getAISettings();
  const provider = process.env.AI_PROVIDER || settings.provider;

  if (provider === 'mock' || provider === 'demo') {
    return mockResult;
  }

  const knowledgeContext = await getRoleKnowledgeContext({
    categoryId: caseData.categoryId,
    caseId: caseData.id,
    role: 'examiner',
  });
  const systemPrompt =
    buildExaminerEvaluationPrompt(caseData, knowledgeContext, lang) +
    adminSystemPromptSuffix(settings, lang, 'examiner');
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        lang === 'AR'
          ? `قيّم جلسة OSCE الكاملة التالية. حلّل كل رسالة STUDENT قبل وضع الدرجات. اكتب كل الحقول النصية بالعربية فقط:\n\n${transcript}`
          : `Evaluate this complete OSCE session. Analyze every STUDENT message before scoring:\n\n${transcript}`,
    },
  ];

  const raw = await callOpenAISafe(
    chatMessages,
    settings.examinerModel,
    0.3,
    4096,
    () => JSON.stringify(mockResult),
    { feature: 'evaluation', userId: usageMeta?.userId, sessionId: usageMeta?.sessionId },
  );

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<EvaluationResult>;
      const normalized = normalizeEvaluation(parsed, mockResult);
      const withContentScores = {
        ...normalized,
        totalScore: mockResult.totalScore,
        communicationScore: mockResult.communicationScore,
        historyTakingScore: mockResult.historyTakingScore,
        clinicalReasonScore: mockResult.clinicalReasonScore,
        organizationScore: mockResult.organizationScore,
        closingScore: mockResult.closingScore,
      };
      return mergeEvaluationWithLanguage(withContentScores, mockResult, lang);
    }
  } catch {
    // fall through to mock
  }

  return mockResult;
}

export function buildRealtimePatientInstructions(caseData: Case, sessionLanguage: string): string {
  const lang: Language = sessionLanguage === 'EN' ? 'EN' : 'AR';
  if (lang === 'EN') {
    return `You are ${caseData.patientName}, a ${caseData.patientAge}-year-old PATIENT in an OSCE voice call. You are NOT the doctor. You NEVER interview or examine the doctor.

Background (only if asked about that specific topic):
- Chief complaint: ${caseData.chiefComplaint}
- History: ${caseData.medicalHistory}

STRICT RULES:
1. Wait for the doctor's question, then answer in ONE short sentence (two max).
2. NEVER ask the doctor any question. Forbidden: "can you tell me", "does it increase when", "what happens when you", "do you have".
3. Greeting or "how are you" ONLY → "Not great, doctor." or "Hello doctor." — NO symptoms, NO history.
4. Do not volunteer symptoms, age, name, or complaints unless directly asked about that topic.
5. Never reveal the diagnosis (${caseData.finalDiagnosis}).`;
  }

  return `أنت ${caseData.patientName}، مريض/ة مصري/ة عمرك ${caseData.patientAge} سنة. أنت المريض فقط — مش الدكتور ومش الممتحن ومش بتعمل مقابلة طبية.

الخلفية (ممنوع تذكرها إلا لو الدكتور سأل عن نفس الموضوع بالتحديد):
- الشكوى: ${caseData.chiefComplaint}
- التاريخ: ${caseData.medicalHistory}

قواعد صارمة للمكالمة الصوتية:
1. استنى سؤال الدكتور، وبعدين أجب بجملة واحدة أو اتنين بالعامية المصرية فقط.
2. ممنوع تسأل الدكتور أي سؤال. ممنوع تماماً: "ممكن تحكيلي"، "قولي إيه"، "هل عندك"، "لما تتحرك"، "فهمني أكتر"، "توضح".
3. تحية أو "إزيك" أو "إيه الأخبار" أو "عامل إيه" → رد بس: "مش في أحسن حالي دكتور." أو "أهلاً دكتور." — ممنوع تذكر أعراض أو شكوى أو مدة المرض.
4. ممنوع تتكلم من نفسك أو تعرض حالتك أو تسأل الدكتور عن أعراضه — أنت المريض بس.
5. جاوب على السؤال اللي اتسأل بس — مش أكتر.
6. ممنوع الفصحى والإنجليزي. ممنوع تقول التشخيص (${caseData.finalDiagnosis}).`;
}

function patientActingAsDoctor(text: string): boolean {
  return /ممكن تحكيلي|قولي إيه|قولّي إيه|قولي بالظبط|تحكيلي|هل عندك|عندك كحة|لما تتحرك|لما تتعب|tell me if|can you tell|what happens when|do you have|when you move/i.test(
    text,
  );
}

function stripDoctorQuestionsFromPatient(text: string): string {
  const withoutQuestions = text
    .split(/[؟?]/)
    .map((part) => part.trim())
    .filter((part) => part && !patientActingAsDoctor(part))
    .join('. ')
    .trim();
  return withoutQuestions || text.split(/[؟?]/)[0]?.trim() || text;
}

/** Post-process OpenAI Realtime patient audio transcript using the same rules as text chat. */
export function sanitizeRealtimePatientTranscript(
  caseData: Case,
  studentMessage: string,
  patientTranscript: string,
  sessionLanguage: string,
): string {
  const lang: Language = sessionLanguage === 'EN' ? 'EN' : 'AR';
  // Keep realtime voice aligned with core patient rules by preserving the model
  // answer whenever it is usable, instead of overriding with canned text.
  let text = sanitizePatientResponse(caseData, studentMessage, patientTranscript, lang, true);

  if (patientActingAsDoctor(text)) {
    if (asksAboutSymptoms(studentMessage)) {
      text = stripDoctorQuestionsFromPatient(text);
    } else {
      text = lang === 'AR' ? 'مش فاهم قصدك دكتور.' : "I don't understand, doctor.";
    }
  }

  const trimmed = text.trim();
  if (!trimmed) {
    const retry = getDeterministicPatientResponse(caseData, studentMessage, lang, [], true);
    if (retry) return retry;
    return lang === 'AR' ? 'مش فاهم، ممكن توضّح سؤالك؟' : 'Could you clarify your question?';
  }
  return trimmed;
}

export async function getPatientResponse(
  caseData: Case,
  history: { role: string; content: string }[],
  userMessage: string,
  language: Language,
  options?: {
    voiceTurn?: boolean;
    userId?: string;
    sessionId?: string;
    stationConfig?: StationConfig | null;
    patientBehavior?: PatientBehavior | null;
  },
): Promise<string> {
  const normalizedMessage = normalizeStudentMessage(userMessage, language);
  const lang = effectivePatientLanguage(language, normalizedMessage);
  const voiceTurn = !!options?.voiceTurn;
  const studentTurn = history.filter((m) => m.role === 'STUDENT').length;
  const patientBehavior =
    options?.patientBehavior ??
    options?.stationConfig?.patientBehavior ??
    null;

  const [customPatientKnowledge, settings] = await Promise.all([
    hasPatientAiKnowledge({
      caseId: caseData.id,
      categoryId: caseData.categoryId,
    }),
    getAISettingsCached(),
  ]);

  // Pure greetings must never dump medical history — even when admin AI knowledge exists.
  if (
    isGreetingOnly(normalizedMessage) &&
    !asksAboutSymptoms(normalizedMessage) &&
    !asksWellbeing(normalizedMessage)
  ) {
    const greeting = patientGreetingOnlyReply(
      caseData,
      resolvePatientLanguage(lang, normalizedMessage),
      normalizedMessage,
    );
    return finalizePatientReply(caseData, normalizedMessage, greeting, lang, history, voiceTurn);
  }

  // Skip other canned social scripts when admin configured patient AI knowledge.
  if (!customPatientKnowledge) {
    const social = quickSocialPatientReply(caseData, normalizedMessage, lang, history, voiceTurn);
    if (social) {
      return finalizePatientReply(caseData, normalizedMessage, social, lang, history, voiceTurn);
    }
  }

  const multiPart = !voiceTurn && isMultiPartPatientQuestion(normalizedMessage);

  // Multi-part chat questions must get a complete bundled answer. Prefer deterministic
  // even when admin patient knowledge exists — otherwise the model often answers only
  // the first 1–2 items and waits for "complete the answer".
  if (multiPart || !customPatientKnowledge) {
    const deterministic = getDeterministicPatientResponse(
      caseData,
      normalizedMessage,
      lang,
      history,
      voiceTurn,
    );
    if (deterministic !== null) {
      // For multi-part, only accept if we actually covered 2+ intents (or symptoms alone).
      const intents = resolvePatientQuestionIntents(normalizedMessage);
      if (!multiPart || intents.length >= 2 || intents.includes('symptoms')) {
        return finalizePatientReply(caseData, normalizedMessage, deterministic, lang, history, voiceTurn);
      }
    }
  }

  const provider = process.env.AI_PROVIDER || settings.provider;

  if (provider === 'mock' || provider === 'demo') {
    return finalizePatientReply(
      caseData,
      normalizedMessage,
      mockPatientResponse(caseData, normalizedMessage, lang, history),
      lang,
      history,
      voiceTurn,
    );
  }

  const knowledgeContext = await getRoleKnowledgeContext({
    categoryId: caseData.categoryId,
    caseId: caseData.id,
    role: 'patient',
  });
  const promptHistory = chatContextWindow(history, settings.maxContextMessages, voiceTurn);
  const multiPartRule = multiPart
    ? `\nMULTI-QUESTION MESSAGE: The doctor asked several questions at once. Answer EVERY part in one reply (name, age, residence, occupation, habits, complaint — whichever was asked). Stay fully in the session language. Never insert English narrative into Arabic replies. Do not invent travel/training stories. Do not stop after the first two facts.`
    : '';
  const systemPrompt =
    buildPatientSystemPrompt(
      caseData,
      lang,
      knowledgeContext,
      voiceTurn,
      studentTurn,
      patientBehavior,
    ) +
    multiPartRule +
    adminSystemPromptSuffix(settings, lang, 'patient');
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...promptHistory.map((m) => ({
      role: (m.role === 'STUDENT' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: normalizedMessage },
  ];

  const voiceModel =
    process.env.OPENAI_VOICE_MODEL ||
    process.env.OPENAI_PATIENT_MODEL ||
    'gpt-4o-mini';
  const activeModel = voiceTurn ? voiceModel : chatPatientModel(settings);
  const maxTokens = voiceTurn
    ? VOICE_PATIENT_MAX_TOKENS
    : Math.min(
        Math.max(settings.maxTokens, multiPart ? CHAT_PATIENT_MULTI_MAX_TOKENS : CHAT_PATIENT_MAX_TOKENS),
        multiPart ? CHAT_PATIENT_MULTI_MAX_TOKENS : CHAT_PATIENT_MAX_TOKENS,
      );
  const temperature = voiceTurn ? 0.3 : Math.min(Math.max(settings.temperature, 0.45), 0.65);
  const chatTimeout = multiPart ? CHAT_MULTI_TIMEOUT_MS : CHAT_TIMEOUT_MS;

  const raw = await callOpenAISafe(
    messages,
    activeModel,
    temperature,
    maxTokens,
    () =>
      voiceTurn
        ? (lang === 'EN' ? 'Sorry, could you clarify?' : 'مش فاهم، ممكن توضّح سؤالك؟')
        : mockPatientResponse(caseData, normalizedMessage, lang, history),
    {
      feature: voiceTurn ? 'realtime' : 'patient_chat',
      userId: options?.userId,
      sessionId: options?.sessionId,
    },
    { timeoutMs: voiceTurn ? VOICE_TIMEOUT_MS : chatTimeout, stream: true },
  );

  const sanitized = sanitizePatientResponse(
    caseData,
    normalizedMessage,
    raw,
    lang,
    voiceTurn,
  );
  const finalized = finalizePatientReply(
    caseData,
    normalizedMessage,
    sanitized,
    lang,
    history,
    voiceTurn,
  );
  const trimmed = finalized.trim();
  if (!trimmed) {
    return lang === 'AR' ? 'مش فاهم، ممكن توضّح سؤالك؟' : 'Could you clarify your question?';
  }
  return trimmed;
}

export interface VivaAnswerEvaluation {
  advance: boolean;
  feedback: string;
}

const VIVA_EVAL_STOP_WORDS = new Set([
  'what',
  'the',
  'how',
  'does',
  'would',
  'which',
  'that',
  'this',
  'with',
  'from',
  'your',
  'you',
  'are',
  'for',
  'and',
  'why',
  'when',
  'where',
  'about',
  'help',
  'role',
  'purpose',
  'features',
  'clinical',
  'patient',
  'examination',
  'history',
  'after',
  'into',
  'they',
  'their',
  'have',
  'has',
  'been',
  'being',
]);

function vivaQuestionKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !VIVA_EVAL_STOP_WORDS.has(word));
}

/** Strip OSCE-style lead-ins so list items become matchable clinical points. */
function stripModelAnswerPreamble(text: string): string {
  return stripMarkdown(text)
    .replace(
      /^(?:the\s+)?(?:main\s+|key\s+|important\s+|expected\s+)?(?:alarm\s+)?(?:symptoms?|signs?|red\s*flags?|findings?|causes?|complications?|features?|points?|answers?)(?:\s+(?:of|for|in|to)\s+[^.:,;]{0,60})?\s*(?:include|are|comprise|consist of|:)\s*/i,
      '',
    )
    .replace(/^(?:include|including|such as|e\.g\.?|for example)\s*:?\s*/i, '')
    .replace(/[.?!]+$/g, '')
    .trim();
}

/** True when a point is a labeled definition like "Guarding: Localized muscle contraction". */
function isLabeledDefinitionPoint(point: string): boolean {
  const cleaned = stripMarkdown(point);
  const match = cleaned.match(/^([^:]{2,60}):\s+(.+)$/);
  if (!match) return false;
  const label = match[1].trim();
  const value = match[2].trim();
  // Short clinical term/label + a definition — keep atomic (do not comma-split).
  return label.split(/\s+/).length <= 5 && value.length >= 3;
}

const REGION_FINDING_LABELS = new Set([
  'abdomen',
  'extremities',
  'hands',
  'eyes',
  'face',
  'facial',
  'neck',
  'legs',
  'general',
  'chest',
  'chest inspection',
  'skin',
  'hair',
  'apex',
  'precordium',
  'limbs',
  'lower limbs',
  'upper limbs',
]);

/** Short clinical cue for coaching — never dump the full definition. */
function extractPointTerm(point: string): string {
  const cleaned = stripMarkdown(point).replace(/[.]+$/g, '').trim();
  if (isLabeledDefinitionPoint(cleaned)) {
    const label = cleaned.split(/:\s*/)[0].trim();
    const value = cleaned.split(/:\s*/).slice(1).join(':').trim();
    if (REGION_FINDING_LABELS.has(label.toLowerCase()) && value.length >= 8) {
      return shortFindingCue(value);
    }
    return label.slice(0, 60);
  }
  return shortFindingCue(cleaned).slice(0, 60);
}

function shortFindingCue(value: string): string {
  const cues: Array<[RegExp, string]> = [
    [/^no\b.*\b(?:pallor|icterus|cyanosis)/i, 'no pallor/icterus/cyanosis'],
    [/periorbital\s+puffiness|facial\s+(?:oedema|edema)|puffy\s+eyes/i, 'periorbital puffiness'],
    [/everted\s+umbilicus/i, 'everted umbilicus'],
    [/full\s+flanks/i, 'full flanks'],
    [/distended|distension/i, 'abdominal distension'],
    [/lower\s+limb|bilateral\s+(?:pitting\s+)?(?:oedema|edema|swelling)|pitting\s+(?:oedema|edema)/i, 'lower limb edema'],
    [/palmar\s+erythema/i, 'palmar erythema'],
    [/leukonychia/i, 'leukonychia'],
    [/scleral\s+icterus|\bjaundice\b|\bicterus\b/i, 'scleral icterus'],
    [/chest\s+tube|\bscar\b|thoracotomy/i, 'scar'],
    [/mid-?axillary/i, 'left mid-axillary line'],
    [/precordial\s+bulge/i, 'no precordial bulge'],
    [/dilated.*veins|superficial\s+veins/i, 'no dilated veins'],
    [/skin\s+lesions|normal\s+chest\s+wall/i, 'normal chest wall'],
    [/no\s+pallor/i, 'no pallor'],
    [/jvp|neck\s+veins/i, 'normal JVP'],
  ];
  for (const [re, label] of cues) {
    if (re.test(value)) return label;
  }
  return value.split(/\s+/).slice(0, 5).join(' ').slice(0, 50).trim();
}

/**
 * Split "Abdomen: ... Extremities: ... Hands: ..." physical-exam prose into
 * progressive viva points (and atomize findings inside each region).
 */
function splitRegionLabeledFindings(text: string): string[] {
  const cleaned = stripMarkdown(text).trim();
  if (!cleaned) return [];

  const re =
    /(?:^|[.!?]\s+|\n+)([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,3})\s*:\s+/g;
  const matches = [...cleaned.matchAll(re)].filter((m) =>
    REGION_FINDING_LABELS.has(m[1].trim().toLowerCase()),
  );
  if (matches.length < 2) return [];

  const points: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const label = matches[i][1].trim();
    const contentStart = (matches[i].index ?? 0) + matches[i][0].length;
    const contentEnd =
      i + 1 < matches.length ? (matches[i + 1].index ?? cleaned.length) : cleaned.length;
    const value = cleaned
      .slice(contentStart, contentEnd)
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .trim();
    if (value.length < 3) continue;
    const atoms = atomizeClinicalFindings(value);
    if (atoms.length >= 2) {
      for (const atom of atoms) points.push(`${label}: ${atom}`);
    } else {
      points.push(`${label}: ${value}`);
    }
  }
  return points.length >= 2 ? points : [];
}

/** Break a findings paragraph into atomic clinical observations. */
function atomizeClinicalFindings(value: string): string[] {
  const cleaned = stripMarkdown(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[.!?]+$/g, '').trim())
    .filter((s) => s.length >= 6);

  const source = sentences.length >= 1 ? sentences : [cleaned];
  const atoms: string[] = [];

  for (const sentence of source) {
    // Skip thin demographic / posture filler as its own scored atom when richer findings exist.
    if (
      (/^(?:middle-aged|elderly|young|male|female|fully conscious|cooperative)\b/i.test(sentence) ||
        /(?:mildly\s+)?tachypneic|sitting upright|cooperative adolescent/i.test(sentence)) &&
      sentence.split(/\s+/).length <= 12 &&
      !/(?:edema|oedema|puffiness|swelling|scar|jaundice|icterus|distend|bulge|vein|lesion)/i.test(
        sentence,
      )
    ) {
      continue;
    }

    const absNeg = sentence.match(/^there\s+is\s+absolutely\s+(.+)$/i);
    const thereIs = absNeg ?? sentence.match(/^there\s+(?:is|are)\s+(.+)$/i);
    if (thereIs?.[1] && /,|\band\b|\bno\b/i.test(thereIs[1])) {
      const parts = thereIs[1]
        .split(/\s*,\s*|\s+and\s+/i)
        .map((p) => p.trim())
        .filter((p) => p.length >= 5);
      if (parts.length >= 2) {
        atoms.push(...parts);
        continue;
      }
    }

    // Scar + anatomic site → two progressive points (video: "scar" then "left mid-axillary").
    const scarSite = sentence.match(
      /^(.+?\bscar\b.+?)\s+in\s+(left\s+mid-?axillary\s+line)\b/i,
    );
    if (scarSite) {
      atoms.push(scarSite[1].trim());
      atoms.push(scarSite[2].trim());
      continue;
    }

    // "No precordial bulge, no dilated veins, no skin lesions" → separate progressive points.
    if (/^no\b/i.test(sentence) && /,\s*no\b/i.test(sentence)) {
      const parts = sentence
        .split(/\s*,\s*(?=no\b)/i)
        .map((p) => p.replace(/[.!?]+$/g, '').trim())
        .filter((p) => p.length >= 5);
      if (parts.length >= 2) {
        atoms.push(...parts);
        continue;
      }
    }

    // Keep "No pallor, icterus, or cyanosis" as ONE screening finding (avoid 8+ micro-points).
    if (/^no\b/i.test(sentence) && /,|\bor\b|\band\b/i.test(sentence)) {
      atoms.push(
        sentence
          .replace(/\s+or\s+/gi, ', ')
          .replace(/,\s*,+/g, ', ')
          .replace(/\s+,/g, ',')
          .replace(/,\s*$/g, '')
          .trim(),
      );
      continue;
    }

    // Adjective skin lists ("smooth, pale, stretched, and shiny") stay one finding.
    if (
      /^(?:the\s+)?skin\b/i.test(sentence) ||
      (sentence.split(/\s+/).length <= 10 &&
        /^(?:[a-z]+,\s+){2,}[a-z]+(?:,?\s+and\s+[a-z]+)?$/i.test(sentence))
    ) {
      atoms.push(sentence);
      continue;
    }

    // "distended abdomen with full flanks and an everted umbilicus"
    if (/\bwith\b.+\band\b/i.test(sentence) && !/\bmust\b|\bshould\b|patient\b/i.test(sentence)) {
      const parts = sentence
        .split(/\s+with\s+|\s+and\s+/i)
        .map((p) => p.replace(/^an\s+/i, '').trim())
        .filter((p) => p.length >= 5 && p.split(/\s+/).length <= 10);
      if (parts.length >= 2) {
        atoms.push(...parts);
        continue;
      }
    }

    atoms.push(sentence);
  }

  const unique: string[] = [];
  for (const atom of atoms) {
    const key = atom.toLowerCase();
    if (unique.some((u) => u.toLowerCase() === key)) continue;
    unique.push(atom);
  }
  // If we skipped demographics and nothing remains, keep the original paragraph.
  if (unique.length === 0 && cleaned) return [cleaned];
  return unique.length >= 2 ? unique : cleaned ? [cleaned] : [];
}

function splitModelAnswerPoints(sampleAnswer: string): string[] {
  const raw = stripMarkdown(sampleAnswer).trim();
  if (!raw) return [];

  // Physical-exam style: multiple anatomical regions with labels.
  const regionPoints = splitRegionLabeledFindings(raw);
  if (regionPoints.length >= 2) return regionPoints;

  const structured = raw
    .split(/\n+|(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/m)
    .flatMap((chunk) => chunk.split(/;\s+/))
    .map((point) => point.replace(/^[-*•\s]+/, '').replace(/\*\*/g, '').trim())
    .filter((point) => point.length >= 3)
    .filter((point) => !/:\s*$/.test(point) && !/^(causes|complications|signs|definition)\b/i.test(point));

  // "The alarm symptoms include: a, b, c" → split the list after the colon.
  // Skip when the answer is already multiple labeled definitions (Guarding:/Rigidity:/...).
  const looksLikeMultiLabeled =
    structured.length >= 2 && structured.filter(isLabeledDefinitionPoint).length >= 2;
  const colonList = raw.match(/^[^:\n]{3,120}:\s*(.+)$/s);
  if (colonList?.[1] && !looksLikeMultiLabeled) {
    const atoms = atomizeClinicalFindings(colonList[1]);
    if (atoms.length >= 2) return atoms;
    const listified = splitProseCauseList(colonList[1]);
    if (listified.length >= 2) return listified;
  }

  if (structured.length >= 2) {
    // Flatten comma-lists only for plain bullets — NEVER break labeled definitions
    // like "Rigidity: Diffuse contraction (Peritonitis, classically ...)".
    const flattened = structured.flatMap((point) => {
      if (isLabeledDefinitionPoint(point)) return [stripMarkdown(point)];
      const atoms = atomizeClinicalFindings(stripModelAnswerPreamble(point) || point);
      if (atoms.length >= 2) return atoms;
      const nested = splitProseCauseList(stripModelAnswerPreamble(point));
      return nested.length >= 2 ? nested : [stripModelAnswerPreamble(point) || point];
    });
    return flattened.filter((point) => point.length >= 3);
  }

  const single = stripModelAnswerPreamble(structured[0] || raw);
  const singleAtoms = atomizeClinicalFindings(single);
  if (singleAtoms.length >= 2) return singleAtoms;
  const listified = splitProseCauseList(single);
  if (listified.length >= 2) return listified;

  // Continuous prose: split into position / purpose / parenthetical concepts.
  const proseConcepts = splitLongProseAnswer(structured[0] || raw);
  if (proseConcepts.length >= 2) return proseConcepts;

  // Last resort: still try listifying the original with preamble stripped.
  const fromRaw = splitProseCauseList(stripModelAnswerPreamble(raw));
  if (fromRaw.length >= 2) return fromRaw;

  return (single ? [single] : []).filter((p) => p.length >= 3);
}

/** Split comma / "and" lists so one correct cause can earn partial credit. */
function splitProseCauseList(text: string): string[] {
  const cleaned = stripModelAnswerPreamble(text);
  if (!cleaned) return [];

  // Instruction-style OSCE prose ("The patient must lie flat and flex...") must NOT
  // be shredded on every "and" — that creates overlapping points and duplicate-credit bugs.
  // Finding lists WITHOUT must/should should still split.
  const looksLikeProseSentence =
    /^(?:the\s+)?(?:patient|doctor|examiner|answer|aim|goal|purpose)\b/i.test(cleaned) ||
    /\bmust\b|\bshould\b|\bin order to\b|\bso that\b/i.test(cleaned);

  if (looksLikeProseSentence) return [];

  if (!/,|\band\b|\bor\b|\//i.test(cleaned)) return [];

  const parts = cleaned
    .split(/\s*,\s*|\s+and\s+|\s+or\s+|\s*\/\s*|\s*&\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .filter((part) => !/^(include|including|such as|e\.g\.?|etc|the|and)\b/i.test(part));

  return parts.length >= 2 ? parts : [];
}

/**
 * Split a long single-paragraph model answer into clinical concept chunks
 * (position / purpose / parenthetical explanation) for progressive viva credit.
 */
function splitLongProseAnswer(text: string): string[] {
  const cleaned = stripMarkdown(text).replace(/[.?!]+$/g, '').trim();
  if (!cleaned || cleaned.split(/\s+/).length < 8) return [];

  const points: string[] = [];
  const parentheticals = [...cleaned.matchAll(/\(([^)]{8,})\)/g)].map((m) => m[1].trim());
  let main = cleaned.replace(/\([^)]{8,}\)/g, ' ').replace(/\s+/g, ' ').trim();
  main = main
    .replace(/^(?:the\s+)?patient\s+must\s+/i, '')
    .replace(/^(?:the\s+)?patient\s+should\s+/i, '')
    .trim();

  // "X to Y" → action/position + purpose
  const purposeSplit = main.split(/\s+to\s+/i);
  if (purposeSplit.length >= 2) {
    const action = purposeSplit[0].trim();
    const purpose = purposeSplit.slice(1).join(' to ').trim();
    if (action.length >= 5) points.push(action);
    // Purpose may still list two concepts with "and the"
    const purposeParts = purpose
      .split(/\s+and\s+the\s+|\s+and\s+/i)
      .map((p) => p.trim())
      .filter((p) => p.length >= 5);
    if (purposeParts.length >= 2) points.push(...purposeParts);
    else if (purpose.length >= 5) points.push(purpose);
  } else if (main.length >= 5) {
    points.push(main);
  }

  for (const paren of parentheticals) {
    const stripped = paren.replace(/^(?:since|because|as|i\.e\.?|e\.g\.?)\s+/i, '').trim();
    if (stripped.length >= 8) points.push(stripped);
  }

  // Deduplicate near-identical chunks
  const unique: string[] = [];
  for (const point of points) {
    const key = point.toLowerCase();
    if (unique.some((u) => u.toLowerCase() === key)) continue;
    unique.push(point);
  }
  return unique.length >= 2 ? unique : [];
}

const GENERIC_MEDICAL_WORDS = new Set([
  'mitral',
  'aortic',
  'tricuspid',
  'pulmonary',
  'ventricular',
  'atrial',
  'cardiac',
  'heart',
  'defect',
  'disease',
  'left',
  'right',
  'thrill',
  'apical',
  'patient',
  'causes',
  'include',
  'the',
  'with',
  'from',
  'and',
  'arteriosus',
]);

const LABEL_TIMING_WORDS = ['systolic', 'diastolic', 'presystolic', 'ejection', 'pansystolic'];
const LABEL_SITE_WORDS = ['parasternal', 'basal', 'epigastric', 'pulmonary', 'tricuspid'];
const LABEL_VOLUME_WORDS = ['minimal', 'earliest', 'mild', 'moderate', 'tense', 'pelvic'];

function stripMarkdown(text: string): string {
  return text.replace(/\*\*/g, '').trim();
}

function requiredLabelTerms(label: string): string[] {
  const lower = stripMarkdown(label).toLowerCase();
  const terms: string[] = [];
  for (const word of LABEL_TIMING_WORDS) {
    if (lower.includes(word)) terms.push(word);
  }
  for (const word of LABEL_SITE_WORDS) {
    if (lower.includes(word)) terms.push(word);
  }
  for (const word of LABEL_VOLUME_WORDS) {
    if (lower.includes(word)) terms.push(word);
  }
  if (lower.includes('left') && lower.includes('parasternal')) terms.push('left');
  if (terms.length === 0 && /\bapical\b/.test(lower)) terms.push('apical');
  return [...new Set(terms)];
}

function requiredValueTerms(value: string): string[] {
  const cleaned = stripMarkdown(value).toLowerCase();
  const abbreviation = cleaned.match(/\(([a-z]{2,8})\)/);
  const words = cleaned
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !GENERIC_MEDICAL_WORDS.has(word));
  // Keep abbreviation as a strong cue, but do NOT drop the rest of the finding words
  // (e.g. Neck/JVP answers should still match "neck veins are normal").
  if (abbreviation) {
    return [...new Set([abbreviation[1], ...words])];
  }
  return words;
}

function normalizeVivaStudentText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u060C\u066B\u066C]/g, ',')
    .replace(/[\u061B]/g, ';')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function colonStructuredPointIsCovered(
  studentLower: string,
  point: string,
  studentRawLower?: string,
): boolean | null {
  const cleaned = stripMarkdown(point);
  const parts = cleaned.split(/:\s*/);
  if (parts.length < 2) return null;

  const label = parts[0].trim();
  const value = parts.slice(1).join(':');
  const labelLower = label.toLowerCase();
  const isRegionLabel = REGION_FINDING_LABELS.has(labelLower);
  const labelTerms = requiredLabelTerms(label);
  const valueTerms = requiredValueTerms(value);
  const defSource = (studentRawLower ?? studentLower).toLowerCase();

  const labelWords = labelLower
    .replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !VIVA_EVAL_STOP_WORDS.has(w));
  const labelMentioned =
    (!isRegionLabel &&
      labelWords.length > 0 &&
      labelWords.every((w) => tokenPresent(studentLower, w) || tokenPresent(defSource, w))) ||
    (!isRegionLabel && labelLower.length >= 5 && (studentLower.includes(labelLower) || defSource.includes(labelLower)));

  // If the student defines the term, score the DEFINITION meaning — never the bare keyword.
  // Use RAW text so alias expansion does not destroy phrases like "difficulty swallowing".
  const studentDef = extractStudentDefinitionForLabel(defSource, label);
  if (studentDef && !isRegionLabel) {
    return definitionMatchesExpectedValue(studentDef, value, valueTerms);
  }

  // Synonym / plain-English description of the concept without naming the label.
  if (!isRegionLabel && valueTerms.length > 0) {
    const valueHits = valueTerms.filter((term) => tokenPresent(studentLower, term));
    if (valueTerms.length <= 2 && valueHits.length >= 1) return true;
    if (valueHits.length >= 2 || valueHits.length / valueTerms.length >= 0.45) return true;
  }

  // Naming the clinical term alone is OK only when they did NOT attach a wrong definition.
  if (labelMentioned) {
    return true;
  }

  if (labelTerms.length > 0 && !labelTerms.every((term) => studentLower.includes(term))) {
    return isRegionLabel ? null : false;
  }

  // Abbreviation in the model answer (JVP, NAFLD, ...) is enough on its own.
  const abbreviation = value.toLowerCase().match(/\(([a-z]{2,8})\)/);
  if (abbreviation) {
    const abbr = abbreviation[1];
    if (new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(studentLower)) {
      return true;
    }
  }

  const valuePhrase = value.toLowerCase().replace(/[.!?]/g, '').replace(/\s+/g, ' ').trim();
  if (valuePhrase.length >= 10 && studentLower.includes(valuePhrase)) {
    return true;
  }

  if (valueTerms.length === 0) return isRegionLabel ? null : false;

  const valueHits = valueTerms.filter((term) => {
    if (term.length <= 5) {
      return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(studentLower);
    }
    return studentLower.includes(term) || tokenPresent(studentLower, term);
  });
  if (valueTerms.length <= 2) {
    if (valueHits.length >= 1) return true;
    return isRegionLabel ? null : false;
  }
  if (valueHits.length >= 2 || valueHits.length / valueTerms.length >= 0.45) return true;
  return isRegionLabel ? null : false;
}

/** Pull "Term is/means/:= ..." definition text from the student reply, if present. */
function extractStudentDefinitionForLabel(studentLower: string, label: string): string | null {
  const labelLower = label.toLowerCase().trim();
  if (labelLower.length < 3) return null;
  const escaped = labelLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `\\b${escaped}\\b\\s*(?:is|=|:|means|meaning|refers\\s+to|defined\\s+as|يعني|هي|هو)\\s+([^.;\\n]+)`,
      'i',
    ),
    new RegExp(`\\b${escaped}\\b\\s*[—–-]\\s*([^.;\\n]+)`, 'i'),
  ];
  for (const re of patterns) {
    const match = studentLower.match(re);
    if (match?.[1]?.trim() && match[1].trim().split(/\s+/).length >= 2) {
      return match[1].trim();
    }
  }
  return null;
}

function definitionMatchesExpectedValue(
  studentDef: string,
  expectedValue: string,
  valueTerms: string[],
): boolean {
  const expectedLower = expectedValue.toLowerCase();
  const expectedPhrase = expectedLower.replace(/[.!?]/g, '').replace(/\s+/g, ' ').trim();
  // Check raw + alias-expanded forms. Alias expansion can replace phrases like
  // "difficulty swallowing" → "dysphagia", so we must not rely on expanded text alone.
  const pools = [
    studentDef.toLowerCase(),
    expandClinicalAliases(studentDef.toLowerCase()).replace(/\s+/g, ' ').trim(),
  ];

  for (const defLower of pools) {
    if (expectedPhrase.length >= 8 && defLower.includes(expectedPhrase)) return true;

    if (valueTerms.length === 0) {
      const expectedWords = expectedLower
        .replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !VIVA_EVAL_STOP_WORDS.has(w) && !GENERIC_MEDICAL_WORDS.has(w));
      const hits = expectedWords.filter((w) => tokenPresent(defLower, w));
      if (hits.length >= 1 && hits.length / Math.max(expectedWords.length, 1) >= 0.4) return true;
      continue;
    }

    const hits = valueTerms.filter((term) => tokenPresent(defLower, term));
    if (valueTerms.length <= 2) {
      if (hits.length >= 1) return true;
    } else if (hits.length >= 2 || hits.length / valueTerms.length >= 0.45) {
      return true;
    }
  }
  return false;
}

function findWrongLabeledDefinitionFeedback(
  studentAnswer: string,
  sampleAnswer: string,
): string | null {
  // Use RAW text — alias expansion can rewrite correct definitions into false negatives.
  const studentRaw = normalizeVivaStudentText(studentAnswer).toLowerCase();
  const points = splitModelAnswerPoints(sampleAnswer);
  for (const point of points) {
    if (!isLabeledDefinitionPoint(point)) continue;
    const cleaned = stripMarkdown(point);
    const [label, ...rest] = cleaned.split(/:\s*/);
    const value = rest.join(':').trim();
    if (!label || !value) continue;
    const studentDef = extractStudentDefinitionForLabel(studentRaw, label);
    if (!studentDef) continue;
    const valueTerms = requiredValueTerms(value);
    if (definitionMatchesExpectedValue(studentDef, value, valueTerms)) continue;

    const term = extractPointTerm(point);
    return (
      `Not quite — ${term} is not "${studentDef.trim()}". ` +
      `That mixes up the clinical meaning. Think about what ${term} actually describes in clinical practice, then try again.`
    );
  }
  return null;
}

export type VivaStudentIntent =
  | 'answer'
  | 'hint'
  | 'clarify'
  | 'repeat'
  | 'give_up'
  | 'off_topic';

/** Classify Examiner Box messages before scoring — never mark help/chat as wrong answers. */
export function detectVivaStudentIntent(raw: string): VivaStudentIntent {
  const text = normalizeVivaStudentText(raw);
  if (!text) return 'off_topic';
  if (studentGaveUpAnswer(text)) return 'give_up';

  const lower = text.toLowerCase();
  // Avoid \\b with Arabic — it does not treat Arabic letters as word chars.
  if (
    /^(hint|help|coach|مساعدة|ساعدني|لمح|لمّح|تلميح|دربني|درّبني)(\s|$)/i.test(text) ||
    /\b(give\s+me\s+(a\s+)?hint|can\s+you\s+help|coach\s+me|teach\s+me|guide\s+me|what\s+should\s+i\s+(say|write|answer))\b/i.test(
      lower,
    ) ||
    /(عايز|عاوز)\s*(تلميح|مساعدة|hint|coach)/i.test(text)
  ) {
    return 'hint';
  }
  if (
    /\b(repeat(\s+the)?\s+question|say\s+(it\s+)?again|ask\s+again)\b/i.test(lower) ||
    /^(repeat|again)(\s|$)/i.test(text) ||
    /^(أعد|كرر|قول\s*تاني|السؤال\s*تاني)/i.test(text) ||
    /(أعد|كرر).*(سؤال)/i.test(text)
  ) {
    return 'repeat';
  }
  if (
    /\b(i\s+don'?t\s+understand|what\s+do\s+you\s+mean|clarify|rephrase|explain\s+the\s+question)\b/i.test(
      lower,
    ) ||
    /(مش\s*فاهم|مو\s*فاهم|وضح|اشرح\s*السؤال)/i.test(text)
  ) {
    return 'clarify';
  }
  if (
    (/^(hi|hello|hey|thanks|thank\s+you|ok|okay)(\s|$)/i.test(text) ||
      /^(مرحبا|السلام|شكرا|شكراً|تمام)(\s|$)/i.test(text)) &&
    text.split(/\s+/).length <= 4
  ) {
    return 'off_topic';
  }
  return 'answer';
}

const OSCE_EXAMINER_RULES = `You are an experienced, fair, and supportive OSCE examiner. Assess clinical knowledge, reasoning, and medical accuracy — NOT memorization or exact wording.

# 1 INTENT FIRST
Before scoring, determine intent: answering / hint / clarification / repeat / general question / casual chat / I don't know / skip.
If NOT an answer attempt: do NOT score, do NOT mark correct/incorrect — respond only to the request. advance=false.
"I don't know" = No Answer (teaching reveal allowed), NOT "Wrong".

# 2 MEANING OVER KEYWORDS (CRITICAL)
Evaluate MEDICAL MEANING only. Never mark correct just because a keyword appeared.
Example: "there's no scar" is NOT credit for a scar finding. "odynophagia is tibial tenderness" is WRONG even though the word odynophagia appears.
Accept synonyms, plain English, abbreviations, alternate structure, equivalent clinical concepts, minor spelling/grammar errors.
Reference/model answer is ONE example — not the only acceptable wording.
Only mark incorrect when medical meaning is incorrect.

# 3 REASONING
Reward correct clinical reasoning even if wording differs from the model answer.

# 4–5 MULTIPLE / EXTRA
Accept any medically correct alternative. Extra correct detail must never reduce the score.

# 6 ORDER
Order does not matter unless the question asks for sequence/priority.

# 7 FULL
If medically complete: advance=true, brief confirmation, no unnecessary extra wording.

# 8 PARTIAL
Acknowledge only what the student already said correctly. Encourage continuation. advance=false.
Do NOT reveal missing answer items. Reveal specifics only on hint request or give-up.

# 9 INCORRECT
Do not say only "Wrong." Explain the misconception briefly and educationally. Never embarrass.

# 10 MINOR VS MAJOR
Supportive tone for minor omissions. Clearly identify major medical misconceptions.

# 11–12 OPEN / NO GUESSING
Credit every correct point mentioned. Never assume unstated meaning (e.g. "Calcium" ≠ Hypercalcemia).

# 13–15 LANGUAGE / FAIRNESS
Ignore minor language errors unless they change meaning. Be fair — not overly strict or generous.

# 16–17 STYLE / BEHAVIOR
Professional, supportive, educational. Vary phrasing naturally. English only in feedback. 2-4 short sentences.

# 18 GOLD STANDARD
Compare against the underlying medical concept — not reference wording.

CRITICAL — NEVER LEAK THE KEY:
- NEVER name/list/paraphrase unanswered model items the student did not say.
- NEVER say "mention X and Y" for remaining points.
- For partial: say more points are expected — without naming them.

Return ONLY valid JSON: {"advance":true|false,"feedback":"..."}`;

/** @deprecated use OSCE_EXAMINER_RULES */
const OSCE_EXAMINER_BOX_RULES = OSCE_EXAMINER_RULES;

/** True when feedback names missing model-answer content the student never said. */
function feedbackLeaksMissingPoints(
  feedback: string,
  studentAnswer: string,
  sampleAnswer: string,
): boolean {
  if (!feedback.trim() || !sampleAnswer.trim()) return false;
  const studentLower = normalizeVivaStudentText(studentAnswer).toLowerCase();
  const combinedStudent = expandClinicalAliases(studentLower);
  const { missing } = scoreAnswerAgainstModel(studentAnswer, sampleAnswer);
  const fb = feedback.toLowerCase();
  for (const point of missing) {
    const term = shortPointLabel(point).toLowerCase().trim();
    if (term.length < 5) continue;
    // Student already said this term → not a leak.
    if (combinedStudent.includes(term) || studentLower.includes(term)) continue;
    // Distinctive multi-word clinical labels in feedback = leak.
    if (term.split(/\s+/).length >= 2 && fb.includes(term)) return true;
    // Single strong clinical tokens (regurgitation, stenosis, constrictive...)
    const tokens = term
      .replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 7);
    if (tokens.some((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(fb))) {
      return true;
    }
  }
  return false;
}

function pointKeywords(point: string): string[] {
  return point
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !VIVA_EVAL_STOP_WORDS.has(word));
}

/** Expand common clinical synonyms so students need not quote the model answer. */
function expandClinicalAliases(text: string): string {
  let out = ` ${text.toLowerCase()} `;
  const aliases: Array<[RegExp, string]> = [
    // Map colloquial / alternate phrasing → canonical model terms (student side).
    [/\bdifficulty\s+swallowing\b/g, ' dysphagia '],
    [/\bpainful\s+swallowing\b/g, ' odynophagia '],
    [/\bgi\s*bleed(?:ing)?\b/g, ' gastrointestinal bleed '],
    [/\bmelena\b|\bmelaena\b/g, ' gastrointestinal bleed '],
    [/\bhematemesis\b|\bhaematemesis\b/g, ' gastrointestinal bleed '],
    [/\bunintentional\s+weight\s*loss\b|\bweight\s*loss\b/g, ' unintentional weight loss '],
    [/\banemia\b|\banaemia\b/g, ' anemia '],
    [/\bmass\s+in\s+(?:the\s+)?epigastrium\b|\bepigastric\s+mass\b/g, ' epigastric mass '],
    // Examination / inspection phrasing
    [/\bpuffy\s+eyes\b|\bfacial\s+(?:oedema|edema)\b|\bperiorbital\s+(?:oedema|edema)\b|\bpuffiness\b/g, ' periorbital puffiness '],
    [/\bdistension\b|\bdistended\b|\bswollen\s+abdomen\b/g, ' distended distension '],
    [/\beverted\s+umbilicus\b|\bumbilicus\s+everted\b/g, ' everted umbilicus '],
    [/\bfull\s+flanks\b|\bflanks?\s+full\b/g, ' full flanks '],
    [
      /\blower\s+limb\s+(?:oedema|edema)\b|\bleg\s+(?:oedema|edema)\b|\bleg\s+swelling\b|\bbilateral\s+(?:leg\s+)?swelling\b|\bpitting\s+(?:oedema|edema)\b/g,
      ' lower limb edema bilateral swelling pitting ',
    ],
    [/\bnormal\s+chest\s+wall\b/g, ' no chest skin lesions '],
    [/\bno\s+dilated\s+(?:superficial\s+)?veins\b/g, ' no dilated collateral superficial veins '],
    [/\bleft\s+(?:side|chest|axilla)\b/g, ' left mid-axillary line '],
    // Negated scar must NOT expand into a positive scar hit ("there's no scar").
    [/\bthere(?:'s|\s+is)\s+no\s+(?:a\s+|any\s+)?scar\b/g, ' negated_scar_finding '],
    [/\b(?:no|without|absent|denies?)\s+(?:a\s+|any\s+|visible\s+)?scar\b/g, ' negated_scar_finding '],
    [/\b(?:there'?s|there\s+is)\s+a\s+scar\b|\bscar\b|\bndبة\b/g, ' scar chest tube '],
    [/\bicterus\b|\bjaundice\b/g, ' scleral icterus jaundice icterus '],
    [/\bjvp\b|\bjugular\s+(?:venous\s+)?pulse\b|\bneck\s+veins?\b/g, ' jvp neck veins normal '],
    [/\bno\s+pallor\b|\bpallor\b/g, ' no pallor pallor '],
    [/\bno\s+cyanosis\b|\bcyanosis\b/g, ' no cyanosis cyanosis '],
    [
      /\bsmooth\b.*\bpale\b|\bpale\b.*\bstretched\b|\bstretched\b.*\bshiny\b|\bshiny\s+skin\b/g,
      ' smooth pale stretched shiny skin ',
    ],
    [
      /\bno\s+redness\b|\bno\s+localized\s+redness\b|\bvaricose\s+veins\b|\bno\s+pigmentation\b/g,
      ' no localized redness pigmentation varicose veins ',
    ],
  ];
  for (const [pattern, replacement] of aliases) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Soft stem match so distension≈distended, edema≈oedematous, etc. */
function tokensRoughlyMatch(studentToken: string, pointToken: string): boolean {
  if (studentToken === pointToken) return true;
  if (studentToken.length < 5 || pointToken.length < 5) return false;

  // Shared stem with different clinical endings must NOT match
  // (pericardial ≠ pericarditis, regurgitation ≠ regurgitant is OK via stem).
  const shorter = studentToken.length <= pointToken.length ? studentToken : pointToken;
  const longer = studentToken.length <= pointToken.length ? pointToken : studentToken;
  let shared = 0;
  while (shared < shorter.length && shorter[shared] === longer[shared]) shared += 1;
  if (shared >= 6) {
    const endShort = shorter.slice(shared);
    const endLong = longer.slice(shared);
    // Distinct suffixes after a long shared stem → different terms.
    if (endShort.length >= 2 && endLong.length >= 2 && endShort !== endLong) {
      return false;
    }
  }

  const a = studentToken.slice(0, 6);
  const b = pointToken.slice(0, 6);
  if (a === b) return true;
  if (studentToken.startsWith(pointToken.slice(0, 5)) || pointToken.startsWith(studentToken.slice(0, 5))) {
    return true;
  }
  return false;
}

function tokenPresent(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (token.length <= 4) {
    return new RegExp(`\\b${escaped}\\b`).test(haystack);
  }
  if (haystack.includes(token)) return true;
  // Soft stem: allow distension≈distended inside the haystack tokens
  const hayTokens = haystack
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return hayTokens.some((ht) => tokensRoughlyMatch(ht, token.toLowerCase()));
}

/** Direct clinical anchors for examination findings — bypass brittle keyword ratios. */
const EXAM_FINDING_ANCHORS: Array<{ pointHint: RegExp; studentTest: RegExp }> = [
  {
    pointHint: /periorbital|puffiness/i,
    studentTest: /puffy\s+eyes|periorbital|puffiness|facial\s+(?:oedema|edema)/i,
  },
  {
    pointHint: /(?:\bpallor\b|\bicterus\b|\bcyanosis\b)/i,
    studentTest: /\bpallor\b|\bicterus\b|\bjaundice\b|\bcyanosis\b/i,
  },
  {
    pointHint: /\bjvp\b|neck\s+veins|jugular/i,
    studentTest: /\bjvp\b|neck\s+veins|jugular/i,
  },
  {
    pointHint: /swelling|oedema|edema|mid-?thighs|dorsum of both feet/i,
    studentTest: /(?:lower\s+limb\s+)?(?:oedema|edema)|swelling|pitting/i,
  },
  {
    pointHint: /smooth|stretched|shiny/i,
    studentTest: /\bsmooth\b|\bpale\b|\bstretched\b|\bshiny\b/i,
  },
  {
    pointHint: /redness|pigmentation|varicose/i,
    studentTest: /redness|pigmentation|varicose/i,
  },
  // AS+MR / chest inspection — positive scar mentions (negation handled separately).
  {
    pointHint: /\bscar\b|chest\s+tube|thoracotomy/i,
    studentTest: /\bscar\b|\bndبة\b|chest\s+tube|thoracotomy/i,
  },
  {
    pointHint: /mid-?axillary/i,
    studentTest: /mid-?axillary|left\s+(?:side|chest|axilla)/i,
  },
  {
    pointHint: /precordial\s+bulge/i,
    studentTest: /precordial\s+bulge/i,
  },
  {
    pointHint: /dilated.*veins|superficial\s+veins/i,
    studentTest: /dilated\s+(?:superficial\s+)?veins|superficial\s+veins/i,
  },
  {
    pointHint: /skin\s+lesions/i,
    studentTest: /skin\s+lesions|normal\s+chest\s+wall/i,
  },
];

function studentNegatesTerm(studentLower: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(
      `\\b(?:no|without|absent|denies?|negative\\s+for)\\s+(?:a\\s+|any\\s+|visible\\s+|obvious\\s+)?${escaped}\\b`,
      'i',
    ).test(studentLower) ||
    new RegExp(`\\bthere(?:'s|\\s+is|\\s+are)\\s+no\\s+(?:a\\s+|any\\s+)?${escaped}\\b`, 'i').test(
      studentLower,
    ) ||
    new RegExp(
      `\\b${escaped}\\s+(?:is|are)\\s+(?:absent|not\\s+present|not\\s+seen|not\\s+visible)\\b`,
      'i',
    ).test(studentLower)
  );
}

/** True when the model point expects a POSITIVE finding (scar present), not "no X". */
function modelPointExpectsPositiveFinding(point: string): boolean {
  const p = stripMarkdown(point).toLowerCase().trim();
  if (/^no\b/i.test(p)) return false;
  if (/\bno\s+(?:precordial|dilated|chest\s+skin|pallor|localized|or)\b/i.test(p)) return false;
  return true;
}

function examFindingAnchorCovered(studentLower: string, point: string): boolean {
  const pointText = stripMarkdown(point);
  // Require at least 2 student hits for skin descriptors to avoid "pale" alone matching.
  for (const { pointHint, studentTest } of EXAM_FINDING_ANCHORS) {
    if (!pointHint.test(pointText)) continue;
    if (!studentTest.test(studentLower)) continue;
    if (/smooth|stretched|shiny/i.test(pointText)) {
      const hits = ['smooth', 'pale', 'stretched', 'shiny'].filter((w) =>
        new RegExp(`\\b${w}\\b`, 'i').test(studentLower),
      );
      if (hits.length < 2) continue;
    }
    // "there's no scar" must never credit a positive scar / chest-tube finding.
    if (
      /\bscar\b|chest\s+tube|thoracotomy|ندبة/i.test(pointText) &&
      modelPointExpectsPositiveFinding(pointText) &&
      (studentNegatesTerm(studentLower, 'scar') ||
        studentNegatesTerm(studentLower, 'ندبة') ||
        /\bnegated_scar_finding\b/i.test(studentLower))
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function pointIsCovered(studentLower: string, point: string, studentRawLower?: string): boolean {
  const rawLower = studentRawLower ?? studentLower;
  const cleaned = stripMarkdown(point);
  const pointLower = cleaned.toLowerCase();

  // Hard rule: negating a positive finding is never credit for that finding.
  if (
    modelPointExpectsPositiveFinding(cleaned) &&
    (/\bscar\b|chest\s+tube|thoracotomy/i.test(pointLower)
      ? studentNegatesTerm(rawLower, 'scar') ||
        studentNegatesTerm(rawLower, 'ندبة') ||
        /\bnegated_scar_finding\b/i.test(studentLower)
      : false)
  ) {
    return false;
  }

  // Fast path for OSCE inspection/palpation prose (Oedema, Ascites, etc.).
  if (examFindingAnchorCovered(studentLower, point)) return true;

  const colonMatch = colonStructuredPointIsCovered(studentLower, point, rawLower);
  if (colonMatch !== null) return colonMatch;

  // Expand only the student text — never inflate the model point with shared filler words.
  const studentExpanded = expandClinicalAliases(studentLower);

  // After alias expansion, negated scar must still not match positive scar points.
  if (
    modelPointExpectsPositiveFinding(cleaned) &&
    /\bscar\b|chest\s+tube|thoracotomy/i.test(pointLower) &&
    /\bnegated_scar_finding\b/i.test(studentExpanded)
  ) {
    return false;
  }

  const abbreviation = cleaned.match(/\(([A-Za-z]{2,8})\)/);
  if (abbreviation) {
    const abbr = abbreviation[1].toLowerCase();
    if (new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(studentExpanded)) {
      return true;
    }
    const corePhrase = pointLower
      .replace(/\([^)]*\)/g, '')
      .replace(/[.!?]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (corePhrase.length >= 8 && studentExpanded.includes(corePhrase)) {
      return true;
    }
  }

  const compactPoint = pointLower.replace(/[.!?]/g, '').replace(/\s+/g, ' ').trim();
  if (compactPoint.length >= 5 && studentExpanded.includes(compactPoint)) {
    return true;
  }

  const keywords = pointKeywords(pointLower);
  if (keywords.length === 0) return false;
  const hits = keywords.filter((word) => tokenPresent(studentExpanded, word));

  // One-word points: a single distinctive hit is enough ("dysphagia", "guarding").
  if (keywords.length === 1) return hits.length >= 1;
  // Two-word clinical labels ("constrictive pericarditis"): require BOTH — never credit
  // from a soft-stem cousin like pericardial ≈ pericarditis alone.
  if (keywords.length === 2) return hits.length >= 2;

  // Longer points: never credit from a single shared word like "abdominal".
  // Require ≥2 keyword hits (or ≥ half of keywords).
  if (hits.length >= 2) return true;
  return hits.length / keywords.length >= 0.5;
}

/** Test/debug helpers — used by scripts/debug-*.ts only. */
export function debugSplitVivaPoints(sampleAnswer: string): string[] {
  return splitModelAnswerPoints(sampleAnswer);
}

export function debugScoreViva(
  studentAnswer: string,
  sampleAnswer: string,
): { coverage: number; matched: string[]; missing: string[] } {
  return scoreAnswerAgainstModel(studentAnswer, sampleAnswer);
}

export function debugEvaluateHistoryVivaLocal(
  studentAnswer: string,
  sampleAnswer: string,
  combinedStudentAnswer?: string,
): VivaAnswerEvaluation {
  return evaluateHistoryVivaAnswerFromModel(studentAnswer, sampleAnswer, combinedStudentAnswer);
}

function scoreAnswerAgainstModel(
  studentAnswer: string,
  sampleAnswer: string,
): { coverage: number; matched: string[]; missing: string[] } {
  const points = splitModelAnswerPoints(sampleAnswer);
  if (points.length === 0) {
    return { coverage: 0, matched: [], missing: [] };
  }
  const studentRaw = normalizeVivaStudentText(studentAnswer).toLowerCase();
  const studentLower = expandClinicalAliases(studentRaw);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const point of points) {
    if (pointIsCovered(studentLower, point, studentRaw)) matched.push(point);
    else missing.push(point);
  }
  return {
    coverage: matched.length / points.length,
    matched,
    missing,
  };
}

function shortPointLabel(point: string): string {
  // Always prefer the clinical TERM (Guarding / Rigidity) — never leak the definition text.
  const term = extractPointTerm(point).replace(/\bno\s+or\b/gi, 'no').replace(/\s+/g, ' ').trim();
  if (term && term.length <= 40) return term;
  const cleaned = stripModelAnswerPreamble(stripMarkdown(point)).replace(/[.]+$/g, '').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return cleaned.slice(0, 50).trim();
  const clinical = words.filter(
    (word) =>
      word.length >= 5 &&
      !VIVA_EVAL_STOP_WORDS.has(word.toLowerCase()) &&
      !/^(include|symptoms?|alarm|findings?|features?|localized|diffuse|muscle|contraction|pain|release)$/i.test(
        word,
      ),
  );
  if (clinical.length > 0) return clinical.slice(0, 3).join(' ').slice(0, 50);
  return cleaned.slice(0, 40).trim();
}

function pickVariedPhrase(seed: string, options: string[]): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return options[(hash >>> 0) % options.length] ?? options[0];
}

function praiseSinglePoint(label: string, remaining: number, seedExtra = ''): string {
  const seed = `${label}|${remaining}|${seedExtra}`;
  const openers = [
    `You've correctly identified ${label}.`,
    `Good — ${label} is correct.`,
    `Nice point: ${label}.`,
    `Well spotted — ${label}.`,
    `Correct on ${label}.`,
    `Good. You've mentioned ${label}, which is an important observation.`,
    `Yes — ${label} is one of the expected points.`,
  ];
  const open = pickVariedPhrase(seed, openers);
  const followUpsOne = [
    `However, there is still one more expected point. Can you add it?`,
    `One more related point is still expected — what else would you include?`,
    `Almost there: one expected point is still missing. Keep going.`,
  ];
  const followUpsMany = [
    `Can you add any other expected points?`,
    `What else belongs on this list?`,
    `Keep going systematically — more expected points are still missing.`,
    `Good start. Add the next expected point.`,
  ];
  const follow =
    remaining === 1
      ? pickVariedPhrase(`${seed}|ask`, followUpsOne)
      : pickVariedPhrase(`${seed}|ask`, followUpsMany);
  return `${open} ${follow}`.trim();
}

function praiseMultiplePoints(labels: string[], remaining: number, seedExtra = ''): string {
  const list =
    labels.length === 2
      ? `${labels[0]} and ${labels[1]}`
      : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
  const seed = `${list}|${remaining}|${seedExtra}`;
  const openers = [
    `Well done — you've correctly covered ${list}.`,
    `Good progress: ${list} are correct.`,
    `Nice work noting ${list}.`,
    `You've got ${list} right so far.`,
  ];
  const open = pickVariedPhrase(seed, openers);
  const follow =
    remaining === 1
      ? pickVariedPhrase(
          `${seed}|ask`,
          [
            `However, there is still one more expected point that is missing. Can you add it?`,
            `One final expected point is still missing — can you think of it?`,
          ],
        )
      : pickVariedPhrase(
          `${seed}|ask`,
          [
            `However, a few more expected points are still missing. Keep going.`,
            `Continue with the next expected point — without repeating what you already said.`,
          ],
        );
  return `${open} ${follow}`.trim();
}

function buildPartialCreditFeedback(
  matched: string[],
  missing: string[],
  options?: { duplicateAttempt?: boolean; newlyMatched?: string[]; noNewProgress?: boolean },
): string {
  if (missing.length === 0) {
    const labels = matched.slice(0, 8).map(shortPointLabel).filter(Boolean);
    if (labels.length >= 2) {
      const list =
        labels.length === 2
          ? `${labels[0]} and ${labels[1]}`
          : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
      return pickVariedPhrase(
        `done|${list}`,
        [
          `Excellent! You've now covered all the expected findings: ${list}. Great job!`,
          `Perfect — all expected points are covered: ${list}. Well done!`,
          `That's complete. You covered ${list}. Excellent work!`,
        ],
      );
    }
    return pickVariedPhrase('done|single', [
      'Correct — you covered all the expected key points. Great job!',
      'Excellent — that completes the expected answer. Well done!',
    ]);
  }

  // Soft coaching only: acknowledge what is correct. Do NOT quote remaining definitions.
  const highlight =
    options?.newlyMatched && options.newlyMatched.length > 0 ? options.newlyMatched : matched;
  const correctLabels = highlight.slice(0, 3).map(shortPointLabel).filter(Boolean);
  const remaining = missing.length;
  const varietySeed = `${matched.length}:${remaining}:${correctLabels.join('|')}`;

  if (options?.noNewProgress) {
    return remaining === 1
      ? pickVariedPhrase(
          `noprog|1|${varietySeed}`,
          [
            `I didn't catch a new expected finding in that reply. You already have solid points — one more is still expected. Keep going.`,
            `That reply didn't add a new expected point. One more is still missing — try another angle.`,
          ],
        )
      : pickVariedPhrase(
          `noprog|n|${varietySeed}`,
          [
            `I didn't catch a new expected finding in that reply. Keep going systematically — ${remaining} expected points are still missing.`,
            `No new expected point there. Continue — ${remaining} points are still outstanding.`,
          ],
        );
  }

  if (options?.duplicateAttempt) {
    return remaining === 1
      ? pickVariedPhrase(
          `dup|1|${varietySeed}`,
          [
            `Good so far — you already covered that point. One more related point is still expected. Keep going.`,
            `You already mentioned that. One expected point is still missing — add something new.`,
          ],
        )
      : pickVariedPhrase(
          `dup|n|${varietySeed}`,
          [
            `Good so far — you already covered that point. Keep going: ${remaining} expected points are still missing.`,
            `That point is already credited. Add a new one — ${remaining} expected points remain.`,
          ],
        );
  }

  if (correctLabels.length === 0) {
    return remaining === 1
      ? `Not complete yet — try one clear clinical point, then we can build on it.`
      : `Not complete yet — try listing the main clinical points systematically, one by one. I will coach you as you go.`;
  }

  if (correctLabels.length === 1) {
    return praiseSinglePoint(correctLabels[0], remaining, varietySeed);
  }

  return praiseMultiplePoints(correctLabels, remaining, varietySeed);
}

function priorCombinedAnswer(combined: string, current: string): string {
  const trimmedCombined = combined.trim();
  const trimmedCurrent = current.trim();
  if (!trimmedCurrent || trimmedCombined === trimmedCurrent) return '';
  if (trimmedCombined.endsWith(trimmedCurrent)) {
    return trimmedCombined.slice(0, trimmedCombined.length - trimmedCurrent.length).replace(/\n+$/, '').trim();
  }
  return trimmedCombined.replace(trimmedCurrent, '').trim();
}

function evaluateHistoryVivaAnswerFromModel(
  studentAnswer: string,
  sampleAnswer: string,
  combinedStudentAnswer?: string,
): VivaAnswerEvaluation {
  const combined = (combinedStudentAnswer ?? studentAnswer).trim();
  const current = studentAnswer.trim();
  const before = priorCombinedAnswer(combined, current);
  const { matched, missing } = scoreAnswerAgainstModel(combined, sampleAnswer);
  const prior = before
    ? scoreAnswerAgainstModel(before, sampleAnswer)
    : { matched: [] as string[], missing };
  const newlyMatched = matched.filter((point) => !prior.matched.includes(point));
  // Only treat as duplicate when THIS attempt itself re-hit already-covered points
  // and added nothing new. Unrecognized new answers must NOT say "already mentioned".
  const currentHits = scoreAnswerAgainstModel(current, sampleAnswer).matched;
  const currentNewHits = currentHits.filter((point) => !prior.matched.includes(point));
  const duplicateAttempt =
    before.length > 0 &&
    newlyMatched.length === 0 &&
    currentNewHits.length === 0 &&
    currentHits.length > 0 &&
    currentHits.every((point) => prior.matched.includes(point));

  // Wrong medical definition attached to a labeled term → educate, never award the keyword.
  const wrongDefinitionFeedback = findWrongLabeledDefinitionFeedback(current, sampleAnswer);
  if (wrongDefinitionFeedback && newlyMatched.length === 0) {
    return {
      advance: false,
      feedback: wrongDefinitionFeedback,
    };
  }

  if (matched.length > 0 && missing.length === 0) {
    return {
      advance: true,
      feedback: buildPartialCreditFeedback(matched, missing),
    };
  }

  // New credit this turn → praise only what was newly covered (video style).
  if (newlyMatched.length > 0) {
    return {
      advance: false,
      feedback: buildPartialCreditFeedback(matched, missing, {
        duplicateAttempt: false,
        newlyMatched,
      }),
    };
  }

  if (duplicateAttempt) {
    return {
      advance: false,
      feedback: buildPartialCreditFeedback(matched, missing, {
        duplicateAttempt: true,
        newlyMatched: [],
      }),
    };
  }

  // Already has some credit, but this reply added nothing recognizable —
  // do NOT re-emit the same praise (that looked like a "fixed" reply).
  if (matched.length > 0 && missing.length > 0 && before.length > 0) {
    return {
      advance: false,
      feedback: buildPartialCreditFeedback(matched, missing, {
        noNewProgress: true,
        newlyMatched: [],
      }),
    };
  }

  const words = current.split(/\s+/).filter(Boolean);
  // Single distinctive clinical tokens ("scar", "edema") can still earn partial credit above.
  if (
    words.length < 2 &&
    !/\b(scar|edema|oedema|murmur|thrill|jaundice|cyanosis|ندبة|clubbing)\b/i.test(current)
  ) {
    return {
      advance: false,
      feedback:
        'That is quite brief. Give one clear clinical point, then we can build the rest of the answer.',
    };
  }

  // Student said something substantial but it didn't match — encourage without leaking the key.
  // Special case: denying an expected positive scar finding.
  if (
    (studentNegatesTerm(current.toLowerCase(), 'scar') ||
      studentNegatesTerm(current.toLowerCase(), 'ندبة')) &&
    splitModelAnswerPoints(sampleAnswer).some(
      (p) => /\bscar\b|chest\s+tube|thoracotomy/i.test(p) && modelPointExpectsPositiveFinding(p),
    )
  ) {
    return {
      advance: false,
      feedback:
        'Not quite — saying there is no scar is incorrect for this case. Look again at the clinical images and describe the positive findings you see.',
    };
  }

  return {
    advance: false,
    feedback:
      'Not complete yet — try listing the main clinical points systematically, one by one. I will coach you as you go.',
  };
}

function mockEvaluateHistoryVivaAnswer(
  vivaQuestion: string,
  studentAnswer: string,
  sampleAnswer?: string,
  combinedStudentAnswer?: string,
): VivaAnswerEvaluation {
  const answer = studentAnswer.trim();
  const combined = (combinedStudentAnswer ?? answer).trim();
  const words = answer.split(/\s+/).filter(Boolean);

  if (sampleAnswer?.trim()) {
    return evaluateHistoryVivaAnswerFromModel(answer, sampleAnswer, combined);
  }

  if (words.length < 3) {
    return {
      advance: false,
      feedback:
        'That is quite brief. Think about the key clinical point in the question and try again.',
    };
  }

  // Without a model answer, stay progressive: require a real topical hit.
  // Do NOT advance just because the reply is long — that is the opposite of viva coaching.
  const keywords = vivaQuestionKeywords(vivaQuestion);
  const lower = combined.toLowerCase();
  const hits = keywords.filter((keyword) => lower.includes(keyword));
  if (hits.length >= 2 || (hits.length >= 1 && words.length >= 8)) {
    return {
      advance: true,
      feedback: 'Good. You covered the key clinical point for this question. Great job!',
    };
  }

  return {
    advance: false,
    feedback:
      hits.length === 1
        ? `Good start — that point is relevant. Add one more focused clinical detail to complete the answer.`
        : 'Not complete yet — give a focused clinical point related to the question, then build on it.',
  };
}

function parseVivaAnswerEvaluation(
  raw: string,
  fallback: () => VivaAnswerEvaluation,
): VivaAnswerEvaluation {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return fallback();
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      advance?: unknown;
      feedback?: unknown;
    };
    if (typeof parsed.advance !== 'boolean') return fallback();
    const feedback = unwrapExaminerPlainText(
      typeof parsed.feedback === 'string' ? parsed.feedback.trim() : '',
    );
    if (!feedback) return fallback();
    if (/question\s+\d+\s+of\s+\d+/i.test(feedback)) return fallback();
    return { advance: parsed.advance, feedback };
  } catch {
    return fallback();
  }
}

/** Shared meaning-first OSCE turn for Examiner Box + Examination. */
async function evaluateOsceMeaningTurn(options: {
  caseData: Case;
  question: string;
  studentAnswer: string;
  combinedAnswer: string;
  sampleAnswer: string;
  questionNumber?: number;
  stationLabel?: string;
  usageMeta?: Omit<AiUsageMeta, 'feature'>;
}): Promise<VivaAnswerEvaluation> {
  const {
    caseData,
    question,
    studentAnswer,
    combinedAnswer,
    sampleAnswer,
    questionNumber,
    stationLabel,
    usageMeta,
  } = options;
  const settings = await getAISettings();
  const provider = process.env.AI_PROVIDER || settings.provider;
  const combined = combinedAnswer.trim();
  const current = studentAnswer.trim();
  const local = mockEvaluateHistoryVivaAnswer(question, current, sampleAnswer, combined);

  const intent = detectVivaStudentIntent(current);
  if (intent === 'hint') {
    return {
      advance: false,
      feedback:
        'Hint: focus on the underlying clinical concept — synonyms and plain English are fine. I will not mark this message as an answer attempt.',
    };
  }
  if (intent === 'repeat') {
    return { advance: false, feedback: `Of course. Here is the question again:\n${question}` };
  }
  if (intent === 'clarify') {
    return {
      advance: false,
      feedback: `Happy to clarify — explain the clinical concept in your own words (synonyms are fine):\n${question}`,
    };
  }
  if (intent === 'off_topic') {
    return { advance: false, feedback: `Let's stay with this viva question:\n${question}` };
  }

  // Hard local safety: wrong labeled definition / negated positive finding.
  if (sampleAnswer.trim()) {
    const wrongDefinitionFeedback = findWrongLabeledDefinitionFeedback(current, sampleAnswer);
    if (wrongDefinitionFeedback) {
      return { advance: false, feedback: unwrapExaminerPlainText(wrongDefinitionFeedback) };
    }
  }

  if (provider === 'mock' || provider === 'demo') {
    return { advance: local.advance, feedback: unwrapExaminerPlainText(local.feedback) };
  }

  const knowledgeContext = await getRoleKnowledgeContext({
    categoryId: caseData.categoryId,
    caseId: caseData.id,
    role: 'examiner',
  });

  const localCoverage = sampleAnswer.trim()
    ? scoreAnswerAgainstModel(combined, sampleAnswer)
    : { coverage: 0, matched: [] as string[], missing: [] as string[] };

  const coverageHint = sampleAnswer.trim()
    ? `\nINTERNAL COVERAGE HINT (do not mention these labels to the student unless they already said them):\n- Likely covered so far: ${
        localCoverage.matched.map(shortPointLabel).filter(Boolean).join('; ') || '(none detected locally)'
      }\n- Still outstanding (DO NOT NAME): ${localCoverage.missing.length} point(s)\n`
    : '';

  const modelAnswerBlock = sampleAnswer.trim()
    ? `\nREFERENCE ANSWER (internal marking key only — evaluate MEANING; NEVER quote/list unanswered items unless student gave up):\n${sampleAnswer.trim()}`
    : '';

  const priorAttempts =
    combined && combined !== current
      ? combined
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && line !== current)
      : [];
  const attemptBlock =
    priorAttempts.length > 0
      ? `\nPrevious attempts for this SAME question (score meaning cumulatively):\n${priorAttempts
          .map((attempt, index) => `${index + 1}. ${attempt}`)
          .join('\n')}\n`
      : '';

  const stationLine = stationLabel ? `\nSTATION / CONTEXT: ${stationLabel}` : '';
  const qNumLine =
    typeof questionNumber === 'number' ? `\nVIVA QUESTION NUMBER: ${questionNumber}` : '';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${OSCE_EXAMINER_RULES}

CASE: ${caseData.titleEn}
DIAGNOSIS (reference only — do not reveal to student): ${caseData.finalDiagnosis}${stationLine}${qNumLine}
${modelAnswerBlock}${coverageHint}${knowledgeContext}`,
    },
    {
      role: 'user',
      content: `Viva / examination prompt: ${question}${attemptBlock}\nLatest student attempt: ${current}\n\nCombined answer so far:\n${combined || '(none)'}`,
    },
  ];

  const raw = await callOpenAISafe(
    messages,
    settings.examinerModel,
    0.2,
    360,
    () => JSON.stringify(local),
    { feature: 'examiner_viva', userId: usageMeta?.userId, sessionId: usageMeta?.sessionId },
  );

  const parsed = parseVivaAnswerEvaluation(raw, () => local);

  // If local already has full coverage, prefer completion (synonyms may be clearer locally).
  if (sampleAnswer.trim() && local.advance) {
    return { advance: true, feedback: unwrapExaminerPlainText(local.feedback) };
  }

  // Hard safety: wrong definition / negation must never advance.
  if (sampleAnswer.trim()) {
    const wrongDefinitionFeedback = findWrongLabeledDefinitionFeedback(current, sampleAnswer);
    if (wrongDefinitionFeedback) {
      return { advance: false, feedback: unwrapExaminerPlainText(wrongDefinitionFeedback) };
    }
  }

  // Hard safety: drop leaked remaining keys.
  if (
    sampleAnswer.trim() &&
    feedbackLeaksMissingPoints(parsed.feedback, combined, sampleAnswer)
  ) {
    return {
      advance: local.advance,
      feedback: unwrapExaminerPlainText(local.feedback),
    };
  }

  // If LLM claims complete but local still sees many uncovered points, stay partial.
  if (
    sampleAnswer.trim() &&
    parsed.advance &&
    localCoverage.missing.length >= 2 &&
    localCoverage.coverage < 0.75
  ) {
    return {
      advance: false,
      feedback: unwrapExaminerPlainText(
        local.feedback ||
          'Good progress so far. Keep going — more expected points are still missing.',
      ),
    };
  }

  return {
    advance: parsed.advance,
    feedback: unwrapExaminerPlainText(parsed.feedback),
  };
}

/** Score a single history-station viva answer; advance only when correct enough or student gave up. */
export async function evaluateHistoryVivaAnswer(
  caseData: Case,
  vivaQuestion: string,
  questionNumber: number,
  studentAnswer: string,
  sampleAnswer = '',
  combinedStudentAnswer?: string,
): Promise<VivaAnswerEvaluation> {
  const combined = (combinedStudentAnswer ?? studentAnswer).trim();
  return evaluateOsceMeaningTurn({
    caseData,
    question: vivaQuestion,
    studentAnswer,
    combinedAnswer: combined,
    sampleAnswer,
    questionNumber,
    stationLabel: 'Examiner Box (History Viva)',
  });
}

export async function getExaminerVivaResponse(
  caseData: Case,
  question: string,
  history: { role: string; content: string }[],
  language: Language = 'AR',
  usageMeta?: Omit<AiUsageMeta, 'feature'>,
): Promise<string> {
  const lang = resolveExaminerLanguage(language, question);
  const settings = await getAISettings();
  const provider = process.env.AI_PROVIDER || settings.provider;
  const caseTitle = lang === 'AR' ? caseData.titleAr || caseData.titleEn : caseData.titleEn;

  if (provider === 'mock' || provider === 'demo') {
    return finalizeExaminerReply(
      lang === 'AR'
        ? `محاولة كويسة. في حالة ${caseTitle}، فكّر في التشخيصات التفريقية والتحاليل اللي بعد كده.`
        : `Good attempt. For this case (${caseTitle}), consider also discussing differential diagnoses and next investigation steps.`,
      lang,
    );
  }

  const knowledgeContext = await getRoleKnowledgeContext({
    categoryId: caseData.categoryId,
    caseId: caseData.id,
    role: 'examiner',
  });
  const promptHistory = chatContextWindow(history, settings.maxContextMessages, true);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are an Egyptian OSCE examiner conducting a viva for case: ${caseTitle}.

CORRECT DIAGNOSIS (reference — do not reveal immediately): ${caseData.finalDiagnosis}
TEACHING POINTS / EXPECTED MANAGEMENT (marking key from case author):
${caseData.teachingPoints || '(not specified)'}

RULES:
1. Ask focused follow-up questions and give brief constructive feedback.
2. PARTIAL CREDIT: if the student states 3 of 4 expected points, acknowledge the 3 correct points and ask only about what is missing. Do NOT say the entire answer is wrong.
3. Use the teaching points above as your marking reference — stay aligned with the case author's expected answer.
4. Do not reveal the full model answer immediately unless the student has clearly failed after a reasonable attempt.
5. ${examinerLangRule(lang)}${knowledgeContext}${adminSystemPromptSuffix(settings, lang, 'examiner')}`,
    },
    ...promptHistory.map((m) => ({
      role: (m.role === 'STUDENT' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: question },
  ];

  const reply = await callOpenAISafe(
    messages,
    process.env.OPENAI_VOICE_MODEL || settings.examinerModel,
    Math.min(settings.temperature, 0.4),
    Math.min(settings.maxTokens, CHAT_EXAMINER_MAX_TOKENS),
    () =>
      lang === 'AR'
        ? `محاولة كويسة. في حالة ${caseTitle}، فكّر في التشخيصات التفريقية والتحاليل اللي بعد كده.`
        : `Good attempt. For this case (${caseTitle}), consider also discussing differential diagnoses and next investigation steps.`,
    { feature: 'examiner_viva', userId: usageMeta?.userId, sessionId: usageMeta?.sessionId },
  );
  return finalizeExaminerReply(unwrapExaminerPlainText(reply), lang);
}

function maneuverLabel(
  maneuverId: string,
  isArabic: boolean,
  stationConfigRaw?: string | null,
) {
  return resolveManeuverLabel(
    maneuverId,
    parseStationConfig(stationConfigRaw),
    isArabic ? 'ar' : 'en',
  );
}

export function getManeuverOpeningMessage(
  _caseData: Case,
  maneuverId: string,
  _language: Language,
  stationConfig?: import('../lib/stationConfig.js').StationConfig,
): string {
  if (stationConfig) {
    return resolveManeuverOpeningMessage(maneuverId, stationConfig);
  }
  return resolveManeuverOpeningMessage(maneuverId, parseStationConfig(null));
}

export async function getManeuverExaminerResponse(
  caseData: Case,
  maneuverId: string,
  question: string,
  history: { role: string; content: string }[],
  _language: Language,
  usageMeta?: Omit<AiUsageMeta, 'feature'>,
): Promise<string> {
  const name = maneuverLabel(maneuverId, false, caseData.stationConfig);
  const physicalExam = parsePhysicalExamForm(caseData.physicalExam);
  const maneuverFindings =
    physicalExam[maneuverId as keyof typeof physicalExam]?.trim() || '';

  const priorStudentTurns = history
    .filter((m) => {
      const role = String(m.role || '').toUpperCase();
      return role === 'STUDENT' || role === 'USER';
    })
    .map((m) => normalizeVivaStudentText(m.content))
    .filter(Boolean);
  const current = normalizeVivaStudentText(question);
  const combinedFindings = [...priorStudentTurns, current].filter(Boolean).join('\n');

  if (studentGaveUpAnswer(current)) {
    if (maneuverFindings) {
      return unwrapExaminerPlainText(
        `No problem — here are the expected ${name} findings:\n${maneuverFindings}`,
      );
    }
    return unwrapExaminerPlainText(
      `That's fine — it's good to say when you're unsure. For ${name}, review the key clinical signs linked to this case and we can continue.`,
    );
  }

  const prompt = `You are evaluating the student's spoken findings for the "${name}" physical-examination step. Score clinical MEANING against the expected findings — not keywords alone.`;

  const evaluation = await evaluateOsceMeaningTurn({
    caseData,
    question: prompt,
    studentAnswer: current,
    combinedAnswer: combinedFindings,
    sampleAnswer: maneuverFindings,
    stationLabel: `Examination — ${name}`,
    usageMeta,
  });

  if (evaluation.advance) {
    return unwrapExaminerPlainText(
      `${evaluation.feedback} Let's move on when you're ready — you can refine technique or continue to the next examination step.`,
    );
  }
  return unwrapExaminerPlainText(evaluation.feedback);
}

const GAVE_UP_ANSWER_PATTERNS = [
  /\b(i\s*)?(don'?t|do\s*not)\s*know\b/i,
  /\bidk\b/i,
  /\bnot\s*sure\b/i,
  /\bno\s*idea\b/i,
  /\bpass\b/i,
  /مش\s*عارف|مش\s*عارفه|معرفش|معنديش\s*فكره|لا\s*أعرف|ما\s*اعرف|منعرفش/i,
];

function studentGaveUpAnswer(answer: string): boolean {
  const normalized = answer.trim();
  if (!normalized) return false;
  return GAVE_UP_ANSWER_PATTERNS.some((pattern) => pattern.test(normalized));
}

