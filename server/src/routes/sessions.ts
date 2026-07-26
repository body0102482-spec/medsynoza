import { Router } from 'express';
import express from 'express';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import {
  getPatientResponse,
  getExaminerEvaluation,
  getExaminerVivaResponse,
  getManeuverExaminerResponse,
  resolveEvaluationLanguage,
  sanitizeRealtimePatientTranscript,
  unwrapExaminerPlainText,
} from '../services/aiService.js';
import { checkCanStartCase, getUserEntitlements, recordCaseAttempt } from '../services/subscriptionService.js';
import { serializeResolvedStationConfigForUser } from '../services/caseResolveService.js';
import { applySessionXp, getRankProgress } from '../services/xpService.js';
import { processTextTurn, processVoiceTurn } from '../services/voiceTurnService.js';
import { createRealtimePatientCallAnswer } from '../services/realtimePatientService.js';
import {
  buildExaminerVivaOpening,
  HISTORY_EXAMINER_STAGE,
  isHistoryExaminerVivaStage,
  respondToHistoryVivaAnswer,
} from '../services/examinerVivaService.js';
import { Language, MessageRole } from '@prisma/client';
import { getSessionStationConfig, isManeuverEnabled, parseStationConfig, resolveManeuverOpeningMessage } from '../lib/stationConfig.js';

const router = Router();

const EXAM_MANEUVER_ORDER = ['inspection', 'palpation', 'percussion', 'auscultation'] as const;

function parseCompletedManeuvers(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function maneuverStage(maneuverId: string) {
  return `examination:${maneuverId}`;
}

function canStartManeuver(_maneuverId: string, _completed: string[]) {
  return true;
}

router.use(authenticate);

router.post('/start', async (req, res) => {
  const { caseId, language = 'AUTO' } = req.body;
  const userId = req.user!.id;

  const caseData = await prisma.case.findUnique({ where: { id: caseId, isPublished: true } });
  if (!caseData) return res.status(404).json({ error: 'Case not found' });

  const access = await checkCanStartCase(userId, caseId);
  if (!access.allowed) {
    if (access.code === 'FREE_LIMIT_REACHED') {
      return res.status(403).json({
        error: 'FREE_LIMIT_REACHED',
        message: 'You have used all free attempts for this case. Upgrade to continue.',
        attempts: access.attempts,
        limit: access.limit,
      });
    }
    if (access.code === 'CASE_QUOTA_EXCEEDED') {
      return res.status(403).json({
        error: 'CASE_QUOTA_EXCEEDED',
        message: 'You have reached your case quota. Upgrade your plan for more cases.',
        casesUnlocked: access.casesUnlocked,
        casesQuota: access.casesQuota,
      });
    }
    if (access.code === 'SUBSCRIPTION_REQUIRED') {
      return res.status(403).json({
        error: 'SUBSCRIPTION_REQUIRED',
        message: 'This case requires a subscription. Upgrade to unlock.',
      });
    }
  }

  const resolvedStationConfig = await serializeResolvedStationConfigForUser(caseId, userId);
  const stationConfig = parseStationConfig(resolvedStationConfig);
  const requestedLanguage = String(language || 'AUTO').toUpperCase();
  const sessionLanguage =
    requestedLanguage === 'AR' || requestedLanguage === 'EN'
      ? requestedLanguage
      : stationConfig.patientBehavior.preferredLanguage === 'AR' ||
          stationConfig.patientBehavior.preferredLanguage === 'EN'
        ? stationConfig.patientBehavior.preferredLanguage
        : 'AUTO';

  const session = await prisma.session.create({
    data: {
      userId,
      caseId,
      language: sessionLanguage as Language,
      resolvedStationConfig,
    },
    include: {
      case: { include: { specialty: true, difficulty: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });

  await recordCaseAttempt(userId, caseId);

  const entitlements = await getUserEntitlements(userId);

  res.status(201).json({ session, entitlements });
});

router.get('/my', async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user!.id },
    include: {
      case: { include: { specialty: true, difficulty: true } },
      result: true,
    },
    orderBy: { startedAt: 'desc' },
  });
  res.json({ sessions });
});

