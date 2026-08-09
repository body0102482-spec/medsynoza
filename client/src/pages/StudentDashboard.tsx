import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Clock, Play, Lock } from 'lucide-react';
import api from '../lib/api';
import { boardDisplayName } from '../lib/boardLabels';
import { BoardIcon, getBoardIconBg } from '../components/BoardIcon';
import { BlindMockOsceCard } from '../components/student/BlindMockOsceCard';
import { RandomCasePreview } from '../components/student/RandomCasePreview';
import { StartCaseConfirmDialog } from '../components/student/StartCaseConfirmDialog';
import { StudentCaseCard } from '../components/student/StudentCaseCard';
import { PortalSupportCard } from '../components/student/PortalSupportCard';
import {
  shouldConfirmCaseStart,
  type PendingCaseStart,
} from '../lib/startCaseConfirm';
import {
  dispatchEntitlementsChanged,
  ENTITLEMENTS_CHANGED_EVENT,
  readEntitlementsFromEvent,
} from '../lib/entitlementsEvents';

interface Case {
  id: string;
  titleEn: string;
  titleAr: string;
  patientName: string;
  chiefComplaint: string;
  specialty: { nameEn: string; nameAr: string };
  difficulty: { nameEn: string; nameAr: string; color: string; level: number };
  category?: { nameEn: string; nameAr: string } | null;
  examImages?: string;
  isFreeTier?: boolean;
}

interface CategoryNode {
  id: string;
  nameEn: string;
  nameAr: string;
  description?: string | null;
  children: CategoryNode[];
  _count?: { cases: number; children: number };
}

interface Entitlements {
  plan: string;
  isFree: boolean;
  freeAttemptsPerCase: number;
  casesQuota: number;
  casesUnlocked: number;
  casesRemaining: number;
  planEndDate?: string | null;
  planStartDate?: string | null;
  planDurationMonths?: number;
  attemptsByCase: Record<string, number>;
}

const DEFAULT_COVER = '/exam/chest-inspection.svg';
function getCaseCover(examImages?: string): string {
  try {
    const parsed = JSON.parse(examImages || '[]') as Array<{ url?: string }>;
    for (const item of parsed) {
      const url = item.url?.trim();
      if (!url) continue;
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      if (url.startsWith('/')) return url;
    }
  } catch {
    /* ignore invalid JSON */
  }
  return DEFAULT_COVER;
}

function CaseCoverImage({ examImages, title }: { examImages?: string; title: string }) {
  const [src, setSrc] = useState(() => getCaseCover(examImages));
  const isSvg = src.endsWith('.svg');

  useEffect(() => {
    setSrc(getCaseCover(examImages));
  }, [examImages]);

  return (
    <img
      src={src}
      alt={title}
      className={`w-full h-full group-hover:scale-105 transition-transform duration-500 ${
        isSvg ? 'object-contain p-3 bg-slate-100 dark:bg-slate-800' : 'object-cover'
      }`}
      onError={() => {
        if (src !== DEFAULT_COVER) setSrc(DEFAULT_COVER);
      }}
    />
  );
}

function difficultyTone(level: number) {
  if (level <= 1) return 'bg-emerald-600';
  if (level === 2) return 'bg-amber-600';
  return 'bg-red-600';
}

function boardIsComingSoon(board: CategoryNode) {
  const childCases = board.children.reduce((sum, child) => sum + (child._count?.cases ?? 0), 0);
  return (board._count?.cases ?? 0) === 0 && childCases === 0 && board.children.length === 0;
}

type SectionOption = {
  id: string;
  label: string;
  shortLabel: string;
  boardLabel?: string;
  caseCount: number;
};

function buildSectionOptions(categories: CategoryNode[], isAr: boolean): SectionOption[] {
  const options: SectionOption[] = [];

  for (const board of categories) {
    if (boardIsComingSoon(board)) continue;

    const boardName = isAr ? board.nameAr : board.nameEn;

    if (board.children.length > 0) {
      for (const child of board.children) {
        const caseCount = child._count?.cases ?? 0;
        if (caseCount === 0) continue;
        const childName = isAr ? child.nameAr : child.nameEn;
        options.push({
          id: child.id,
          label: `${boardName} → ${childName}`,
          shortLabel: childName,
          boardLabel: boardName,
          caseCount,
        });
      }
      const boardCases = board._count?.cases ?? 0;
      if (boardCases > 0) {
        options.push({ id: board.id, label: boardName, shortLabel: boardName, caseCount: boardCases });
      }
    } else {
      const caseCount = board._count?.cases ?? 0;
      if (caseCount > 0) {
        options.push({ id: board.id, label: boardName, shortLabel: boardName, caseCount });
      }
    }
  }

  return options;
}

