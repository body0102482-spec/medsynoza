import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import {
  Users, FileText, BarChart3, ClipboardList,
  TrendingUp, Activity, CheckCircle2, BookOpen, FolderTree, Plus, Trash2,
  Globe, GraduationCap, Pencil, X, Eye, ExternalLink, RefreshCw, Library,
  DollarSign, Cpu, Sparkles, Settings,
} from 'lucide-react';
import api, { pingServer } from '../lib/api';
import { DashboardLayout } from '../components/DashboardLayout';
import { AdminQbankTab } from '../components/admin/AdminQbankTab';
import { AdminCasesTab } from '../components/admin/AdminCasesTab';
import { AdminUserPlanModal } from '../components/admin/AdminUserPlanModal';
import { AdminApiUsageTab } from '../components/admin/AdminApiUsageTab';
import { AdminPricingTab } from '../components/admin/AdminPricingTab';
import { AdminStudentProfile } from '../components/admin/AdminStudentProfile';
import { AdminKnowledgeAiTab } from '../components/admin/AdminKnowledgeAiTab';
import { AdminSettingsTab } from '../components/admin/AdminSettingsTab';
import type { SiteSettings } from '../components/SiteFooter';

type Tab = 'overview' | 'users' | 'cases' | 'results' | 'knowledge' | 'knowledgeAi' | 'site' | 'qbank' | 'apiUsage' | 'pricing' | 'settings';

interface CategoryRow {
  id: string;
  nameEn: string;
  nameAr: string;
  description?: string | null;
  parentId?: string | null;
  sortOrder: number;
  isActive: boolean;
  parent?: { id: string; nameEn: string; nameAr: string } | null;
  _count?: { items: number; cases: number; children: number };
}

interface KnowledgeRow {
  id: string;
  categoryId: string;
  titleEn: string;
  titleAr: string;
  content: string;
  type: string;
  isActive: boolean;
  category?: { nameEn: string; nameAr: string } | null;
}

interface AISettingsRow {
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
}

interface UserSubscriptionRow {
  id: string;
  plan: string;
  status: string;
  endDate?: string | null;
}

interface AdminUserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  phone?: string | null;
  university?: string | null;
  academicYear?: string | null;
  lastSeenAt?: string | null;
  totalXp?: number;
  subscriptions?: UserSubscriptionRow[];
}

interface UniversityRow {
  id: string;
  nameEn: string;
  nameAr: string;
  logoUrl?: string | null;
  website?: string | null;
  sortOrder: number;
  isActive: boolean;
}

interface StatsSeriesPoint {
  date: string;
  sessions: number;
  completedSessions: number;
  newUsers: number;
  revenueEgp: number;
}

