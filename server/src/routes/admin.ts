import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { Prisma, Role, type SubscriptionPlan } from '@prisma/client';
import {
  getPlanDefinition,
  getUserEntitlements,
  getActiveSubscription,
  setUserSubscriptionPlan,
  listPlanConfigs,
  clearPlanCache,
  ensurePlanConfigsSeeded,
} from '../services/subscriptionService.js';
import { clearAISettingsCache } from '../services/aiService.js';
import {
  getAiUsageSummary,
  getCostRatesMap,
  clearCostRatesCache,
  ensureDefaultCostRates,
} from '../services/aiUsageService.js';
import { getRankProgress } from '../services/xpService.js';
import adminQbankRoutes from './adminQbank.js';
import adminCasesRoutes from './adminCases.js';
import adminAiKnowledgeRoutes from './adminAiKnowledge.js';

const router = Router();

router.use(authenticate);
router.use(authorize(Role.ADMIN));

const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  'FREE',
  'PACKAGE_50',
  'PACKAGE_150',
  'PACKAGE_300',
  'INSTITUTION',
];

function parseDateParam(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function bucketKey(date: Date, granularity: 'day' | 'week' | 'month') {
  const d = new Date(date);
  if (granularity === 'month') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  if (granularity === 'week') {
    const day = new Date(d);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - day.getDay());
    return day.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

router.get('/stats', async (req, res) => {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const from = startOfDay(parseDateParam(req.query.from, defaultFrom));
  const to = endOfDay(parseDateParam(req.query.to, now));
  const granularity =
    req.query.granularity === 'week' || req.query.granularity === 'month'
      ? req.query.granularity
      : 'day';

  const range = { gte: from, lte: to };

  const [
    usersTotal,
    cases,
    sessionsInRange,
    completedInRange,
    newUsersInRange,
    avgScoreInRange,
    revenueAgg,
    allTimeSessions,
    allTimeCompleted,
    allTimeAvg,
    recentSessions,
    sessionsForSeries,
    usersForSeries,
    paymentsForSeries,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.case.count(),
    prisma.session.count({ where: { startedAt: range } }),
    prisma.session.count({ where: { status: 'COMPLETED', startedAt: range } }),
    prisma.user.count({ where: { createdAt: range } }),
    prisma.result.aggregate({
      where: { createdAt: range },
      _avg: { totalScore: true },
    }),
    prisma.paymentOrder.aggregate({
      where: { status: 'PAID', paidAt: range },
      _sum: { amountEgp: true },
    }),
    prisma.session.count(),
    prisma.session.count({ where: { status: 'COMPLETED' } }),
    prisma.result.aggregate({ _avg: { totalScore: true } }),
    prisma.session.findMany({
      take: 10,
      where: { startedAt: range },
      orderBy: { startedAt: 'desc' },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        case: { select: { titleEn: true } },
      },
    }),
    prisma.session.findMany({
      where: { startedAt: range },
      select: { startedAt: true, status: true },
    }),
    prisma.user.findMany({
      where: { createdAt: range },
      select: { createdAt: true },
    }),
    prisma.paymentOrder.findMany({
      where: { status: 'PAID', paidAt: range },
      select: { paidAt: true, amountEgp: true },
    }),
  ]);

  const seriesMap: Record<
    string,
    { date: string; sessions: number; completedSessions: number; newUsers: number; revenueEgp: number }
  > = {};

  const ensureBucket = (key: string) => {
    if (!seriesMap[key]) {
      seriesMap[key] = {
        date: key,
        sessions: 0,
        completedSessions: 0,
        newUsers: 0,
        revenueEgp: 0,
      };
    }
    return seriesMap[key];
  };

  for (const s of sessionsForSeries) {
    const b = ensureBucket(bucketKey(s.startedAt, granularity));
    b.sessions += 1;
    if (s.status === 'COMPLETED') b.completedSessions += 1;
  }
  for (const u of usersForSeries) {
    ensureBucket(bucketKey(u.createdAt, granularity)).newUsers += 1;
  }
  for (const p of paymentsForSeries) {
    if (!p.paidAt) continue;
    ensureBucket(bucketKey(p.paidAt, granularity)).revenueEgp += p.amountEgp;
  }

  res.json({
    from: from.toISOString(),
    to: to.toISOString(),
    granularity,
    stats: {
      users: usersTotal,
      cases,
      sessions: sessionsInRange,
      completedSessions: completedInRange,
      newUsers: newUsersInRange,
      averageScore: avgScoreInRange._avg.totalScore || 0,
      revenueEgp: revenueAgg._sum.amountEgp || 0,
      allTimeSessions,
      allTimeCompleted,
      allTimeAverageScore: allTimeAvg._avg.totalScore || 0,
    },
    series: Object.values(seriesMap).sort((a, b) => a.date.localeCompare(b.date)),
    recentSessions,
  });
});

