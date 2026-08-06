import { Phone, PhoneOff } from "lucide-react";

export interface LiveCallButtonProps {
  isLiveCall?: boolean;
  isLiveCallBusy?: boolean;
  isLiveCallSupported?: boolean;
  onToggleLiveCall?: () => void;
  liveCallLabel?: string;
  endLiveCallLabel?: string;
  disabled?: boolean;
  compact?: boolean;
}

export function LiveCallButton({
  isLiveCall,
  isLiveCallBusy,
  isLiveCallSupported,
  onToggleLiveCall,
  liveCallLabel = "Live call",
  endLiveCallLabel = "End call",
  disabled,
  compact = false,
}: LiveCallButtonProps) {
  if (!onToggleLiveCall) return null;

  const label = isLiveCall ? endLiveCallLabel : liveCallLabel;

  return (
    <button
      type="button"
      onClick={onToggleLiveCall}
      disabled={(disabled && !isLiveCall) || isLiveCallBusy}
      title={label}
      aria-label={label}
      className={`inline-flex items-center justify-center shrink-0 font-semibold transition-colors whitespace-nowrap ${
        compact
          ? 'w-9 h-9 rounded-full p-0 sm:w-auto sm:h-auto sm:gap-1.5 sm:px-2.5 sm:py-1.5 sm:rounded-full'
          : 'gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-full text-[11px] sm:text-xs max-w-[9.5rem] sm:max-w-none'
      } ${
        isLiveCall
          ? "bg-emerald-500 text-white ring-2 ring-emerald-300"
          : isLiveCallSupported
            ? "bg-slate-800 dark:bg-slate-700 text-white hover:bg-slate-700"
            : "bg-slate-200 dark:bg-slate-700 text-slate-500 cursor-not-allowed opacity-60"
      }`}
    >
      {isLiveCall ? <PhoneOff size={compact ? 16 : 14} className="shrink-0 sm:!w-[14px] sm:!h-[14px]" /> : <Phone size={compact ? 16 : 14} className="shrink-0 sm:!w-[14px] sm:!h-[14px]" />}
      {compact ? (
        <span className="hidden sm:inline truncate text-[11px] sm:text-xs">{label}</span>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </button>
  );
}
