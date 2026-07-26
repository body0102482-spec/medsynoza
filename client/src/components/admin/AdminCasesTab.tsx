import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Plus, Trash2, Pencil, Upload, Save, X, ClipboardPaste, Music, Search, ArrowUpDown, Undo2, ChevronUp, ChevronDown } from 'lucide-react';
import api from '../../lib/api';
import {
  ALL_MANEUVERS,
  DEFAULT_STATION_CONFIG,
  DEFAULT_PATIENT_BEHAVIOR,
  DEFAULT_MANEUVER_OPENING_TEMPLATE,
  MAIN_STAGES,
  MANEUVER_LABELS,
  type MainStageId,
  type PatientBehavior,
  type PatientPreferredLanguage,
} from '../../lib/stationConfig';

type ManeuverId = 'inspection' | 'palpation' | 'percussion' | 'auscultation';
type MediaType = 'image' | 'video' | 'audio';

interface LookupRow {
  id: string;
  nameEn: string;
  nameAr?: string;
  level?: number;
}

interface CategoryRow {
  id: string;
  nameEn: string;
}

interface CaseListRow {
  id: string;
  titleEn: string;
  titleAr: string;
  patientName: string;
  isPublished: boolean;
  isFreeTier: boolean;
  specialtyId: string;
  difficultyId: string;
  categoryId?: string | null;
  createdAt: string;
  specialty?: { nameEn: string };
  difficulty?: { nameEn: string };
  category?: { id: string; nameEn: string; nameAr?: string } | null;
}

type CaseStatusFilter = 'all' | 'published' | 'draft' | 'free';
type CaseSortKey = 'newest' | 'oldest' | 'titleAz' | 'titleZa';

const CASES_PER_PAGE = 12;

interface VitalSignForm {
  bpValue: string;
  bpNote: string;
  hrValue: string;
  hrNote: string;
  rrValue: string;
  rrNote: string;
  tempValue: string;
  tempNote: string;
  spo2Value: string;
  spo2Note: string;
}

interface ExamImageForm {
  id: string;
  url: string;
  caption: string;
  captionAr: string;
  maneuver: ManeuverId | '';
  mediaType: MediaType;
}

interface LabSectionForm {
  id: string;
  title: string;
  titleAr: string;
  content: string;
  contentAr: string;
}

interface RubricItemForm {
  id: string;
  item: string;
  category: string;
}

interface ExaminerQuestionForm {
  id: string;
  question: string;
  sampleAnswer: string;
}

interface PhysicalExamForm {
  inspection: string;
  palpation: string;
  percussion: string;
  auscultation: string;
}

interface CaseFormPayload {
  titleEn: string;
  titleAr: string;
  specialtyId: string;
  difficultyId: string;
  categoryId: string;
  patientName: string;
  patientAge: number;
  patientGender: string;
  patientNationality: string;
  chiefComplaint: string;
  medicalHistory: string;
  medicationHistory: string;
  surgicalHistory: string;
  familyHistory: string;
  socialHistory: string;
  patientPersonality: string;
  scenarioPrompt: string;
  finalDiagnosis: string;
  teachingPoints: string;
  isPublished: boolean;
  isFreeTier: boolean;
  vitalSigns: VitalSignForm;
  physicalExam: PhysicalExamForm;
  examImages: ExamImageForm[];
  labSections: LabSectionForm[];
  rubricItems: RubricItemForm[];
  examinerQuestions: ExaminerQuestionForm[];
  stationConfig: {
    enabledManeuvers: ManeuverId[];
    enableHistoryExaminer: boolean;
    enableInvestigations: boolean;
    stageOrder: MainStageId[];
    maneuverOpeningMessages: Partial<Record<ManeuverId, string>>;
    maneuverLabels: Partial<Record<ManeuverId, { en: string; ar: string }>>;
    patientBehavior: PatientBehavior;
  };
}

type UniversityOverrideRow = {
  id: string;
  universityId: string;
  university: { id: string; nameEn: string; nameAr: string; isActive?: boolean };
  isActive: boolean;
  stationConfig: CaseFormPayload['stationConfig'];
};

const MANEUVERS: Array<{ id: ManeuverId; label: string }> = ALL_MANEUVERS.map((id) => ({
  id,
  label: MANEUVER_LABELS[id].en,
}));

const STAGE_LABELS: Record<MainStageId, string> = {
  history: 'History',
  examination: 'Examination',
  investigations: 'Investigations',
  diagnosis: 'Diagnosis',
};

const FORM_HISTORY_LIMIT = 30;

function cloneForm(value: CaseFormPayload): CaseFormPayload {
  return JSON.parse(JSON.stringify(value)) as CaseFormPayload;
}

function normalizeStationConfig(
  raw?: Partial<CaseFormPayload['stationConfig']> | null,
): CaseFormPayload['stationConfig'] {
  const behavior = raw?.patientBehavior;
  return {
    enabledManeuvers: raw?.enabledManeuvers?.length ? [...raw.enabledManeuvers] : [...ALL_MANEUVERS],
    enableHistoryExaminer: raw?.enableHistoryExaminer !== false,
    enableInvestigations: raw?.enableInvestigations !== false,
    stageOrder: raw?.stageOrder?.length ? [...raw.stageOrder] : [...MAIN_STAGES],
    maneuverOpeningMessages: { ...(raw?.maneuverOpeningMessages ?? {}) },
    maneuverLabels: { ...(raw?.maneuverLabels ?? {}) },
    patientBehavior: {
      instructions: behavior?.instructions ?? '',
      tone: behavior?.tone ?? '',
      emotion: behavior?.emotion ?? '',
      preferredLanguage:
        behavior?.preferredLanguage === 'AR' || behavior?.preferredLanguage === 'EN'
          ? behavior.preferredLanguage
          : 'AUTO',
      constraints: behavior?.constraints ?? '',
    },
  };
}

function normalizeCaseForm(raw: CaseFormPayload): CaseFormPayload {
  return {
    ...raw,
    stationConfig: normalizeStationConfig(raw.stationConfig),
  };
}

const RUBRIC_CATEGORIES = ['History', 'Examination', 'Reasoning', 'Investigations', 'Management', 'Communication'];

const EMPTY_VITALS: VitalSignForm = {
  bpValue: '', bpNote: '', hrValue: '', hrNote: '', rrValue: '', rrNote: '',
  tempValue: '', tempNote: '', spo2Value: '', spo2Note: '',
};

function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function emptyForm(specialtyId = '', difficultyId = '', categoryId = ''): CaseFormPayload {
  return {
    titleEn: '',
    titleAr: '',
    specialtyId,
    difficultyId,
    categoryId,
    patientName: '',
    patientAge: 30,
    patientGender: 'Male',
    patientNationality: 'Egyptian',
    chiefComplaint: '',
    medicalHistory: '',
    medicationHistory: '',
    surgicalHistory: '',
    familyHistory: '',
    socialHistory: '',
    patientPersonality: '',
    scenarioPrompt: '',
    finalDiagnosis: '',
    teachingPoints: '',
    isPublished: false,
    isFreeTier: false,
    vitalSigns: { ...EMPTY_VITALS },
    physicalExam: { inspection: '', palpation: '', percussion: '', auscultation: '' },
    examImages: [],
    labSections: [],
    rubricItems: [],
    examinerQuestions: [],
    stationConfig: {
      enabledManeuvers: [...ALL_MANEUVERS],
      enableHistoryExaminer: DEFAULT_STATION_CONFIG.enableHistoryExaminer,
      enableInvestigations: DEFAULT_STATION_CONFIG.enableInvestigations,
      stageOrder: [...MAIN_STAGES],
      maneuverOpeningMessages: {},
      maneuverLabels: {},
      patientBehavior: { ...DEFAULT_PATIENT_BEHAVIOR },
    },
  };
}