router.get('/users', async (req, res) => {
  const university = typeof req.query.university === 'string' ? req.query.university.trim() : '';
  const plan = typeof req.query.plan === 'string' ? req.query.plan.trim() : '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '50'), 10) || 50));

  const where: Prisma.UserWhereInput = {};
  const and: Prisma.UserWhereInput[] = [];
  if (university) and.push({ university });
  if (q) {
    and.push({
      OR: [
        { firstName: { contains: q } },
        { lastName: { contains: q } },
        { email: { contains: q } },
        { phone: { contains: q } },
      ],
    });
  }
  if (plan && SUBSCRIPTION_PLANS.includes(plan as SubscriptionPlan)) {
    if (plan === 'FREE') {
      and.push({
        OR: [
          { subscriptions: { none: { status: 'ACTIVE' } } },
          { subscriptions: { some: { status: 'ACTIVE', plan: 'FREE' } } },
        ],
      });
    } else {
      and.push({ subscriptions: { some: { status: 'ACTIVE', plan: plan as SubscriptionPlan } } });
    }
  }
  if (and.length) where.AND = and;

  const [total, users, universities] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        isActive: true,
        university: true,
        academicYear: true,
        avatarUrl: true,
        totalXp: true,
        studentId: true,
        lastSeenAt: true,
        createdAt: true,
        subscriptions: {
          where: { status: 'ACTIVE' },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.findMany({
      where: { university: { not: null } },
      select: { university: true },
      distinct: ['university'],
    }),
  ]);

  res.json({
    users,
    total,
    page,
    pageSize,
    universities: universities
      .map((u) => u.university)
      .filter((v): v is string => !!v)
      .sort(),
  });
});

router.get('/users/:userId/profile', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      avatarUrl: true,
      university: true,
      academicYear: true,
      studentId: true,
      lastSeenAt: true,
      totalXp: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const [entitlements, subscription, qbankModules, recentSessions, completedCount, results] =
    await Promise.all([
      getUserEntitlements(user.id),
      getActiveSubscription(user.id),
      prisma.qbankModuleEntitlement.findMany({
        where: { userId: user.id },
      }),
      prisma.session.findMany({
        where: { userId: user.id },
        take: 10,
        orderBy: { startedAt: 'desc' },
        include: {
          case: { select: { titleEn: true, titleAr: true } },
          result: { select: { totalScore: true } },
        },
      }),
      prisma.session.count({ where: { userId: user.id, status: 'COMPLETED' } }),
      prisma.result.findMany({
        where: { session: { userId: user.id } },
        select: {
          totalScore: true,
          weaknesses: true,
          clinicalErrors: true,
          missedQuestions: true,
        },
      }),
    ]);

  const moduleIds = qbankModules.map((m) => m.moduleId);
  const modules =
    moduleIds.length > 0
      ? await prisma.qbankModule.findMany({
          where: { id: { in: moduleIds } },
          select: { id: true, nameEn: true, nameAr: true },
        })
      : [];

  const avgScore =
    results.length > 0
      ? results.reduce((sum, r) => sum + (r.totalScore || 0), 0) / results.length
      : 0;

  const phraseCounts = new Map<string, number>();
  const addPhrases = (text: string) => {
    for (const line of text.split(/\n+/)) {
      const cleaned = line.replace(/^[-•*\d.)\s]+/, '').trim();
      if (cleaned.length < 4) continue;
      phraseCounts.set(cleaned, (phraseCounts.get(cleaned) || 0) + 1);
    }
  };
  for (const r of results) {
    addPhrases(r.weaknesses || '');
    addPhrases(r.clinicalErrors || '');
    addPhrases(r.missedQuestions || '');
  }
  const commonMistakes = [...phraseCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([phrase, count]) => ({ phrase, count }));

  const planDef = await getPlanDefinition(subscription?.plan ?? 'FREE');

  res.json({
    user: {
      ...user,
      rankProgress: (() => {
        const rp = getRankProgress(user.totalXp ?? 0);
        return {
          rank: rp.currentRank.nameEn,
          nextRank: rp.nextRank?.nameEn,
          progress: rp.progressPercent,
        };
      })(),
    },
    subscription: subscription
      ? {
          ...subscription,
          planNameEn: planDef.labelEn,
          planNameAr: planDef.labelAr,
        }
      : null,
    entitlements,
    qbankModules: modules,
    activity: {
      recentSessions,
      completedCount,
      averageScore: avgScore,
    },
    commonMistakes,
  });
});

