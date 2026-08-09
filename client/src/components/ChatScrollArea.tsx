import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';

const NEAR_BOTTOM_PX = 120;

export interface ChatScrollAreaProps {
  children: ReactNode;
  /** Scroll sentinel (optional — component manages its own when not provided). */
  endRef?: RefObject<HTMLDivElement | null>;
  /** Dependencies that should trigger scroll-to-bottom when near bottom. */
  scrollDeps: unknown[];
  /** Force scroll when a new local turn arrives (e.g. sending). */
  forceScroll?: boolean;
  className?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
  empty?: boolean;
  emptyContent?: ReactNode;
}

/**
 * Full-height scroll area that bottom-aligns short conversations
 * and only auto-scrolls when the user is already near the bottom.
 */
export function ChatScrollArea({
  children,
  endRef: externalEndRef,
  scrollDeps,
  forceScroll = false,
  className = '',
  dir = 'ltr',
  empty = false,
  emptyContent,
}: ChatScrollAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalEndRef = useRef<HTMLDivElement>(null);
  const endRef = externalEndRef ?? internalEndRef;
  const stickToBottomRef = useRef(true);

  const updateStickToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance <= NEAR_BOTTOM_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior });
    } else {
      endRef.current?.scrollIntoView({ behavior, block: 'end' });
    }
  }, [endRef]);

  useEffect(() => {
    if (forceScroll || stickToBottomRef.current) {
      scrollToBottom(forceScroll ? 'auto' : 'smooth');
      stickToBottomRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceScroll, scrollToBottom, ...scrollDeps]);

  // Re-anchor to the bottom whenever the scroll area (or its content) changes
  // size — e.g. the collapsible clinical gallery opening/closing or media
  // loading above the chat. Without this the container keeps a stale scrollTop
  // and the conversation appears to jump or get stuck mid-scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom('auto');
    });
    observer.observe(el);
    const content = el.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  return (
    <div
      ref={containerRef}
      className={`flex-1 min-h-0 overflow-y-auto overscroll-y-contain ${className}`}
      dir={dir}
      onScroll={updateStickToBottom}
    >
      <div className={`flex flex-col min-h-full ${empty ? 'justify-center' : 'justify-end'}`}>
        <div className="flex flex-col gap-2 sm:gap-3 p-3 sm:p-4">
          {empty && emptyContent ? emptyContent : children}
          <div ref={endRef} aria-hidden className="h-px w-full shrink-0" />
        </div>
      </div>
    </div>
  );
}
