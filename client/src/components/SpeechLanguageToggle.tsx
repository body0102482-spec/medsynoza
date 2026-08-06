type SpeechLang = 'AUTO' | 'AR' | 'EN';

interface SpeechLanguageToggleProps {
  value: SpeechLang;
  onChange: (value: SpeechLang) => void;
  disabled?: boolean;
  compact?: boolean;
  labels: {
    auto: string;
    ar: string;
    en: string;
  };
}

const OPTIONS: SpeechLang[] = ['AUTO', 'AR', 'EN'];

export function SpeechLanguageToggle({
  value,
  onChange,
  disabled,
  compact = false,
  labels,
}: SpeechLanguageToggleProps) {
  return (
    <div
      className={`inline-flex items-center rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 shrink-0 ${
        compact ? 'p-0.5' : 'p-0.5'
      }`}
      role="group"
      aria-label="Speech language"
    >
      {OPTIONS.map((opt) => {
        const active = value === opt;
        const fullLabel = opt === 'AUTO' ? labels.auto : opt === 'AR' ? labels.ar : labels.en;
        const shortLabel = opt === 'AUTO' ? labels.auto : opt === 'AR' ? 'ع' : 'EN';
        return (
          <button
            key={opt}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt)}
            className={`${compact ? 'px-1.5' : 'px-2 sm:px-2.5'} py-1 rounded-full text-[10px] sm:text-xs font-semibold transition-colors disabled:opacity-50 ${
              active
                ? 'bg-primary text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-300 hover:bg-white/70 dark:hover:bg-slate-700/70'
            }`}
          >
            {compact ? (
              <>
                <span className="sm:hidden">{shortLabel}</span>
                <span className="hidden sm:inline">{fullLabel}</span>
              </>
            ) : (
              fullLabel
            )}
          </button>
        );
      })}
    </div>
  );
}