export default function StudentDashboard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const isAr = i18n.language?.startsWith('ar');

  const [cases, setCases] = useState<Case[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [rootCategories, setRootCategories] = useState<CategoryNode[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [randomLoading, setRandomLoading] = useState<'all' | 'section' | null>(null);
  const [randomSectionIds, setRandomSectionIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState<PendingCaseStart | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const randomErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadEntitlements = () => {
      api.get('/student/entitlements').then((r) => {
        setEntitlements(r.data.entitlements);
      });
    };
    const onEntitlementsChanged = (event: Event) => {
      const detail = readEntitlementsFromEvent(event);
      if (detail) {
        setEntitlements(detail as Entitlements);
        return;
      }
      loadEntitlements();
    };
    loadEntitlements();
    window.addEventListener(ENTITLEMENTS_CHANGED_EVENT, onEntitlementsChanged);
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) loadEntitlements();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener(ENTITLEMENTS_CHANGED_EVENT, onEntitlementsChanged);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  useEffect(() => {
    api
      .get('/categories')
      .then((r) => {
        setRootCategories(r.data.categories ?? []);
      })
      .catch(() => {
        setRootCategories([]);
      });
  }, []);

  const selectedBoard = useMemo(
    () => rootCategories.find((cat) => cat.id === selectedBoardId) ?? null,
    [rootCategories, selectedBoardId],
  );

  const subCategories = selectedBoard?.children ?? [];

  const activeCategoryId = selectedSubId ?? selectedBoardId;

  const sectionOptions = useMemo(
    () => buildSectionOptions(rootCategories, isAr),
    [rootCategories, isAr],
  );

  const boardKeyOf = useCallback(
    (id: string) => {
      const opt = sectionOptions.find((o) => o.id === id);
      return opt ? (opt.boardLabel ?? opt.shortLabel) : null;
    },
    [sectionOptions],
  );

  useEffect(() => {
    if (!sectionOptions.length) return;
    setRandomSectionIds((prev) => {
      const stillValid = prev.filter((id) => sectionOptions.some((o) => o.id === id));
      if (stillValid.length) return stillValid;
      if (activeCategoryId && sectionOptions.some((o) => o.id === activeCategoryId)) {
        return [activeCategoryId];
      }
      return [sectionOptions[0].id];
    });
  }, [sectionOptions, activeCategoryId]);

  // Multi-select limited to one specialty (board): toggling a department in a
  // different specialty switches the whole selection to that specialty.
  const toggleRandomSection = useCallback(
    (id: string) => {
      setRandomSectionIds((prev) => {
        if (prev.includes(id)) {
          const next = prev.filter((x) => x !== id);
          return next.length ? next : prev; // keep at least one selected
        }
        const board = boardKeyOf(id);
        const sameBoard = prev.length === 0 || boardKeyOf(prev[0]) === board;
        return sameBoard ? [...prev, id] : [id];
      });
    },
    [boardKeyOf],
  );

  useEffect(() => {
    if (!rootCategories.length || selectedBoardId) return;
    const firstBoard = rootCategories[0];
    setSelectedBoardId(firstBoard.id);
    setSelectedSubId(firstBoard.children[0]?.id ?? firstBoard.id);
  }, [rootCategories, selectedBoardId]);

  useEffect(() => {
    setLoading(true);
    api
      .get('/cases', {
        params: {
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(activeCategoryId && !search.trim() ? { categoryId: activeCategoryId } : {}),
        },
      })
      .then((r) => setCases(r.data.cases ?? []))
      .catch(() => setCases([]))
      .finally(() => setLoading(false));
  }, [search, activeCategoryId]);

  const selectBoard = (board: CategoryNode) => {
    if (boardIsComingSoon(board)) return;
    setSelectedBoardId(board.id);
    setSelectedSubId(board.children[0]?.id ?? board.id);
    setSearch('');
  };

  const showStartError = (message: string) => {
    setStartError(message);
    requestAnimationFrame(() => {
      randomErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const resolveStartError = (err: unknown, scope?: 'all' | 'section') => {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    const code = axiosErr.response?.data?.error;
    if (code === 'NO_ELIGIBLE_CASES') return t('noEligibleRandomCase');
    if (code === 'NO_CASES') return scope === 'section' ? t('noCasesInSection') : t('noStationsInCategory');
    if (code === 'FREE_LIMIT_REACHED') return t('freeLimitReached');
    if (code === 'CASE_QUOTA_EXCEEDED') return t('caseQuotaExceeded');
    if (code === 'SUBSCRIPTION_REQUIRED') return t('subscriptionRequired');
    return t('error');
  };

  const launchSession = async (caseId: string) => {
    const res = await api.post('/sessions/start', { caseId, language: 'AR' });
    if (res.data.entitlements) {
      setEntitlements(res.data.entitlements);
      dispatchEntitlementsChanged(res.data.entitlements);
    } else {
      dispatchEntitlementsChanged();
    }
    navigate(`/simulation/${res.data.session.id}`, { state: { fromCaseStart: true } });
  };

  const startStation = async (caseId: string) => {
    setStartError(null);
    try {
      await launchSession(caseId);
    } catch (err: unknown) {
      showStartError(resolveStartError(err));
    }
  };

  const startRandomCase = async (categoryIds?: string[]) => {
    const ids = (categoryIds ?? []).filter(Boolean);
    setStartError(null);
    setRandomLoading(ids.length ? 'section' : 'all');
    try {
      const randomRes = await api.get('/student/random-case', {
        params: ids.length ? { categoryId: ids.join(',') } : {},
      });
      const caseId = randomRes.data?.case?.id;
      if (!caseId) {
        showStartError(t('error'));
        return;
      }
      await launchSession(caseId);
    } catch (err: unknown) {
      showStartError(resolveStartError(err, ids.length ? 'section' : 'all'));
    } finally {
      setRandomLoading(null);
      setConfirmLoading(false);
      setConfirmOpen(false);
      setPendingStart(null);
    }
  };

  const executePendingStart = async (pending: PendingCaseStart) => {
    setConfirmLoading(true);
    try {
      if (pending.type === 'random') {
        await startRandomCase(pending.categoryIds);
      } else {
        setConfirmOpen(false);
        setPendingStart(null);
        await startStation(pending.caseId);
      }
    } finally {
      if (pending.type !== 'random') setConfirmLoading(false);
    }
  };

  const requestCaseStart = (pending: PendingCaseStart) => {
    if (!entitlements) return;
    if (shouldConfirmCaseStart(entitlements, pending)) {
      setPendingStart(pending);
      setConfirmOpen(true);
      return;
    }
    void executePendingStart(pending);
  };

  const getCaseAttempts = (caseId: string) => entitlements?.attemptsByCase[caseId] ?? 0;

  const canStartCase = (c: Case) => {
    if (!entitlements) return false;
    if (entitlements.isFree) {
      if (!c.isFreeTier) return false;
      return getCaseAttempts(c.id) < entitlements.freeAttemptsPerCase;
    }
    const attempts = getCaseAttempts(c.id);
    if (attempts > 0) return true;
    return entitlements.casesRemaining > 0;
  };

  const caseAttemptLabel = (caseId: string) => {
    if (!entitlements) return null;
    const used = getCaseAttempts(caseId);
    if (entitlements.isFree) {
      const left = Math.max(0, entitlements.freeAttemptsPerCase - used);
      return left > 0 ? t('attemptsRemaining', { count: left }) : t('attemptsUsedUp');
    }
    if (used > 0) return t('completed');
    return null;
  };

  const sortedCases = useMemo(() => {
    if (entitlements?.isFree) {
      return cases.filter((c) => !c.isFreeTier);
    }
    return cases;
  }, [cases, entitlements?.isFree]);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <StartCaseConfirmDialog
        open={confirmOpen}
        pending={pendingStart}
        entitlements={entitlements}
        confirming={confirmLoading}
        title={t('startCaseConfirmTitle')}
        confirmLabel={t('startCaseConfirmButton')}
        cancelLabel={t('stayInExam')}
        onConfirm={() => pendingStart && void executePendingStart(pendingStart)}
        onCancel={() => {
          if (confirmLoading) return;
          setConfirmOpen(false);
          setPendingStart(null);
        }}
      />

      {entitlements?.isFree ? (
        <RandomCasePreview entitlements={entitlements} />
      ) : entitlements && sectionOptions.length > 0 ? (
        <BlindMockOsceCard
          sections={sectionOptions.map((o) => ({
            id: o.id,
            shortLabel: o.shortLabel,
            caseCount: o.caseCount,
            boardLabel: o.boardLabel,
          }))}
          selectedSectionIds={randomSectionIds}
          onToggleSection={toggleRandomSection}
          onSurpriseMe={() => requestCaseStart({ type: 'random', categoryIds: randomSectionIds })}
          loading={randomLoading !== null}
          error={startError}
          errorRef={randomErrorRef}
        />
      ) : null}

      {/* Active rotations */}
      <section className="space-y-5">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{t('portalActiveRotations')}</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{t('portalActiveRotationsDesc')}</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {rootCategories.map((board) => {
            const soon = boardIsComingSoon(board);
            const selected = selectedBoardId === board.id;
            const label = boardDisplayName(board.nameEn, !!isAr);
            return (
              <button
                key={board.id}
                type="button"
                onClick={() => selectBoard(board)}
                disabled={soon}
                className={`rounded-2xl border p-4 text-center transition-all min-h-[120px] flex flex-col items-center justify-center gap-3 ${
                  soon
                    ? 'border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 text-slate-300 dark:text-slate-500 cursor-not-allowed'
                    : selected
                      ? 'border-teal-200 dark:border-teal-700 bg-teal-50/80 dark:bg-teal-950/50 shadow-md ring-1 ring-teal-200 dark:ring-teal-800'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 hover:border-teal-200 dark:hover:border-teal-700 hover:shadow-sm'
                }`}
              >
                <div className={`w-10 h-10 rounded-xl border flex items-center justify-center ${getBoardIconBg(board.nameEn)}`}>
                  <BoardIcon nameEn={board.nameEn} size={20} />
                </div>
                <span className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 leading-tight">{label}</span>
                {soon && (
                  <span className="text-[9px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{t('comingSoon')}</span>
                )}
              </button>
            );
          })}
        </div>

        {!search.trim() && subCategories.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {subCategories.map((sub) => {
              const selected = selectedSubId === sub.id;
              return (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => setSelectedSubId(sub.id)}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold border transition-all ${
                    selected
                      ? 'bg-teal-600 text-white border-teal-600 shadow-md'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600 hover:border-teal-300 dark:hover:border-teal-600'
                  }`}
                >
                  <BoardIcon nameEn={sub.nameEn} size={14} />
                  {boardDisplayName(sub.nameEn, !!isAr)}
                </button>
              );
            })}
          </div>
        )}

        {loading ? (
          <p className="text-slate-500 dark:text-slate-400 py-16 text-center">{t('loading')}</p>
        ) : sortedCases.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 p-12 text-center text-slate-500 dark:text-slate-400">
            {t('noStationsInCategory')}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {sortedCases.map((c) =>
              entitlements?.isFree ? (
                <StudentCaseCard
                  key={c.id}
                  caseData={c}
                  isAr={!!isAr}
                  isFreeUser
                  canStart={canStartCase(c)}
                  attemptLabel={caseAttemptLabel(c.id)}
                  onStart={(id) => requestCaseStart({ type: 'station', caseId: id })}
                />
              ) : (
                <article
                  key={c.id}
                  className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/90 overflow-hidden shadow-sm hover:shadow-md transition-shadow flex flex-col h-full"
                >
                  <div className="h-44 bg-slate-100 dark:bg-slate-900 relative overflow-hidden">
                    <CaseCoverImage examImages={c.examImages} title={isAr ? c.titleAr : c.titleEn} />
                    <div className="absolute top-3 start-3 flex gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase text-white ${difficultyTone(c.difficulty.level)}`}
                      >
                        {isAr ? c.difficulty.nameAr : c.difficulty.nameEn}
                      </span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-900/70 text-white flex items-center gap-1">
                        <Clock size={10} />
                        18 {t('portalMins')}
                      </span>
                    </div>
                  </div>

                  <div className="p-5 flex-1 flex flex-col gap-4 min-h-0">
                    <div className="flex-1 min-h-0">
                      <p className="text-[10px] font-bold tracking-[0.12em] text-teal-600 dark:text-teal-400 uppercase">
                        {isAr ? c.specialty.nameAr : c.specialty.nameEn}
                      </p>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-white mt-2 mb-2">
                        {isAr ? c.titleAr : c.titleEn}
                      </h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-2">{c.chiefComplaint}</p>
                      {caseAttemptLabel(c.id) && (
                        <p className={`text-xs font-semibold mt-2 ${canStartCase(c) ? 'text-teal-600 dark:text-teal-400' : 'text-red-500 dark:text-red-400'}`}>
                          {caseAttemptLabel(c.id)}
                        </p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => requestCaseStart({ type: 'station', caseId: c.id })}
                      disabled={!canStartCase(c)}
                      className={`w-full py-3 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 mt-auto shrink-0 ${
                        canStartCase(c)
                          ? 'bg-gradient-to-r from-slate-800 to-teal-800 text-white hover:opacity-95'
                          : 'bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      {canStartCase(c) ? <Play size={14} fill="currentColor" /> : <Lock size={14} />}
                      {canStartCase(c) ? t('portalOpenSimulator') : t('attemptsUsedUp')}
                    </button>
                  </div>
                </article>
              ),
            )}
          </div>
        )}
      </section>

      <PortalSupportCard isAr={!!isAr} topic="general" />
    </div>
  );
}