const statMeta: Record<string, { label: string; icon: typeof Users; color: string; bg: string }> = {
  users: { label: 'Total Users', icon: Users, color: 'text-blue-600', bg: 'bg-blue-500' },
  cases: { label: 'Clinical Cases', icon: FileText, color: 'text-violet-600', bg: 'bg-violet-500' },
  sessions: { label: 'Sessions', icon: Activity, color: 'text-amber-600', bg: 'bg-amber-500' },
  completedSessions: { label: 'Completed', icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-500' },
  newUsers: { label: 'New Users', icon: Users, color: 'text-sky-600', bg: 'bg-sky-500' },
  averageScore: { label: 'Avg Score', icon: TrendingUp, color: 'text-rose-600', bg: 'bg-rose-500' },
  revenueEgp: { label: 'Revenue (EGP)', icon: DollarSign, color: 'text-emerald-700', bg: 'bg-emerald-600' },
};

function daysAgoIso(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function startOfMonthIso() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function startOfYearIso() {
  const d = new Date();
  return new Date(d.getFullYear(), 0, 1).toISOString().slice(0, 10);
}

export default function AdminDashboard() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('overview');
  const [stats, setStats] = useState<Record<string, number>>({});
  const [statsSeries, setStatsSeries] = useState<StatsSeriesPoint[]>([]);
  const [statsFrom, setStatsFrom] = useState(daysAgoIso(30));
  const [statsTo, setStatsTo] = useState(new Date().toISOString().slice(0, 10));
  const [statsGranularity, setStatsGranularity] = useState<'day' | 'week' | 'month'>('day');
  const [recentSessions, setRecentSessions] = useState<Record<string, unknown>[]>([]);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [userUniversities, setUserUniversities] = useState<string[]>([]);
  const [userFilterQ, setUserFilterQ] = useState('');
  const [userFilterUniversity, setUserFilterUniversity] = useState('');
  const [userFilterPlan, setUserFilterPlan] = useState('');
  const [planModalUser, setPlanModalUser] = useState<AdminUserRow | null>(null);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, unknown>[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeRow[]>([]);
  const [aiSettings, setAiSettings] = useState<AISettingsRow | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null);
  const [categoryForm, setCategoryForm] = useState({
    nameEn: '', nameAr: '', description: '', parentId: '', sortOrder: 0, isActive: true,
  });
  const [knowledgeForm, setKnowledgeForm] = useState({
    titleEn: '', titleAr: '', content: '', type: 'QUESTION', isActive: true,
  });
  const [universities, setUniversities] = useState<UniversityRow[]>([]);
  const [siteSettings, setSiteSettings] = useState<SiteSettings | null>(null);
  const [uniForm, setUniForm] = useState({ nameEn: '', nameAr: '', logoUrl: '', website: '', sortOrder: 0, isActive: true });
  const [editingUniId, setEditingUniId] = useState<string | null>(null);
  const [viewingUni, setViewingUni] = useState<UniversityRow | null>(null);
  const [uniLoading, setUniLoading] = useState(false);
  const [uniError, setUniError] = useState('');
  const [uniSaving, setUniSaving] = useState(false);
  const [siteSaved, setSiteSaved] = useState(false);
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [aiSaved, setAiSaved] = useState(false);

  const loadOverviewStats = async (overrides?: {
    from?: string;
    to?: string;
    granularity?: 'day' | 'week' | 'month';
  }) => {
    const from = overrides?.from ?? statsFrom;
    const to = overrides?.to ?? statsTo;
    const granularity = overrides?.granularity ?? statsGranularity;
    const r = await api.get('/admin/stats', {
      params: { from, to, granularity },
    });
    setStats(r.data.stats);
    setStatsSeries(r.data.series || []);
    setRecentSessions(r.data.recentSessions || []);
  };

  const refreshUsers = (overrides?: { q?: string; university?: string; plan?: string }) => {
    const q = overrides?.q ?? userFilterQ;
    const university = overrides?.university ?? userFilterUniversity;
    const plan = overrides?.plan ?? userFilterPlan;
    void api
      .get('/admin/users', {
        params: {
          q: q || undefined,
          university: university || undefined,
          plan: plan || undefined,
          pageSize: 100,
        },
      })
      .then((r) => {
        setUsers(r.data.users as AdminUserRow[]);
        setUserUniversities(r.data.universities || []);
      });
  };

  const refreshCategories = async () => {
    const r = await api.get('/admin/categories');
    setCategories(r.data.categories);
    if (!selectedCategoryId && r.data.categories.length > 0) {
      setSelectedCategoryId(r.data.categories[0].id);
    }
    return r.data.categories as CategoryRow[];
  };

  const refreshKnowledgeItems = async (categoryId: string) => {
    const r = await api.get(`/admin/categories/${categoryId}/knowledge`);
    setKnowledgeItems(r.data.items);
  };

  const loadKnowledgeAdmin = async () => {
    const [categoriesRes, aiSettingsRes] = await Promise.all([
      api.get('/admin/categories'),
      api.get('/admin/ai-settings'),
    ]);
    const nextCategories = categoriesRes.data.categories as CategoryRow[];
    setCategories(nextCategories);
    setAiSettings(aiSettingsRes.data.settings);
    if (!selectedCategoryId && nextCategories.length > 0) {
      setSelectedCategoryId(nextCategories[0].id);
    }
  };

  const loadSiteContent = async () => {
    setUniLoading(true);
    setUniError('');
    try {
      const ping = await pingServer();
      if (!ping.online) {
        setUniError('Backend server is offline. Stop any duplicate server, then from the Synoza folder run: npm run dev');
        return;
      }

      const [uniRes, settingsRes] = await Promise.all([
        api.get('/admin/universities'),
        api.get('/admin/site-settings'),
      ]);
      setUniversities(uniRes.data.universities || []);
      setSiteSettings(settingsRes.data.settings);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 403) {
          setUniError('Admin access required. Log in with admin@synoza.com / Admin@123456');
        } else if (!err.response) {
          setUniError('Cannot reach the API server. Run npm run dev from C:\\Users\\Eng-Loay\\Desktop\\Synoza (not from server/ alone).');
        } else {
          setUniError(String(err.response.data?.error || 'Could not load site content.'));
        }
      } else {
        setUniError('Could not load site content.');
      }
    } finally {
      setUniLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'overview') {
      void loadOverviewStats();
    }
    if (tab === 'users') refreshUsers();
    if (tab === 'results') api.get('/admin/results').then((r) => setResults(r.data.results));
    if (tab === 'knowledge') {
      void loadKnowledgeAdmin();
    }
    if (tab === 'site') {
      void loadSiteContent();
    }
  }, [tab]);

  useEffect(() => {
    if (tab === 'knowledge' && selectedCategoryId) {
      void refreshKnowledgeItems(selectedCategoryId);
    }
  }, [tab, selectedCategoryId]);

  const formatLastSeen = (value?: string | null) => {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return '—';
    }
  };

  const activePlanForUser = (user: AdminUserRow) => {
    const sub = user.subscriptions?.[0];
    if (!sub || sub.status !== 'ACTIVE') return 'FREE';
    return sub.plan;
  };

  const applyStatsPreset = (preset: 'today' | '7d' | '30d' | 'month' | 'year') => {
    const today = new Date().toISOString().slice(0, 10);
    let from = today;
    let to = today;
    let granularity: 'day' | 'week' | 'month' = 'day';
    if (preset === 'today') {
      from = today;
      to = today;
    } else if (preset === '7d') {
      from = daysAgoIso(7);
    } else if (preset === '30d') {
      from = daysAgoIso(30);
    } else if (preset === 'month') {
      from = startOfMonthIso();
    } else {
      from = startOfYearIso();
      granularity = 'month';
    }
    setStatsFrom(from);
    setStatsTo(to);
    setStatsGranularity(granularity);
    void loadOverviewStats({ from, to, granularity });
  };

  const navItems = [
    { id: 'overview', label: t('statistics'), icon: BarChart3 },
    { id: 'settings', label: t('adminSettingsNav'), icon: Settings },
    { id: 'apiUsage', label: t('adminApiUsage'), icon: Cpu },
    { id: 'pricing', label: t('adminPricing'), icon: DollarSign },
    { id: 'users', label: t('users'), icon: Users },
    { id: 'cases', label: t('cases'), icon: FileText },
    { id: 'results', label: t('results'), icon: ClipboardList },
    { id: 'knowledge', label: t('knowledgeBase'), icon: BookOpen },
    { id: 'knowledgeAi', label: t('adminAiKbNav'), icon: Sparkles },
    { id: 'qbank', label: t('adminQbankNav'), icon: Library },
    { id: 'site', label: 'Site Content', icon: Globe },
  ];

  const overviewStatKeys = ['users', 'cases', 'sessions', 'completedSessions', 'newUsers', 'averageScore', 'revenueEgp'];
  const maxSeriesSessions = Math.max(1, ...statsSeries.map((s) => s.sessions));

  const resetCategoryForm = () => {
    setEditingCategoryId(null);
    setCategoryForm({ nameEn: '', nameAr: '', description: '', parentId: '', sortOrder: 0, isActive: true });
  };

  const saveCategory = async () => {
    const payload = {
      ...categoryForm,
      parentId: categoryForm.parentId || null,
    };
    if (editingCategoryId) {
      await api.put(`/admin/categories/${editingCategoryId}`, payload);
    } else {
      await api.post('/admin/categories', payload);
    }
    resetCategoryForm();
    await refreshCategories();
  };

  const resetKnowledgeForm = () => {
    setEditingKnowledgeId(null);
    setKnowledgeForm({ titleEn: '', titleAr: '', content: '', type: 'QUESTION', isActive: true });
  };

  const saveKnowledge = async () => {
    if (!selectedCategoryId) return;
    setKnowledgeSaving(true);
    try {
      const payload = { ...knowledgeForm, categoryId: selectedCategoryId };
      if (editingKnowledgeId) {
        await api.put(`/admin/knowledge/${editingKnowledgeId}`, payload);
      } else {
        await api.post('/admin/knowledge', payload);
      }
      resetKnowledgeForm();
      await refreshKnowledgeItems(selectedCategoryId);
    } finally {
      setKnowledgeSaving(false);
    }
  };

  const deleteKnowledge = async (id: string) => {
    await api.delete(`/admin/knowledge/${id}`);
    setKnowledgeItems((items) => items.filter((i) => i.id !== id));
  };

  const deleteCategory = async (id: string) => {
    await api.delete(`/admin/categories/${id}`);
    const nextCategories = await refreshCategories();
    if (selectedCategoryId === id) setSelectedCategoryId(nextCategories[0]?.id || '');
    if (editingCategoryId === id) resetCategoryForm();
  };

  const editCategory = (category: CategoryRow) => {
    setEditingCategoryId(category.id);
    setSelectedCategoryId(category.id);
    setCategoryForm({
      nameEn: category.nameEn,
      nameAr: category.nameAr,
      description: category.description || '',
      parentId: category.parentId || '',
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    });
  };

  const editKnowledge = (item: KnowledgeRow) => {
    setEditingKnowledgeId(item.id);
    setSelectedCategoryId(item.categoryId);
    setKnowledgeForm({
      titleEn: item.titleEn,
      titleAr: item.titleAr,
      content: item.content,
      type: item.type,
      isActive: item.isActive,
    });
  };

  const saveAISettings = async () => {
    if (!aiSettings) return;
    const r = await api.put('/admin/ai-settings', aiSettings);
    setAiSettings(r.data.settings);
    setAiSaved(true);
    setTimeout(() => setAiSaved(false), 2000);
  };

  const resetUniForm = () => {
    setUniForm({ nameEn: '', nameAr: '', logoUrl: '', website: '', sortOrder: 0, isActive: true });
    setEditingUniId(null);
    setViewingUni(null);
  };

  const saveUniversity = async () => {
    setUniSaving(true);
    setUniError('');
    const payload = {
      ...uniForm,
      logoUrl: uniForm.logoUrl || null,
      website: uniForm.website || null,
    };
    try {
      if (editingUniId) {
        await api.put(`/admin/universities/${editingUniId}`, payload);
      } else {
        await api.post('/admin/universities', payload);
      }
      resetUniForm();
      const r = await api.get('/admin/universities');
      setUniversities(r.data.universities || []);
    } catch {
      setUniError('Could not save university. Check required fields and try again.');
    } finally {
      setUniSaving(false);
    }
  };

  const editUniversity = (uni: UniversityRow) => {
    setViewingUni(null);
    setEditingUniId(uni.id);
    setUniForm({
      nameEn: uni.nameEn,
      nameAr: uni.nameAr,
      logoUrl: uni.logoUrl || '',
      website: uni.website || '',
      sortOrder: uni.sortOrder,
      isActive: uni.isActive,
    });
  };

  const viewUniversity = (uni: UniversityRow) => {
    setEditingUniId(null);
    setViewingUni(uni);
  };

  const deleteUniversity = async (id: string) => {
    const uni = universities.find((u) => u.id === id);
    if (!window.confirm(`Delete "${uni?.nameEn || 'this university'}"?`)) return;
    setUniError('');
    try {
      await api.delete(`/admin/universities/${id}`);
      setUniversities((list) => list.filter((u) => u.id !== id));
      if (editingUniId === id) resetUniForm();
      if (viewingUni?.id === id) setViewingUni(null);
    } catch {
      setUniError('Could not delete university.');
    }
  };

  const saveSiteSettings = async () => {
    if (!siteSettings) return;
    const r = await api.put('/admin/site-settings', siteSettings);
    setSiteSettings(r.data.settings);
    setSiteSaved(true);
    setTimeout(() => setSiteSaved(false), 2000);
  };

  return (
    <DashboardLayout
      title={t('adminPanel')}
      subtitle="Manage users, cases, results & site content"
      navItems={navItems}
      activeId={tab}
      onNavChange={(id) => setTab(id as Tab)}
      homeLink="/admin"
    >
      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="card p-4 flex flex-wrap items-end gap-3">
            <div className="flex flex-wrap gap-2">
              {([
                ['today', t('adminPresetToday')],
                ['7d', t('adminPreset7d')],
                ['30d', t('adminPreset30d')],
                ['month', t('adminPresetMonth')],
                ['year', t('adminPresetYear')],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => applyStatsPreset(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">{t('adminDateFrom')}</label>
              <input type="date" className="input-field" value={statsFrom} onChange={(e) => setStatsFrom(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">{t('adminDateTo')}</label>
              <input type="date" className="input-field" value={statsTo} onChange={(e) => setStatsTo(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">{t('adminGranularity')}</label>
              <select
                className="input-field"
                value={statsGranularity}
                onChange={(e) => setStatsGranularity(e.target.value as 'day' | 'week' | 'month')}
              >
                <option value="day">{t('adminGranularityDay')}</option>
                <option value="week">{t('adminGranularityWeek')}</option>
                <option value="month">{t('adminGranularityMonth')}</option>
              </select>
            </div>
            <button type="button" className="btn-primary" onClick={() => void loadOverviewStats()}>
              {t('adminApplyFilters')}
            </button>
          </div>

          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {overviewStatKeys.map((key) => {
              const value = stats[key];
              if (value === undefined) return null;
              const meta = statMeta[key] || { label: key, icon: BarChart3, color: 'text-slate-600', bg: 'bg-slate-500' };
              const Icon = meta.icon;
              return (
                <div key={key} className="stat-card group hover:shadow-md transition-shadow">
                  <div className={`absolute top-0 right-0 w-20 h-20 ${meta.bg} rounded-full opacity-10 -translate-y-1/3 translate-x-1/3`} />
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">{meta.label}</p>
                      <p className="text-3xl font-bold mt-2 text-slate-900 dark:text-white">
                        {typeof value === 'number'
                          ? key === 'averageScore'
                            ? `${Math.round(value * 10) / 10}%`
                            : value.toLocaleString()
                          : value}
                      </p>
                    </div>
                    <div className={`p-3 rounded-xl bg-slate-50 dark:bg-slate-800 ${meta.color}`}>
                      <Icon size={22} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card p-6">
            <h2 className="font-semibold text-slate-900 dark:text-white mb-4">{t('adminSessionsChart')}</h2>
            {statsSeries.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">{t('adminNoSeriesData')}</p>
            ) : (
              <div className="flex items-end gap-1 h-44">
                {statsSeries.map((point) => (
                  <div key={point.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                    <div
                      className="w-full rounded-t bg-amber-500/80"
                      style={{ height: `${Math.max(4, (point.sessions / maxSeriesSessions) * 100)}%` }}
                      title={`${point.date}: ${point.sessions} sessions, ${point.newUsers} users, ${point.revenueEgp} EGP`}
                    />
                    <span className="text-[9px] text-slate-400 truncate w-full text-center">{point.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800">
              <h2 className="font-semibold text-slate-900 dark:text-white">{t('recentSessions')}</h2>
            </div>
            <div className="table-scroll">
              <table className="dashboard-table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Case</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.length === 0 ? (
                    <tr><td colSpan={3} className="text-center text-slate-400 py-8">No sessions yet</td></tr>
                  ) : (
                    recentSessions.map((s) => {
                      const user = s.user as Record<string, string>;
                      const caseData = s.case as Record<string, string>;
                      return (
                        <tr key={s.id as string}>
                          <td className="font-medium">{user?.firstName} {user?.lastName}</td>
                          <td>{caseData?.titleEn}</td>
                          <td className="text-slate-500">{new Date(s.startedAt as string).toLocaleString()}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'apiUsage' && <AdminApiUsageTab />}
      {tab === 'settings' && <AdminSettingsTab />}
      {tab === 'pricing' && <AdminPricingTab />}

      {tab === 'users' && (
        <>
          <AdminUserPlanModal
            user={planModalUser ?? { id: '', email: '', firstName: '', lastName: '', role: 'STUDENT' }}
            open={planModalUser !== null}
            onClose={() => setPlanModalUser(null)}
            onSaved={() => refreshUsers()}
          />
          <AdminStudentProfile
            userId={profileUserId}
            open={profileUserId !== null}
            onClose={() => setProfileUserId(null)}
          />
          <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-900 dark:text-white">{t('users')}</h2>
              <span className="badge bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">{users.length} total</span>
            </div>
            <div className="flex flex-wrap gap-3">
              <input
                className="input-field min-w-[200px] flex-1"
                placeholder={t('adminSearchUsers')}
                value={userFilterQ}
                onChange={(e) => setUserFilterQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') refreshUsers();
                }}
              />
              <select
                className="input-field"
                value={userFilterUniversity}
                onChange={(e) => {
                  setUserFilterUniversity(e.target.value);
                  refreshUsers({ university: e.target.value });
                }}
              >
                <option value="">{t('adminAllUniversities')}</option>
                {userUniversities.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
              <select
                className="input-field"
                value={userFilterPlan}
                onChange={(e) => {
                  setUserFilterPlan(e.target.value);
                  refreshUsers({ plan: e.target.value });
                }}
              >
                <option value="">{t('adminAllPlans')}</option>
                <option value="FREE">FREE</option>
                <option value="PACKAGE_50">PACKAGE_50</option>
                <option value="PACKAGE_150">PACKAGE_150</option>
                <option value="PACKAGE_300">PACKAGE_300</option>
                <option value="INSTITUTION">INSTITUTION</option>
              </select>
              <button type="button" className="btn-primary" onClick={() => refreshUsers()}>
                {t('adminApplyFilters')}
              </button>
            </div>
          </div>
          <div className="table-scroll">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>{t('adminPhone')}</th>
                  <th>University</th>
                  <th>{t('subscriptions')}</th>
                  <th>Status</th>
                  <th>{t('adminLastSeen')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="font-medium">
                      <button
                        type="button"
                        className="text-violet-600 dark:text-violet-400 hover:underline"
                        onClick={() => setProfileUserId(u.id)}
                      >
                        {u.firstName} {u.lastName}
                      </button>
                    </td>
                    <td>{u.email}</td>
                    <td className="text-slate-500">{u.phone || '—'}</td>
                    <td className="text-slate-500">{u.university || '—'}</td>
                    <td>
                      <span className="badge bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">
                        {activePlanForUser(u)}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${u.isActive ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                        {u.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="text-slate-500 text-xs">{formatLastSeen(u.lastSeenAt)}</td>
                    <td>
                      {u.role === 'STUDENT' && (
                        <button
                          type="button"
                          onClick={() => setPlanModalUser(u)}
                          className="text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline"
                        >
                          {t('adminManagePlan')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      {tab === 'cases' && <AdminCasesTab />}

      {tab === 'knowledgeAi' && <AdminKnowledgeAiTab />}

      {tab === 'results' && (
        <div className="card overflow-hidden animate-fade-in">
            <div className="table-scroll">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Case</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const session = r.session as Record<string, unknown>;
                  const user = (session?.user as Record<string, string>) || {};
                  const caseData = (session?.case as Record<string, string>) || {};
                  return (
                    <tr key={r.id as string}>
                      <td className="font-medium">{user.firstName} {user.lastName}</td>
                      <td>{caseData.titleEn}</td>
                      <td><span className="font-bold text-primary">{r.totalScore as number}%</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'knowledge' && (
        <div className="space-y-6">
          <div className="card p-6">
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-2xl bg-violet-50 dark:bg-violet-900/20 flex items-center justify-center shrink-0">
                <BookOpen className="text-violet-600" size={20} />
              </div>
              <div className="min-w-0">
                <h2 className="font-semibold text-slate-900 dark:text-white">{t('knowledgeBase')}</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  {t('knowledgeForAIDesc')}
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">
                  {t('knowledgeBaseAdminHint')}
                </p>
              </div>
            </div>
          </div>

          <div className="grid xl:grid-cols-[360px_minmax(0,1fr)] gap-6">
          <div className="space-y-4">
            <div className="card p-6">
              <div className="flex items-center gap-2 mb-4">
                <FolderTree className="text-primary" size={20} />
                <h2 className="font-semibold text-slate-900 dark:text-white">{t('categories')}</h2>
              </div>
              <div className="space-y-3 mb-4 max-h-64 overflow-y-auto">
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategoryId(cat.id)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedCategoryId === cat.id
                        ? 'border-primary bg-primary/5'
                        : 'border-slate-200 dark:border-slate-700 hover:border-primary/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{cat.nameEn} / {cat.nameAr}</p>
                        {cat.description && (
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                            {cat.description}
                          </p>
                        )}
                      </div>
                      <span className={`badge shrink-0 ${cat.isActive ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                        {cat.isActive ? t('active') : t('inactive')}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {cat.parent ? `${cat.parent.nameEn} → ` : ''}{cat._count?.items ?? 0} {t('items')} · {cat._count?.children ?? 0} {t('subcategories')} · {cat._count?.cases ?? 0} {t('cases')}
                    </p>
                  </button>
                ))}
              </div>
              <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{editingCategoryId ? t('editCategory') : t('addCategory')}</p>
                  {editingCategoryId && (
                    <button type="button" onClick={resetCategoryForm} className="text-xs text-slate-500 hover:text-slate-700">
                      {t('cancel')}
                    </button>
                  )}
                </div>
                <input className="input-field" placeholder="Name (English)" value={categoryForm.nameEn} onChange={(e) => setCategoryForm({ ...categoryForm, nameEn: e.target.value })} />
                <input className="input-field" placeholder="الاسم (عربي)" value={categoryForm.nameAr} onChange={(e) => setCategoryForm({ ...categoryForm, nameAr: e.target.value })} />
                <select className="input-field" value={categoryForm.parentId} onChange={(e) => setCategoryForm({ ...categoryForm, parentId: e.target.value })}>
                  <option value="">{t('rootCategory')}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.nameEn} / {c.nameAr}</option>
                  ))}
                </select>
                <input className="input-field" placeholder={t('description')} value={categoryForm.description} onChange={(e) => setCategoryForm({ ...categoryForm, description: e.target.value })} />
                <div className="grid grid-cols-2 gap-3">
                  <input type="number" className="input-field" placeholder={t('sortOrder')} value={categoryForm.sortOrder} onChange={(e) => setCategoryForm({ ...categoryForm, sortOrder: parseInt(e.target.value) || 0 })} />
                  <label className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700">
                    <input type="checkbox" checked={categoryForm.isActive} onChange={(e) => setCategoryForm({ ...categoryForm, isActive: e.target.checked })} />
                    {t('active')}
                  </label>
                </div>
                <div className="flex gap-2">
                  <button onClick={saveCategory} className="btn-primary flex items-center gap-2"><Plus size={16} /> {editingCategoryId ? t('save') : t('add')}</button>
                  {selectedCategoryId && (
                    <button onClick={() => {
                      const category = categories.find((c) => c.id === selectedCategoryId);
                      if (category) editCategory(category);
                    }} className="btn-secondary flex items-center gap-2">
                      <Pencil size={16} /> {t('edit')}
                    </button>
                  )}
                  {selectedCategoryId && (
                    <button onClick={() => deleteCategory(selectedCategoryId)} className="btn-secondary text-red-600 flex items-center gap-2">
                      <Trash2 size={16} /> {t('delete')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="card p-6">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-semibold text-slate-900 dark:text-white mb-1">{t('knowledgeForAI')}</h2>
                  <p className="text-sm text-slate-500 mb-1">{t('knowledgeForAIDesc')}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">{t('knowledgeBaseAdminCategoryHint')}</p>
                </div>
                <select className="input-field min-w-[240px]" value={selectedCategoryId} onChange={(e) => setSelectedCategoryId(e.target.value)}>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.nameEn} / {c.nameAr}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-3 mb-6 max-h-72 overflow-y-auto">
                {knowledgeItems.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-6">{t('noKnowledgeYet')}</p>
                ) : (
                  knowledgeItems.map((item) => (
                    <div key={item.id} className="p-4 rounded-lg border border-slate-200 dark:border-slate-700">
                      <div className="flex justify-between items-start gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <span className="badge bg-blue-50 text-blue-700 text-xs">{item.type}</span>
                            <span className={`badge text-xs ${item.isActive ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                              {item.isActive ? t('active') : t('inactive')}
                            </span>
                          </div>
                          <p className="font-medium">{item.titleEn}</p>
                          <p className="text-sm text-slate-500">{item.titleAr}</p>
                          <p className="text-sm mt-2 text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{item.content}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => editKnowledge(item)} className="p-2 text-slate-500 hover:text-primary rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800">
                            <Pencil size={15} />
                          </button>
                          <button onClick={() => deleteKnowledge(item.id)} className="p-2 text-red-500 hover:text-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30">
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{editingKnowledgeId ? t('editKnowledge') : t('addKnowledge')}</p>
                  {editingKnowledgeId && (
                    <button type="button" onClick={resetKnowledgeForm} className="text-xs text-slate-500 hover:text-slate-700">
                      {t('cancel')}
                    </button>
                  )}
                </div>
                <input className="input-field" placeholder="Title (English)" value={knowledgeForm.titleEn} onChange={(e) => setKnowledgeForm({ ...knowledgeForm, titleEn: e.target.value })} />
                <input className="input-field" placeholder="العنوان (عربي)" value={knowledgeForm.titleAr} onChange={(e) => setKnowledgeForm({ ...knowledgeForm, titleAr: e.target.value })} />
                <select className="input-field" value={knowledgeForm.type} onChange={(e) => setKnowledgeForm({ ...knowledgeForm, type: e.target.value })}>
                  <option value="QUESTION">Question</option>
                  <option value="TOPIC">Topic</option>
                  <option value="GUIDELINE">Guideline</option>
                  <option value="TEACHING">Teaching</option>
                </select>
                <textarea className="input-field min-h-[120px]" placeholder={t('knowledgeContent')} value={knowledgeForm.content} onChange={(e) => setKnowledgeForm({ ...knowledgeForm, content: e.target.value })} />
                <label className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700">
                  <input type="checkbox" checked={knowledgeForm.isActive} onChange={(e) => setKnowledgeForm({ ...knowledgeForm, isActive: e.target.checked })} />
                  {t('knowledgeEnabledForAI')}
                </label>
                <button onClick={saveKnowledge} disabled={!selectedCategoryId || knowledgeSaving} className="btn-primary flex items-center gap-2"><Plus size={16} /> {knowledgeSaving ? t('save') : editingKnowledgeId ? t('save') : t('add')}</button>
              </div>
            </div>

            <div className="card p-6">
              <div className="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="font-semibold text-slate-900 dark:text-white">{t('aiSettings')}</h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{t('aiSettingsAdminDesc')}</p>
                </div>
                {aiSaved && <span className="text-sm text-emerald-600">{t('aiSettingsSaved')}</span>}
              </div>
              {aiSettings && (
                <div className="space-y-4">
                  <div className="grid md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">{t('patientModel')}</label>
                      <input className="input-field" value={aiSettings.patientModel} onChange={(e) => setAiSettings({ ...aiSettings, patientModel: e.target.value })} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">{t('examinerModel')}</label>
                      <input className="input-field" value={aiSettings.examinerModel} onChange={(e) => setAiSettings({ ...aiSettings, examinerModel: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">{t('temperature')}</label>
                      <input type="number" step="0.1" className="input-field" value={aiSettings.temperature} onChange={(e) => setAiSettings({ ...aiSettings, temperature: Number(e.target.value) || 0 })} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">{t('maxTokens')}</label>
                      <input type="number" className="input-field" value={aiSettings.maxTokens} onChange={(e) => setAiSettings({ ...aiSettings, maxTokens: Number(e.target.value) || 0 })} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">{t('adminMaxContextMessages')}</label>
                    <input
                      type="number"
                      className="input-field"
                      value={aiSettings.maxContextMessages ?? 12}
                      onChange={(e) => setAiSettings({ ...aiSettings, maxContextMessages: Number(e.target.value) || 12 })}
                    />
                    <p className="text-xs text-slate-400 mt-1">{t('adminMaxContextMessagesHint')}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">{t('adminPatientPromptAr')}</label>
                    <textarea
                      className="input-field min-h-[110px]"
                      value={aiSettings.patientSystemPromptAr || aiSettings.systemPromptAr || ''}
                      onChange={(e) => setAiSettings({ ...aiSettings, patientSystemPromptAr: e.target.value, systemPromptAr: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">{t('adminPatientPromptEn')}</label>
                    <textarea
                      className="input-field min-h-[110px]"
                      value={aiSettings.patientSystemPromptEn || aiSettings.systemPromptEn || ''}
                      onChange={(e) => setAiSettings({ ...aiSettings, patientSystemPromptEn: e.target.value, systemPromptEn: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">{t('adminExaminerPromptAr')}</label>
                    <textarea
                      className="input-field min-h-[110px]"
                      value={aiSettings.examinerSystemPromptAr || ''}
                      onChange={(e) => setAiSettings({ ...aiSettings, examinerSystemPromptAr: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">{t('adminExaminerPromptEn')}</label>
                    <textarea
                      className="input-field min-h-[110px]"
                      value={aiSettings.examinerSystemPromptEn || ''}
                      onChange={(e) => setAiSettings({ ...aiSettings, examinerSystemPromptEn: e.target.value })}
                    />
                  </div>
                  <button onClick={saveAISettings} className="btn-primary">{t('save')}</button>
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
      )}

      {tab === 'qbank' && <AdminQbankTab />}

      {tab === 'site' && (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="card p-6">
            <div className="flex items-center gap-2 mb-4">
              <GraduationCap className="text-primary" size={20} />
              <h2 className="font-semibold text-slate-900 dark:text-white">Partner Universities</h2>
              <span className="badge bg-blue-50 dark:bg-blue-900/30 text-blue-700 ml-auto">{universities.length}</span>
              <button
                type="button"
                onClick={() => void loadSiteContent()}
                disabled={uniLoading}
                className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-primary hover:border-primary/40 disabled:opacity-50"
                title="Refresh"
              >
                <RefreshCw size={15} className={uniLoading ? 'animate-spin' : ''} />
              </button>
            </div>

            {uniError && (
              <div className="mb-4 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {uniError}
              </div>
            )}

            {viewingUni && (
              <div className="mb-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">University Details</p>
                    <p className="font-semibold text-slate-900 dark:text-white mt-1">{viewingUni.nameEn}</p>
                    <p className="text-sm text-slate-600 dark:text-slate-300">{viewingUni.nameAr}</p>
                  </div>
                  <button type="button" onClick={() => setViewingUni(null)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg">
                    <X size={16} />
                  </button>
                </div>
                <div className="grid sm:grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-slate-500">Sort order</p>
                    <p className="font-medium">{viewingUni.sortOrder}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Visibility</p>
                    <p className="font-medium">{viewingUni.isActive ? 'Visible on site' : 'Hidden'}</p>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="text-xs text-slate-500">Logo URL</p>
                    <p className="font-medium break-all">{viewingUni.logoUrl || '—'}</p>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="text-xs text-slate-500">Website</p>
                    {viewingUni.website ? (
                      <a href={viewingUni.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline break-all">
                        {viewingUni.website} <ExternalLink size={13} />
                      </a>
                    ) : (
                      <p className="font-medium">—</p>
                    )}
                  </div>
                </div>
                {viewingUni.logoUrl && (
                  <img src={viewingUni.logoUrl} alt={viewingUni.nameEn} className="mt-3 h-12 object-contain" />
                )}
                <div className="flex gap-2 mt-4">
                  <button type="button" onClick={() => editUniversity(viewingUni)} className="btn-secondary text-xs py-1.5 px-3">
                    Edit
                  </button>
                  <button type="button" onClick={() => deleteUniversity(viewingUni.id)} className="text-xs py-1.5 px-3 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30">
                    Delete
                  </button>
                </div>
              </div>
            )}

            <div className="table-scroll mb-4 max-h-80 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="dashboard-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name (EN)</th>
                    <th>Name (AR)</th>
                    <th>Order</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {uniLoading ? (
                    <tr><td colSpan={6} className="text-center text-slate-400 py-8">Loading universities...</td></tr>
                  ) : universities.length === 0 ? (
                    <tr><td colSpan={6} className="text-center text-slate-400 py-8">No universities yet. Add one below or run db:seed.</td></tr>
                  ) : (
                    universities.map((uni, index) => (
                      <tr key={uni.id}>
                        <td className="text-slate-500">{index + 1}</td>
                        <td className="font-medium max-w-[140px] truncate" title={uni.nameEn}>{uni.nameEn}</td>
                        <td className="text-slate-600 dark:text-slate-300 max-w-[140px] truncate" title={uni.nameAr}>{uni.nameAr}</td>
                        <td>{uni.sortOrder}</td>
                        <td>
                          <span className={`badge text-xs ${uni.isActive ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                            {uni.isActive ? 'Visible' : 'Hidden'}
                          </span>
                        </td>
                        <td>
                          <div className="flex justify-end gap-1">
                            <button type="button" onClick={() => viewUniversity(uni)} className="p-2 text-slate-500 hover:text-primary rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800" title="View">
                              <Eye size={15} />
                            </button>
                            <button type="button" onClick={() => editUniversity(uni)} className="p-2 text-slate-500 hover:text-primary rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800" title="Edit">
                              <Pencil size={15} />
                            </button>
                            <button type="button" onClick={() => deleteUniversity(uni.id)} className="p-2 text-red-500 hover:text-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30" title="Delete">
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{editingUniId ? 'Edit University' : 'Add University'}</p>
                {(editingUniId || viewingUni) && (
                  <button onClick={resetUniForm} className="text-xs text-slate-500 flex items-center gap-1 hover:text-slate-700">
                    <X size={14} /> Cancel
                  </button>
                )}
              </div>
              <input className="input-field" placeholder="Name (English)" value={uniForm.nameEn} onChange={(e) => setUniForm({ ...uniForm, nameEn: e.target.value })} />
              <input className="input-field" placeholder="الاسم (عربي)" value={uniForm.nameAr} onChange={(e) => setUniForm({ ...uniForm, nameAr: e.target.value })} />
              <input className="input-field" placeholder="Logo URL (optional)" value={uniForm.logoUrl} onChange={(e) => setUniForm({ ...uniForm, logoUrl: e.target.value })} />
              <input className="input-field" placeholder="Website URL (optional)" value={uniForm.website} onChange={(e) => setUniForm({ ...uniForm, website: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <input type="number" className="input-field" placeholder="Sort order" value={uniForm.sortOrder} onChange={(e) => setUniForm({ ...uniForm, sortOrder: parseInt(e.target.value) || 0 })} />
                <label className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700">
                  <input type="checkbox" checked={uniForm.isActive} onChange={(e) => setUniForm({ ...uniForm, isActive: e.target.checked })} />
                  Visible on site
                </label>
              </div>
              <button onClick={() => void saveUniversity()} disabled={!uniForm.nameEn || !uniForm.nameAr || uniSaving} className="btn-primary flex items-center gap-2">
                <Plus size={16} /> {uniSaving ? 'Saving...' : editingUniId ? 'Update' : 'Add'}
              </button>
            </div>
          </div>

          <div className="card p-6">
            <div className="flex items-center gap-2 mb-4">
              <Globe className="text-primary" size={20} />
              <h2 className="font-semibold text-slate-900 dark:text-white">Footer & CTA</h2>
            </div>
            {siteSettings && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Footer tagline (EN)</label>
                  <input className="input-field" value={siteSettings.footerTaglineEn} onChange={(e) => setSiteSettings({ ...siteSettings, footerTaglineEn: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Footer tagline (AR)</label>
                  <input className="input-field" value={siteSettings.footerTaglineAr} onChange={(e) => setSiteSettings({ ...siteSettings, footerTaglineAr: e.target.value })} />
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Contact phone</label>
                    <input className="input-field" value={siteSettings.contactPhone} onChange={(e) => setSiteSettings({ ...siteSettings, contactPhone: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Contact email</label>
                    <input className="input-field" value={siteSettings.contactEmail || ''} onChange={(e) => setSiteSettings({ ...siteSettings, contactEmail: e.target.value || null })} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">CTA title (EN)</label>
                  <input className="input-field" value={siteSettings.ctaTitleEn} onChange={(e) => setSiteSettings({ ...siteSettings, ctaTitleEn: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">CTA title (AR)</label>
                  <input className="input-field" value={siteSettings.ctaTitleAr} onChange={(e) => setSiteSettings({ ...siteSettings, ctaTitleAr: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">CTA subtitle (EN)</label>
                  <input className="input-field" value={siteSettings.ctaSubtitleEn} onChange={(e) => setSiteSettings({ ...siteSettings, ctaSubtitleEn: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">CTA subtitle (AR)</label>
                  <input className="input-field" value={siteSettings.ctaSubtitleAr} onChange={(e) => setSiteSettings({ ...siteSettings, ctaSubtitleAr: e.target.value })} />
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <button onClick={saveSiteSettings} className="btn-primary">{t('save')}</button>
                  {siteSaved && <span className="text-sm text-emerald-600">Saved!</span>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