router.get('/users/:userId/entitlements', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
    },
  });

  if (!user) return res.status(404).json({ error: 'User not found' });

  const [entitlements, subscription, plans] = await Promise.all([
    getUserEntitlements(user.id),
    getActiveSubscription(user.id),
    listPlanConfigs(),
  ]);

  res.json({
    user,
    entitlements,
    subscription,
    plans: plans.map((p) => ({
      id: p.id,
      priceEgp: p.priceEgp,
      casesQuota: p.casesQuota,
      durationMonths: p.durationMonths,
      labelEn: p.labelEn,
      labelAr: p.labelAr,
    })),
  });
});

router.patch('/users/:id', async (req, res) => {
  const { role, isActive, academicYear, university, phone } = req.body;
  const data: Prisma.UserUpdateInput = {};
  if (role !== undefined) data.role = role;
  if (isActive !== undefined) data.isActive = isActive;
  if (academicYear !== undefined) data.academicYear = academicYear || null;
  if (university !== undefined) data.university = university || null;
  if (phone !== undefined) data.phone = phone || null;
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data,
  });
  res.json({ user });
});

router.post('/users', async (req, res) => {
  const { email, password, firstName, lastName, role, university } = req.body;
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email, passwordHash, firstName, lastName, role, university, emailVerified: true },
  });
  res.status(201).json({ user });
});

router.get('/plans', async (_req, res) => {
  await ensurePlanConfigsSeeded();
  const plans = await listPlanConfigs();
  res.json({ plans });
});

router.put('/plans', async (req, res) => {
  const items = Array.isArray(req.body?.plans) ? req.body.plans : [];
  await ensurePlanConfigsSeeded();

  for (const item of items) {
    const plan = item.id || item.plan;
    if (!plan || !SUBSCRIPTION_PLANS.includes(plan)) continue;
    await prisma.planConfig.upsert({
      where: { plan },
      create: {
        plan,
        nameEn: String(item.nameEn || item.labelEn || plan),
        nameAr: String(item.nameAr || item.labelAr || plan),
        priceEgp: Number(item.priceEgp) || 0,
        casesQuota: Number(item.casesQuota) || 0,
        durationMonths: Number(item.durationMonths) || 0,
        isActive: item.isActive !== false,
        sortOrder: Number(item.sortOrder) || 0,
      },
      update: {
        ...(item.nameEn !== undefined || item.labelEn !== undefined
          ? { nameEn: String(item.nameEn || item.labelEn) }
          : {}),
        ...(item.nameAr !== undefined || item.labelAr !== undefined
          ? { nameAr: String(item.nameAr || item.labelAr) }
          : {}),
        ...(item.priceEgp !== undefined ? { priceEgp: Number(item.priceEgp) || 0 } : {}),
        ...(item.casesQuota !== undefined ? { casesQuota: Number(item.casesQuota) || 0 } : {}),
        ...(item.durationMonths !== undefined
          ? { durationMonths: Number(item.durationMonths) || 0 }
          : {}),
        ...(item.isActive !== undefined ? { isActive: Boolean(item.isActive) } : {}),
        ...(item.sortOrder !== undefined ? { sortOrder: Number(item.sortOrder) || 0 } : {}),
      },
    });
  }

  clearPlanCache();
  const plans = await listPlanConfigs();
  res.json({ plans });
});

router.get('/ai-usage', async (req, res) => {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const from = startOfDay(parseDateParam(req.query.from, defaultFrom));
  const to = endOfDay(parseDateParam(req.query.to, now));
  const data = await getAiUsageSummary(from, to);
  res.json({ from: from.toISOString(), to: to.toISOString(), ...data });
});

router.get('/ai-usage/rates', async (_req, res) => {
  await ensureDefaultCostRates();
  const map = await getCostRatesMap();
  const rates = Object.entries(map)
    .filter(([model]) => model !== 'default')
    .map(([model, r]) => ({ model, ...r }));
  res.json({ rates });
});

