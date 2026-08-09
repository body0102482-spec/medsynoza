import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight, Lock, CheckCircle2, Loader2 } from 'lucide-react';
import api from '../../lib/api';

type ModuleView = {
  id: string;
  nameEn: string;
  nameAr: string;
  specialtyEn: string;
  specialtyAr: string;
  subjects: string[];
  locked: boolean;
  owned: boolean;
  priceEgp?: number;
};

type TermView = {
  id: string;
  titleEn: string;
  titleAr: string;
  modules: number;
  questions: number;
};

export default function StudentMcqTermPage() {
  const { termId = '401' } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith('ar');

  const [loading, setLoading] = useState(true);
  const [purchasingId, setPurchasingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [term, setTerm] = useState<TermView | null>(null);
  const [modules, setModules] = useState<ModuleView[]>([]);

  const loadModules = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/student/qbank/${termId}/modules`);
      setTerm(res.data.term);
      setModules(res.data.modules);
    } catch {
      setError(t('portalMcqLoadFailed'));
      setModules([]);
      setTerm(null);
    } finally {
      setLoading(false);
    }
  }, [termId, t]);

  useEffect(() => {
    void loadModules();
  }, [loadModules]);

  const handlePurchase = async (moduleId: string) => {
    setPurchasingId(moduleId);
    setError('');
    try {
      const res = await api.post('/payments/checkout-module', { termId, moduleId });
      const { merchantOrderId, status, provider, iframeUrl } = res.data;

      if (status === 'PAID') {
        navigate(`/student/mcq/${termId}/${moduleId}/setup`, { replace: true });
        return;
      }

      if ((provider === 'paymob' || provider === 'kashier') && iframeUrl) {
        sessionStorage.setItem(`synoza_checkout_${merchantOrderId}`, iframeUrl);
        navigate(`/student/payment/checkout?order=${encodeURIComponent(merchantOrderId)}`, {
          state: { iframeUrl, provider, termId, moduleId },
        });
        return;
      }

      if (provider === 'mock') {
        navigate(`/student/payment/checkout?order=${encodeURIComponent(merchantOrderId)}`, {
          state: { provider: 'mock', termId, moduleId },
        });
        return;
      }

      setError(t('paymentCheckoutFailed'));
    } catch {
      setError(t('paymentCheckoutFailed'));
    } finally {
      setPurchasingId(null);
    }
  };

  if (!loading && !term) {
    return (
      <div className="max-w-3xl mx-auto text-center py-16">
        <p className="text-slate-500">{t('portalMcqComingSoon')}</p>
        <Link to="/student/mcq" className="text-violet-600 font-semibold mt-4 inline-block">
          {t('portalMcqTitle')}
        </Link>
      </div>
    );
  }

  const termTitle = term ? (isAr ? term.titleAr : term.titleEn) : '';

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-8">
      <div className="flex items-start gap-4">
        <Link
          to="/student/mcq"
          className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
          aria-label={t('back')}
        >
          <ArrowLeft size={18} />
        </Link>
        <div>
          <p className="text-3xl font-black text-violet-600 dark:text-violet-400">{termId}</p>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{termTitle}</h1>
          {term && (
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              {term.modules} {t('portalMcqModules')} · {term.questions.toLocaleString()} {t('portalMcqQuestions')}
            </p>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 text-violet-600 animate-spin" />
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {modules.map((mod) => {
            const name = isAr ? mod.nameAr : mod.nameEn;
            const specialty = isAr ? mod.specialtyAr : mod.specialtyEn;
            const unlocked = !mod.locked;
            const isPurchasing = purchasingId === mod.id;

            const inner = (
              <>
                {mod.owned && (
                  <span className="absolute top-3 end-3 inline-flex items-center gap-1 text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 size={12} />
                    {t('portalMcqOwned')}
                  </span>
                )}
                {mod.locked && (
                  <span className="absolute top-3 end-3 inline-flex items-center gap-1 text-[10px] font-bold uppercase text-slate-400">
                    <Lock size={12} />
                    {t('portalCaseLocked')}
                  </span>
                )}
                <p className="text-lg font-black text-violet-600 dark:text-violet-400">{name}</p>
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-0.5">{specialty}</p>
                {mod.subjects.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {mod.subjects.map((s) => (
                      <span
                        key={s}
                        className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700 text-[10px] font-medium text-slate-600 dark:text-slate-300"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
                {mod.locked && mod.priceEgp != null && (
                  <p className="mt-4 text-sm font-bold text-violet-600 dark:text-violet-400">{mod.priceEgp} EGP</p>
                )}
                {unlocked && (
                  <div className="absolute bottom-4 end-4 w-9 h-9 rounded-xl bg-violet-600 text-white flex items-center justify-center">
                    <ChevronRight size={18} />
                  </div>
                )}
                {mod.locked && (
                  <div className="absolute bottom-4 end-4 w-9 h-9 rounded-xl bg-violet-600 text-white flex items-center justify-center">
                    {isPurchasing ? <Loader2 size={18} className="animate-spin" /> : <Lock size={16} />}
                  </div>
                )}
              </>
            );

            if (unlocked) {
              return (
                <Link
                  key={mod.id}
                  to={`/student/mcq/${termId}/${mod.id}/setup`}
                  className="relative block text-start rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 p-5 shadow-sm hover:border-violet-300 dark:hover:border-violet-700 hover:shadow-md transition-all min-h-[140px]"
                >
                  {inner}
                </Link>
              );
            }

            return (
              <button
                key={mod.id}
                type="button"
                onClick={() => void handlePurchase(mod.id)}
                disabled={!!purchasingId}
                className="relative w-full text-start rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 p-5 shadow-sm hover:border-violet-300 dark:hover:border-violet-700 hover:shadow-md transition-all min-h-[140px] disabled:opacity-60 cursor-pointer"
              >
                {inner}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
