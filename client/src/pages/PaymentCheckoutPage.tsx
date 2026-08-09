import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CreditCard, Loader2, Lock, ShieldCheck } from 'lucide-react';
import api from '../lib/api';
import { Navbar } from '../components/Navbar';

type CheckoutState = {
  iframeUrl?: string;
  provider?: string;
};

export default function PaymentCheckoutPage() {
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith('ar');
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const orderRef = searchParams.get('order') || '';
  const state = (location.state as CheckoutState) || {};

  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');
  const [iframeUrl, setIframeUrl] = useState(state.iframeUrl || '');
  const [provider, setProvider] = useState(state.provider || '');
  const [order, setOrder] = useState<{
    status: string;
    planLabelEn?: string;
    planLabelAr?: string;
    amountEgp?: number;
    provider?: string;
  } | null>(null);

  useEffect(() => {
    if (!orderRef) {
      setError(t('paymentCheckoutMissing'));
      setLoading(false);
      return;
    }

    const stored = sessionStorage.getItem(`synoza_checkout_${orderRef}`);
    if (!iframeUrl && stored) setIframeUrl(stored);

    const load = async () => {
      try {
        const res = await api.get(`/payments/orders/${encodeURIComponent(orderRef)}`);
        const o = res.data.order;
        setOrder(o);
        setProvider(o.provider || provider);

        if (o.status === 'PAID') {
          navigate(`/student/payment/success?order=${encodeURIComponent(orderRef)}`, { replace: true });
          return;
        }
        if (o.status === 'FAILED') {
          navigate(`/student/payment/failed?order=${encodeURIComponent(orderRef)}`, { replace: true });
          return;
        }
      } catch {
        setError(t('paymentVerifyFailed'));
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [orderRef, iframeUrl, provider, navigate, t]);

  useEffect(() => {
    if (!orderRef || (provider !== 'paymob' && provider !== 'kashier') || !iframeUrl) return;

    const poll = setInterval(async () => {
      try {
        const res = await api.get(`/payments/orders/${encodeURIComponent(orderRef)}`);
        if (res.data.order.status === 'PAID') {
          navigate(`/student/payment/success?order=${encodeURIComponent(orderRef)}`, { replace: true });
        } else if (res.data.order.status === 'FAILED') {
          navigate(`/student/payment/failed?order=${encodeURIComponent(orderRef)}`, { replace: true });
        }
      } catch {
        /* ignore poll errors */
      }
    }, 4000);

    return () => clearInterval(poll);
  }, [orderRef, provider, iframeUrl, navigate]);

  const handleMockPay = async () => {
    setPaying(true);
    setError('');
    try {
      await api.post('/payments/mock/complete', { merchantOrderId: orderRef });
      navigate(`/student/payment/success?order=${encodeURIComponent(orderRef)}`, { replace: true });
    } catch {
      setError(t('paymentCheckoutFailed'));
      setPaying(false);
    }
  };

  const planLabel = order ? (isAr ? order.planLabelAr : order.planLabelEn) : '';

  return (
    <div className="min-h-screen auth-bg flex flex-col">
      <Navbar />
      <div className="flex-1 px-4 py-8 sm:py-12">
        <div className="max-w-2xl mx-auto">
          {loading ? (
            <div className="card p-10 text-center">
              <Loader2 className="w-10 h-10 text-teal-600 animate-spin mx-auto mb-4" />
              <p className="text-slate-600 dark:text-slate-300">{t('paymentProcessing')}</p>
            </div>
          ) : error ? (
            <div className="card p-8 text-center">
              <p className="text-red-600 dark:text-red-400 mb-6">{error}</p>
              <Link to="/student" className="btn-primary inline-block px-6 py-3">
                {t('backToDashboard')}
              </Link>
            </div>
          ) : (
            <>
              <div className="text-center mb-6">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-teal-100 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200 text-xs font-semibold mb-3">
                  <Lock size={14} />
                  {t('paymentCheckoutSecure')}
                </div>
                <h1 className="text-heading text-2xl mb-1">{t('paymentCheckoutTitle')}</h1>
                {planLabel && (
                  <p className="text-body text-sm">
                    {planLabel}
                    {order?.amountEgp ? ` · ${order.amountEgp} ${t('egp')}` : ''}
                  </p>
                )}
              </div>

              {(provider === 'paymob' || provider === 'kashier') && iframeUrl ? (
                <div className="card overflow-hidden shadow-xl">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                    <ShieldCheck size={18} className="text-teal-600" />
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      {provider === 'kashier'
                        ? t('paymentKashierLabel')
                        : t('paymentPaymobLabel')}
                    </span>
                  </div>
                  <iframe
                    title={provider === 'kashier' ? 'Kashier checkout' : 'Paymob checkout'}
                    src={iframeUrl}
                    className="w-full min-h-[520px] border-0 bg-white"
                    allow="payment"
                  />
                </div>
              ) : provider === 'mock' ? (
                <div className="card p-6 sm:p-8 shadow-xl space-y-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                    {t('paymentMockNotice')}
                  </p>
                  <div className="space-y-4">
                    <div>
                      <label className="text-label block mb-1.5">{t('paymentCardNumber')}</label>
                      <input
                        type="text"
                        readOnly
                        value="4242 4242 4242 4242"
                        className="input w-full font-mono"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-label block mb-1.5">{t('paymentExpiry')}</label>
                        <input type="text" readOnly value="12/28" className="input w-full font-mono" />
                      </div>
                      <div>
                        <label className="text-label block mb-1.5">CVV</label>
                        <input type="text" readOnly value="123" className="input w-full font-mono" />
                      </div>
                    </div>
                  </div>
                  {error && (
                    <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleMockPay()}
                    disabled={paying}
                    className="btn-primary w-full py-3.5 inline-flex items-center justify-center gap-2"
                  >
                    {paying ? (
                      <>
                        <Loader2 size={18} className="animate-spin" />
                        {t('paymentProcessing')}
                      </>
                    ) : (
                      <>
                        <CreditCard size={18} />
                        {t('paymentConfirmPay', { amount: order?.amountEgp ?? '' })}
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="card p-8 text-center">
                  <p className="text-body text-sm mb-6">{t('paymentSessionExpired')}</p>
                  <Link to="/student" className="btn-primary inline-block px-6 py-3">
                    {t('backToDashboard')}
                  </Link>
                </div>
              )}

              <p className="text-center text-xs text-slate-500 dark:text-slate-400 mt-4">
                {t('paymentCheckoutFooter')}{' '}
                <Link
                  to="/refund-policy"
                  className="underline underline-offset-2 hover:text-teal-700 dark:hover:text-teal-400"
                >
                  {t('refundPolicyLink')}
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