router.put('/ai-usage/rates', async (req, res) => {
  const items = Array.isArray(req.body?.rates) ? req.body.rates : [];
  for (const item of items) {
    if (!item?.model) continue;
    await prisma.aiCostRate.upsert({
      where: { model: String(item.model) },
      create: {
        model: String(item.model),
        inputPer1MUsd: Number(item.inputPer1MUsd) || 0,
        outputPer1MUsd: Number(item.outputPer1MUsd) || 0,
      },
      update: {
        inputPer1MUsd: Number(item.inputPer1MUsd) || 0,
        outputPer1MUsd: Number(item.outputPer1MUsd) || 0,
      },
    });
  }
  clearCostRatesCache();
  const map = await getCostRatesMap();
  const rates = Object.entries(map)
    .filter(([model]) => model !== 'default')
    .map(([model, r]) => ({ model, ...r }));
  res.json({ rates });
});

router.get('/specialties', async (_req, res) => {
  const specialties = await prisma.specialty.findMany({ orderBy: { nameEn: 'asc' } });
  res.json({ specialties });
});

router.post('/specialties', async (req, res) => {
  const specialty = await prisma.specialty.create({ data: req.body });
  res.status(201).json({ specialty });
});

router.put('/specialties/:id', async (req, res) => {
  const specialty = await prisma.specialty.update({ where: { id: req.params.id }, data: req.body });
  res.json({ specialty });
});

router.get('/difficulties', async (_req, res) => {
  const difficulties = await prisma.difficultyLevel.findMany({ orderBy: { level: 'asc' } });
  res.json({ difficulties });
});

router.post('/difficulties', async (req, res) => {
  const difficulty = await prisma.difficultyLevel.create({ data: req.body });
  res.status(201).json({ difficulty });
});

