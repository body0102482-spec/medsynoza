import type { SubscriptionPlan } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export const FREE_ATTEMPTS_PER_CASE = 3;

export const PLAN_CATALOG = {
  FREE: { priceEgp: 0, casesQuota: 3, durationMonths: 0, labelEn: 'Free', labelAr: 'مجاني' },
  PACKAGE_50: { priceEgp: 150, casesQuota: 30, durationMonths: 2, labelEn: 'Basic', labelAr: 'Basic' },
  PACKAGE_150: { priceEgp: 300, casesQuota: 60, durationMonths: 4, labelEn: 'Pro', labelAr: 'Pro' },
  PACKAGE_300: { priceEgp: 500, casesQuota: 100, durationMonths: 6, labelEn: 'Premium', labelAr: 'Premium' },
  INSTITUTION: { priceEgp: 0, casesQuota: 999_999, durationMonths: 0, labelEn: 'Institution', labelAr: 'مؤسسة' },
} as const;

export type PlanCatalogKey = keyof typeof PLAN_CATALOG;

/** Legacy quotas from the previous catalog — migrated automatically when still present in PlanConfig. */
const LEGACY_PLAN_QUOTAS: Partial<Record<PlanCatalogKey, number>> = {
  FREE: 0,
  PACKAGE_50: 50,
  PACKAGE_150: 150,
  PACKAGE_300: 300,
};

export type PlanDefinition = {
  priceEgp: number;
  casesQuota: number;
  durationMonths: number;
  labelEn: string;
  labelAr: string;
  isActive?: boolean;
  sortOrder?: number;
};

let planCache: Record<string, PlanDefinition> | null = null;
let planCacheExpiresAt = 0;

export function isPaidPlan(plan: SubscriptionPlan): boolean {
  return plan === 'PACKAGE_50' || plan === 'PACKAGE_150' || plan === 'PACKAGE_300' || plan === 'INSTITUTION';
}

export async function ensurePlanConfigsSeeded() {
  const count = await prisma.planConfig.count();
  if (count === 0) {
    let sortOrder = 0;
    for (const [plan, cfg] of Object.entries(PLAN_CATALOG)) {
      await prisma.planConfig.create({
        data: {
          plan: plan as SubscriptionPlan,
          nameEn: cfg.labelEn,
          nameAr: cfg.labelAr,
          priceEgp: cfg.priceEgp,
          casesQuota: cfg.casesQuota,
          durationMonths: cfg.durationMonths,
          isActive: true,
          sortOrder: sortOrder++,
        },
      });
    }
    return;
  }

  // Migrate legacy case quotas to the new catalog when rows still hold old defaults.
  for (const [plan, legacyQuota] of Object.entries(LEGACY_PLAN_QUOTAS) as [PlanCatalogKey, number][]) {
    const nextQuota = PLAN_CATALOG[plan].casesQuota;
    if (nextQuota === legacyQuota) continue;
    await prisma.planConfig.updateMany({
      where: { plan, casesQuota: legacyQuota },
      data: { casesQuota: nextQuota },
    });
  }
}

export async function refreshPlanCache() {
  await ensurePlanConfigsSeeded();
  const rows = await prisma.planConfig.findMany({ orderBy: { sortOrder: 'asc' } });
  const map: Record<string, PlanDefinition> = {};
  for (const row of rows) {
    map[row.plan] = {
      priceEgp: row.priceEgp,
      casesQuota: row.casesQuota,
      durationMonths: row.durationMonths,
      labelEn: row.nameEn,
      labelAr: row.nameAr,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    };
  }
  for (const [key, cfg] of Object.entries(PLAN_CATALOG)) {
    if (!map[key]) {
      map[key] = { ...cfg, isActive: true };
    }
  }
  planCache = map;
  planCacheExpiresAt = Date.now() + 60_000;
  return map;
}

export function clearPlanCache() {
  planCache = null;
  planCacheExpiresAt = 0;
}

export function getPlanConfig(plan: SubscriptionPlan): PlanDefinition {
  const key = plan in PLAN_CATALOG ? (plan as PlanCatalogKey) : 'FREE';
  if (planCache?.[key]) return planCache[key];
  return PLAN_CATALOG[key];
}

