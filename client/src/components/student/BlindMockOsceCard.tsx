import { EyeOff, Shuffle, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface BlindMockSectionOption {
  id: string;
  shortLabel: string;
  caseCount: number;
  /** Parent board (specialty) name — used to group chips so specialties don't look merged. */
  boardLabel?: string;
}

interface BlindMockOsceCardProps {
  sections: BlindMockSectionOption[];
  selectedSectionIds: string[];
  onToggleSection: (id: string) => void;
  onSurpriseMe: () => void;
  loading?: boolean;
  error?: string | null;
  errorRef?: React.RefObject<HTMLDivElement | null>;
}

export function BlindMockOsceCard({
  sections,
  selectedSectionIds,
  onToggleSection,
  onSurpriseMe,
  loading = false,
  error,
  errorRef,
}: BlindMockOsceCardProps) {
  const { t } = useTranslation();

  const selectedSet = new Set(selectedSectionIds);

  const boardGroups: { board: string; items: BlindMockSectionOption[] }[] = [];
  const boardIndex = new Map<string, number>();
  for (const section of sections) {
    const board = section.boardLabel ?? section.shortLabel;
    let idx = boardIndex.get(board);
    if (idx === undefined) {
      idx = boardGroups.length;
      boardIndex.set(board, idx);
      boardGroups.push({ board, items: [] });
    }
    boardGroups[idx].items.push(section);
  }
  const showBoardHeaders = boardGroups.length > 1;

  const renderChip = (section: BlindMockSectionOption) => {
    const selected = selectedSet.has(section.id);
    return (
      <button
        key={section.id}
        type="button"
        onClick={() => onToggleSection(section.id)}
        className={`group inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl border text-sm font-semibold transition-all duration-200 ${
          selected
            ? 'bg-teal-500/90 border-teal-300 text-white shadow-lg shadow-teal-500/25 scale-[1.02]'
            : 'bg-white/5 border-white/15 text-slate-200 hover:bg-white/10 hover:border-white/25'
        }`}
      >
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            selected ? 'bg-white animate-pulse' : 'bg-teal-400/60 group-hover:bg-teal-300'
          }`}
        />
        <span>{section.shortLabel}</span>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
            selected ? 'bg-white/20 text-white' : 'bg-black/20 text-slate-300'
          }`}
        >
          {section.caseCount}
        </span>
      </button>
    );
  };

  return (
    <div className="relative overflow-hidden rounded-3xl border border-teal-200/50 shadow-xl shadow-teal-900/10">
      <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-teal-950 to-slate-900" />
      <div
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 15%, rgba(20,184,166,0.45), transparent 42%), radial-gradient(circle at 85% 80%, rgba(99,102,241,0.35), transparent 40%)',
        }}
      />
      <div className="absolute -top-16 -end-16 w-48 h-48 rounded-full bg-teal-400/10 blur-3xl pointer-events-none" />

      <div className="relative p-6 sm:p-8">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
          <div className="text-start max-w-lg">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/15 text-teal-200 text-[10px] font-bold uppercase tracking-[0.16em] mb-3">
              <EyeOff size={12} />
              {t('blindMockBadge')}
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-white mb-2 leading-tight">
              {t('portalBlindMockTitle')}
            </h2>
            <p className="text-sm text-slate-300 leading-relaxed">{t('portalBlindMockDesc')}</p>
          </div>
          <div className="hidden sm:flex w-14 h-14 rounded-2xl bg-white/10 border border-white/15 items-center justify-center shrink-0">
            <Sparkles size={26} className="text-teal-300" />
          </div>
        </div>

        <div className="text-start mb-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-300/90 mb-1">
            {t('blindMockPickSection')}
          </p>
          <p className="text-[11px] text-slate-400 mb-3">{t('blindMockMultiSelectHint')}</p>
          {showBoardHeaders ? (
            <div className="space-y-4">
              {boardGroups.map((group) => (
                <div key={group.board}>
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-teal-200/70 mb-2">
                    {group.board}
                  </p>
                  <div className="flex flex-wrap gap-2.5">{group.items.map(renderChip)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2.5">{sections.map(renderChip)}</div>
          )}
        </div>

        {error && (
          <div
            ref={errorRef}
            className="mt-5 text-sm text-red-200 bg-red-500/15 border border-red-400/25 rounded-xl px-4 py-3 text-start"
          >
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={onSurpriseMe}
          disabled={loading || sections.length === 0}
          className="mt-6 w-full sm:max-w-md sm:mx-auto flex items-center justify-center gap-2.5 py-4 rounded-2xl bg-gradient-to-r from-teal-400 via-teal-500 to-emerald-500 text-white font-bold text-sm uppercase tracking-[0.12em] shadow-lg shadow-teal-500/30 hover:shadow-teal-400/40 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 disabled:hover:scale-100 transition-all"
        >
          <Shuffle size={18} className={loading ? 'animate-spin' : ''} />
          {loading ? t('randomCaseLoading') : t('portalSurpriseMe')}
        </button>

        <p className="mt-3 text-center text-[11px] text-slate-400">{t('blindMockNoPreviewHint')}</p>
      </div>
    </div>
  );
}