router.get('/users/:userId/activity', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      university: true,
      createdAt: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const [entitlements, subscription, sessions, caseAccess] = await Promise.all([
    getUserEntitlements(user.id),
    getActiveSubscription(user.id),
    prisma.session.findMany({
      where: { userId: user.id },
      include: {
        case: { select: { id: true, titleEn: true, titleAr: true } },
        result: { select: { totalScore: true, createdAt: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    }),
    prisma.caseAccess.findMany({
      where: { userId: user.id },
      include: { case: { select: { titleEn: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);

  const totalAiTokens = sessions.reduce((sum, s) => sum + (s.aiTotalTokens ?? 0), 0);

  res.json({
    user,
    entitlements,
    subscription,
    caseAccess,
    totalAiTokens,
    sessions: sessions.map((s) => ({
      id: s.id,
      status: s.status,
      currentStage: s.currentStage,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      durationSeconds: s.durationSeconds,
      messageCount: s._count.messages,
      aiPromptTokens: s.aiPromptTokens,
      aiCompletionTokens: s.aiCompletionTokens,
      aiTotalTokens: s.aiTotalTokens,
      case: s.case,
      score: s.result?.totalScore ?? null,
    })),
  });
});

router.get('/results', async (_req, res) => {
  const results = await prisma.result.findMany({
    include: {
      session: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          case: { select: { titleEn: true, titleAr: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ results });
});

router.get('/ai-settings', async (_req, res) => {
  let settings = await prisma.aISettings.findFirst();
  if (!settings) settings = await prisma.aISettings.create({ data: {} });
  const key = settings.openRouterApiKey?.trim() || '';
  res.json({
    settings: {
      ...settings,
      openRouterApiKey: key
        ? `${key.slice(0, 10)}…${key.slice(-4)}`
        : '',
      hasOpenRouterApiKey: Boolean(key || process.env.OPENROUTER_API_KEY?.trim()),
      openRouterEnvConfigured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    },
  });
});

router.put('/ai-settings', async (req, res) => {
  let settings = await prisma.aISettings.findFirst();
  if (!settings) settings = await prisma.aISettings.create({ data: {} });
  const {
    provider,
    patientModel,
    examinerModel,
    temperature,
    maxTokens,
    systemPromptAr,
    systemPromptEn,
    patientSystemPromptAr,
    patientSystemPromptEn,
    examinerSystemPromptAr,
    examinerSystemPromptEn,
    maxContextMessages,
    openRouterApiKey,
  } = req.body;

  const keyIncoming = typeof openRouterApiKey === 'string' ? openRouterApiKey.trim() : undefined;
  // Ignore masked placeholders from the UI (contain ellipsis) so save doesn't overwrite the real key.
  const keyLooksMasked = !!keyIncoming && (/…|\.{3}|•/.test(keyIncoming) || keyIncoming.includes('***'));
  const shouldUpdateKey = keyIncoming !== undefined && !keyLooksMasked;

  settings = await prisma.aISettings.update({
    where: { id: settings.id },
    data: {
      ...(provider !== undefined ? { provider } : {}),
      ...(patientModel !== undefined ? { patientModel } : {}),
      ...(examinerModel !== undefined ? { examinerModel } : {}),
      ...(temperature !== undefined ? { temperature: Number(temperature) } : {}),
      ...(maxTokens !== undefined ? { maxTokens: Number(maxTokens) } : {}),
      ...(systemPromptAr !== undefined ? { systemPromptAr } : {}),
      ...(systemPromptEn !== undefined ? { systemPromptEn } : {}),
      ...(patientSystemPromptAr !== undefined ? { patientSystemPromptAr } : {}),
      ...(patientSystemPromptEn !== undefined ? { patientSystemPromptEn } : {}),
      ...(examinerSystemPromptAr !== undefined ? { examinerSystemPromptAr } : {}),
      ...(examinerSystemPromptEn !== undefined ? { examinerSystemPromptEn } : {}),
      ...(maxContextMessages !== undefined
        ? { maxContextMessages: Math.max(2, Math.min(100, Number(maxContextMessages) || 12)) }
        : {}),
      ...(shouldUpdateKey
        ? { openRouterApiKey: keyIncoming || null }
        : {}),
    },
  });
  clearAISettingsCache();

  const key = settings.openRouterApiKey?.trim() || '';
  res.json({
    settings: {
      ...settings,
      openRouterApiKey: key ? `${key.slice(0, 10)}…${key.slice(-4)}` : '',
      hasOpenRouterApiKey: Boolean(key || process.env.OPENROUTER_API_KEY?.trim()),
      openRouterEnvConfigured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    },
  });
});

router.get('/audit-logs', async (_req, res) => {
  const logs = await prisma.auditLog.findMany({
    take: 100,
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { email: true, firstName: true, lastName: true } } },
  });
  res.json({ logs });
});

router.get('/subscriptions', async (_req, res) => {
  const subscriptions = await prisma.subscription.findMany({
    include: { user: { select: { email: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ subscriptions });
});

router.patch('/subscriptions/:id', async (req, res) => {
  const { plan, status, endDate } = req.body;
  const data: Record<string, unknown> = {};
  if (status !== undefined) data.status = status;
  if (endDate !== undefined) data.endDate = endDate;
  if (plan !== undefined) {
    const config = await getPlanDefinition(plan);
    data.plan = plan;
    data.casesQuota = config.casesQuota;
    data.priceEgp = config.priceEgp;
  }
  const subscription = await prisma.subscription.update({
    where: { id: req.params.id },
    data,
  });
  res.json({ subscription });
});

router.post('/users/:userId/subscription', async (req, res) => {
  const { plan, endDate } = req.body;

  if (!plan || !SUBSCRIPTION_PLANS.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { id: true, role: true },
  });

  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role !== Role.STUDENT) {
    return res.status(400).json({ error: 'Only student accounts can have subscription plans assigned' });
  }

  try {
    const parsedEndDate = endDate ? new Date(endDate) : undefined;
    if (parsedEndDate && Number.isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({ error: 'Invalid end date' });
    }

    const subscription = await setUserSubscriptionPlan(user.id, plan as SubscriptionPlan, {
      endDate: parsedEndDate,
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'SUBSCRIPTION_CHANGED',
        entity: 'User',
        entityId: user.id,
        details: JSON.stringify({
          plan,
          endDate: parsedEndDate?.toISOString() ?? null,
        }),
      },
    });

    const entitlements = await getUserEntitlements(user.id);
    res.json({ subscription, entitlements });
  } catch {
    return res.status(400).json({ error: 'Could not update subscription plan' });
  }
});

router.get('/categories', async (_req, res) => {
  const categories = await prisma.knowledgeCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
    include: {
      _count: { select: { items: true, cases: true, children: true } },
      parent: { select: { id: true, nameEn: true, nameAr: true } },
    },
  });
  res.json({ categories });
});

router.post('/categories', async (req, res) => {
  const { nameEn, nameAr, description, parentId, sortOrder, isActive } = req.body;
  const category = await prisma.knowledgeCategory.create({
    data: { nameEn, nameAr, description, parentId: parentId || null, sortOrder, isActive },
  });
  res.status(201).json({ category });
});

router.put('/categories/:id', async (req, res) => {
  const { nameEn, nameAr, description, parentId, sortOrder, isActive } = req.body;
  const category = await prisma.knowledgeCategory.update({
    where: { id: req.params.id },
    data: {
      nameEn,
      nameAr,
      description,
      parentId: parentId === undefined ? undefined : parentId || null,
      sortOrder,
      isActive,
    },
  });
  res.json({ category });
});

router.delete('/categories/:id', async (req, res) => {
  const childCount = await prisma.knowledgeCategory.count({ where: { parentId: req.params.id } });
  if (childCount > 0) {
    return res.status(400).json({ error: 'Cannot delete category with subcategories' });
  }
  await prisma.knowledgeCategory.delete({ where: { id: req.params.id } });
  res.json({ message: 'Category deleted' });
});

router.get('/categories/:id/knowledge', async (req, res) => {
  const items = await prisma.knowledgeItem.findMany({
    where: { categoryId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ items });
});

router.post('/knowledge', async (req, res) => {
  const { categoryId, titleEn, titleAr, content, type, isActive } = req.body;
  const item = await prisma.knowledgeItem.create({
    data: { categoryId, titleEn, titleAr, content, type, isActive },
  });
  res.status(201).json({ item });
});

router.put('/knowledge/:id', async (req, res) => {
  const item = await prisma.knowledgeItem.update({
    where: { id: req.params.id },
    data: req.body,
  });
  res.json({ item });
});

router.delete('/knowledge/:id', async (req, res) => {
  await prisma.knowledgeItem.delete({ where: { id: req.params.id } });
  res.json({ message: 'Knowledge item deleted' });
});

router.get('/universities', async (_req, res) => {
  const universities = await prisma.partnerUniversity.findMany({
    orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
  });
  res.json({ universities });
});

router.get('/universities/:id', async (req, res) => {
  const university = await prisma.partnerUniversity.findUnique({ where: { id: req.params.id } });
  if (!university) return res.status(404).json({ error: 'University not found' });
  res.json({ university });
});

router.post('/universities', async (req, res) => {
  const { nameEn, nameAr, logoUrl, website, sortOrder, isActive } = req.body;
  if (!nameEn?.trim() || !nameAr?.trim()) {
    return res.status(400).json({ error: 'English and Arabic names are required' });
  }
  const university = await prisma.partnerUniversity.create({
    data: {
      nameEn: nameEn.trim(),
      nameAr: nameAr.trim(),
      logoUrl: logoUrl || null,
      website: website || null,
      sortOrder: sortOrder ?? 0,
      isActive: isActive ?? true,
    },
  });
  res.status(201).json({ university });
});

router.put('/universities/:id', async (req, res) => {
  const { nameEn, nameAr, logoUrl, website, sortOrder, isActive } = req.body;
  const existing = await prisma.partnerUniversity.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'University not found' });

  const university = await prisma.partnerUniversity.update({
    where: { id: req.params.id },
    data: {
      ...(nameEn !== undefined ? { nameEn: String(nameEn).trim() } : {}),
      ...(nameAr !== undefined ? { nameAr: String(nameAr).trim() } : {}),
      ...(logoUrl !== undefined ? { logoUrl: logoUrl || null } : {}),
      ...(website !== undefined ? { website: website || null } : {}),
      ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) || 0 } : {}),
      ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
    },
  });
  res.json({ university });
});

router.delete('/universities/:id', async (req, res) => {
  await prisma.partnerUniversity.delete({ where: { id: req.params.id } });
  res.json({ message: 'University deleted' });
});

router.get('/site-settings', async (_req, res) => {
  let settings = await prisma.siteSettings.findUnique({ where: { id: 'default' } });
  if (!settings) settings = await prisma.siteSettings.create({ data: { id: 'default' } });
  res.json({ settings });
});

router.put('/site-settings', async (req, res) => {
  let settings = await prisma.siteSettings.findUnique({ where: { id: 'default' } });
  if (!settings) settings = await prisma.siteSettings.create({ data: { id: 'default' } });
  settings = await prisma.siteSettings.update({ where: { id: 'default' }, data: req.body });
  res.json({ settings });
});

router.use('/qbank', adminQbankRoutes);
router.use('/cases', adminCasesRoutes);
router.use('/ai-knowledge', adminAiKnowledgeRoutes);

export default router;