export async function getPlanDefinition(plan: SubscriptionPlan): Promise<PlanDefinition> {
  if (!planCache || Date.now() > planCacheExpiresAt) {
    await refreshPlanCache();
  }
  return getPlanConfig(plan);
}

export async function listPlanConfigs(activeOnly = false) {
  const map = await refreshPlanCache();
  return (Object.keys(PLAN_CATALOG) as PlanCatalogKey[])
    .map((id) => {
      const cfg = map[id] || PLAN_CATALOG[id];
      return {
        id,
        priceEgp: cfg.priceEgp,
        casesQuota: cfg.casesQuota,
        durationMonths: cfg.durationMonths,
        labelEn: cfg.labelEn,
        labelAr: cfg.labelAr,
        isActive: cfg.isActive !== false,
        sortOrder: cfg.sortOrder ?? 0,
      };
    })
    .filter((p) => !activeOnly || p.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function addMonths(from: Date, months: number): Date {
  const end = new Date(from);
  end.setMonth(end.getMonth() + months);
  return end;
}

async function resolvePlanEndDate(
  subscription: Awaited<ReturnType<typeof getActiveSubscription>>,
): Promise<Date | null> {
  if (!subscription || !isPaidPlan(subscription.plan)) return null;
  if (subscription.endDate) return subscription.endDate;

  const config = await getPlanDefinition(subscription.plan);
  const months = config.durationMonths || 12;
  const computed = addMonths(subscription.startDate, months);
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { endDate: computed },
  });
  return computed;
}

