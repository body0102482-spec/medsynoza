import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Save, ShieldCheck } from 'lucide-react';
import api from '../../lib/api';

interface AISettingsForm {
  id: string;
  provider: string;
  patientModel: string;
  examinerModel: string;
  temperature: number;
  maxTokens: number;
  systemPromptAr?: string | null;
  systemPromptEn?: string | null;
  patientSystemPromptAr?: string | null;
  patientSystemPromptEn?: string | null;
  examinerSystemPromptAr?: string | null;
  examinerSystemPromptEn?: string | null;
  maxContextMessages?: number;
  openRouterApiKey?: string;
  hasOpenRouterApiKey?: boolean;
  openRouterEnvConfigured?: boolean;
}

const OPENROUTER_MODEL_HINTS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3.5-sonnet',
  'google/gemini-2.0-flash-001',
];

export function AdminSettingsTab() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AISettingsForm | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/admin/ai-settings');
      const s = r.data.settings as AISettingsForm;
      setSettings(s);
      setKeyDraft('');
    } catch {
      setError(t('adminSettingsLoadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        provider: settings.provider,
        patientModel: settings.patientModel,
        examinerModel: settings.examinerModel,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        maxContextMessages: settings.maxContextMessages ?? 12,
        patientSystemPromptAr: settings.patientSystemPromptAr,
        patientSystemPromptEn: settings.patientSystemPromptEn,
        examinerSystemPromptAr: settings.examinerSystemPromptAr,
        examinerSystemPromptEn: settings.examinerSystemPromptEn,
        systemPromptAr: settings.systemPromptAr,
        systemPromptEn: settings.systemPromptEn,
      };
      if (keyDraft.trim()) {
        payload.openRouterApiKey = keyDraft.trim();
      }
      const r = await api.put('/admin/ai-settings', payload);
      setSettings(r.data.settings);
      setKeyDraft('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError(t('adminSettingsSaveError'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="card p-8 text-center text-slate-500 dark:text-slate-400">
        {t('loading')}
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="card p-6 text-red-600 dark:text-red-400">
        {error || t('adminSettingsLoadError')}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="card p-6">
        <div className="flex items-start gap-3 mb-6">
          <div className="p-2.5 rounded-xl bg-primary/10 text-primary">
            <KeyRound size={22} />
          </div>
          <div>
            <h2 className="font-semibold text-lg text-slate-900 dark:text-white">
              {t('adminSettingsTitle')}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              {t('adminSettingsDesc')}
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="space-y-5">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              {t('adminAiProvider')}
            </label>
            <select
              className="input-field"
              value={settings.provider}
              onChange={(e) => setSettings({ ...settings, provider: e.target.value })}
            >
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
              <option value="mock">Mock / Demo</option>
            </select>
            <p className="text-xs text-slate-400 mt-1">{t('adminAiProviderHint')}</p>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-600" />
              <h3 className="font-semibold text-sm text-slate-900 dark:text-white">
                {t('adminOpenRouterKey')}
              </h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('adminOpenRouterKeyHint')}
            </p>
            {(settings.hasOpenRouterApiKey || settings.openRouterApiKey) && (
              <p className="text-xs font-mono text-slate-600 dark:text-slate-300">
                {t('adminOpenRouterKeyStored')}: {settings.openRouterApiKey || '••••'}
                {settings.openRouterEnvConfigured ? ` (${t('adminOpenRouterEnvActive')})` : ''}
              </p>
            )}
            <input
              type="password"
              autoComplete="off"
              className="input-field font-mono text-sm"
              placeholder={t('adminOpenRouterKeyPlaceholder')}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
            <p className="text-[11px] text-slate-400">{t('adminOpenRouterKeyLeaveBlank')}</p>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">
                {t('patientModel')}
              </label>
              <input
                className="input-field"
                list="openrouter-models"
                value={settings.patientModel}
                onChange={(e) => setSettings({ ...settings, patientModel: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">
                {t('examinerModel')}
              </label>
              <input
                className="input-field"
                list="openrouter-models"
                value={settings.examinerModel}
                onChange={(e) => setSettings({ ...settings, examinerModel: e.target.value })}
              />
            </div>
          </div>
          <datalist id="openrouter-models">
            {OPENROUTER_MODEL_HINTS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {settings.provider === 'openrouter' && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('adminOpenRouterModelHint')}
            </p>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="btn-primary inline-flex items-center gap-2"
            >
              <Save size={16} />
              {saving ? t('saving') : t('save')}
            </button>
            {saved && (
              <span className="text-sm text-emerald-600">{t('aiSettingsSaved')}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
