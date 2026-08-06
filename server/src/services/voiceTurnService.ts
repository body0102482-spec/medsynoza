import { MessageRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  getExaminerVivaResponse,
  getManeuverExaminerResponse,
  getPatientResponse,
  sanitizeRealtimePatientTranscript,
  unwrapExaminerPlainText,
} from './aiService.js';
import {
  isHistoryExaminerVivaStage,
  respondToHistoryVivaAnswer,
} from './examinerVivaService.js';
import {
  fixArabicSpeechTranscript,
  isValidArabicSessionTranscript,
  looksLikeSttHallucination,
} from './arabicSttFix.js';
import { extractPrimaryUtterance, transcribeAudioBuffer } from './transcriptionService.js';
import { getSessionStationConfig } from '../lib/stationConfig.js';

function maneuverStage(maneuverId: string) {
  return `examination:${maneuverId}`;
}

function resolveExpectArabic(
  sessionLanguage: string,
  opts?: { forceArabic?: boolean; language?: string; sessionLang?: string },
): boolean {
  if (opts?.forceArabic === true) return true;
  if (opts?.forceArabic === false) return false;

  const toggle = (opts?.sessionLang || '').toUpperCase();
  if (toggle === 'EN' || toggle === 'AUTO') return false;
  if (toggle === 'AR') return true;

  const code = (opts?.language || '').toLowerCase().trim();
  if (code === 'auto' || code === 'auto-detect' || code.startsWith('en')) return false;
  if (code.startsWith('ar')) return true;

  return sessionLanguage === 'AR';
}

function resolveReplyLanguage(sessionLanguage: string, sessionLang?: string): string {
  const toggle = (sessionLang || '').toUpperCase();
  if (toggle === 'EN' || toggle === 'AR' || toggle === 'AUTO') return toggle;
  return sessionLanguage;
}

function resolveCodeSwitch(
  sessionLanguage: string,
  opts?: { sessionLang?: string; language?: string },
): boolean {
  const toggle = (opts?.sessionLang || sessionLanguage || '').toUpperCase();
  if (toggle === 'AUTO') return true;
  const code = (opts?.language || '').toLowerCase().trim();
  return code === 'auto' || code === 'auto-detect';
}

function normalizeStudentTranscript(raw: string, expectArabic: boolean, codeSwitch = false): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('recording-too-short');

  let text = fixArabicSpeechTranscript(trimmed, expectArabic, codeSwitch);
  if (looksLikeSttHallucination(text, !expectArabic)) {
    // English mode: keep imperfect / short student speech instead of failing the turn.
    if (!expectArabic && /[a-zA-Z\u0600-\u06FF]/.test(text) && text.length >= 2) {
      try {
        return extractPrimaryUtterance(text, true);
      } catch {
        return text;
      }
    }
    throw new Error('transcription-prompt-leak');
  }
  try {
    text = extractPrimaryUtterance(text, !expectArabic);
  } catch (err) {
    if (!expectArabic && text.length >= 2) return text;
    throw err;
  }
  if (!isValidArabicSessionTranscript(text, expectArabic)) {
    if (!expectArabic && /[a-zA-Z\u0600-\u06FF]/.test(text)) return text;
    throw new Error(expectArabic ? 'transcription-not-arabic' : 'transcription-prompt-leak');
  }
  return text;
}

async function loadActiveSession(sessionId: string, userId: string, recentMessages?: number) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId, status: 'IN_PROGRESS' },
    include: {
      case: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        ...(recentMessages ? { take: recentMessages } : {}),
      },
    },
  });
  if (session?.messages?.length) {
    session.messages.reverse();
  }
  return session;
}

interface TurnContext {
  endpoint: 'chat' | 'examiner';
  stage: string;
  maneuverId?: string;
}

export interface VoiceTurnInput extends TurnContext {
  sessionId: string;
  userId: string;
  audioBuffer: Buffer;
  mimeType: string;
  language: string;
  forceArabic?: boolean;
  sessionLang?: string;
}

export interface TextTurnInput extends TurnContext {
  sessionId: string;
  userId: string;
  transcript: string;
  /** Client speech-language toggle (AUTO / AR / EN) — wins over stale session.language. */
  sessionLang?: string;
  language?: string;
  forceArabic?: boolean;
}

export interface VoiceTurnResult {
  transcript: string;
  studentMessage: {
    id: string;
    role: string;
    content: string;
    stage: string;
    createdAt: Date;
  };
  replyMessage: {
    id: string;
    role: string;
    content: string;
    stage: string;
    createdAt: Date;
  };
}