export async function getActiveSubscription(userId: string) {
  return prisma.subscription.findFirst({
    where: { userId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  });
}

async function getEffectiveAttempts(userId: string, caseId: string) {
  const [access, sessionCount] = await Promise.all([
    prisma.caseAccess.findUnique({
      where: { userId_caseId: { userId, caseId } },
    }),
    prisma.session.count({ where: { userId, caseId } }),
  ]);
  return Math.max(access?.attempts ?? 0, sessionCount);
}

async function getUsedCaseCredits(userId: string, since?: Date | null) {
  return prisma.session.count({
    where: {
      userId,
      ...(since ? { startedAt: { gte: since } } : {}),
    },
  });
}

export async function getUserEntitlements(userId: string) {
  const subscription = await getActiveSubscription(userId);
  const plan = subscription?.plan ?? 'FREE';
  const config = await getPlanDefinition(plan);
  const isFree = !isPaidPlan(plan);
  const periodStart = !isFree && subscription?.startDate ? subscription.startDate : null;
  const casesUnlocked = await getUsedCaseCredits(userId, periodStart);
  const casesQuota = subscription?.casesQuota ?? config.casesQuota;

  const caseAccess = await prisma.caseAccess.findMany({
    where: { userId },
    select: { caseId: true, attempts: true },
  });

  const attemptsByCase: Record<string, number> = {};
  for (const row of caseAccess) {
    attemptsByCase[row.caseId] = row.attempts;
  }

  const sessionsByCase = await prisma.session.groupBy({
    by: ['caseId'],
    where: { userId },
    _count: { _all: true },
  });
  for (const row of sessionsByCase) {
    attemptsByCase[row.caseId] = Math.max(attemptsByCase[row.caseId] ?? 0, row._count._all);
  }

  const planEndDate = await resolvePlanEndDate(subscription);

  return {
    plan,
    isFree,
    freeAttemptsPerCase: FREE_ATTEMPTS_PER_CASE,
    // Free entitlements stay attempt-based; paid plans use credit quotas.
    casesQuota: isFree ? 0 : casesQuota,
    casesUnlocked,
    casesRemaining: isFree ? 0 : Math.max(0, casesQuota - casesUnlocked),
    priceEgp: subscription?.priceEgp ?? config.priceEgp,
    planEndDate: planEndDate?.toISOString() ?? null,
    planStartDate: subscription?.startDate?.toISOString() ?? null,
    planDurationMonths: isFree ? 0 : config.durationMonths,
    attemptsByCase,
  };
}

export async function checkCanStartCase(userId: string, caseId: string) {
  const subscription = await getActiveSubscription(userId);
  const plan = subscription?.plan ?? 'FREE';
  const config = await getPlanDefinition(plan);

  if (!isPaidPlan(plan)) {
    const caseData = await prisma.case.findUnique({
      where: { id: caseId },
      select: { isFreeTier: true },
    });
    if (!caseData?.isFreeTier) {
      return {
        allowed: false as const,
        code: 'SUBSCRIPTION_REQUIRED' as const,
      };
    }

    const attempts = await getEffectiveAttempts(userId, caseId);
    if (attempts >= FREE_ATTEMPTS_PER_CASE) {
      return {
        allowed: false as const,
        code: 'FREE_LIMIT_REACHED' as const,
        attempts,
        limit: FREE_ATTEMPTS_PER_CASE,
      };
    }
    return {
      allowed: true as const,
      attempts,
      attemptsRemaining: FREE_ATTEMPTS_PER_CASE - attempts,
    };
  }

  const periodStart = subscription?.startDate ?? null;
  const casesUnlocked = await getUsedCaseCredits(userId, periodStart);
  const quota = subscription?.casesQuota ?? config.casesQuota;
  if (casesUnlocked >= quota) {
    return {
      allowed: false as const,
      code: 'CASE_QUOTA_EXCEEDED' as const,
      casesUnlocked,
      casesQuota: quota,
    };
  }

  return {
    allowed: true as const,
    casesRemaining: quota - casesUnlocked,
  };
}

export async function recordCaseAttempt(userId: string, caseId: string) {
  await prisma.caseAccess.upsert({
    where: { userId_caseId: { userId, caseId } },
    create: { userId, caseId, attempts: 1 },
    update: { attempts: { increment: 1 } },
  });
}

export async function pickRandomEligibleCase(
  userId: string,
  categoryIds?: string | string[],
) {
  const subscription = await getActiveSubscription(userId);
  const plan = subscription?.plan ?? 'FREE';
  const freePlan = !isPaidPlan(plan);

  const ids = (Array.isArray(categoryIds) ? categoryIds : categoryIds ? [categoryIds] : [])
    .map((id) => id.trim())
    .filter(Boolean);

  const cases = await prisma.case.findMany({
    where: {
      isPublished: true,
      ...(freePlan ? { isFreeTier: true } : {}),
      ...(ids.length === 1 ? { categoryId: ids[0] } : ids.length > 1 ? { categoryId: { in: ids } } : {}),
    },
    include: { specialty: true, difficulty: true, category: true },
  });

  if (cases.length === 0) {
    return { ok: false as const, code: 'NO_CASES' as const };
  }

  const eligible = [];
  for (const caseData of cases) {
    const access = await checkCanStartCase(userId, caseData.id);
    if (access.allowed) eligible.push(caseData);
  }

  if (eligible.length === 0) {
    return { ok: false as const, code: 'NO_ELIGIBLE_CASES' as const };
  }

  const picked = eligible[Math.floor(Math.random() * eligible.length)];
  return { ok: true as const, case: picked, eligibleCount: eligible.length };
}

export async function activatePlan(
  userId: string,
  plan: SubscriptionPlan,
  options?: { endDate?: Date },
) {
  if (plan === 'FREE') {
    throw new Error('INVALID_PLAN');
  }

  const config = await getPlanDefinition(plan);
  if (!config.casesQuota) {
    throw new Error('INVALID_PLAN');
  }

  await prisma.subscription.updateMany({
    where: { userId, status: 'ACTIVE' },
    data: { status: 'CANCELLED', endDate: new Date() },
  });

  const endDate =
    options?.endDate ??
    (config.durationMonths > 0 ? addMonths(new Date(), config.durationMonths) : null);

  return prisma.subscription.create({
    data: {
      userId,
      plan,
      status: 'ACTIVE',
      casesQuota: config.casesQuota,
      priceEgp: config.priceEgp,
      endDate,
    },
  });
}

export async function setUserSubscriptionPlan(
  userId: string,
  plan: SubscriptionPlan,
  options?: { endDate?: Date },
) {
  if (plan === 'FREE') {
    await prisma.subscription.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'CANCELLED', endDate: new Date() },
    });
    return null;
  }

  return activatePlan(userId, plan, options);
}