router.get('/:id', async (req, res) => {
  const session = await prisma.session.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: {
      case: { include: { specialty: true, difficulty: true } },
      messages: { orderBy: { createdAt: 'asc' } },
      result: true,
    },
  });

  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

router.post('/:id/maneuver/start', async (req, res) => {
  const { maneuverId } = req.body;
  if (!maneuverId || !EXAM_MANEUVER_ORDER.includes(maneuverId)) {
    return res.status(400).json({ error: 'Invalid maneuver' });
  }

  const session = await prisma.session.findFirst({
    where: { id: req.params.id, userId: req.user!.id, status: 'IN_PROGRESS' },
    include: { case: true, messages: true },
  });
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  const stationConfig = getSessionStationConfig(session);
  if (!isManeuverEnabled(stationConfig, maneuverId)) {
    return res.status(400).json({ error: 'Maneuver not enabled for this case' });
  }

  const completed = parseCompletedManeuvers(session.completedManeuvers);
  if (!canStartManeuver(maneuverId, completed)) {
    return res.status(400).json({ error: 'Complete the previous examination step first' });
  }

  const stage = maneuverStage(maneuverId);
  const existing = session.messages.filter((m) => m.stage === stage);
  let openingMessage = existing.find((m) => m.role === MessageRole.EXAMINER);
  const openingContent = resolveManeuverOpeningMessage(maneuverId, stationConfig);

  if (!openingMessage) {
    openingMessage = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: MessageRole.EXAMINER,
        content: openingContent,
        stage,
      },
    });
  } else if (openingMessage.content !== openingContent) {
    openingMessage = await prisma.message.update({
      where: { id: openingMessage.id },
      data: { content: openingContent },
    });
  }

  const updated = await prisma.session.update({
    where: { id: session.id },
    data: { activeManeuver: maneuverId, currentStage: 'examination' },
  });

  res.json({ session: updated, message: openingMessage });
});

router.post('/:id/maneuver/complete', async (req, res) => {
  const { maneuverId } = req.body;
  const session = await prisma.session.findFirst({
    where: { id: req.params.id, userId: req.user!.id, status: 'IN_PROGRESS' },
  });
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  const completed = parseCompletedManeuvers(session.completedManeuvers);
  if (!completed.includes(maneuverId)) completed.push(maneuverId);

  const updated = await prisma.session.update({
    where: { id: session.id },
    data: { completedManeuvers: JSON.stringify(completed), activeManeuver: null },
  });

  res.json({ session: updated, completedManeuvers: completed });
});

router.post(
  '/:id/realtime/call',
  express.text({ type: ['application/sdp', 'text/plain'] }),
  async (req, res) => {
    try {
      const sdpOffer = typeof req.body === 'string' ? req.body.trim() : '';
      if (!sdpOffer) {
        return res.status(400).json({ error: 'SDP offer required' });
      }

      const session = await prisma.session.findFirst({
        where: { id: req.params.id, userId: req.user!.id, status: 'IN_PROGRESS' },
        include: { case: true },
      });
      if (!session) return res.status(404).json({ error: 'Active session not found' });

      const answerSdp = await createRealtimePatientCallAnswer(
        session.case,
        session.language,
        sdpOffer,
      );
      res.type('application/sdp').send(answerSdp);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Realtime call failed';
      if (message === 'realtime-unavailable') {
        return res.status(503).json({ error: 'Realtime API is not configured' });
      }
      if (message === 'invalid-sdp') {
        return res.status(400).json({ error: 'Incomplete WebRTC offer. Refresh and try again.' });
      }
      console.error('[realtime/call]', error);
      res.status(500).json({ error: 'Realtime call failed' });
    }
  },
);