function fileToBase64(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 40));
      }
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('read-failed'));
        return;
      }
      const base64 = result.split(',')[1];
      if (!base64) {
        reject(new Error('read-failed'));
        return;
      }
      onProgress?.(40);
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('read-failed'));
    reader.readAsDataURL(file);
  });
}

function mediaTypeFromFile(file: File): MediaType {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'image';
}

function MediaThumbnail({ url, mediaType }: { url: string; mediaType: MediaType }) {
  if (!url) return null;
  if (mediaType === 'image') {
    return (
      <img
        src={url}
        alt=""
        className="h-28 w-full max-w-xs object-cover rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
      />
    );
  }
  if (mediaType === 'video') {
    return (
      <video
        src={url}
        muted
        playsInline
        preload="metadata"
        className="h-28 w-full max-w-xs object-cover rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-900"
      />
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-3 max-w-xs">
      <Music size={20} className="text-violet-600 shrink-0" />
      <audio src={url} controls preload="metadata" className="w-full min-w-0 h-8" />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card p-5 space-y-4">
      <h3 className="font-semibold text-slate-900 dark:text-white">{title}</h3>
      {children}
    </div>
  );
}

export function AdminCasesTab() {
  const { t, i18n } = useTranslation();
  const isAr = i18n.language?.startsWith('ar');
  const [cases, setCases] = useState<CaseListRow[]>([]);
  const [specialties, setSpecialties] = useState<LookupRow[]>([]);
  const [difficulties, setDifficulties] = useState<LookupRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CaseFormPayload>(emptyForm());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [importSource, setImportSource] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [importError, setImportError] = useState('');
  const [search, setSearch] = useState('');
  const [specialtyFilter, setSpecialtyFilter] = useState('');
  const [difficultyFilter, setDifficultyFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<CaseStatusFilter>('all');
  const [sortKey, setSortKey] = useState<CaseSortKey>('newest');
  const [page, setPage] = useState(1);
  const [partnerUniversities, setPartnerUniversities] = useState<Array<{ id: string; nameEn: string; nameAr: string; isActive?: boolean }>>([]);
  const [universityOverrides, setUniversityOverrides] = useState<UniversityOverrideRow[]>([]);
  const [selectedOverrideUniversityId, setSelectedOverrideUniversityId] = useState('');
  const [overrideDraft, setOverrideDraft] = useState<CaseFormPayload['stationConfig'] | null>(null);
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [formHistory, setFormHistory] = useState<CaseFormPayload[]>([]);

  const pushFormHistory = useCallback((snapshot: CaseFormPayload) => {
    setFormHistory((prev) => {
      const next = [...prev, cloneForm(snapshot)];
      return next.length > FORM_HISTORY_LIMIT ? next.slice(next.length - FORM_HISTORY_LIMIT) : next;
    });
  }, []);

  const updateForm = useCallback(
    (updater: CaseFormPayload | ((prev: CaseFormPayload) => CaseFormPayload)) => {
      setForm((prev) => {
        pushFormHistory(prev);
        return typeof updater === 'function' ? updater(prev) : updater;
      });
    },
    [pushFormHistory],
  );

  const undoFormChange = useCallback(() => {
    setFormHistory((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      const last = next.pop()!;
      setForm(last);
      return next;
    });
  }, []);

  const filteredCases = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = cases.filter((c) => {
      if (q && ![c.titleEn, c.titleAr, c.patientName, c.category?.nameEn].some((v) => v?.toLowerCase().includes(q))) return false;
      if (specialtyFilter && c.specialtyId !== specialtyFilter) return false;
      if (difficultyFilter && c.difficultyId !== difficultyFilter) return false;
      if (categoryFilter === '__none__' && c.categoryId) return false;
      if (categoryFilter && categoryFilter !== '__none__' && c.categoryId !== categoryFilter) return false;
      if (statusFilter === 'published' && !c.isPublished) return false;
      if (statusFilter === 'draft' && c.isPublished) return false;
      if (statusFilter === 'free' && !c.isFreeTier) return false;
      return true;
    });
    const sorted = [...rows];
    switch (sortKey) {
      case 'oldest':
        sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case 'titleAz':
        sorted.sort((a, b) => a.titleEn.localeCompare(b.titleEn));
        break;
      case 'titleZa':
        sorted.sort((a, b) => b.titleEn.localeCompare(a.titleEn));
        break;
      default:
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return sorted;
  }, [cases, search, specialtyFilter, difficultyFilter, categoryFilter, statusFilter, sortKey]);

  const groupedCases = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; items: CaseListRow[] }>();
    for (const row of filteredCases) {
      const key = row.categoryId || '__uncategorized__';
      const label = row.category?.nameEn || t('adminCaseUncategorized');
      if (!groups.has(key)) groups.set(key, { key, label, items: [] });
      groups.get(key)!.items.push(row);
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [filteredCases, t]);

  const totalPages = Math.max(1, Math.ceil(filteredCases.length / CASES_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const pagedGroups = useMemo(() => {
    const start = (currentPage - 1) * CASES_PER_PAGE;
    const end = start + CASES_PER_PAGE;
    let offset = 0;
    const result: Array<{ key: string; label: string; items: CaseListRow[] }> = [];
    for (const group of groupedCases) {
      const groupStart = offset;
      const groupEnd = offset + group.items.length;
      offset = groupEnd;
      if (groupEnd <= start || groupStart >= end) continue;
      const sliceStart = Math.max(0, start - groupStart);
      const sliceEnd = Math.min(group.items.length, end - groupStart);
      result.push({ ...group, items: group.items.slice(sliceStart, sliceEnd) });
    }
    return result;
  }, [groupedCases, currentPage]);

  useEffect(() => {
    setPage(1);
  }, [search, specialtyFilter, difficultyFilter, categoryFilter, statusFilter, sortKey]);

  const loadLookups = useCallback(async () => {
    const [specRes, diffRes, catRes, uniRes] = await Promise.all([
      api.get('/cases/specialties'),
      api.get('/cases/difficulties'),
      api.get('/admin/categories'),
      api.get('/admin/universities'),
    ]);
    const specs = specRes.data.specialties as LookupRow[];
    const diffs = diffRes.data.difficulties as LookupRow[];
    const cats = catRes.data.categories as CategoryRow[];
    setSpecialties(specs);
    setDifficulties(diffs);
    setCategories(cats);
    setPartnerUniversities(uniRes.data.universities ?? []);
    return { specs, diffs, cats };
  }, []);

  const loadCases = useCallback(async () => {
    const r = await api.get('/admin/cases');
    setCases(r.data.cases);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadCases(), loadLookups()]);
    } catch {
      setError(t('adminCaseLoadError'));
    } finally {
      setLoading(false);
    }
  }, [loadCases, loadLookups, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadUniversityOverrides = useCallback(async (caseId: string) => {
    const r = await api.get(`/admin/cases/${caseId}/university-overrides`);
    setUniversityOverrides(r.data.overrides ?? []);
  }, []);

  const startCreate = async () => {
    const { specs, diffs, cats } = await loadLookups();
    setEditingId('new');
    setFormHistory([]);
    setForm(emptyForm(specs[0]?.id ?? '', diffs[0]?.id ?? '', cats[0]?.id ?? ''));
    setUniversityOverrides([]);
    setSelectedOverrideUniversityId('');
    setOverrideDraft(null);
    setImportSource('');
    setImportMessage('');
    setImportError('');
    setError('');
  };

  const startEdit = async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get(`/admin/cases/${id}`);
      setEditingId(id);
      setFormHistory([]);
      setForm(normalizeCaseForm(r.data.form as CaseFormPayload));
      await loadUniversityOverrides(id);
      setSelectedOverrideUniversityId('');
      setOverrideDraft(null);
      setImportSource('');
      setImportMessage('');
      setImportError('');
    } catch {
      setError(t('adminCaseLoadError'));
    } finally {
      setLoading(false);
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormHistory([]);
    setForm(emptyForm());
    setUniversityOverrides([]);
    setSelectedOverrideUniversityId('');
    setOverrideDraft(null);
    setImportSource('');
    setImportMessage('');
    setImportError('');
    setError('');
    setUploadProgress({});
  };

  const saveCase = async () => {
    if (!form.titleEn.trim() || !form.specialtyId || !form.difficultyId) {
      setError(t('adminCaseRequiredFields'));
      return;
    }
    if (form.stationConfig.enabledManeuvers.length === 0) {
      setError(t('adminCaseManeuverRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = normalizeCaseForm(form);
      if (editingId === 'new') {
        await api.post('/admin/cases', payload);
      } else if (editingId) {
        await api.put(`/admin/cases/${editingId}`, payload);
      }
      await loadCases();
      cancelEdit();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || t('adminCaseSaveError'));
    } finally {
      setSaving(false);
    }
  };

  const beginOverrideEdit = (universityId: string) => {
    if (!universityId) {
      setSelectedOverrideUniversityId('');
      setOverrideDraft(null);
      return;
    }
    const existing = universityOverrides.find((row) => row.universityId === universityId);
    setSelectedOverrideUniversityId(universityId);
    setOverrideDraft(
      normalizeStationConfig(
        existing?.stationConfig ?? {
          enabledManeuvers: [...form.stationConfig.enabledManeuvers],
          enableHistoryExaminer: form.stationConfig.enableHistoryExaminer,
          enableInvestigations: form.stationConfig.enableInvestigations,
          stageOrder: [...form.stationConfig.stageOrder],
          maneuverOpeningMessages: { ...form.stationConfig.maneuverOpeningMessages },
          maneuverLabels: { ...form.stationConfig.maneuverLabels },
          patientBehavior: { ...form.stationConfig.patientBehavior },
        },
      ),
    );
  };

  const saveUniversityOverride = async () => {
    if (!editingId || editingId === 'new' || !selectedOverrideUniversityId || !overrideDraft) return;
    if (overrideDraft.enabledManeuvers.length === 0) {
      setError(t('adminCaseManeuverRequired'));
      return;
    }
    setOverrideSaving(true);
    setError('');
    try {
      await api.put(`/admin/cases/${editingId}/university-overrides/${selectedOverrideUniversityId}`, {
        stationConfig: overrideDraft,
      });
      await loadUniversityOverrides(editingId);
      setSelectedOverrideUniversityId('');
      setOverrideDraft(null);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || t('adminCaseOverrideSaveError'));
    } finally {
      setOverrideSaving(false);
    }
  };

  const deleteUniversityOverride = async (universityId: string) => {
    if (!editingId || editingId === 'new') return;
    if (!window.confirm(t('adminCaseOverrideDeleteConfirm'))) return;
    setOverrideSaving(true);
    setError('');
    try {
      await api.delete(`/admin/cases/${editingId}/university-overrides/${universityId}`);
      await loadUniversityOverrides(editingId);
      if (selectedOverrideUniversityId === universityId) {
        setSelectedOverrideUniversityId('');
        setOverrideDraft(null);
      }
    } catch {
      setError(t('adminCaseOverrideSaveError'));
    } finally {
      setOverrideSaving(false);
    }
  };

  const deleteCase = async (id: string) => {
    if (!window.confirm(t('adminCaseDeleteConfirm'))) return;
    try {
      await api.delete(`/admin/cases/${id}`);
      if (editingId === id) cancelEdit();
      await loadCases();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || t('adminCaseDeleteError'));
    }
  };

  const uploadMedia = async (imageId: string, file: File) => {
    setError('');
    setUploadProgress((prev) => ({ ...prev, [imageId]: 1 }));
    const detectedType = mediaTypeFromFile(file);
    setForm((prev) => ({
      ...prev,
      examImages: prev.examImages.map((img) =>
        img.id === imageId ? { ...img, mediaType: detectedType } : img,
      ),
    }));
    try {
      const dataBase64 = await fileToBase64(file, (pct) => {
        setUploadProgress((prev) => ({ ...prev, [imageId]: pct }));
      });
      const r = await api.post(
        '/admin/cases/media/upload',
        {
          fileName: file.name,
          mimeType: file.type,
          dataBase64,
          caseSlug: form.titleEn.trim() || 'draft',
        },
        {
          timeout: 120_000,
          onUploadProgress: (event) => {
            if (!event.total) return;
            const pct = 40 + Math.round((event.loaded / event.total) * 60);
            setUploadProgress((prev) => ({ ...prev, [imageId]: Math.min(pct, 99) }));
          },
        },
      );
      setForm((prev) => ({
        ...prev,
        examImages: prev.examImages.map((img) =>
          img.id === imageId
            ? { ...img, url: r.data.url as string, mediaType: detectedType }
            : img,
        ),
      }));
      setUploadProgress((prev) => ({ ...prev, [imageId]: 100 }));
      window.setTimeout(() => {
        setUploadProgress((prev) => {
          const next = { ...prev };
          delete next[imageId];
          return next;
        });
      }, 600);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || t('adminCaseUploadError'));
      setUploadProgress((prev) => {
        const next = { ...prev };
        delete next[imageId];
        return next;
      });
    }
  };

  const updateVital = (key: keyof VitalSignForm, value: string) => {
    setForm((prev) => ({ ...prev, vitalSigns: { ...prev.vitalSigns, [key]: value } }));
  };

  const importCaseObject = async () => {
    setImportMessage('');
    setImportError('');
    try {
      const r = await api.post('/admin/cases/import/parse', { source: importSource });
      const mapped = r.data.form as CaseFormPayload;
      updateForm((prev) => normalizeCaseForm({
        ...prev,
        ...mapped,
        titleAr: prev.titleAr.trim() ? prev.titleAr : mapped.titleAr,
        isPublished: prev.isPublished,
        isFreeTier: prev.isFreeTier,
      }));
      setImportMessage(t('adminCaseImportSuccess'));
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setImportError(msg || t('adminCaseImportError'));
    }
  };

  if (editingId) {
    return (
      <div className="space-y-4 pb-2">
        <div className="sticky top-0 z-30 -mx-4 lg:-mx-8 px-4 lg:px-8 py-3 mb-2 bg-slate-100/95 dark:bg-slate-950/95 backdrop-blur border-b border-slate-200/80 dark:border-slate-800/80 shadow-sm flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white truncate">
              {editingId === 'new'
                ? (form.titleEn.trim() || t('adminCaseAdd'))
                : (form.titleEn.trim() || t('adminCaseEdit'))}
            </h2>
            <p className="text-sm text-slate-500">
              {editingId === 'new' ? t('adminCaseAdd') : t('adminCaseEdit')}
              {form.titleEn.trim() ? ` — ${form.titleEn}` : ''}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={undoFormChange}
              disabled={!formHistory.length || saving}
              className="btn-secondary inline-flex items-center gap-2 disabled:opacity-40"
              title={t('adminCaseUndo')}
            >
              <Undo2 size={16} /> {t('adminCaseUndo')}
            </button>
            <button type="button" onClick={cancelEdit} className="btn-secondary inline-flex items-center gap-2">
              <X size={16} /> {t('cancel')}
            </button>
            <button type="button" onClick={saveCase} disabled={saving} className="btn-primary inline-flex items-center gap-2">
              <Save size={16} /> {saving ? t('saving') : t('save')}
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <Section title={t('adminCaseSectionImport')}>
          <p className="text-sm text-slate-500">{t('adminCaseImportDesc')}</p>
          <textarea
            className="input-field min-h-[220px] font-mono text-xs"
            placeholder={t('adminCaseImportPlaceholder')}
            value={importSource}
            onChange={(e) => setImportSource(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={importCaseObject} className="btn-secondary inline-flex items-center gap-2">
              <ClipboardPaste size={16} /> {t('adminCaseImportFill')}
            </button>
            {importMessage && <p className="text-sm text-emerald-600">{importMessage}</p>}
            {importError && <p className="text-sm text-red-600">{importError}</p>}
          </div>
        </Section>

        <Section title={t('adminCaseSectionBasics')}>
          <div className="grid sm:grid-cols-2 gap-3">
            <input className="input-field" placeholder={t('adminCaseTitleEn')} value={form.titleEn} onChange={(e) => setForm({ ...form, titleEn: e.target.value })} />
            <input className="input-field" placeholder={t('adminCaseTitleAr')} value={form.titleAr} onChange={(e) => setForm({ ...form, titleAr: e.target.value })} />
            <select className="input-field" value={form.specialtyId} onChange={(e) => setForm({ ...form, specialtyId: e.target.value })}>
              {specialties.map((s) => <option key={s.id} value={s.id}>{s.nameEn}</option>)}
            </select>
            <select className="input-field" value={form.difficultyId} onChange={(e) => setForm({ ...form, difficultyId: e.target.value })}>
              {difficulties.map((d) => <option key={d.id} value={d.id}>{d.nameEn}</option>)}
            </select>
            <select className="input-field" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">{t('adminCaseNoCategory')}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.nameEn}</option>)}
            </select>
            <div className="flex flex-wrap gap-4 items-center">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isPublished} onChange={(e) => setForm({ ...form, isPublished: e.target.checked })} /> {t('adminCasePublished')}</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isFreeTier} onChange={(e) => setForm({ ...form, isFreeTier: e.target.checked })} /> {t('adminCaseFreeTier')}</label>
            </div>
          </div>
        </Section>

        <Section title={t('adminCaseSectionPatient')}>
          <div className="grid sm:grid-cols-2 gap-3">
            <input className="input-field" placeholder={t('adminCasePatientName')} value={form.patientName} onChange={(e) => setForm({ ...form, patientName: e.target.value })} />
            <input type="number" className="input-field" placeholder={t('adminCasePatientAge')} value={form.patientAge} onChange={(e) => setForm({ ...form, patientAge: Number(e.target.value) })} />
            <input className="input-field" placeholder={t('adminCasePatientGender')} value={form.patientGender} onChange={(e) => setForm({ ...form, patientGender: e.target.value })} />
            <input className="input-field" placeholder={t('adminCasePatientNationality')} value={form.patientNationality} onChange={(e) => setForm({ ...form, patientNationality: e.target.value })} />
            <textarea className="input-field sm:col-span-2 min-h-[80px]" placeholder={t('adminCaseChiefComplaint')} value={form.chiefComplaint} onChange={(e) => setForm({ ...form, chiefComplaint: e.target.value })} />
          </div>
        </Section>

        <Section title={t('adminCaseSectionHistory')}>
          <div className="grid sm:grid-cols-2 gap-3">
            {([
              ['medicalHistory', t('adminCaseMedicalHistory')],
              ['medicationHistory', t('adminCaseMedicationHistory')],
              ['surgicalHistory', t('adminCaseSurgicalHistory')],
              ['familyHistory', t('adminCaseFamilyHistory')],
              ['socialHistory', t('adminCaseSocialHistory')],
            ] as const).map(([key, label]) => (
              <textarea
                key={key}
                className="input-field min-h-[100px]"
                placeholder={label}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            ))}
          </div>
        </Section>

        <Section title={t('adminCaseSectionVitals')}>
          <div className="grid sm:grid-cols-2 gap-3">
            {([
              ['bp', 'BP'],
              ['hr', 'HR'],
              ['rr', 'RR'],
              ['temp', t('adminCaseTemp')],
              ['spo2', 'SpO₂'],
            ] as const).map(([code, label]) => {
              const valueKey = `${code}Value` as keyof VitalSignForm;
              const noteKey = `${code}Note` as keyof VitalSignForm;
              return (
                <div key={code} className="grid grid-cols-2 gap-2">
                  <input className="input-field" placeholder={`${label} ${t('adminCaseValue')}`} value={form.vitalSigns[valueKey]} onChange={(e) => updateVital(valueKey, e.target.value)} />
                  <input className="input-field" placeholder={`${label} ${t('adminCaseNote')}`} value={form.vitalSigns[noteKey]} onChange={(e) => updateVital(noteKey, e.target.value)} />
                </div>
              );
            })}
          </div>
        </Section>

        <Section title={t('adminCaseSectionStation')}>
          <p className="text-sm text-slate-500 mb-3">{t('adminCaseStationDesc')}</p>
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">
                {t('adminCaseEnabledManeuvers')}
              </p>
              <div className="flex flex-wrap gap-3">
                {MANEUVERS.map((maneuver) => {
                  const checked = form.stationConfig.enabledManeuvers.includes(maneuver.id);
                  const customLabel = form.stationConfig.maneuverLabels[maneuver.id]?.en || maneuver.label;
                  return (
                    <label
                      key={maneuver.id}
                      className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer ${
                        checked
                          ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/30'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const enabled = e.target.checked
                            ? [...form.stationConfig.enabledManeuvers, maneuver.id]
                            : form.stationConfig.enabledManeuvers.filter((id) => id !== maneuver.id);
                          updateForm({
                            ...form,
                            stationConfig: { ...form.stationConfig, enabledManeuvers: enabled },
                          });
                        }}
                      />
                      <span className="text-sm">{customLabel}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-slate-800">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                {t('adminCaseManeuverLabels')}
              </p>
              <p className="text-xs text-slate-500">{t('adminCaseManeuverLabelsHint')}</p>
              <div className="grid sm:grid-cols-2 gap-3">
                {MANEUVERS.map((maneuver) => (
                  <div key={maneuver.id} className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">{maneuver.label}</p>
                    <input
                      className="input-field"
                      placeholder={`${maneuver.label} (EN)`}
                      value={form.stationConfig.maneuverLabels[maneuver.id]?.en ?? ''}
                      onChange={(e) => {
                        const en = e.target.value;
                        const ar = form.stationConfig.maneuverLabels[maneuver.id]?.ar ?? '';
                        updateForm({
                          ...form,
                          stationConfig: {
                            ...form.stationConfig,
                            maneuverLabels: {
                              ...form.stationConfig.maneuverLabels,
                              ...(en.trim() || ar.trim()
                                ? { [maneuver.id]: { en, ar } }
                                : Object.fromEntries(
                                    Object.entries(form.stationConfig.maneuverLabels).filter(
                                      ([key]) => key !== maneuver.id,
                                    ),
                                  )),
                            },
                          },
                        });
                      }}
                    />
                    <input
                      className="input-field"
                      placeholder={`${maneuver.label} (AR)`}
                      value={form.stationConfig.maneuverLabels[maneuver.id]?.ar ?? ''}
                      onChange={(e) => {
                        const ar = e.target.value;
                        const en = form.stationConfig.maneuverLabels[maneuver.id]?.en ?? '';
                        updateForm({
                          ...form,
                          stationConfig: {
                            ...form.stationConfig,
                            maneuverLabels: {
                              ...form.stationConfig.maneuverLabels,
                              ...(en.trim() || ar.trim()
                                ? { [maneuver.id]: { en, ar } }
                                : Object.fromEntries(
                                    Object.entries(form.stationConfig.maneuverLabels).filter(
                                      ([key]) => key !== maneuver.id,
                                    ),
                                  )),
                            },
                          },
                        });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                {t('adminCaseStageOrder')}
              </p>
              <p className="text-xs text-slate-500">{t('adminCaseStageOrderHint')}</p>
              <div className="space-y-2">
                {form.stationConfig.stageOrder.map((stage, index) => (
                  <div
                    key={stage}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2"
                  >
                    <span className="text-sm font-medium">
                      {index + 1}. {STAGE_LABELS[stage]}
                    </span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
                        disabled={index === 0}
                        onClick={() => {
                          const next = [...form.stationConfig.stageOrder];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          updateForm({
                            ...form,
                            stationConfig: { ...form.stationConfig, stageOrder: next },
                          });
                        }}
                        aria-label="Move up"
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        type="button"
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
                        disabled={index === form.stationConfig.stageOrder.length - 1}
                        onClick={() => {
                          const next = [...form.stationConfig.stageOrder];
                          [next[index + 1], next[index]] = [next[index], next[index + 1]];
                          updateForm({
                            ...form,
                            stationConfig: { ...form.stationConfig, stageOrder: next },
                          });
                        }}
                        aria-label="Move down"
                      >
                        <ChevronDown size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.stationConfig.enableHistoryExaminer}
                onChange={(e) => updateForm({
                  ...form,
                  stationConfig: {
                    ...form.stationConfig,
                    enableHistoryExaminer: e.target.checked,
                  },
                })}
              />
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {t('adminCaseEnableHistoryExaminer')}
              </span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.stationConfig.enableInvestigations}
                onChange={(e) => updateForm({
                  ...form,
                  stationConfig: {
                    ...form.stationConfig,
                    enableInvestigations: e.target.checked,
                  },
                })}
              />
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {t('adminCaseEnableInvestigations')}
              </span>
            </label>
            <p className="text-xs text-slate-500">{t('adminCaseEnableHistoryExaminerHint')}</p>
            <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-slate-800">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                {t('adminCaseManeuverOpeningMessages')}
              </p>
              <p className="text-xs text-slate-500">{t('adminCaseManeuverOpeningMessagesHint')}</p>
              {MANEUVERS.map((maneuver) => {
                const label = form.stationConfig.maneuverLabels[maneuver.id]?.en || maneuver.label;
                return (
                <div key={maneuver.id}>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    {label}
                  </label>
                  <textarea
                    className="input-field min-h-[88px] text-sm"
                    placeholder={DEFAULT_MANEUVER_OPENING_TEMPLATE.replace(/\{\{maneuver\}\}/g, label)}
                    value={form.stationConfig.maneuverOpeningMessages[maneuver.id] ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      updateForm({
                        ...form,
                        stationConfig: {
                          ...form.stationConfig,
                          maneuverOpeningMessages: {
                            ...form.stationConfig.maneuverOpeningMessages,
                            ...(value.trim()
                              ? { [maneuver.id]: value }
                              : Object.fromEntries(
                                  Object.entries(form.stationConfig.maneuverOpeningMessages).filter(
                                    ([key]) => key !== maneuver.id,
                                  ),
                                )),
                          },
                        },
                      });
                    }}
                  />
                </div>
              );})}
            </div>
          </div>
        </Section>

        {editingId && editingId !== 'new' && (
          <Section title={t('adminCaseUniversityOverrides')}>
            <p className="text-sm text-slate-500">{t('adminCaseUniversityOverridesDesc')}</p>
            <div className="space-y-3">
              {universityOverrides.map((row) => (
                <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                  <div>
                    <p className="font-medium">{isAr ? row.university.nameAr : row.university.nameEn}</p>
                    <p className="text-xs text-slate-500">
                      {row.stationConfig.enabledManeuvers.join(', ')}
                      {!row.stationConfig.enableInvestigations ? ` · ${t('adminCaseInvestigationsOff')}` : ''}
                      {!row.stationConfig.enableHistoryExaminer ? ` · ${t('adminCaseHistoryExaminerOff')}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="text-violet-600 text-sm" onClick={() => beginOverrideEdit(row.universityId)}>
                      {t('edit')}
                    </button>
                    <button type="button" className="text-red-600 text-sm" onClick={() => void deleteUniversityOverride(row.universityId)}>
                      {t('delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid sm:grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
              <div>
                <label className="block text-sm font-medium mb-1.5">{t('adminCaseSelectUniversityOverride')}</label>
                <select
                  className="input-field"
                  value={selectedOverrideUniversityId}
                  onChange={(e) => beginOverrideEdit(e.target.value)}
                >
                  <option value="">{t('adminCaseSelectUniversityOverride')}</option>
                  {partnerUniversities
                    .filter((u) => u.isActive !== false)
                    .filter((u) => !universityOverrides.some((row) => row.universityId === u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>{isAr ? u.nameAr : u.nameEn}</option>
                    ))}
                </select>
              </div>
            </div>
            {overrideDraft && selectedOverrideUniversityId && (
              <div className="space-y-4 rounded-xl border border-violet-200 dark:border-violet-900/40 bg-violet-50/40 dark:bg-violet-950/20 p-4">
                <p className="text-sm font-semibold">{t('adminCaseOverrideFlowTitle')}</p>
                <div className="flex flex-wrap gap-3">
                  {MANEUVERS.map((maneuver) => {
                    const checked = overrideDraft.enabledManeuvers.includes(maneuver.id);
                    const customLabel = overrideDraft.maneuverLabels[maneuver.id]?.en || maneuver.label;
                    return (
                      <label key={maneuver.id} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const enabled = e.target.checked
                              ? [...overrideDraft.enabledManeuvers, maneuver.id]
                              : overrideDraft.enabledManeuvers.filter((id) => id !== maneuver.id);
                            setOverrideDraft({ ...overrideDraft, enabledManeuvers: enabled });
                          }}
                        />
                        <span className="text-sm">{customLabel}</span>
                      </label>
                    );
                  })}
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-semibold">{t('adminCaseStageOrder')}</p>
                  <p className="text-xs text-slate-500">{t('adminCaseStageOrderHint')}</p>
                  {overrideDraft.stageOrder.map((stage, index) => (
                    <div
                      key={`override-stage-${stage}`}
                      className="flex items-center justify-between gap-2 rounded-lg border border-violet-200 dark:border-violet-900/40 px-3 py-2 bg-white/60 dark:bg-slate-900/40"
                    >
                      <span className="text-sm font-medium">
                        {index + 1}. {STAGE_LABELS[stage]}
                      </span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="p-1.5 rounded hover:bg-violet-100 dark:hover:bg-violet-900/40 disabled:opacity-30"
                          disabled={index === 0}
                          onClick={() => {
                            const next = [...overrideDraft.stageOrder];
                            [next[index - 1], next[index]] = [next[index], next[index - 1]];
                            setOverrideDraft({ ...overrideDraft, stageOrder: next });
                          }}
                          aria-label="Move up"
                        >
                          <ChevronUp size={16} />
                        </button>
                        <button
                          type="button"
                          className="p-1.5 rounded hover:bg-violet-100 dark:hover:bg-violet-900/40 disabled:opacity-30"
                          disabled={index === overrideDraft.stageOrder.length - 1}
                          onClick={() => {
                            const next = [...overrideDraft.stageOrder];
                            [next[index + 1], next[index]] = [next[index], next[index + 1]];
                            setOverrideDraft({ ...overrideDraft, stageOrder: next });
                          }}
                          aria-label="Move down"
                        >
                          <ChevronDown size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  <p className="text-sm font-semibold">{t('adminCaseManeuverLabels')}</p>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {MANEUVERS.map((maneuver) => (
                      <div key={`override-label-${maneuver.id}`} className="space-y-1">
                        <p className="text-xs font-medium text-slate-500">{maneuver.label}</p>
                        <input
                          className="input-field"
                          placeholder={`${maneuver.label} (EN)`}
                          value={overrideDraft.maneuverLabels[maneuver.id]?.en ?? ''}
                          onChange={(e) => {
                            const en = e.target.value;
                            const ar = overrideDraft.maneuverLabels[maneuver.id]?.ar ?? '';
                            setOverrideDraft({
                              ...overrideDraft,
                              maneuverLabels: {
                                ...overrideDraft.maneuverLabels,
                                ...(en.trim() || ar.trim()
                                  ? { [maneuver.id]: { en, ar } }
                                  : Object.fromEntries(
                                      Object.entries(overrideDraft.maneuverLabels).filter(
                                        ([key]) => key !== maneuver.id,
                                      ),
                                    )),
                              },
                            });
                          }}
                        />
                        <input
                          className="input-field"
                          placeholder={`${maneuver.label} (AR)`}
                          value={overrideDraft.maneuverLabels[maneuver.id]?.ar ?? ''}
                          onChange={(e) => {
                            const ar = e.target.value;
                            const en = overrideDraft.maneuverLabels[maneuver.id]?.en ?? '';
                            setOverrideDraft({
                              ...overrideDraft,
                              maneuverLabels: {
                                ...overrideDraft.maneuverLabels,
                                ...(en.trim() || ar.trim()
                                  ? { [maneuver.id]: { en, ar } }
                                  : Object.fromEntries(
                                      Object.entries(overrideDraft.maneuverLabels).filter(
                                        ([key]) => key !== maneuver.id,
                                      ),
                                    )),
                              },
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={overrideDraft.enableHistoryExaminer}
                    onChange={(e) => setOverrideDraft({ ...overrideDraft, enableHistoryExaminer: e.target.checked })}
                  />
                  <span className="text-sm">{t('adminCaseEnableHistoryExaminer')}</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={overrideDraft.enableInvestigations}
                    onChange={(e) => setOverrideDraft({ ...overrideDraft, enableInvestigations: e.target.checked })}
                  />
                  <span className="text-sm">{t('adminCaseEnableInvestigations')}</span>
                </label>
                <div className="space-y-3 pt-2 border-t border-violet-200/60 dark:border-violet-900/40">
                  <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                    {t('adminCaseManeuverOpeningMessages')}
                  </p>
                  {MANEUVERS.map((maneuver) => {
                    const label = overrideDraft.maneuverLabels[maneuver.id]?.en || maneuver.label;
                    return (
                    <div key={`override-${maneuver.id}`}>
                      <label className="block text-xs text-slate-500 mb-1">{label}</label>
                      <textarea
                        className="input-field min-h-[72px] text-sm"
                        placeholder={DEFAULT_MANEUVER_OPENING_TEMPLATE.replace(/\{\{maneuver\}\}/g, label)}
                        value={overrideDraft.maneuverOpeningMessages?.[maneuver.id] ?? ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          const current = overrideDraft.maneuverOpeningMessages ?? {};
                          setOverrideDraft({
                            ...overrideDraft,
                            maneuverOpeningMessages: value.trim()
                              ? { ...current, [maneuver.id]: value }
                              : Object.fromEntries(
                                  Object.entries(current).filter(([key]) => key !== maneuver.id),
                                ),
                          });
                        }}
                      />
                    </div>
                  );})}
                </div>
                <div className="space-y-3 pt-2 border-t border-violet-200/60 dark:border-violet-900/40">
                  <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                    {t('adminCasePatientBehavior')}
                  </p>
                  <p className="text-[11px] text-slate-500">{t('adminCasePatientBehaviorOverrideHint')}</p>
                  <div className="grid sm:grid-cols-2 gap-2">
                    <input
                      className="input-field text-sm"
                      placeholder={t('adminCasePatientTone')}
                      value={overrideDraft.patientBehavior.tone}
                      onChange={(e) =>
                        setOverrideDraft({
                          ...overrideDraft,
                          patientBehavior: { ...overrideDraft.patientBehavior, tone: e.target.value },
                        })
                      }
                    />
                    <input
                      className="input-field text-sm"
                      placeholder={t('adminCasePatientEmotion')}
                      value={overrideDraft.patientBehavior.emotion}
                      onChange={(e) =>
                        setOverrideDraft({
                          ...overrideDraft,
                          patientBehavior: { ...overrideDraft.patientBehavior, emotion: e.target.value },
                        })
                      }
                    />
                  </div>
                  <select
                    className="input-field text-sm"
                    value={overrideDraft.patientBehavior.preferredLanguage}
                    onChange={(e) =>
                      setOverrideDraft({
                        ...overrideDraft,
                        patientBehavior: {
                          ...overrideDraft.patientBehavior,
                          preferredLanguage: e.target.value as PatientPreferredLanguage,
                        },
                      })
                    }
                  >
                    <option value="AUTO">{t('speechLangAuto')}</option>
                    <option value="AR">{t('speechLangAr')}</option>
                    <option value="EN">{t('speechLangEn')}</option>
                  </select>
                  <textarea
                    className="input-field min-h-[80px] text-sm"
                    placeholder={t('adminCasePatientInstructions')}
                    value={overrideDraft.patientBehavior.instructions}
                    onChange={(e) =>
                      setOverrideDraft({
                        ...overrideDraft,
                        patientBehavior: {
                          ...overrideDraft.patientBehavior,
                          instructions: e.target.value,
                        },
                      })
                    }
                  />
                  <textarea
                    className="input-field min-h-[72px] text-sm"
                    placeholder={t('adminCasePatientConstraints')}
                    value={overrideDraft.patientBehavior.constraints}
                    onChange={(e) =>
                      setOverrideDraft({
                        ...overrideDraft,
                        patientBehavior: {
                          ...overrideDraft.patientBehavior,
                          constraints: e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <button type="button" onClick={() => void saveUniversityOverride()} disabled={overrideSaving} className="btn-primary">
                  {t('adminCaseSaveOverride')}
                </button>
              </div>
            )}
          </Section>
        )}

        <Section title={t('adminCaseSectionPhysicalExam')}>
          <div className="grid sm:grid-cols-2 gap-3">
            {MANEUVERS.map((maneuver) => (
              <textarea
                key={maneuver.id}
                className="input-field min-h-[110px]"
                placeholder={form.stationConfig.maneuverLabels[maneuver.id]?.en || maneuver.label}
                value={form.physicalExam[maneuver.id]}
                onChange={(e) => setForm({
                  ...form,
                  physicalExam: { ...form.physicalExam, [maneuver.id]: e.target.value },
                })}
              />
            ))}
          </div>
        </Section>

        <Section title={t('adminCaseSectionMedia')}>
          <div className="space-y-4">
            {form.examImages.map((img) => {
              const progress = uploadProgress[img.id];
              const isUploading = typeof progress === 'number';
              return (
              <div key={img.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <input className="input-field sm:col-span-2" placeholder={t('adminCaseMediaUrl')} value={img.url} onChange={(e) => setForm({
                    ...form,
                    examImages: form.examImages.map((row) => row.id === img.id ? { ...row, url: e.target.value } : row),
                  })} />
                  <select className="input-field" value={img.maneuver} onChange={(e) => setForm({
                    ...form,
                    examImages: form.examImages.map((row) => row.id === img.id ? { ...row, maneuver: e.target.value as ManeuverId | '' } : row),
                  })}>
                    <option value="">{t('adminCaseMediaNoManeuver')}</option>
                    {MANEUVERS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  <select className="input-field" value={img.mediaType} onChange={(e) => setForm({
                    ...form,
                    examImages: form.examImages.map((row) => row.id === img.id ? { ...row, mediaType: e.target.value as MediaType } : row),
                  })}>
                    <option value="image">{t('adminCaseMediaImage')}</option>
                    <option value="video">{t('adminCaseMediaVideo')}</option>
                    <option value="audio">{t('adminCaseMediaAudio')}</option>
                  </select>
                  <input className="input-field" placeholder={t('adminCaseMediaCaptionEn')} value={img.caption} onChange={(e) => setForm({
                    ...form,
                    examImages: form.examImages.map((row) => row.id === img.id ? { ...row, caption: e.target.value } : row),
                  })} />
                  <input className="input-field" placeholder={t('adminCaseMediaCaptionAr')} value={img.captionAr} onChange={(e) => setForm({
                    ...form,
                    examImages: form.examImages.map((row) => row.id === img.id ? { ...row, captionAr: e.target.value } : row),
                  })} />
                </div>
                {img.url && !isUploading && (
                  <div className="space-y-1">
                    <MediaThumbnail url={img.url} mediaType={img.mediaType} />
                    <a href={img.url} target="_blank" rel="noreferrer" className="text-sm text-violet-600 hover:underline inline-block">
                      {t('adminCasePreviewMedia')}
                    </a>
                  </div>
                )}
                {isUploading && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>{t('adminCaseUploading')}</span>
                      <span>{progress}%</span>
                    </div>
                    <div
                      className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden"
                      role="progressbar"
                      aria-valuenow={progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="h-full rounded-full bg-violet-600 transition-[width] duration-200 ease-out"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <label className={`btn-secondary inline-flex items-center gap-2 ${isUploading ? 'opacity-60 pointer-events-none' : 'cursor-pointer'}`}>
                    <Upload size={16} />
                    {isUploading ? t('adminCaseUploading') : t('adminCaseUploadFile')}
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*,video/*,audio/*"
                      disabled={isUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadMedia(img.id, file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <button type="button" className="text-red-600 text-sm ms-auto" onClick={() => setForm({
                    ...form,
                    examImages: form.examImages.filter((row) => row.id !== img.id),
                  })}>
                    <Trash2 size={14} className="inline" /> {t('delete')}
                  </button>
                </div>
              </div>
              );
            })}
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2"
              onClick={() => setForm({
                ...form,
                examImages: [...form.examImages, { id: newId('media'), url: '', caption: '', captionAr: '', maneuver: '', mediaType: 'image' }],
              })}
            >
              <Plus size={16} /> {t('adminCaseAddMedia')}
            </button>
          </div>
        </Section>

        <Section title={t('adminCaseSectionLabs')}>
          <div className="space-y-4">
            {form.labSections.map((section) => (
              <div key={section.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <input className="input-field" placeholder={t('adminCaseLabTitleEn')} value={section.title} onChange={(e) => setForm({
                    ...form,
                    labSections: form.labSections.map((row) => row.id === section.id ? { ...row, title: e.target.value } : row),
                  })} />
                  <input className="input-field" placeholder={t('adminCaseLabTitleAr')} value={section.titleAr} onChange={(e) => setForm({
                    ...form,
                    labSections: form.labSections.map((row) => row.id === section.id ? { ...row, titleAr: e.target.value } : row),
                  })} />
                  <textarea className="input-field min-h-[90px]" placeholder={t('adminCaseLabContentEn')} value={section.content} onChange={(e) => setForm({
                    ...form,
                    labSections: form.labSections.map((row) => row.id === section.id ? { ...row, content: e.target.value } : row),
                  })} />
                  <textarea className="input-field min-h-[90px]" placeholder={t('adminCaseLabContentAr')} value={section.contentAr} onChange={(e) => setForm({
                    ...form,
                    labSections: form.labSections.map((row) => row.id === section.id ? { ...row, contentAr: e.target.value } : row),
                  })} />
                </div>
                <button type="button" className="text-red-600 text-sm" onClick={() => setForm({
                  ...form,
                  labSections: form.labSections.filter((row) => row.id !== section.id),
                })}>
                  <Trash2 size={14} className="inline" /> {t('delete')}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2"
              onClick={() => setForm({
                ...form,
                labSections: [...form.labSections, { id: newId('lab'), title: '', titleAr: '', content: '', contentAr: '' }],
              })}
            >
              <Plus size={16} /> {t('adminCaseAddLabSection')}
            </button>
          </div>
        </Section>

        <Section title={t('adminCaseSectionRubric')}>
          <div className="space-y-3">
            {form.rubricItems.map((item) => (
              <div key={item.id} className="grid sm:grid-cols-[1fr_180px_auto] gap-2 items-start">
                <input className="input-field" placeholder={t('adminCaseRubricItem')} value={item.item} onChange={(e) => setForm({
                  ...form,
                  rubricItems: form.rubricItems.map((row) => row.id === item.id ? { ...row, item: e.target.value } : row),
                })} />
                <select className="input-field" value={item.category} onChange={(e) => setForm({
                  ...form,
                  rubricItems: form.rubricItems.map((row) => row.id === item.id ? { ...row, category: e.target.value } : row),
                })}>
                  {RUBRIC_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                </select>
                <button type="button" className="text-red-600 p-2" onClick={() => setForm({
                  ...form,
                  rubricItems: form.rubricItems.filter((row) => row.id !== item.id),
                })}>
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2"
              onClick={() => setForm({
                ...form,
                rubricItems: [...form.rubricItems, { id: newId('rubric'), item: '', category: 'History' }],
              })}
            >
              <Plus size={16} /> {t('adminCaseAddRubricItem')}
            </button>
          </div>
        </Section>

        <Section title={t('adminCaseSectionExaminerQuestions')}>
          <p className="text-sm text-slate-500">{t('adminCaseExaminerQuestionsDesc')}</p>
          <div className="space-y-4">
            {form.examinerQuestions.map((row) => (
              <div key={row.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                <textarea
                  className="input-field min-h-[70px]"
                  placeholder={t('adminCaseExaminerQuestion')}
                  value={row.question}
                  onChange={(e) => setForm({
                    ...form,
                    examinerQuestions: form.examinerQuestions.map((q) =>
                      q.id === row.id ? { ...q, question: e.target.value } : q,
                    ),
                  })}
                />
                <textarea
                  className="input-field min-h-[90px]"
                  placeholder={t('adminCaseExaminerSampleAnswer')}
                  value={row.sampleAnswer}
                  onChange={(e) => setForm({
                    ...form,
                    examinerQuestions: form.examinerQuestions.map((q) =>
                      q.id === row.id ? { ...q, sampleAnswer: e.target.value } : q,
                    ),
                  })}
                />
                <button
                  type="button"
                  className="text-red-600 text-sm"
                  onClick={() => setForm({
                    ...form,
                    examinerQuestions: form.examinerQuestions.filter((q) => q.id !== row.id),
                  })}
                >
                  <Trash2 size={14} className="inline" /> {t('delete')}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2"
              onClick={() => setForm({
                ...form,
                examinerQuestions: [
                  ...form.examinerQuestions,
                  { id: newId('viva'), question: '', sampleAnswer: '' },
                ],
              })}
            >
              <Plus size={16} /> {t('adminCaseAddExaminerQuestion')}
            </button>
          </div>
        </Section>

        <Section title={t('adminCaseSectionAi')}>
          <div className="space-y-3">
            <textarea className="input-field min-h-[100px]" placeholder={t('adminCasePersonality')} value={form.patientPersonality} onChange={(e) => setForm({ ...form, patientPersonality: e.target.value })} />
            <textarea className="input-field min-h-[180px]" placeholder={t('adminCaseScenarioPrompt')} value={form.scenarioPrompt} onChange={(e) => setForm({ ...form, scenarioPrompt: e.target.value })} />
            <input className="input-field" placeholder={t('adminCaseFinalDiagnosis')} value={form.finalDiagnosis} onChange={(e) => setForm({ ...form, finalDiagnosis: e.target.value })} />
            <textarea className="input-field min-h-[100px]" placeholder={t('adminCaseTeachingPoints')} value={form.teachingPoints} onChange={(e) => setForm({ ...form, teachingPoints: e.target.value })} />
          </div>

          <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800 space-y-3">
            <div>
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                {t('adminCasePatientBehavior')}
              </p>
              <p className="text-xs text-slate-500 mt-1">{t('adminCasePatientBehaviorHint')}</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <input
                className="input-field"
                placeholder={t('adminCasePatientTone')}
                value={form.stationConfig.patientBehavior.tone}
                onChange={(e) =>
                  updateForm({
                    ...form,
                    stationConfig: {
                      ...form.stationConfig,
                      patientBehavior: { ...form.stationConfig.patientBehavior, tone: e.target.value },
                    },
                  })
                }
              />
              <input
                className="input-field"
                placeholder={t('adminCasePatientEmotion')}
                value={form.stationConfig.patientBehavior.emotion}
                onChange={(e) =>
                  updateForm({
                    ...form,
                    stationConfig: {
                      ...form.stationConfig,
                      patientBehavior: { ...form.stationConfig.patientBehavior, emotion: e.target.value },
                    },
                  })
                }
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1 block">
                {t('adminCasePatientPreferredLanguage')}
              </label>
              <select
                className="input-field"
                value={form.stationConfig.patientBehavior.preferredLanguage}
                onChange={(e) =>
                  updateForm({
                    ...form,
                    stationConfig: {
                      ...form.stationConfig,
                      patientBehavior: {
                        ...form.stationConfig.patientBehavior,
                        preferredLanguage: e.target.value as PatientPreferredLanguage,
                      },
                    },
                  })
                }
              >
                <option value="AUTO">{t('speechLangAuto')}</option>
                <option value="AR">{t('speechLangAr')}</option>
                <option value="EN">{t('speechLangEn')}</option>
              </select>
            </div>
            <textarea
              className="input-field min-h-[120px]"
              placeholder={t('adminCasePatientInstructions')}
              value={form.stationConfig.patientBehavior.instructions}
              onChange={(e) =>
                updateForm({
                  ...form,
                  stationConfig: {
                    ...form.stationConfig,
                    patientBehavior: {
                      ...form.stationConfig.patientBehavior,
                      instructions: e.target.value,
                    },
                  },
                })
              }
            />
            <textarea
              className="input-field min-h-[100px]"
              placeholder={t('adminCasePatientConstraints')}
              value={form.stationConfig.patientBehavior.constraints}
              onChange={(e) =>
                updateForm({
                  ...form,
                  stationConfig: {
                    ...form.stationConfig,
                    patientBehavior: {
                      ...form.stationConfig.patientBehavior,
                      constraints: e.target.value,
                    },
                  },
                })
              }
            />
          </div>
        </Section>

      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{t('adminCaseTitle')}</h2>
          <p className="text-sm text-slate-500">{t('adminCaseListDesc')}</p>
        </div>
        <button type="button" onClick={startCreate} className="btn-primary inline-flex items-center gap-2">
          <Plus size={16} /> {t('adminCaseAdd')}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-slate-500">{t('loading')}</p>}

      <div className="card p-4 space-y-3">
        <div className="relative">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            className="input-field ps-9"
            placeholder={t('adminCaseSearchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
          <select className="input-field" value={specialtyFilter} onChange={(e) => setSpecialtyFilter(e.target.value)}>
            <option value="">{t('adminCaseFilterSpecialtyAll')}</option>
            {specialties.map((s) => <option key={s.id} value={s.id}>{s.nameEn}</option>)}
          </select>
          <select className="input-field" value={difficultyFilter} onChange={(e) => setDifficultyFilter(e.target.value)}>
            <option value="">{t('adminCaseFilterDifficultyAll')}</option>
            {difficulties.map((d) => <option key={d.id} value={d.id}>{d.nameEn}</option>)}
          </select>
          <select className="input-field" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">{t('adminCaseFilterCategoryAll')}</option>
            <option value="__none__">{t('adminCaseUncategorized')}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.nameEn}</option>)}
          </select>
          <select className="input-field" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as CaseStatusFilter)}>
            <option value="all">{t('adminCaseFilterStatusAll')}</option>
            <option value="published">{t('adminCaseStatusPublished')}</option>
            <option value="draft">{t('adminCaseStatusDraft')}</option>
            <option value="free">{t('adminCaseStatusFree')}</option>
          </select>
          <div className="relative">
            <ArrowUpDown size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <select className="input-field ps-8" value={sortKey} onChange={(e) => setSortKey(e.target.value as CaseSortKey)}>
              <option value="newest">{t('adminCaseSortNewest')}</option>
              <option value="oldest">{t('adminCaseSortOldest')}</option>
              <option value="titleAz">{t('adminCaseSortTitleAz')}</option>
              <option value="titleZa">{t('adminCaseSortTitleZa')}</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          {t('adminCaseShowingCount', {
            shown: pagedGroups.reduce((sum, g) => sum + g.items.length, 0),
            total: filteredCases.length,
          })}
        </p>
      </div>

      {!loading && filteredCases.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-8">{t('adminCaseNoMatches')}</p>
      )}

      <div className="space-y-6">
        {pagedGroups.map((group) => (
          <div key={group.key} className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{group.label}</h3>
              <span className="text-xs text-slate-400">({group.items.length})</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {group.items.map((c) => (
                <div key={c.id} className="card card-interactive p-5 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="w-11 h-11 rounded-xl bg-violet-50 dark:bg-violet-900/20 flex items-center justify-center shrink-0">
                      <FileText className="text-violet-600" size={20} />
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button type="button" className="text-violet-600 p-2" onClick={() => void startEdit(c.id)} aria-label={t('edit')}>
                        <Pencil size={16} />
                      </button>
                      <button type="button" className="text-red-600 p-2" onClick={() => void deleteCase(c.id)} aria-label={t('delete')}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-900 dark:text-white break-words">{c.titleEn}</p>
                    <p className="text-sm text-slate-500 mt-0.5">{c.patientName}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{c.specialty?.nameEn} · {c.difficulty?.nameEn}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-auto">
                    <span className={`badge ${c.isPublished ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                      {c.isPublished ? t('adminCaseStatusPublished') : t('adminCaseStatusDraft')}
                    </span>
                    {c.isFreeTier && <span className="badge bg-blue-50 dark:bg-blue-900/30 text-blue-700">{t('adminCaseStatusFree')}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
          <button
            type="button"
            className="btn-secondary text-sm disabled:opacity-40"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            {t('adminCasePrevPage')}
          </button>
          <span className="text-sm text-slate-500 px-2">
            {t('adminCasePageOf', { page: currentPage, pages: totalPages })}
          </span>
          <button
            type="button"
            className="btn-secondary text-sm disabled:opacity-40"
            disabled={currentPage >= totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            {t('adminCaseNextPage')}
          </button>
        </div>
      )}
    </div>
  );
}
