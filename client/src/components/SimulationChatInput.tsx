import { useLayoutEffect, useRef } from 'react';
import { Send } from 'lucide-react';
import { VoiceMicButton } from './VoiceMicButton';

interface SimulationChatInputProps {
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  placeholder: string;
  chatError?: string;
  isListening: boolean;
  isProcessing?: boolean;
  isMicSupported: boolean;
  onToggleMic: () => void;
  micListeningLabel: string;
  micNotSupportedLabel: string;
  micProcessingLabel?: string;
  micError?: string;
  disabled?: boolean;
  isLiveCall?: boolean;
  compact?: boolean;
}

const MAX_TEXTAREA_HEIGHT = 160;

export function SimulationChatInput({
  input,
  setInput,
  onSend,
  sending,
  placeholder,
  chatError,
  isListening,
  isProcessing,
  isMicSupported,
  onToggleMic,
  micListeningLabel,
  micNotSupportedLabel,
  micProcessingLabel,
  micError,
  disabled,
  isLiveCall,
  compact = false,
}: SimulationChatInputProps) {
  const locked = disabled || sending || isProcessing;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [input]);

  return (
    <div
      className={`border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 ${
        compact ? 'p-2 sm:p-4' : 'p-4'
      }`}
    >
      {chatError && <p className="text-xs text-red-500 mb-2">{chatError}</p>}
      {micError && !isLiveCall && <p className="text-xs text-red-500 mb-2">{micError}</p>}
      {isProcessing && (
        <p className="text-xs text-primary mb-2 animate-pulse">{micProcessingLabel ?? '…'}</p>
      )}
      {isListening && !isProcessing && (
        <p className="text-xs text-primary mb-2">{micListeningLabel}</p>
      )}

      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          rows={1}
          className="input-field flex-1 min-w-0 resize-none overflow-y-auto leading-5 max-h-40"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={locked || isLiveCall}
        />
        <VoiceMicButton
          isListening={isListening || !!isProcessing}
          isSupported={isMicSupported}
          disabled={locked || isLiveCall}
          onClick={onToggleMic}
          listeningLabel={micListeningLabel}
          notSupportedLabel={micNotSupportedLabel}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={locked || isLiveCall || !input.trim()}
          className="w-11 h-11 bg-primary text-white rounded-full flex items-center justify-center hover:bg-primary-dark disabled:opacity-50 shrink-0"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