router.post('/:id/realtime/message', async (req, res) => {
  try {
    const { content, role = 'STUDENT', stage = 'history', orderIndex } = req.body as {
      content?: string;
      role?: 'STUDENT' | 'PATIENT';
      stage?: string;
      orderIndex?: number;
    };

    const text = content?.trim();
    if (!text) return res.status(400).json({ error: 'Message content required' });

    const session = await prisma.session.findFirst({
      where: { id: req.params.id, userId: req.user!.id, status: 'IN_PROGRESS' },
      include: { case: true },
    });
    if (!session) return res.status(404).json({ error: 'Active session not found' });

    let messageContent = text;
    if (role === 'PATIENT') {
      const lastStudent = await prisma.message.findFirst({
        where: { sessionId: session.id, role: MessageRole.STUDENT },
        orderBy: { createdAt: 'desc' },
      });
      messageContent = sanitizeRealtimePatientTranscript(
        session.case,
        lastStudent?.content ?? '',
        text,
        session.language,
      );
    }

    const createdAt =
      typeof orderIndex === 'number' && Number.isFinite(orderIndex)
        ? new Date(session.startedAt.getTime() + orderIndex * 1000)
        : undefined;

    const message = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: role === 'PATIENT' ? MessageRole.PATIENT : MessageRole.STUDENT,
        content: messageContent,
        stage,
        ...(createdAt ? { createdAt } : {}),
      },
    });

    res.json({ message });
  } catch (error) {
    console.error('[realtime/message]', error);
    res.status(500).json({ error: 'Failed to save realtime message' });
  }
});

router.patch('/:id/language', async (req, res) => {
  const languageRaw = String(req.body?.language ?? '').toUpperCase();
  if (languageRaw !== 'AUTO' && languageRaw !== 'AR' && languageRaw !== 'EN') {
    return res.status(400).json({ error: 'language must be AUTO, AR, or EN' });
  }

  const session = await prisma.session.findFirst({
    where: { id: req.params.id, userId: req.user!.id, status: 'IN_PROGRESS' },
  });
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const updated = await prisma.session.update({
    where: { id: session.id },
    data: { language: languageRaw as Language },
  });

  res.json({ language: updated.language });
});

router.post('/:id/voice-turn', async (req, res) => {
  try {
    const {
      audioBase64,
      transcript: transcriptBody,
      mimeType = 'audio/webm',
      language = 'ar-EG',
      forceArabic,
      stage = 'history',
      endpoint = 'chat',
      maneuverId,
    } = req.body as {
      audioBase64?: string;
      transcript?: string;
      mimeType?: string;
      language?: string;
      forceArabic?: boolean;
      stage?: string;
      endpoint?: 'chat' | 'examiner';
      maneuverId?: string;
    };

    const turnMeta = {
      sessionId: req.params.id,
      userId: req.user!.id,
      endpoint: endpoint === 'examiner' ? ('examiner' as const) : ('chat' as const),
      stage,
      maneuverId,
    };

    let result;
    if (typeof transcriptBody === 'string' && transcriptBody.trim()) {
      result = await processTextTurn({
        ...turnMeta,
        transcript: transcriptBody,
      });
    } else if (audioBase64 && typeof audioBase64 === 'string') {
      const buffer = Buffer.from(audioBase64, 'base64');
      if (buffer.length > 6 * 1024 * 1024) {
        return res.status(400).json({ error: 'Recording too large' });
      }

      result = await processVoiceTurn({
        ...turnMeta,
        audioBuffer: buffer,
        mimeType,
        language,
        forceArabic: !!forceArabic,
      });
    } else {
      return res.status(400).json({ error: 'No transcript or audio provided' });
    }

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Voice turn failed';
    if (message === 'recording-too-short') {
      return res.status(400).json({
        error: 'Recording too short or quiet',
        code: 'recording-too-short',
      });
    }
    if (message === 'transcription-unavailable') {
      return res.status(503).json({
        error: 'Speech transcription is not configured on the server',
        code: 'transcription-unavailable',
      });
    }
    if (message === 'transcription-auth-failed') {
      return res.status(503).json({
        error: 'The OpenAI API key is missing or invalid',
        code: 'transcription-auth-failed',
      });
    }
    if (message === 'transcription-quota-exceeded') {
      return res.status(503).json({
        error: 'The OpenAI transcription quota is unavailable',
        code: 'transcription-quota-exceeded',
      });
    }
    if (message === 'transcription-not-arabic') {
      return res.status(422).json({ error: 'Could not recognize Arabic speech — try again clearly' });
    }
    if (message === 'transcription-prompt-leak') {
      return res.status(422).json({ error: 'Could not understand speech — try again' });
    }
    if (message === 'local-stt-ffmpeg-missing') {
      return res.status(503).json({
        error: 'Local speech recognition needs ffmpeg — install ffmpeg-static or set FFMPEG_PATH',
      });
    }
    if (message === 'session-not-found') {
      return res.status(404).json({ error: 'Active session not found' });
    }
    console.error('[voice-turn]', error);
    res.status(500).json({ error: 'Voice turn failed' });
  }
});

