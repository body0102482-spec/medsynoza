import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import {
  getUserEntitlements,
  pickRandomEligibleCase,
  listPlanConfigs,
} from '../services/subscriptionService.js';
import { getPaymentPublicConfig } from '../services/payment/paymentService.js';
import { getRankProgress } from '../services/xpService.js';
import { getModulesForUser, userHasModuleAccess, getActiveTerms, getModuleSetupMeta, countAvailableQuestions, fetchExamQuestions } from '../services/qbankService.js';

const router = Router();

router.use(authenticate);

router.get('/entitlements', async (req, res) => {
  const userId = req.user!.id;
  const [entitlements, user, plans] = await Promise.all([
    getUserEntitlements(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { totalXp: true } }),
    listPlanConfigs(true),
  ]);
  const rankProgress = getRankProgress(user?.totalXp ?? 0);
  res.json({
    entitlements: { ...entitlements, totalXp: user?.totalXp ?? 0, rankProgress },
    payment: getPaymentPublicConfig(),
    plans: plans
      .filter((p) => p.id === 'PACKAGE_50' || p.id === 'PACKAGE_150' || p.id === 'PACKAGE_300')
      .map((p) => ({
        id: p.id,
        priceEgp: p.priceEgp,
        casesQuota: p.casesQuota,
        durationMonths: p.durationMonths,
        labelEn: p.labelEn,
        labelAr: p.labelAr,
      })),
  });
});

router.get('/random-case', async (req, res) => {
  const userId = req.user!.id;
  // Accepts a single id, a comma-separated list, or repeated categoryId params.
  const categoryIds = req.query.categoryId
    ? String(req.query.categoryId)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : [];

  const result = await pickRandomEligibleCase(userId, categoryIds);

  if (!result.ok) {
    if (result.code === 'NO_CASES') {
      return res.status(404).json({ error: 'NO_CASES', message: 'No published cases found' });
    }
    return res.status(403).json({
      error: 'NO_ELIGIBLE_CASES',
      message: 'No cases available for you to start right now',
    });
  }

  res.json({ case: result.case, eligibleCount: result.eligibleCount });
});

router.get('/overview', async (req, res) => {
  const userId = req.user!.id;

  const [totalSessions, completedSessions, results, recentSessions] = await Promise.all([
    prisma.session.count({ where: { userId } }),
    prisma.session.count({ where: { userId, status: 'COMPLETED' } }),
    prisma.result.findMany({
      where: { session: { userId } },
      select: { totalScore: true, historyTakingScore: true, communicationScore: true },
    }),
    prisma.session.findMany({
      where: { userId },
      take: 5,
      orderBy: { startedAt: 'desc' },
      include: {
        case: { select: { titleEn: true, titleAr: true } },
        result: { select: { totalScore: true } },
      },
    }),
  ]);

  const avgScore =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.totalScore, 0) / results.length
      : 0;

  const avgHistory =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.historyTakingScore, 0) / results.length
      : 0;

  const avgCommunication =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.communicationScore, 0) / results.length
      : 0;

  res.json({
    stats: {
      totalSessions,
      completedSessions,
      averageScore: Math.round(avgScore * 10) / 10,
      averageHistoryTaking: Math.round(avgHistory * 10) / 10,
      averageCommunication: Math.round(avgCommunication * 10) / 10,
    },
    recentSessions,
  });
});

router.get('/results', async (req, res) => {
  const results = await prisma.result.findMany({
    where: { session: { userId: req.user!.id } },
    include: {
      session: {
        include: {
          case: { include: { specialty: true, difficulty: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ results });
});

router.get('/results/:sessionId', async (req, res) => {
  const result = await prisma.result.findFirst({
    where: {
      sessionId: req.params.sessionId,
      session: { userId: req.user!.id },
    },
    include: {
      session: {
        include: {
          case: true,
          messages: { orderBy: { createdAt: 'asc' } },
        },
      },
    },
  });

  if (!result) return res.status(404).json({ error: 'Result not found' });
  res.json({ result });
});

router.get('/qbank/terms', async (req, res) => {
  const terms = await getActiveTerms(req.user!.id);
  res.json({ terms });
});

router.get('/qbank/:termId/modules', async (req, res) => {
  const termId = String(req.params.termId);
  const data = await getModulesForUser(req.user!.id, termId);
  if (!data.term) {
    return res.status(404).json({ error: 'TERM_NOT_FOUND' });
  }
  res.json(data);
});

router.get('/qbank/:termId/modules/:moduleId/access', async (req, res) => {
  const termId = String(req.params.termId);
  const moduleId = String(req.params.moduleId);
  const hasAccess = await userHasModuleAccess(req.user!.id, termId, moduleId);
  res.json({ hasAccess });
});

router.get('/qbank/:termId/modules/:moduleId/setup', async (req, res) => {
  const termId = String(req.params.termId);
  const moduleId = String(req.params.moduleId);
  const hasAccess = await userHasModuleAccess(req.user!.id, termId, moduleId);
  if (!hasAccess) {
    return res.status(403).json({ error: 'ACCESS_DENIED' });
  }
  const meta = await getModuleSetupMeta(termId, moduleId);
  if (!meta) {
    return res.status(404).json({ error: 'MODULE_NOT_FOUND' });
  }
  res.json(meta);
});

router.get('/qbank/:termId/modules/:moduleId/questions', async (req, res) => {
  const termId = String(req.params.termId);
  const moduleId = String(req.params.moduleId);
  const hasAccess = await userHasModuleAccess(req.user!.id, termId, moduleId);
  if (!hasAccess) {
    return res.status(403).json({ error: 'ACCESS_DENIED' });
  }

  const chapterIds = String(req.query.chapters ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const referenceIds = String(req.query.references ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const subjectTags = String(req.query.subjects ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const count = Number.parseInt(String(req.query.count ?? '20'), 10) || 20;
  const mode = String(req.query.mode ?? 'exam');

  const available = await countAvailableQuestions(
    moduleId,
    chapterIds,
    referenceIds,
    subjectTags.length ? subjectTags : undefined,
  );
  if (available === 0) {
    return res.status(404).json({ error: 'NO_QUESTIONS', message: 'No questions match the selected filters' });
  }

  const questions = await fetchExamQuestions(moduleId, {
    chapterIds,
    referenceIds,
    subjectTags: subjectTags.length ? subjectTags : undefined,
    count: Math.min(count, available),
    includeAnswers: true,
  });

  res.json({ questions, available });
});

export default router;
