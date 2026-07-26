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

function normalizeStudentTranscript(raw: string, expectArabic: boolean, codeSwitch = false): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('recording-too-short');

  let text = fixArabicSpeechTranscript(trimmed, expectArabic, codeSwitch);
  if (looksLikeSttHallucination(text, !expectArabic)) {
    throw new Error('transcription-prompt-leak');
  }
  text = extractPrimaryUtterance(text);
  if (!isValidArabicSessionTranscript(text, expectArabic)) {
    throw new Error('transcription-not-arabic');
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
}

export interface TextTurnInput extends TurnContext {
  sessionId: string;
  userId: string;
  transcript: string;
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
): Promise<VoiceTurnResult> {
  const effectiveStage = input.maneuverId ? maneuverStage(input.maneuverId) : input.stage;

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
          session.language,
          { userId: session.userId, sessionId: session.id },
        )
      : isHistoryExaminerVivaStage(effectiveStage, input.maneuverId)
        ? await respondToHistoryVivaAnswer(
            session.id,
            session.case,
            session.messages,
            effectiveStage,
            transcript,
            session.language,
          )
        : await getExaminerVivaResponse(
            session.case,
            transcript,
            examinerHistory.map((m) => ({ role: String(m.role), content: m.content })),
            session.language,
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
    replyText = await getPatientResponse(session.case, stageHistory, transcript, session.language, {
      voiceTurn: true,
      userId: session.userId,
      sessionId: session.id,
      stationConfig: getSessionStationConfig(session),
    });
    replyText = sanitizeRealtimePatientTranscript(
      session.case,
      transcript,
      replyText,
      session.language,
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

  // Only AR sessions force Arabic-only transcripts; AUTO/EN allow code-switching.
  const expectArabic = session.language === 'AR';
  const transcript = normalizeStudentTranscript(
    input.transcript,
    expectArabic,
    session.language === 'AUTO',
  );

  return completeTextTurn(session, transcript, input);
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

  const expectArabic = session.language === 'AR';
  const transcript = normalizeStudentTranscript(
    rawTranscript,
    expectArabic,
    session.language === 'AUTO',
  );

  return completeTextTurn(session, transcript, input);
}