router.post('/:id/chat', async (req, res) => {
  try {
    const { message, stage = 'history' } = req.body;

    const session = await prisma.session.findFirst({
      where: { id: req.params.id, userId: req.user!.id, status: 'IN_PROGRESS' },
      include: { case: true, messages: { orderBy: { createdAt: 'asc' } } },
    });

    if (!session) return res.status(404).json({ error: 'Active session not found' });

    await prisma.message.create({
      data: {
        sessionId: session.id,
        role: MessageRole.STUDENT,
        content: message,
        stage,
      },
    });

    const stageHistory = session.messages
      .filter((m) => m.stage === stage)
      .map((m) => ({ role: m.role, content: m.content }));

    const stationConfig = getSessionStationConfig(session);
    const patientReply = await getPatientResponse(
      session.case,
      stageHistory,
      message,
      session.language as 'AUTO' | 'AR' | 'EN',
      {
        userId: req.user!.id,
        sessionId: session.id,
        stationConfig,
      },
    );

    const patientMessage = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: MessageRole.PATIENT,
        content: patientReply,
        stage,
      },
    });

    res.json({ message: patientMessage });
  } catch (error) {
    console.error('[chat]', error);
    res.status(500).json({ error: 'Failed to get patient response' });
  }
});

router.post('/:id/examiner-viva/init', async (req, res) => {
  try {
    const session = await prisma.session.findFirst({
      where: { id: req.params.id, userId: req.user!.id, status: 'IN_PROGRESS' },
      include: { case: true, messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) return res.status(404).json({ error: 'Active session not found' });

    const stationConfig = getSessionStationConfig(session);
    if (!stationConfig.enableHistoryExaminer) {
      return res.status(403).json({ error: 'History examiner is disabled for this case' });
    }

    const stage = HISTORY_EXAMINER_STAGE;
    const existing = session.messages.find(
      (m) => m.stage === stage && m.role === MessageRole.EXAMINER,
    );
    if (existing) {
      return res.json({ message: existing });
    }

    const opening = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: MessageRole.EXAMINER,
        content: buildExaminerVivaOpening(session.id, session.case),
        stage,
      },
    });

    res.json({ message: opening });
  } catch (error) {
    console.error('[examiner-viva/init]', error);
    res.status(500).json({ error: 'Failed to start examiner viva' });
  }
});