async function completeTextTurn(
  session: NonNullable<Awaited<ReturnType<typeof loadActiveSession>>>,
  transcript: string,
  input: TurnContext,
  replyLanguage?: string,
): Promise<VoiceTurnResult> {
  const effectiveStage = input.maneuverId ? maneuverStage(input.maneuverId) : input.stage;
  const language = (replyLanguage || session.language) as 'AUTO' | 'AR' | 'EN';

  let replyText: string;
  let replyRole: MessageRole;

  if (input.endpoint === 'examiner') {
    const studentMessage = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: MessageRole.STUDENT,
        content: transcript,
        stage: effectiveStage,
      },
    });

    const stageMessages = await prisma.message.findMany({
      where: { sessionId: session.id, stage: effectiveStage },
      orderBy: { createdAt: 'asc' },
    });
    const examinerHistory = stageMessages.filter(
      (m) => m.role !== MessageRole.PATIENT && m.id !== studentMessage.id,
    );

    replyText = input.maneuverId
      ? await getManeuverExaminerResponse(
          session.case,
          input.maneuverId,
          transcript,
          examinerHistory.map((m) => ({ role: String(m.role), content: m.content })),
          language,
          { userId: session.userId, sessionId: session.id },
        )
      : isHistoryExaminerVivaStage(effectiveStage, input.maneuverId)
        ? await respondToHistoryVivaAnswer(
            session.id,
            session.case,
            session.messages,
            effectiveStage,
            transcript,
            language,
          )
        : await getExaminerVivaResponse(
            session.case,
            transcript,
            examinerHistory.map((m) => ({ role: String(m.role), content: m.content })),
            language,
            { userId: session.userId, sessionId: session.id },
          );
    replyText = unwrapExaminerPlainText(replyText);
    replyRole = MessageRole.EXAMINER;

    const replyMessage = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: replyRole,
        content: replyText,
        stage: effectiveStage,
      },
    });

    return {
      transcript,
      studentMessage,
      replyMessage,
    };
  } else {
    const stageHistory = session.messages
      .filter((m) => m.stage === effectiveStage)
      .map((m) => ({ role: m.role, content: m.content }));

    // Keep AUTO as AUTO so patient replies follow the student's spoken language.
    replyText = await getPatientResponse(session.case, stageHistory, transcript, language, {
      voiceTurn: true,
      userId: session.userId,
      sessionId: session.id,
      stationConfig: getSessionStationConfig(session),
    });
    replyText = sanitizeRealtimePatientTranscript(
      session.case,
      transcript,
      replyText,
      language,
    );
    replyRole = MessageRole.PATIENT;
  }

  const [studentMessage, replyMessage] = await Promise.all([
    prisma.message.create({
      data: {
        sessionId: session.id,
        role: MessageRole.STUDENT,
        content: transcript,
        stage: effectiveStage,
      },
    }),
    prisma.message.create({
      data: {
        sessionId: session.id,
        role: replyRole,
        content: replyText,
        stage: effectiveStage,
      },
    }),
  ]);

  return {
    transcript,
    studentMessage,
    replyMessage,
  };
}

export async function processTextTurn(input: TextTurnInput): Promise<VoiceTurnResult> {
  const session = await loadActiveSession(input.sessionId, input.userId, 48);
  if (!session) {
    throw new Error('session-not-found');
  }

  // Prefer the live UI speech toggle over a stale session.language (e.g. EN selected
  // in the client but DB still AR) so English live-call transcripts are not rejected.
  const langOpts = {
    forceArabic: input.forceArabic,
    language: input.language,
    sessionLang: input.sessionLang,
  };
  const expectArabic = resolveExpectArabic(session.language, langOpts);
  const transcript = normalizeStudentTranscript(
    input.transcript,
    expectArabic,
    resolveCodeSwitch(session.language, langOpts),
  );

  return completeTextTurn(
    session,
    transcript,
    input,
    resolveReplyLanguage(session.language, input.sessionLang),
  );
}

export async function processVoiceTurn(input: VoiceTurnInput): Promise<VoiceTurnResult> {
  const [rawTranscript, session] = await Promise.all([
    transcribeAudioBuffer(input.audioBuffer, input.mimeType, input.language, input.forceArabic, {
      fast: true,
    }),
    loadActiveSession(input.sessionId, input.userId, 48),
  ]);

  if (!session) {
    throw new Error('session-not-found');
  }

  const langOpts = {
    forceArabic: input.forceArabic,
    language: input.language,
    sessionLang: input.sessionLang,
  };
  const expectArabic = resolveExpectArabic(session.language, langOpts);
  const transcript = normalizeStudentTranscript(
    rawTranscript,
    expectArabic,
    resolveCodeSwitch(session.language, langOpts),
  );

  return completeTextTurn(
    session,
    transcript,
    input,
    resolveReplyLanguage(session.language, input.sessionLang),
  );
}
