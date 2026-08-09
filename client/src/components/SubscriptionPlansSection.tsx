import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, Phone, Sparkles, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconBox } from './IconBox';
import api from '../lib/api';
import { dispatchEntitlementsChanged } from '../lib/entitlementsEvents';
import { PlanMarketingCards, type PlanOption } from './PlanMarketingCards';

export type { PlanOption };

export interface EntitlementsSummary {
  plan: string;
  isFree: boolean;
  casesQuota: number;
  casesUnlocked: number;
  casesRemaining: number;
  freeAttemptsPerCase?: number;
  attemptsByCase?: Record<string, number>;
}

interface FreeTierCase {
  id: string;
  titleEn: string;
  titleAr: string;
  chiefComplaint: string;
}

interface SubscriptionPlansSectionProps {
  entitlements: EntitlementsSummary;
  plans: PlanOption[];
  isAr: boolean;
  /** Hide hero copy when embedded under another page heading */
  compact?: boolean;
}

const CONTACT_PHONE = '01024828652';
const WHATSAPP_URL = `https://wa.me/201024828652`;

function buildWhatsAppLink(planName: string, price: number, isAr: boolean) {
  const text = isAr
    ? `مرحباً، أريد تفعيل باقة ${planName} (${price} ج.م) على Synoza.`
    : `Hi, I want to activate the ${planName} plan (${price} EGP) on Synoza.`;
  return `${WHATSAPP_URL}?text=${encodeURIComponent(text)}`;
}

export function SubscriptionPlansSection({
  entitlements,
  plans,
  isAr,
  compact = false,
}: SubscriptionPlansSectionProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [checkoutPlanId, setCheckoutPlanId] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState('');
  const [freeCases, setFreeCases] = useState<FreeTierCase[]>([]);
  const [startingCaseId, setStartingCaseId] = useState<string | null>(null);

  const freeAttemptsPerCase = entitlements.freeAttemptsPerCase ?? 3;
  const attemptsByCase = entitlements.attemptsByCase ?? {};
  const freeCase = freeCases[0] ?? null;

  useEffect(() => {
    if (!entitlements.isFree) return;
    api
      .get('/cases', { params: { freeTier: 'true' } })
      .then((r) => setFreeCases(r.data.cases ?? []))
      .catch(() => {});
  }, [entitlements.isFree]);

  const getAttemptsLeft = (caseId: string) =>
    Math.max(0, freeAttemptsPerCase - (attemptsByCase[caseId] ?? 0));

  const startFreeCase = async (caseId: string) => {
    setStartingCaseId(caseId);
    try {
      const res = await api.post('/sessions/start', { caseId, language: 'AR' });
      if (res.data.entitlements) {
        dispatchEntitlementsChanged(res.data.entitlements);
      } else {
        dispatchEntitlementsChanged();
      }
      navigate(`/simulation/${res.data.session.id}`, { state: { fromCaseStart: true } });
    } catch {
      /* handled on simulation route */
    } finally {
      setStartingCaseId(null);
    }
  };

  const handleCheckout = async (planId: string) => {
    setCheckoutError('');
    setCheckoutPlanId(planId);
    try {
      const res = await api.post('/payments/checkout', { planId });
      const { merchantOrderId, iframeUrl, provider, status } = res.data as {
        merchantOrderId: string;
        iframeUrl?: string;
        provider?: string;
        status?: string;
      };
      if (status === 'PAID') {
        navigate(`/student/payment/success?order=${encodeURIComponent(merchantOrderId)}`);
        return;
      }
      if (iframeUrl) {
        sessionStorage.setItem(`synoza_checkout_${merchantOrderId}`, iframeUrl);
      }
      navigate(`/student/payment/checkout?order=${encodeURIComponent(merchantOrderId)}`, {
        state: { iframeUrl, provider },
      });
    } catch (err: unknown) {
      const code = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setCheckoutError(
        code === 'PAYMOB_NOT_CONFIGURED' || code === 'KASHIER_NOT_CONFIGURED'
          ? t('paymentGatewayNotReady')
          : t('paymentCheckoutFailed'),
      );
    } finally {
      setCheckoutPlanId(null);
    }
  };

  const canStartFree = Boolean(freeCase && getAttemptsLeft(freeCase.id) > 0);
  const planLabel = entitlements.plan.replace('PACKAGE_', '');

  return (
    <section id="subscription-plans" className="space-y-6">
      {!entitlements.isFree && (
        <div className="relative overflow-hidden rounded-2xl border border-teal-200 dark:border-teal-800/60 bg-gradient-to-br from-teal-50 via-white to-indigo-50/50 dark:from-teal-950/30 dark:via-slate-900/80 dark:to-indigo-950/20 p-6 sm:p-8">
          <div className="absolute top-0 end-0 w-40 h-40 bg-teal-400/10 rounded-full blur-3xl pointer-events-none" aria-hidden />
          <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
            <div className="flex items-start gap-4">
              <IconBox icon={Crown} variant="brand" size="xl" />
              <div>
                <p className="text-label mb-1">{t('subscriptionPlans')}</p>
                <h2 className="text-heading text-xl sm:text-2xl mb-1">
                  {t('activePlanTitle', { plan: planLabel })}
                </h2>
                <p className="text-body text-sm">{t('activePlanDesc')}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="rounded-xl bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 px-4 py-3 min-w-[120px]">
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('casesUnlockedLabel')}</p>
                <p className="text-xl font-bold text-slate-900 dark:text-white">
                  {entitlements.casesUnlocked}/{entitlements.casesQuota}
                </p>
              </div>
              <div className="rounded-xl bg-white/80 dark:bg-slate-800/80 border border-emerald-200 dark:border-emerald-800/60 px-4 py-3 min-w-[120px]">
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('casesRemainingLabel')}</p>
                <p className="text-xl font-bold text-emerald-700 dark:text-emerald-400">
                  {t('casesRemaining', { count: entitlements.casesRemaining })}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {!compact && (
        <div className="text-center sm:text-start">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-teal-100 dark:bg-teal-950/50 text-teal-800 dark:text-teal-300 text-xs font-semibold mb-3">
            <Sparkles size={14} />
            {t('subscriptionHeroBadge')}
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-2">
            {t('subscriptionHeroTitle')}
          </h2>
          <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 max-w-2xl mx-auto sm:mx-0">
            {t('subscriptionHeroDesc')}
          </p>
        </div>
      )}

      {checkoutError && (
        <div className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
          {checkoutError}
        </div>
      )}

      <PlanMarketingCards
        plans={plans}
        mode="checkout"
        currentPlanId={entitlements.plan}
        checkoutPlanId={checkoutPlanId}
        startingFree={startingCaseId !== null}
        canStartFree={canStartFree}
        onStartFree={() => {
          if (freeCase && canStartFree) void startFreeCase(freeCase.id);
        }}
        onCheckout={(planId) => void handleCheckout(planId)}
      />

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/60 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <IconBox icon={Zap} variant="soft" size="md" />
          <div>
            <p className="font-semibold text-slate-900 dark:text-white text-sm">{t('paymentHelpTitle')}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{t('paymentSecureDesc')}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`tel:+20${CONTACT_PHONE.replace(/^0/, '')}`}
            className="btn-secondary inline-flex items-center gap-2 text-sm px-4 py-2.5"
          >
            <Phone size={16} />
            {CONTACT_PHONE}
          </a>
          <a
            href={buildWhatsAppLink(t('planNamePro'), 300, isAr)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary inline-flex items-center gap-2 text-sm px-4 py-2.5"
          >
            WhatsApp
          </a>
        </div>
      </div>
    </section>
  );
}