router.post('/:id/examiner', async (req, res) => {
  try {
    const { message, stage = 'history', maneuverId } = req.body;

  const session = await prisma.session.findFirst({
    where: { id: req.params.id, userId: req.user!.id, status: 'IN_PROGRESS' },
    include: { case: true, messages: { orderBy: { createdAt: 'asc' } } },
  });

  if (!session) return res.status(404).json({ error: 'Active session not found' });

  const stationConfig = getSessionStationConfig(session);
  const effectiveStage = maneuverId ? maneuverStage(maneuverId) : stage;

  if (!maneuverId && isHistoryExaminerVivaStage(effectiveStage, maneuverId) && !stationConfig.enableHistoryExaminer) {
    return res.status(403).json({ error: 'History examiner is disabled for this case' });
  }
  if (maneuverId && !isManeuverEnabled(stationConfig, maneuverId)) {
    return res.status(400).json({ error: 'Maneuver not enabled for this case' });
  }

  const studentMessage = await prisma.message.create({
    data: {
      sessionId: session.id,
      role: MessageRole.STUDENT,
      content: message,
      stage: effectiveStage,
    },
  });

  // Reload from DB so cumulative viva scoring always sees prior student turns
  // (avoid relying on the pre-insert in-memory session.messages snapshot).
  const stageMessages = await prisma.message.findMany({
    where: { sessionId: session.id, stage: effectiveStage },
    orderBy: { createdAt: 'asc' },
  });
  const examinerHistory = stageMessages.filter(
    (m) => m.role !== MessageRole.PATIENT && m.id !== studentMessage.id,
  );

  const reply = maneuverId
    ? await getManeuverExaminerResponse(
        session.case,
        maneuverId,
        message,
        examinerHistory.map((m) => ({ role: String(m.role), content: m.content })),
        session.language,
        { userId: req.user!.id, sessionId: session.id },
      )
    : isHistoryExaminerVivaStage(effectiveStage, maneuverId)
      ? await respondToHistoryVivaAnswer(
          session.id,
          session.case,
          session.messages,
          effectiveStage,
          message,
          session.language,
        )
      : await getExaminerVivaResponse(
          session.case,
          message,
          examinerHistory.map((m) => ({ role: m.role, content: m.content })),
          session.language,
          { userId: req.user!.id, sessionId: session.id },
        );

  const examinerMessage = await prisma.message.create({
    data: {
      sessionId: session.id,
      role: MessageRole.EXAMINER,
      content: unwrapExaminerPlainText(reply),
      stage: effectiveStage,
    },
  });

  res.json({ message: examinerMessage });
  } catch (error) {
    console.error('[examiner]', error);
    res.status(500).json({ error: 'Failed to get examiner response' });
  }
});

router.patch('/:id/stage', async (req, res) => {
  const { stage } = req.body;
  const session = await prisma.session.updateMany({
    where: { id: req.params.id, userId: req.user!.id },
    data: { currentStage: stage },
  });

  if (session.count === 0) return res.status(404).json({ error: 'Session not found' });
  res.json({ message: 'Stage updated' });
});

router.post('/:id/complete', async (req, res) => {
  try {
  const session = await prisma.session.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: { case: true, messages: { orderBy: { createdAt: 'asc' } } },
  });

  if (!session) return res.status(404).json({ error: 'Session not found' });

  const durationSeconds = Math.floor(
    (Date.now() - new Date(session.startedAt).getTime()) / 1000
  );
  const STATION_DURATION_SECONDS = 20 * 60;
  const timedOut =
    req.body?.timedOut === true || durationSeconds >= STATION_DURATION_SECONDS;

  // If the session was already completed, return the existing result instead of erroring.
  if (session.status === 'COMPLETED') {
    const existingResult = await prisma.result.findUnique({ where: { sessionId: session.id } });
    if (existingResult) {
      const existingRank = existingResult.xpRankSnapshot
        ? (JSON.parse(existingResult.xpRankSnapshot) as Awaited<ReturnType<typeof applySessionXp>>['rankProgress'])
        : getRankProgress(
            (
              await prisma.user.findUnique({
                where: { id: session.userId },
                select: { totalXp: true },
              })
            )?.totalXp ?? 0,
          );
      return res.json({ result: existingResult, rankProgress: existingRank });
    }
  }

  // A finish request (manual or timed out) is always intentional. An empty transcript
  // simply yields a low-participation evaluation rather than a hard error, so students
  // are never trapped on the station screen.
  const sessionMessages = session.messages.map((m) => ({
    role: m.role,
    content: m.content,
    stage: m.stage,
    createdAt: m.createdAt,
  }));

  const evaluationLang = resolveEvaluationLanguage(
    session.language,
    sessionMessages,
    req.body?.language
  );

  let completedManeuvers: string[] = [];
  try {
    completedManeuvers = JSON.parse(session.completedManeuvers || '[]');
  } catch {
    completedManeuvers = [];
  }

  const evaluation = await getExaminerEvaluation(
    session.case,
    sessionMessages,
    evaluationLang,
    { completedManeuvers },
    { userId: req.user!.id, sessionId: session.id },
  );

  await prisma.session.update({
    where: { id: session.id },
    data: { status: 'COMPLETED', completedAt: new Date(), durationSeconds },
  });

  const result = await prisma.result.upsert({
    where: { sessionId: session.id },
    create: {
      sessionId: session.id,
      ...evaluation,
      strengths: evaluation.strengths,
      weaknesses: evaluation.weaknesses,
      missedQuestions: evaluation.missedQuestions,
      clinicalErrors: evaluation.clinicalErrors,
      recommendations: evaluation.recommendations,
      idealApproach: evaluation.idealApproach,
      fullReport: evaluation.fullReport,
    },
    update: {
      ...evaluation,
      strengths: evaluation.strengths,
      weaknesses: evaluation.weaknesses,
      missedQuestions: evaluation.missedQuestions,
      clinicalErrors: evaluation.clinicalErrors,
      recommendations: evaluation.recommendations,
      idealApproach: evaluation.idealApproach,
      fullReport: evaluation.fullReport,
    },
  });

  let xpPayload: Awaited<ReturnType<typeof applySessionXp>> | null = null;
  if (!result.xpApplied) {
    xpPayload = await applySessionXp(session.userId, session.id, session.caseId, {
      totalScore: evaluation.totalScore,
      communicationScore: evaluation.communicationScore,
      historyTakingScore: evaluation.historyTakingScore,
      clinicalReasonScore: evaluation.clinicalReasonScore,
      organizationScore: evaluation.organizationScore,
      closingScore: evaluation.closingScore,
    });

    await prisma.result.update({
      where: { sessionId: session.id },
      data: {
        xpBreakdown: JSON.stringify(xpPayload.breakdown),
        xpCalculated: xpPayload.calculatedXp,
        xpAwarded: xpPayload.awardedXp,
        xpIsRepeat: xpPayload.isRepeat,
        xpApplied: true,
        xpRankSnapshot: JSON.stringify(xpPayload.rankProgress),
      },
    });
  }

  const finalResult = await prisma.result.findUnique({ where: { sessionId: session.id } });
  const rankProgress =
    xpPayload?.rankProgress ??
    (finalResult?.xpRankSnapshot
      ? (JSON.parse(finalResult.xpRankSnapshot) as Awaited<ReturnType<typeof applySessionXp>>['rankProgress'])
      : getRankProgress(
          (
            await prisma.user.findUnique({
              where: { id: session.userId },
              select: { totalXp: true },
            })
          )?.totalXp ?? 0,
        ));

  res.json({ result: finalResult, rankProgress });
  } catch (error) {
    console.error('[complete]', error);
    res.status(500).json({ error: 'Failed to generate session evaluation' });
  }
});

router.post('/:id/abandon', async (req, res) => {
  await prisma.session.updateMany({
    where: { id: req.params.id, userId: req.user!.id },
    data: { status: 'ABANDONED' },
  });
  res.json({ message: 'Session abandoned' });
});

export default router;
