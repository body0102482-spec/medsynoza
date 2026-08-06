import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import axios from "axios";
import {
  MessageSquare,
  Search,
  FlaskConical,
  ClipboardList,
  Lightbulb,
  UserCircle,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  Stethoscope,
  Eye,
  Download,
  Shield,
  ClipboardCheck,
  Loader2,
  CheckCircle2,
  GraduationCap,
} from "lucide-react";
import api from "../lib/api";
import { dispatchEntitlementsChanged } from "../lib/entitlementsEvents";
import { downloadOsceReportPdf } from "../lib/osceReportPdf";
import { ConnectionStatus } from "../components/ConnectionStatus";
import chestInspectionImg from "../assets/exam/chest-inspection.svg?url";
import chestPalpationImg from "../assets/exam/chest-palpation.svg?url";
import chestPercussionImg from "../assets/exam/chest-percussion.svg?url";
import chestAuscultationImg from "../assets/exam/chest-auscultation.svg?url";
// import { VoiceMicButton } from '../components/VoiceMicButton';
import { SimulationChatInput } from '../components/SimulationChatInput';
import { ChatScrollArea } from '../components/ChatScrollArea';
import { LiveCallButton } from '../components/LiveCallButton';
import { LiveCallMicStatus } from '../components/LiveCallMicStatus';
import { SpeechLanguageToggle } from '../components/SpeechLanguageToggle';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { useLiveVoiceCall } from '../hooks/useLivePatientCall';
import { stopSpeaking } from '../lib/speech';
import { IS_MOBILE, unlockMobileAudio } from '../lib/mobileAudio';
import type { VoiceTurnResponse } from '../lib/voiceTurn';
import { isVivaClosingMessage } from '../lib/vivaClosing';
import {
  XpBreakdownSection,
  parseRankSnapshot,
  type RankSnapshot,
} from '../components/student/XpBreakdownSection';
import { RankPromotionModal } from '../components/student/RankPromotionModal';
import { getNextMainStageAfter, getSessionStationConfig, getSimulationStages, resolveManeuverLabel } from '../lib/stationConfig';

interface Message {
  id: string;
  role: "STUDENT" | "PATIENT" | "EXAMINER" | "SYSTEM";
  content: string;
  stage: string;
  createdAt: string;
}

interface ExamImage {
  url: string;
  caption?: string;
  captionAr?: string;
  maneuver?: string;
  mediaType?: 'image' | 'video' | 'audio';
}

interface VitalSigns {
  bp?: { value: string; note: string };
  hr?: { value: string; note: string };
  temp?: { value: string; note: string };
  spo2?: { value: string; note: string };
}

interface Session {
  id: string;
  currentStage: string;
  activeManeuver: string | null;
  completedManeuvers: string;
  resolvedStationConfig?: string;
  language: string;
  startedAt: string;
  case: {
    titleEn: string;
    titleAr: string;
    patientName: string;
    patientAge: number;
    patientGender: string;
    patientNationality: string;
    vitalSigns: string;
    physicalExam: string;
    labResults: string;
    examImages: string;
    stationConfig?: string;
  };
  messages: Message[];
  result?: Record<string, unknown> | null;
  status?: string;
}

const STAGE_ICONS = {
  history: MessageSquare,
  examination: Search,
  investigations: FlaskConical,
  diagnosis: ClipboardList,
  feedback: Lightbulb,
} as const;

const EXAM_MANEUVERS = [
  { id: "inspection", nameEn: "Inspection", nameAr: "الفحص البصري" },
  { id: "palpation", nameEn: "Palpation", nameAr: "الجس" },
  { id: "percussion", nameEn: "Percussion", nameAr: "النقر" },
  { id: "auscultation", nameEn: "Auscultation", nameAr: "الاستماع" },
] as const;

type ExamManeuverMeta = {
  id: (typeof EXAM_MANEUVERS)[number]["id"];
  nameEn: string;
  nameAr: string;
};

const STATION_SECONDS = 20 * 60;

const DEFAULT_MANEUVER_IMAGES: Record<string, string> = {
  inspection: chestInspectionImg,
  palpation: chestPalpationImg,
  percussion: chestPercussionImg,
  auscultation: chestAuscultationImg,
};

function resolveExamImageUrl(maneuverId: string, url: string): string {
  if (url.startsWith('/exam/cases/')) return url;
  if (/\.(png|jpe?g|webp|gif|mp4|webm|mpeg|mp3|ogg|wav)(\?|#|$)/i.test(url)) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return DEFAULT_MANEUVER_IMAGES[maneuverId] || url;
}

function inferMediaType(item: ExamImage): 'image' | 'video' | 'audio' {
  if (item.mediaType) return item.mediaType;
  const lower = item.url.toLowerCase();
  if (/\.(mp4|webm)(\?|#|$)/.test(lower)) return 'video';
  if (/\.(mpeg|mp3|ogg|wav)(\?|#|$)/.test(lower)) return 'audio';
  return 'image';
}

const maneuverStage = (id: string) => `examination:${id}`;
const HISTORY_EXAMINER_STAGE = "history:examiner";

function getNextManeuver(
  completed: string[],
  maneuvers: readonly { id: string }[] = EXAM_MANEUVERS,
): string | null {
  const next = maneuvers.find((m) => !completed.includes(m.id));
  return next?.id ?? null;
}

function parseJsonArray<T>(raw: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function ChatTypingIndicator({ label }: { label: string }) {
  return (
    <div className="flex justify-start">
      <div className="px-4 py-3 rounded-2xl rounded-bl-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-1.5">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">
          {label}
        </p>
      </div>
    </div>
  );
}

export default function SimulationPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const isAr = i18n.language.startsWith("ar");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [activeStage, setActiveStage] = useState("history");
  const [activeManeuver, setActiveManeuver] = useState<string | null>(null);
  const [completedManeuvers, setCompletedManeuvers] = useState<string[]>([]);
  const [showExaminerPanel, setShowExaminerPanel] = useState(false);
  const [input, setInput] = useState("");
  const [lang, setLang] = useState<"AUTO" | "AR" | "EN">("AR");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(STATION_SECONDS);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [rankProgress, setRankProgress] = useState<RankSnapshot | null>(null);
  const [promotionModal, setPromotionModal] = useState<RankSnapshot | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState("");
  const [vivaActive, setVivaActive] = useState(false);
  const [micError, setMicError] = useState('');
  const [exitPrompt, setExitPrompt] = useState<'navigation' | 'refresh' | null>(null);
  const [exiting, setExiting] = useState(false);
  const autoCompleteTriggeredRef = useRef(false);
  const refreshPromptCheckedRef = useRef(false);
  /** When false, mic interim/complete must not refill the chat input (e.g. after Send). */
  const acceptMicInputRef = useRef(true);
  const forceReleaseMicRef = useRef<() => void>(() => {});
  const stopListeningRef = useRef<() => void>(() => {});

  const sessionLocked = !!result || completing || secondsLeft <= 0;

  const stationConfig = useMemo(
    () => getSessionStationConfig(session ?? { case: { stationConfig: '{}' } }),
    [session],
  );
  const visibleStages = useMemo(
    () => getSimulationStages(stationConfig),
    [stationConfig],
  );
  const caseManeuvers = useMemo(
    () =>
      EXAM_MANEUVERS.filter((m) => stationConfig.enabledManeuvers.includes(m.id)).map((m) => ({
        ...m,
        nameEn: resolveManeuverLabel(m.id, stationConfig, 'en'),
        nameAr: resolveManeuverLabel(m.id, stationConfig, 'ar'),
      })),
    [stationConfig],
  );
  const enableHistoryExaminer = stationConfig.enableHistoryExaminer;

  const voiceCallContext =
    activeStage === 'history' && !showExaminerPanel
      ? 'patient'
      : activeStage === 'history' && showExaminerPanel && enableHistoryExaminer
        ? 'examiner'
        : activeStage === 'examination' || activeStage === 'diagnosis'
          ? 'examiner'
          : null;

  // Always honor the speech-language toggle for mic + live call STT.
  // Previously patient context hardcoded ar-EG/AR, so EN speech was transcribed as Arabic letters.
  const listenLang =
    lang === 'EN'
      ? 'en-US'
      : lang === 'AR'
        ? 'ar-EG'
        : // AUTO: patient stages prefer Arabic; examiner / examination prefer English
          voiceCallContext === 'examiner' ||
            activeStage === 'examination' ||
            activeStage === 'diagnosis' ||
            (activeStage === 'history' && showExaminerPanel)
            ? 'en-US'
            : 'ar-EG';
  const speakLang = listenLang;

  const sendMessage = useCallback(
    async (overrideText?: string): Promise<{ success: boolean; reply?: string }> => {
      const text = (overrideText ?? input).trim();
      if (!text || sending || sessionLocked) return { success: false };
      // Stop mic and ignore late transcripts so voice text cannot reappear after Send.
      acceptMicInputRef.current = false;
      forceReleaseMicRef.current();
      stopListeningRef.current();
      setSending(true);
      setChatError("");
      setInput("");

      const isExamViva = activeStage === "examination" && activeManeuver;
      const endpoint =
        isExamViva || activeStage === "diagnosis" || (showExaminerPanel && enableHistoryExaminer)
          ? "examiner"
          : "chat";
      const stage = isExamViva
        ? maneuverStage(activeManeuver!)
        : activeStage === "history" && showExaminerPanel && enableHistoryExaminer
          ? HISTORY_EXAMINER_STAGE
          : activeStage;

      const studentMsg: Message = {
        id: `tmp-${Date.now()}`,
        role: "STUDENT",
        content: text,
        stage,
        createdAt: new Date().toISOString(),
      };
      setSession((prev) =>
        prev ? { ...prev, messages: [...prev.messages, studentMsg] } : prev,
      );

      try {
        const res = await api.post(`/sessions/${sessionId}/${endpoint}`, {
          message: text,
          stage,
          ...(isExamViva ? { maneuverId: activeManeuver } : {}),
        });
        setSession((prev) => {
          if (!prev) return prev;
          const base = prev.messages.filter((m) => m.id !== studentMsg.id);
          const next = [...base, studentMsg];
          if (!next.some((m) => m.id === res.data.message.id)) {
            next.push(res.data.message);
          }
          return { ...prev, messages: next };
        });
        return {
          success: true,
          reply:
            res.data.message.role === 'PATIENT' || res.data.message.role === 'EXAMINER'
              ? res.data.message.content
              : undefined,
        };
      } catch (err) {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.filter((m) => m.id !== studentMsg.id),
              }
            : prev,
        );
        if (!overrideText) setInput(text);
        if (!axios.isAxiosError(err) || !err.response) {
          setChatError(t("chatErrorOffline"));
        } else {
          setChatError(String(err.response.data?.error || t("chatError")));
        }
        return { success: false };
      } finally {
        setSending(false);
      }
    },
    [
      input,
      sending,
      activeStage,
      activeManeuver,
      showExaminerPanel,
      sessionId,
      t,
      sessionLocked,
      enableHistoryExaminer,
    ],
  );

  const getVoiceTurnMeta = useCallback(() => {
    const isExamViva = activeStage === 'examination' && activeManeuver;
    const endpoint =
      isExamViva || activeStage === 'diagnosis' || (showExaminerPanel && enableHistoryExaminer)
        ? 'examiner'
        : 'chat';
    const stage = isExamViva
      ? maneuverStage(activeManeuver!)
      : activeStage === 'history' && showExaminerPanel && enableHistoryExaminer
        ? HISTORY_EXAMINER_STAGE
        : activeStage;
    return {
      endpoint: endpoint as 'chat' | 'examiner',
      stage,
      maneuverId: isExamViva ? activeManeuver! : undefined,
    };
  }, [activeStage, activeManeuver, showExaminerPanel, enableHistoryExaminer]);

  // Mic + live-call STT must follow the same language the student selected (AUTO / AR / EN).
  const micSpeechLang = listenLang;
  const micSessionLang = lang;

  const { isListening, isProcessing, isSupported: isMicSupported, toggleListening, stopListening, forceReleaseMic } = useSpeechInput({
    lang: micSpeechLang,
    sessionLang: micSessionLang,
    onInterim: (text) => {
      if (!acceptMicInputRef.current) return;
      setMicError('');
      if (text.trim()) setInput(text);
    },
    onComplete: (transcript) => {
      if (!acceptMicInputRef.current) return;
      setMicError('');
      setInput(transcript.trim());
    },
    onError: (code) => {
      if (acceptMicInputRef.current) setInput('');
      if (code === 'not-supported') setMicError(t('micNotSupported'));
      else if (code === 'not-allowed') setMicError(t('micPermissionDenied'));
      else if (code === 'no-speech') setMicError(t('micNoSpeech'));
      else if (code === 'micArabicFailed') setMicError(t('micArabicFailed'));
      else if (code === 'network') setMicError(t('micNetworkError'));
      else if (code === 'audio-capture') setMicError(t('micCaptureError'));
      else if (code === 'start-failed') setMicError(t('micStartFailed'));
      else if (code === 'transcription-failed') setMicError(t('micTranscriptionFailed'));
      else if (code === 'transcription-unavailable') setMicError(t('micTranscriptionUnavailable'));
      else setMicError(t('micError'));
    },
  });

  forceReleaseMicRef.current = forceReleaseMic;
  stopListeningRef.current = stopListening;

  const appendVoiceTurnMessages = useCallback((result: VoiceTurnResponse) => {
    setMicError('');
    setSession((prev) => {
      if (!prev) return prev;
      const studentMsg: Message = {
        ...result.studentMessage,
        role: result.studentMessage.role as Message['role'],
      };
      const replyMsg: Message = {
        ...result.replyMessage,
        role: result.replyMessage.role as Message['role'],
      };
      return {
        ...prev,
        messages: [...prev.messages, studentMsg, replyMsg],
      };
    });
  }, []);

  const handleLiveCallError = useCallback(
    (code: string) => {
      if (code === 'not-supported') setMicError(t('liveCallNotSupported'));
      else if (code === 'not-allowed') setMicError(t('micPermissionDenied'));
      else if (code === 'no-speech') setMicError('');
      else if (code === 'network') setMicError(t('micNetworkError'));
      else if (code === 'audio-capture') setMicError(t('micCaptureError'));
      else if (code === 'start-failed') setMicError(t('micStartFailed'));
      else if (code === 'transcription-failed') setMicError(t('micTranscriptionFailed'));
      else if (code === 'transcription-unavailable') setMicError(t('micTranscriptionUnavailable'));
      else if (code === 'transcription-auth-failed') setMicError(t('micTranscriptionAuthFailed'));
      else if (code === 'transcription-quota-exceeded') setMicError(t('micTranscriptionQuotaExceeded'));
      else if (code === 'tts-failed') setMicError(t('ttsPlaybackFailed'));
      else setMicError(t('micError'));
    },
    [t],
  );

  const patientLiveCall = useLiveVoiceCall({
    listenLang,
    speakLang,
    sessionLang: micSessionLang,
    sendMessage,
    // Student can speak / live-call; AI replies are text-only (no TTS).
    speakReplies: false,
    voiceTurn: sessionId
      ? {
          sessionId,
          getRequestMeta: getVoiceTurnMeta,
          onTurn: appendVoiceTurnMessages,
        }
      : undefined,
    disabled: voiceCallContext !== 'patient' || sessionLocked,
    onError: handleLiveCallError,
  });

  const examinerLiveCall = useLiveVoiceCall({
    listenLang,
    speakLang,
    sessionLang: micSessionLang,
    sendMessage,
    // Student can speak / live-call; AI replies are text-only (no TTS).
    speakReplies: false,
    voiceTurn: sessionId
      ? {
          sessionId,
          getRequestMeta: getVoiceTurnMeta,
          onTurn: appendVoiceTurnMessages,
        }
      : undefined,
    disabled: voiceCallContext !== 'examiner' || sessionLocked,
    onError: handleLiveCallError,
  });

  const isPatientLiveCall = voiceCallContext === 'patient';
  const activeLiveCall = isPatientLiveCall ? patientLiveCall : examinerLiveCall;

  useEffect(() => {
    if (!voiceCallContext) {
      patientLiveCall.stopCall();
      examinerLiveCall.stopCall();
      stopListening();
    }
  }, [voiceCallContext, patientLiveCall.stopCall, examinerLiveCall.stopCall, stopListening]);

  useEffect(() => {
    // Language toggle must never leave STT running or auto-accept phantom results.
    acceptMicInputRef.current = false;
    setInput('');
    setMicError('');
    if (patientLiveCall.isLiveCall) patientLiveCall.stopCall();
    if (examinerLiveCall.isLiveCall) examinerLiveCall.stopCall();
    stopListening();
    forceReleaseMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenLang]);

  const toggleMic = useCallback(() => {
    setMicError('');
    patientLiveCall.stopCall();
    examinerLiveCall.stopCall();
    stopSpeaking();
    void unlockMobileAudio();
    // Starting a new recording may refill the input; allow mic text again.
    if (!isListening && !isProcessing) {
      acceptMicInputRef.current = true;
      forceReleaseMic();
    }
    toggleListening();
  }, [
    examinerLiveCall,
    forceReleaseMic,
    isListening,
    isProcessing,
    patientLiveCall,
    toggleListening,
  ]);

  const toggleLiveCall = useCallback(() => {
    setMicError('');
    if (isPatientLiveCall) {
      if (patientLiveCall.isLiveCall) {
        patientLiveCall.stopCall();
        return;
      }
      forceReleaseMic();
      stopListening();
      examinerLiveCall.stopCall();
      setInput('');
      window.setTimeout(() => patientLiveCall.toggleLiveCall(), IS_MOBILE ? 650 : 300);
      return;
    }
    if (examinerLiveCall.isLiveCall) {
      examinerLiveCall.stopCall();
      return;
    }
    forceReleaseMic();
    stopListening();
    patientLiveCall.stopCall();
    setInput('');
    window.setTimeout(() => examinerLiveCall.toggleLiveCall(), IS_MOBILE ? 650 : 300);
  }, [
    isPatientLiveCall,
    patientLiveCall,
    examinerLiveCall,
    forceReleaseMic,
    stopListening,
  ]);

  const liveCallInputProps = {
    isLiveCall: activeLiveCall.isLiveCall,
    isLiveCallBusy: activeLiveCall.isBusy,
    isLiveCallMicListening: activeLiveCall.isMicListening,
    isLiveCallSpeaking: activeLiveCall.isSpeaking,
    isLiveCallSupported: activeLiveCall.isSupported,
    onToggleLiveCall: voiceCallContext ? toggleLiveCall : undefined,
    liveCallLabel: t('liveCall'),
    endLiveCallLabel: t('endLiveCall'),
  };

  const loadSession = useCallback(async () => {
    const res = await api.get(`/sessions/${sessionId}`);
    const s = res.data.session as Session;
    setSession(s);
    const sessionLang = (s.language || 'AUTO').toUpperCase();
    if (sessionLang === 'AR' || sessionLang === 'EN' || sessionLang === 'AUTO') {
      setLang(sessionLang);
    }
    setActiveManeuver(s.activeManeuver);
    setCompletedManeuvers(parseJsonArray(s.completedManeuvers, []));
    if (s.result) {
      setResult(s.result);
      setRankProgress(parseRankSnapshot(s.result.xpRankSnapshot));
      setActiveStage("feedback");
    } else {
      setActiveStage(s.currentStage || "history");
    }
  }, [sessionId]);

  const updateSpeechLanguage = useCallback(
    async (next: "AUTO" | "AR" | "EN") => {
      setLang(next);
      if (!sessionId) return;
      try {
        await api.patch(`/sessions/${sessionId}/language`, { language: next });
        setSession((prev) => (prev ? { ...prev, language: next } : prev));
      } catch {
        // Keep UI selection even if persist fails — STT still uses local lang.
      }
    },
    [sessionId],
  );

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const initExaminerViva = useCallback(async () => {
    if (!sessionId) return;
    setSending(true);
    setChatError("");
    try {
      const res = await api.post(`/sessions/${sessionId}/examiner-viva/init`);
      setSession((prev) => {
        if (!prev) return prev;
        if (prev.messages.some((m) => m.id === res.data.message.id)) return prev;
        return { ...prev, messages: [...prev.messages, res.data.message] };
      });
    } catch {
      setChatError(t("completeSessionError"));
    } finally {
      setSending(false);
    }
  }, [sessionId, t]);

  useEffect(() => {
    if (!enableHistoryExaminer && showExaminerPanel) {
      setShowExaminerPanel(false);
    }
  }, [enableHistoryExaminer, showExaminerPanel]);

  useEffect(() => {
    if (!showExaminerPanel || !session || !enableHistoryExaminer) return;
    const hasOpening = session.messages.some(
      (m) => m.stage === HISTORY_EXAMINER_STAGE && m.role === "EXAMINER",
    );
    if (!hasOpening) void initExaminerViva();
  }, [showExaminerPanel, session, initExaminerViva, enableHistoryExaminer]);

  const examInProgress = !!session && !result;

  useEffect(() => {
    if (!session || result || refreshPromptCheckedRef.current) return;
    refreshPromptCheckedRef.current = true;
    if ((location.state as { fromCaseStart?: boolean } | null)?.fromCaseStart) return;
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav?.type === 'reload' && session.status !== 'COMPLETED') {
      setExitPrompt('refresh');
    }
  }, [session, result, location.state]);

  useEffect(() => {
    if (!examInProgress) return;

    window.history.pushState({ synozaExamGuard: true }, "");

    const onPopState = () => {
      window.history.pushState({ synozaExamGuard: true }, "");
      setExitPrompt('navigation');
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [examInProgress]);

  const requestExit = useCallback(() => {
    if (!examInProgress) {
      navigate("/student");
      return;
    }
    setExitPrompt('navigation');
  }, [examInProgress, navigate]);

  const cancelExit = useCallback(() => {
    setExitPrompt(null);
  }, []);

  const confirmExit = useCallback(async () => {
    setExiting(true);
    patientLiveCall.stopCall();
    examinerLiveCall.stopCall();
    stopListening();
    try {
      await api.post(`/sessions/${sessionId}/abandon`);
    } catch {
      /* leave even if abandon fails */
    }
    setExiting(false);
    setExitPrompt(null);
    dispatchEntitlementsChanged();
    navigate("/student");
  }, [navigate, patientLiveCall, examinerLiveCall, sessionId, stopListening]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
      .toString()
      .padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  let vitals: VitalSigns = {};
  let examImages: ExamImage[] = [];
  try {
    if (session) {
      vitals = JSON.parse(session.case.vitalSigns);
      examImages = parseJsonArray(session.case.examImages, []);
    }
  } catch {
    /* empty */
  }

  const startManeuver = async (maneuverId: string) => {
    if (maneuverId === activeManeuver || sessionLocked) return;
    setSending(true);
    try {
      const res = await api.post(`/sessions/${sessionId}/maneuver/start`, {
        maneuverId,
      });
      setActiveManeuver(maneuverId);
      setVivaActive(true);
      setActiveStage("examination");
      setSession((prev) =>
        prev
          ? {
              ...prev,
              activeManeuver: maneuverId,
              currentStage: "examination",
              messages: prev.messages.some((m) => m.id === res.data.message.id)
                ? prev.messages
                : [...prev.messages, res.data.message],
            }
          : prev,
      );
    } finally {
      setSending(false);
    }
  };

  const completeManeuver = async () => {
    if (!activeManeuver) return;
    const currentIndex = caseManeuvers.findIndex((m) => m.id === activeManeuver);
    setSending(true);
    try {
      const res = await api.post(`/sessions/${sessionId}/maneuver/complete`, {
        maneuverId: activeManeuver,
      });
      const updatedCompleted = res.data.completedManeuvers as string[];
      setCompletedManeuvers(updatedCompleted);
      setVivaActive(false);

      const next = caseManeuvers[currentIndex + 1];
      if (next) {
        await startManeuver(next.id);
      } else {
        setActiveManeuver(null);
        setSession((prev) =>
          prev
            ? {
                ...prev,
                activeManeuver: null,
                completedManeuvers: JSON.stringify(updatedCompleted),
              }
            : prev,
        );
        changeStage(getNextMainStageAfter('examination', stationConfig));
      }
    } finally {
      setSending(false);
    }
  };

  const changeStage = (stage: string) => {
    if (sessionLocked && stage !== "feedback") return;
    setActiveStage(stage);
    api.patch(`/sessions/${sessionId}/stage`, { stage });
    if (stage === "feedback" && session?.result) {
      setResult(session.result);
    }
    if (stage === "examination" && !activeManeuver) {
      const next = getNextManeuver(completedManeuvers, caseManeuvers);
      if (next) startManeuver(next);
    }
  };

  useEffect(() => {
    if (!session || result || activeStage !== "examination" || activeManeuver || sending) return;
    if (completedManeuvers.length >= caseManeuvers.length) return;
    const next = getNextManeuver(completedManeuvers, caseManeuvers);
    if (next) void startManeuver(next);
  }, [session, result, activeStage, activeManeuver, completedManeuvers, sending, caseManeuvers]);

  useEffect(() => {
    if (!sessionLocked) return;
    patientLiveCall.stopCall();
    examinerLiveCall.stopCall();
    stopListening();
  }, [sessionLocked, patientLiveCall, examinerLiveCall, stopListening]);

  const completeSession = useCallback(async (options?: { timedOut?: boolean }) => {
    setCompleting(true);
    setCompleteError("");
    const evaluationLanguage = 'EN';
    try {
      const res = await api.post(`/sessions/${sessionId}/complete`, {
        language: evaluationLanguage,
        ...(options?.timedOut ? { timedOut: true } : {}),
      });
      setResult(res.data.result);
      const progress = parseRankSnapshot(res.data.rankProgress ?? res.data.result?.xpRankSnapshot);
      setRankProgress(progress);
      if (progress?.promoted) setPromotionModal(progress);
      dispatchEntitlementsChanged();
      setSession((prev) =>
        prev ? { ...prev, result: res.data.result, status: "COMPLETED" } : prev,
      );
      setActiveStage("feedback");
    } catch (err) {
      autoCompleteTriggeredRef.current = false;
      if (!axios.isAxiosError(err) || !err.response) {
        setCompleteError(t("chatErrorOffline"));
      } else {
        setCompleteError(String(err.response.data?.error || t("completeSessionError")));
      }
    } finally {
      setCompleting(false);
    }
  }, [sessionId, t]);

  const triggerTimeUpComplete = useCallback(() => {
    if (autoCompleteTriggeredRef.current) return;
    autoCompleteTriggeredRef.current = true;
    void completeSession({ timedOut: true });
  }, [completeSession]);

  useEffect(() => {
    if (!session?.startedAt || result) return;
    const startedAtMs = new Date(session.startedAt).getTime();
    const updateTimer = () => {
      const elapsed = Math.floor((Date.now() - startedAtMs) / 1000);
      const remaining = Math.max(0, STATION_SECONDS - elapsed);
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        triggerTimeUpComplete();
      }
    };
    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [session?.startedAt, result, triggerTimeUpComplete]);

  useEffect(() => {
    if (!session || result || completing) return;
    if (secondsLeft > 0) return;
    triggerTimeUpComplete();
  }, [session, result, completing, secondsLeft, triggerTimeUpComplete]);

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const historyPatientMessages = session.messages.filter(
    (m) =>
      m.stage === "history" && (m.role === "STUDENT" || m.role === "PATIENT"),
  );

  const historyExaminerMessages = session.messages.filter(
    (m) =>
      m.stage === HISTORY_EXAMINER_STAGE &&
      (m.role === "STUDENT" || m.role === "EXAMINER"),
  );

  const activeHistoryMessages = showExaminerPanel && enableHistoryExaminer
    ? historyExaminerMessages
    : historyPatientMessages;

  const examinerVivaComplete = historyExaminerMessages.some(
    (m) => m.role === "EXAMINER" && isVivaClosingMessage(m.content),
  );

  const maneuverMessages = activeManeuver
    ? session.messages.filter(
        (m) =>
          m.stage === maneuverStage(activeManeuver) &&
          (m.role === "STUDENT" || m.role === "EXAMINER"),
      )
    : [];

  const diagnosisMessages = session.messages.filter(
    (m) =>
      m.stage === "diagnosis" &&
      (m.role === "STUDENT" || m.role === "EXAMINER"),
  );

  const activeManeuverMeta = caseManeuvers.find(
    (m) => m.id === activeManeuver,
  );

  const feedbackResult = result ?? session.result ?? null;

  return (
    <div className="h-dvh overflow-hidden bg-slate-100 dark:bg-slate-950 flex flex-col">
      <ConfirmDialog
        open={exitPrompt !== null}
        title={exitPrompt === 'refresh' ? t("refreshExamTitle") : t("exitExamTitle")}
        message={exitPrompt === 'refresh' ? t("refreshExamMessage") : t("exitExamMessage")}
        confirmLabel={t("leaveExam")}
        cancelLabel={t("stayInExam")}
        confirming={exiting}
        variant="danger"
        onConfirm={() => void confirmExit()}
        onCancel={cancelExit}
      />
      <RankPromotionModal
        rankProgress={promotionModal}
        isAr={isAr}
        onClose={() => setPromotionModal(null)}
      />
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 py-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={requestExit}
              className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label={t("back")}
            >
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Synoza OSCE
            </p>
            <p className="text-sm font-semibold text-slate-800 dark:text-white truncate">
              {isAr ? session.case.titleAr : session.case.titleEn}
            </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ConnectionStatus />
            {enableHistoryExaminer && (
            <button
              onClick={() => setShowExaminerPanel((v) => !v)}
              className={`hidden sm:block text-xs font-bold px-3 py-1.5 rounded border ${
                showExaminerPanel
                  ? "bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200"
                  : "border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300"
              }`}
            >
              {t("viewExaminer")}
            </button>
            )}
            <div
              className={`px-3 py-1 rounded font-mono text-sm font-bold ${secondsLeft < 120 ? "bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300" : "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200"}`}
            >
              {formatTime(secondsLeft)}
            </div>
            <button
              onClick={requestExit}
              className="bg-red-500 text-white px-3 py-1.5 rounded text-xs font-bold hover:bg-red-600"
            >
              {t("quit")}
            </button>
          </div>
        </div>

        {/* Stage tabs */}
        <div className="flex gap-0 mt-2 -mb-px overflow-x-auto">
          {visibleStages.map((stage) => {
            const Icon = STAGE_ICONS[stage];
            return (
              <button
                key={stage}
                onClick={() => changeStage(stage)}
                disabled={sessionLocked && stage !== "feedback"}
                className={`flex items-center gap-1.5 px-5 py-2.5 text-sm border-b-2 whitespace-nowrap transition-colors disabled:opacity-40 disabled:pointer-events-none ${
                  activeStage === stage
                    ? "border-primary text-primary font-semibold bg-primary/5"
                    : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                }`}
              >
                <Icon size={15} /> {t(stage)}
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <aside className="w-64 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 hidden md:flex flex-col shrink-0">
          {activeStage === "examination" ? (
            <div className="p-4 flex-1 overflow-y-auto">
              <div className="flex items-center gap-2 mb-1">
                <Stethoscope size={18} className="text-primary" />
                <h2 className="font-bold text-sm text-slate-800 dark:text-white">
                  {t("physicalExam")}
                </h2>
              </div>
              <p className="text-xs text-slate-500 mb-4">
                {t("physicalExamDesc")}
              </p>
              <div className="space-y-2 mb-4">
                {caseManeuvers.map((m) => {
                  const active = activeManeuver === m.id;
                  const done = completedManeuvers.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      disabled={sending || active}
                      onClick={() => !sending && !active && startManeuver(m.id)}
                      className={`w-full text-left px-3 py-3 rounded-lg border text-sm transition-all ${
                        active
                          ? "border-primary bg-primary text-white shadow-md"
                          : done
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                            : "border-slate-200 dark:border-slate-700 hover:border-primary/50 text-slate-700 dark:text-slate-200"
                      }`}
                    >
                      <p className="font-semibold">
                        {isAr ? m.nameAr : m.nameEn}
                      </p>
                      <p
                        className={`text-[10px] mt-0.5 ${active ? "text-white/80" : ""}`}
                      >
                        {active
                          ? t("activeViva")
                          : done
                            ? t("completed")
                            : t("clickToStart")}
                      </p>
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-slate-200 dark:border-slate-800 pt-4">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase mb-2">
                  {t("vitalSigns")}
                </h3>
                <div className="grid grid-cols-2 gap-1.5">
                  {(["bp", "hr", "temp", "spo2"] as const).map((key) => {
                    const v = vitals[key];
                    return (
                      <div
                        key={key}
                        className="border border-slate-200 dark:border-slate-700 rounded p-2 bg-slate-50 dark:bg-slate-800"
                      >
                        <p className="text-[9px] font-bold text-slate-400 uppercase">
                          {key}
                        </p>
                        <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                          {v?.value || "—"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-4 flex-1 overflow-y-auto">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-11 h-11 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
                  <UserCircle size={28} className="text-slate-400" />
                </div>
                <div>
                  <p className="font-semibold text-sm text-slate-900 dark:text-white">
                    {session.case.patientName}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {session.case.patientAge} {isAr ? "سنة" : "yo"} ·{" "}
                    {session.case.patientGender}
                  </p>
                </div>
              </div>
              <h3 className="text-[10px] font-bold text-slate-400 uppercase mb-2">
                {t("vitalSigns")}
              </h3>
              <div className="grid grid-cols-2 gap-1.5 mb-4">
                {(["bp", "hr", "temp", "spo2"] as const).map((key) => {
                  const v = vitals[key];
                  return (
                    <div
                      key={key}
                      className="border border-slate-200 dark:border-slate-700 rounded p-2 bg-slate-50 dark:bg-slate-800"
                    >
                      <p className="text-[9px] font-bold text-slate-400 uppercase">
                        {key}
                      </p>
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                        {v?.value || "—"}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col overflow-hidden bg-slate-100 dark:bg-slate-950 relative">
          {completeError && !result && secondsLeft <= 0 && !completing && (
            <div className="shrink-0 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900 px-4 py-2 flex items-center justify-between gap-3">
              <p className="text-sm text-red-700 dark:text-red-300">{completeError}</p>
              <button
                type="button"
                onClick={() => void completeSession()}
                className="text-xs font-bold text-red-700 dark:text-red-300 underline shrink-0"
              >
                {t("completeSession")}
              </button>
            </div>
          )}
          {completing && (
            <div className="absolute inset-0 z-20 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center">
              <div className="card p-8 text-center max-w-sm mx-4">
                <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                <p className="font-semibold text-slate-900 dark:text-white">{t("generatingFeedback")}</p>
                <p className="text-sm text-slate-500 mt-2">{t("feedbackGeneratedFromChat")}</p>
              </div>
            </div>
          )}
          {activeStage === "feedback" ? (
            feedbackResult ? (
              <div className="flex-1 overflow-y-auto p-4">
                <FeedbackView
                  result={feedbackResult}
                  rankProgress={rankProgress}
                  t={t}
                  session={session}
                  isAr={isAr}
                  onRegenerate={completeSession}
                  regenerating={completing}
                />
              </div>
            ) : (
              <FeedbackPendingView
                t={t}
                completing={completing}
                onGoToDiagnosis={() => changeStage("diagnosis")}
                onGenerate={() => void completeSession()}
              />
            )
          ) : activeStage === "examination" ? (
            <>
              <ExaminationStepsBar
                isAr={isAr}
                t={t}
                activeManeuver={activeManeuver}
                completedManeuvers={completedManeuvers}
                onStartManeuver={startManeuver}
                sending={sending}
                caseManeuvers={caseManeuvers}
              />
              <ExaminationView
                session={session}
                isAr={isAr}
                t={t}
                activeManeuver={activeManeuver}
                activeManeuverMeta={activeManeuverMeta}
                vivaActive={vivaActive}
                examImages={examImages}
                messages={maneuverMessages}
                input={input}
                setInput={setInput}
                sendMessage={sendMessage}
                sending={sending}
                chatError={chatError}
                completeManeuver={completeManeuver}
                chatEndRef={chatEndRef}
                lang={lang}
                setLang={updateSpeechLanguage}
                isListening={isListening}
                isProcessing={isProcessing}
                isMicSupported={isMicSupported}
                onToggleMic={toggleMic}
                micError={micError}
                completedManeuvers={completedManeuvers}
                onStartManeuver={startManeuver}
                caseManeuvers={caseManeuvers}
                sessionLocked={sessionLocked}
                {...liveCallInputProps}
              />
            </>
          ) : activeStage === "investigations" ? (
            <InvestigationsView
              t={t}
              isAr={isAr}
              labResults={session.case.labResults}
            />
          ) : activeStage === "diagnosis" ? (
            <DiagnosisView
              t={t}
              messages={diagnosisMessages}
              input={input}
              setInput={setInput}
              sendMessage={sendMessage}
              sending={sending}
              chatError={chatError}
              completeSession={completeSession}
              completing={completing}
              completeError={completeError}
              chatEndRef={chatEndRef}
              lang={lang}
              setLang={updateSpeechLanguage}
              isListening={isListening}
              isProcessing={isProcessing}
              isMicSupported={isMicSupported}
              onToggleMic={toggleMic}
              micError={micError}
              sessionLocked={sessionLocked}
              {...liveCallInputProps}
            />
          ) : (
            <HistoryChatView
              t={t}
              session={session}
              messages={activeHistoryMessages}
              input={input}
              setInput={setInput}
              sendMessage={sendMessage}
              sending={sending}
              chatError={chatError}
              chatEndRef={chatEndRef}
              lang={lang}
              setLang={updateSpeechLanguage}
              showExaminerPanel={showExaminerPanel}
              setShowExaminerPanel={setShowExaminerPanel}
              enableHistoryExaminer={enableHistoryExaminer}
              examinerVivaComplete={examinerVivaComplete}
              isListening={isListening}
              isProcessing={isProcessing}
              isMicSupported={isMicSupported}
              onToggleMic={toggleMic}
              micError={micError}
              sessionLocked={sessionLocked}
              {...liveCallInputProps}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function ExaminationStepsBar({
  isAr,
  t,
  activeManeuver,
  completedManeuvers,
  onStartManeuver,
  sending,
  caseManeuvers,
}: {
  isAr: boolean;
  t: (k: string, opts?: Record<string, unknown>) => string;
  activeManeuver: string | null;
  completedManeuvers: string[];
  onStartManeuver: (id: string) => void;
  sending: boolean;
  caseManeuvers: readonly ExamManeuverMeta[];
}) {
  return (
    <div className="md:hidden bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 py-2 shrink-0">
      <div className="flex gap-2 overflow-x-auto">
        {caseManeuvers.map((m) => {
          const active = activeManeuver === m.id;
          const done = completedManeuvers.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              disabled={sending || active}
              onClick={() => !sending && !active && onStartManeuver(m.id)}
              className={`shrink-0 px-3 py-2 rounded-lg border text-xs font-semibold transition-all ${
                active
                  ? "border-primary bg-primary text-white"
                  : done
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                    : "border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-primary/50"
              }`}
            >
              {isAr ? m.nameAr : m.nameEn}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ExaminationView({
  session,
  isAr,
  t,
  activeManeuver,
  activeManeuverMeta,
  vivaActive,
  examImages,
  messages,
  input,
  setInput,
  sendMessage,
  sending,
  chatError,
  completeManeuver,
  chatEndRef,
  lang,
  setLang,
  isListening,
  isProcessing,
  isMicSupported,
  onToggleMic,
  micError,
  completedManeuvers,
  onStartManeuver,
  caseManeuvers,
  isLiveCall,
  isLiveCallBusy,
  isLiveCallMicListening,
  isLiveCallSpeaking,
  isLiveCallSupported,
  onToggleLiveCall,
  liveCallLabel,
  endLiveCallLabel,
  sessionLocked = false,
}: {
  session: Session;
  isAr: boolean;
  t: (k: string, opts?: Record<string, unknown>) => string;
  activeManeuver: string | null;
  activeManeuverMeta?: ExamManeuverMeta;
  vivaActive: boolean;
  examImages: ExamImage[];
  messages: Message[];
  input: string;
  setInput: (v: string) => void;
  sendMessage: (text?: string) => Promise<{ success: boolean; reply?: string }>;
  sending: boolean;
  chatError: string;
  completeManeuver: () => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  lang: "AUTO" | "AR" | "EN";
  setLang: (l: "AUTO" | "AR" | "EN") => void;
  isListening: boolean;
  isProcessing: boolean;
  isMicSupported: boolean;
  onToggleMic: () => void;
  micError: string;
  completedManeuvers: string[];
  onStartManeuver: (id: string) => void;
  caseManeuvers: readonly ExamManeuverMeta[];
  isLiveCall?: boolean;
  isLiveCallBusy?: boolean;
  isLiveCallMicListening?: boolean;
  isLiveCallSpeaking?: boolean;
  isLiveCallSupported?: boolean;
  onToggleLiveCall?: () => void;
  liveCallLabel?: string;
  endLiveCallLabel?: string;
  sessionLocked?: boolean;
}) {
  const [galleryOpen, setGalleryOpen] = useState(false);

  if (!activeManeuver || !activeManeuverMeta) {
    const nextId = getNextManeuver(completedManeuvers, caseManeuvers);
    const nextMeta = caseManeuvers.find((m) => m.id === nextId);
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center text-slate-500">
        <div className="max-w-sm">
          {sending ? (
            <>
              <Loader2 size={40} className="mx-auto mb-3 animate-spin text-primary" />
              <p className="font-medium">{t("paymentProcessing")}</p>
            </>
          ) : nextMeta ? (
            <>
              <Eye size={48} className="mx-auto mb-3 text-slate-300" />
              <p className="font-medium">{t("continueToStep", { step: isAr ? nextMeta.nameAr : nextMeta.nameEn })}</p>
              <button
                type="button"
                onClick={() => onStartManeuver(nextMeta.id)}
                className="btn-primary mt-4 px-6 py-2.5 inline-flex items-center gap-2"
              >
                {isAr ? nextMeta.nameAr : nextMeta.nameEn}
                <ChevronRight size={16} />
              </button>
            </>
          ) : (
            <>
              <CheckCircle2 size={48} className="mx-auto mb-3 text-emerald-500" />
              <p className="font-medium">{t("examinationComplete")}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Station header — desktop only (saves vertical space on mobile) */}
      <div className="hidden md:flex shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-5 py-3 items-center justify-between">
        <div>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
            {activeManeuverMeta.nameEn} · {t("observationStation")}
          </p>
          <p className="text-sm font-bold text-slate-800 dark:text-white uppercase">
            {t("mustExaminerPanel")}
          </p>
        </div>
        {vivaActive && (
          <span className="text-[10px] font-bold uppercase px-3 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
            {t("oralCheckInProgress")}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-0 overflow-hidden">
        {/* Desktop clinical panel */}
        {activeManeuver && (
          <div className="hidden lg:block shrink-0 lg:w-[42%] lg:max-w-md lg:border-r border-slate-200 dark:border-slate-800 overflow-y-auto p-4">
            <ClinicalStationPanel
              maneuverId={activeManeuver}
              examImages={examImages}
              isAr={isAr}
              t={t}
            />
          </div>
        )}

        {/* Clinical examiner chat — takes all remaining mobile height */}
        <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-slate-900 border-t lg:border-t-0 border-slate-200 dark:border-slate-800">
          {/* Mobile collapsible gallery — collapsed by default so chat stays visible */}
          {activeManeuver && (
            <div className="lg:hidden shrink-0 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80">
              <button
                type="button"
                onClick={() => setGalleryOpen((open) => !open)}
                className="w-full px-3 py-2 flex items-center justify-between gap-2 text-left"
              >
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                  {t("patientSlideGallery")}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary shrink-0">
                  {galleryOpen ? t("hideClinicalImages") : t("showClinicalImages")}
                  {galleryOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </span>
              </button>
              {galleryOpen && (
                <div className="max-h-[22vh] overflow-y-auto overscroll-y-contain px-3 pb-3">
                  <ClinicalStationPanel
                    maneuverId={activeManeuver}
                    examImages={examImages}
                    isAr={isAr}
                    t={t}
                    compact
                  />
                </div>
              )}
            </div>
          )}

          <div className="shrink-0 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800">
            {/* Row 1: examiner identity + status */}
            <div className="px-3 pt-2 pb-1 flex items-start gap-2 min-w-0">
              <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                <Stethoscope size={16} className="text-amber-700" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold text-slate-400 uppercase leading-tight">
                  {t("clinicalExaminer")}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-300 truncate">
                  {activeManeuverMeta.nameEn}
                </p>
              </div>
              {vivaActive && (
                <span className="shrink-0 max-w-[42%] text-right text-[9px] font-bold uppercase leading-tight px-2 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                  {t("oralCheckInProgress")}
                </span>
              )}
            </div>

            {/* Row 2: speech + live call — never overlap */}
            <div className="px-3 pb-2 flex items-center justify-between gap-2 min-w-0">
              <SpeechLanguageToggle
                value={lang}
                onChange={setLang}
                disabled={sending || isLiveCall}
                compact
                labels={{
                  auto: t('speechLangAuto'),
                  ar: t('speechLangAr'),
                  en: t('speechLangEn'),
                }}
              />
              <LiveCallButton
                isLiveCall={isLiveCall}
                isLiveCallBusy={isLiveCallBusy}
                isLiveCallSupported={isLiveCallSupported}
                onToggleLiveCall={onToggleLiveCall}
                liveCallLabel={liveCallLabel}
                endLiveCallLabel={endLiveCallLabel}
                disabled={sending}
                compact
              />
            </div>

            {/* Row 3: complete step on mobile */}
            <div className="md:hidden px-3 pb-2 flex justify-end border-t border-slate-100 dark:border-slate-800 pt-2">
              <button
                type="button"
                onClick={completeManeuver}
                className="text-[11px] btn-secondary px-3 py-1.5 inline-flex items-center gap-1"
              >
                {t("completeStep")}
                <ChevronRight size={14} />
              </button>
            </div>
          </div>

          <ChatScrollArea
            endRef={chatEndRef}
            scrollDeps={[messages, sending, galleryOpen]}
            forceScroll={sending}
            empty={messages.length === 0}
            emptyContent={
              <p className="text-sm text-slate-400 text-center py-4">
                {t("examinerWillStart")}
              </p>
            }
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "STUDENT" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[92%] sm:max-w-[85%] px-3 py-2 sm:px-4 sm:py-2.5 rounded-2xl text-sm ${
                    msg.role === "STUDENT"
                      ? "bg-primary text-white rounded-br-sm"
                      : "bg-amber-50 border border-amber-100 text-amber-950 rounded-bl-sm"
                  }`}
                >
                  <span dir="auto">{msg.content}</span>
                </div>
              </div>
            ))}
            {sending && <ChatTypingIndicator label={t("examinerTyping")} />}
          </ChatScrollArea>

          <div className="shrink-0 border-t border-slate-100 dark:border-slate-800">
            <div className="hidden md:flex px-4 pt-3 justify-end">
              <button
                type="button"
                onClick={completeManeuver}
                className="text-xs btn-secondary"
              >
                {t("completeStep")}{" "}
                <ChevronRight size={14} className="inline" />
              </button>
            </div>
            {(isLiveCall || micError) && (
              <LiveCallMicStatus
                isLiveCall={isLiveCall}
                isBusy={isLiveCallBusy}
                isMicListening={isLiveCallMicListening}
                isSpeaking={isLiveCallSpeaking}
                error={isLiveCall ? micError : undefined}
              />
            )}
            <SimulationChatInput
              input={input}
              setInput={setInput}
              onSend={() => sendMessage()}
              sending={sending}
              placeholder={t("describeFindings")}
              chatError={chatError}
              isListening={isListening}
              isProcessing={isProcessing}
              isMicSupported={isMicSupported}
              onToggleMic={onToggleMic}
              micListeningLabel={t("micListening")}
              micNotSupportedLabel={t("micNotSupported")}
              micProcessingLabel={t("micProcessing")}
              micError={micError}
              disabled={sessionLocked}
              isLiveCall={isLiveCall}
              compact
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryChatView({
  t,
  session,
  messages,
  input,
  setInput,
  sendMessage,
  sending,
  chatError,
  chatEndRef,
  lang,
  setLang,
  showExaminerPanel,
  setShowExaminerPanel,
  enableHistoryExaminer,
  examinerVivaComplete,
  isListening,
  isProcessing,
  isMicSupported,
  onToggleMic,
  micError,
  isLiveCall,
  isLiveCallBusy,
  isLiveCallMicListening,
  isLiveCallSpeaking,
  isLiveCallSupported,
  onToggleLiveCall,
  liveCallLabel,
  endLiveCallLabel,
  sessionLocked = false,
}: {
  t: (k: string) => string;
  session: Session;
  messages: Message[];
  input: string;
  setInput: (v: string) => void;
  sendMessage: (text?: string) => Promise<{ success: boolean; reply?: string }>;
  sending: boolean;
  chatError: string;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  lang: "AUTO" | "AR" | "EN";
  setLang: (l: "AUTO" | "AR" | "EN") => void;
  showExaminerPanel: boolean;
  setShowExaminerPanel: (value: boolean) => void;
  enableHistoryExaminer: boolean;
  examinerVivaComplete: boolean;
  isListening: boolean;
  isProcessing: boolean;
  isMicSupported: boolean;
  onToggleMic: () => void;
  micError: string;
  isLiveCall?: boolean;
  isLiveCallBusy?: boolean;
  isLiveCallMicListening?: boolean;
  isLiveCallSpeaking?: boolean;
  isLiveCallSupported?: boolean;
  onToggleLiveCall?: () => void;
  liveCallLabel?: string;
  endLiveCallLabel?: string;
  sessionLocked?: boolean;
}) {
  const isExaminerChat = showExaminerPanel && enableHistoryExaminer;

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-3 sm:p-4 min-h-0">
      <div className={`grid gap-2 sm:gap-3 mb-2 sm:mb-4 shrink-0 ${enableHistoryExaminer ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <button
          type="button"
          disabled={sessionLocked}
          onClick={() => setShowExaminerPanel(false)}
          className={`flex items-center gap-2 sm:gap-3 p-2.5 sm:p-4 rounded-xl border-2 text-left transition-all min-w-0 ${
            !showExaminerPanel || !enableHistoryExaminer
              ? "bg-sky-50 dark:bg-sky-950/40 border-sky-300 dark:border-sky-600 shadow-sm"
              : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
          }`}
        >
          <div
            className={`w-8 h-8 sm:w-11 sm:h-11 rounded-full flex items-center justify-center shrink-0 ${
              !showExaminerPanel || !enableHistoryExaminer
                ? "bg-sky-500 text-white"
                : "bg-slate-100 dark:bg-slate-800 text-slate-400"
            }`}
          >
            <UserCircle className="w-4 h-4 sm:w-6 sm:h-6" />
          </div>
          <div className="min-w-0">
            <p
              className={`text-[9px] sm:text-[11px] font-bold uppercase tracking-wide sm:tracking-wider leading-tight ${
                !showExaminerPanel || !enableHistoryExaminer
                  ? "text-sky-700 dark:text-sky-300"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {t("patientEncounter")}
            </p>
            <p
              className={`text-xs sm:text-sm font-semibold truncate leading-tight mt-0.5 ${
                !showExaminerPanel || !enableHistoryExaminer
                  ? "text-sky-900 dark:text-sky-100"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              {session.case.patientName}
            </p>
          </div>
        </button>

        {enableHistoryExaminer && (
        <button
          type="button"
          disabled={sessionLocked}
          onClick={() => setShowExaminerPanel(true)}
          className={`flex items-center gap-2 sm:gap-3 p-2.5 sm:p-4 rounded-xl border-2 text-left transition-all min-w-0 ${
            showExaminerPanel
              ? "bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-600 shadow-sm"
              : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
          }`}
        >
          <div
            className={`w-8 h-8 sm:w-11 sm:h-11 rounded-full flex items-center justify-center shrink-0 ${
              showExaminerPanel
                ? "bg-amber-500 text-white"
                : "bg-slate-100 dark:bg-slate-800 text-slate-400"
            }`}
          >
            <Shield className="w-4 h-4 sm:w-[22px] sm:h-[22px]" />
          </div>
          <div className="min-w-0">
            <p
              className={`text-[9px] sm:text-[11px] font-bold uppercase tracking-wide sm:tracking-wider leading-tight ${
                showExaminerPanel
                  ? "text-amber-800 dark:text-amber-300"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {t("examinerBox")}
            </p>
            <p
              className={`text-xs sm:text-sm font-medium leading-tight mt-0.5 truncate ${
                showExaminerPanel
                  ? "text-amber-900 dark:text-amber-100"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              {t("vivaQuestions")}
            </p>
          </div>
        </button>
        )}
      </div>

      <div className="card flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="shrink-0 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800">
          <div className="px-3 py-2 sm:px-4 sm:py-3 flex items-center justify-between gap-2 sm:gap-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase min-w-0 truncate">
              {isExaminerChat
                ? t("examinerBox")
                : `${t("interviewLog")}: ${session.case.patientName}`}
            </h3>
            <div className="flex items-center gap-2 shrink-0">
              <SpeechLanguageToggle
                value={lang}
                onChange={setLang}
                disabled={sending || isLiveCall}
                labels={{
                  auto: t('speechLangAuto'),
                  ar: t('speechLangAr'),
                  en: t('speechLangEn'),
                }}
              />
              <LiveCallButton
                isLiveCall={isLiveCall}
                isLiveCallBusy={isLiveCallBusy}
                isLiveCallSupported={isLiveCallSupported}
                onToggleLiveCall={onToggleLiveCall}
                liveCallLabel={t("liveCall")}
                endLiveCallLabel={t("endLiveCall")}
                disabled={sending}
              />
            </div>
          </div>
        </div>

        <ChatScrollArea
          endRef={chatEndRef}
          scrollDeps={[messages, sending]}
          forceScroll={sending}
          empty={messages.length === 0}
          className="bg-white dark:bg-slate-900"
          emptyContent={
            isExaminerChat ? (
              <div className="flex flex-col items-center text-slate-400 dark:text-slate-500 py-8">
                <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
                  <Shield
                    size={32}
                    className="text-slate-300 dark:text-slate-500"
                  />
                </div>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {t("examinerBox")}
                </p>
                <p className="text-sm mt-1 text-center max-w-sm">
                  {t("startExaminerViva")}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center text-slate-400 dark:text-slate-500 py-8">
                <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
                  <UserCircle
                    size={32}
                    className="text-slate-300 dark:text-slate-500"
                  />
                </div>
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {t("simulatedInterview")}
                </p>
                <p className="text-sm mt-1 text-center max-w-sm">
                  {t("startInterview")}
                </p>
              </div>
            )
          }
        >
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "STUDENT" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[88%] sm:max-w-[80%] px-3 py-2 sm:px-4 sm:py-2.5 rounded-2xl text-xs sm:text-sm leading-snug ${
                  msg.role === "STUDENT"
                    ? "bg-primary text-white rounded-br-md"
                    : msg.role === "EXAMINER"
                      ? "bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100 rounded-bl-md"
                      : "bg-teal-50 dark:bg-slate-800 border border-teal-100 dark:border-slate-700 text-slate-800 dark:text-slate-100 rounded-bl-md"
                }`}
              >
                <span dir="auto">{msg.content}</span>
              </div>
            </div>
          ))}
          {sending && (
            <ChatTypingIndicator
              label={
                isExaminerChat ? t("examinerTyping") : t("patientTyping")
              }
            />
          )}
        </ChatScrollArea>

        <div className="shrink-0 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900">
          {(isLiveCall || micError) && (
            <LiveCallMicStatus
              isLiveCall={isLiveCall}
              isBusy={isLiveCallBusy}
              isMicListening={isLiveCallMicListening}
              isSpeaking={isLiveCallSpeaking}
              error={isLiveCall ? micError : undefined}
            />
          )}
          <SimulationChatInput
            input={input}
            setInput={setInput}
            onSend={() => sendMessage()}
            sending={sending}
            placeholder={isExaminerChat ? t("askExaminer") : t("askPatient")}
            chatError={chatError}
            isListening={isListening}
            isProcessing={isProcessing}
            isMicSupported={isMicSupported}
            onToggleMic={onToggleMic}
            micListeningLabel={t("micListening")}
            micNotSupportedLabel={t("micNotSupported")}
            micProcessingLabel={t("micProcessing")}
            micError={micError}
            disabled={sessionLocked || isLiveCall || (isExaminerChat && examinerVivaComplete)}
            isLiveCall={isLiveCall}
          />
        </div>
      </div>
    </div>
  );
}

function DiagnosisView({
  t,
  messages,
  input,
  setInput,
  sendMessage,
  sending,
  chatError,
  completeSession,
  completing,
  completeError,
  chatEndRef,
  lang,
  setLang,
  isListening,
  isProcessing,
  isMicSupported,
  onToggleMic,
  micError,
  isLiveCall,
  isLiveCallBusy,
  isLiveCallMicListening,
  isLiveCallSpeaking,
  isLiveCallSupported,
  onToggleLiveCall,
  liveCallLabel,
  endLiveCallLabel,
  sessionLocked = false,
}: {
  t: (k: string) => string;
  messages: Message[];
  input: string;
  setInput: (v: string) => void;
  sendMessage: (text?: string) => Promise<{ success: boolean; reply?: string }>;
  sending: boolean;
  chatError: string;
  completeSession: () => void | Promise<void>;
  completing: boolean;
  completeError: string;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  lang: "AUTO" | "AR" | "EN";
  setLang: (l: "AUTO" | "AR" | "EN") => void;
  isListening: boolean;
  isProcessing: boolean;
  isMicSupported: boolean;
  onToggleMic: () => void;
  micError: string;
  isLiveCall?: boolean;
  isLiveCallBusy?: boolean;
  isLiveCallMicListening?: boolean;
  isLiveCallSpeaking?: boolean;
  isLiveCallSupported?: boolean;
  onToggleLiveCall?: () => void;
  liveCallLabel?: string;
  endLiveCallLabel?: string;
  sessionLocked?: boolean;
}) {
  const [impression, setImpression] = useState("");
  const [management, setManagement] = useState("");

  const buildSubmission = () => {
    const parts: string[] = [];
    if (impression.trim()) {
      parts.push(`${t("diagnosticImpression")}:\n${impression.trim()}`);
    }
    if (management.trim()) {
      parts.push(`${t("initialManagement")}:\n${management.trim()}`);
    }
    return parts.join("\n\n");
  };

  const handleCompleteAndEvaluate = async () => {
    const text = buildSubmission();
    if (text) {
      const result = await sendMessage(text);
      if (!result.success) return;
      setImpression("");
      setManagement("");
    }
    await completeSession();
  };

  const handleLearnWithExaminer = async () => {
    const text = buildSubmission();
    if (!text) return;
    await sendMessage(`${text}\n\n${t("learnWithExaminerRequest")}`);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 md:py-10">
          <div className="flex justify-center mb-6">
            <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-primary/30 text-primary text-[11px] font-semibold tracking-wider uppercase bg-white dark:bg-slate-900 shadow-sm">
              <Stethoscope size={14} />
              {t("diagnosticFinalizationStation")}
            </span>
          </div>

          <h1 className="text-3xl md:text-4xl font-bold text-center text-slate-900 dark:text-white mb-3">
            {t("clinicalFormulation")}
          </h1>
          <p className="text-center text-slate-500 dark:text-slate-400 max-w-2xl mx-auto mb-10 text-sm md:text-base leading-relaxed">
            {t("clinicalFormulationDesc")}
          </p>

          <div className="grid md:grid-cols-2 gap-6 mb-8">
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800 p-6">
              <div className="flex items-center gap-2 mb-4 text-teal-600 dark:text-teal-400">
                <Search size={18} />
                <span className="text-xs font-bold tracking-wider uppercase">
                  {t("diagnosticImpression")}
                </span>
              </div>
              <textarea
                className="w-full min-h-[220px] rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 p-4 text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 resize-y focus:outline-none focus:ring-2 focus:ring-teal-500/30"
                placeholder={t("diagnosticImpressionPlaceholder")}
                value={impression}
                onChange={(e) => setImpression(e.target.value)}
                disabled={sending || sessionLocked}
              />
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800 p-6">
              <div className="flex items-center gap-2 mb-4 text-emerald-600 dark:text-emerald-400">
                <ClipboardCheck size={18} />
                <span className="text-xs font-bold tracking-wider uppercase">
                  {t("initialManagement")}
                </span>
              </div>
              <textarea
                className="w-full min-h-[220px] rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 p-4 text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 resize-y focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                placeholder={t("initialManagementPlaceholder")}
                value={management}
                onChange={(e) => setManagement(e.target.value)}
                disabled={sending || sessionLocked}
              />
            </div>
          </div>

          <div className="flex flex-col items-center gap-3 mb-6">
            {(chatError || completeError) && (
              <p className="text-sm text-red-500 text-center">{chatError || completeError}</p>
            )}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                onClick={() => void handleCompleteAndEvaluate()}
                disabled={completing || sending || sessionLocked}
                className="btn-primary px-8 min-w-[220px] flex items-center justify-center gap-2"
              >
                {completing || sending ? (
                  <>
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    {completing ? t("generatingFeedback") : t("examinerTyping")}
                  </>
                ) : (
                  t("completeSession")
                )}
              </button>
              <button
                onClick={() => void handleLearnWithExaminer()}
                disabled={
                  completing ||
                  sending ||
                  sessionLocked ||
                  (!impression.trim() && !management.trim())
                }
                className="btn-secondary px-6 min-w-[220px] flex items-center justify-center gap-2 disabled:opacity-50"
                title={t("learnWithExaminerHint")}
              >
                <GraduationCap size={18} />
                {t("learnWithExaminer")}
              </button>
            </div>
            <p className="text-xs text-slate-400 text-center max-w-md">
              {t("learnWithExaminerHint")}
            </p>
          </div>
        </div>
      </div>

      <div className="shrink-0 sm:shrink sm:min-h-[280px] sm:max-h-[45vh] sm:flex-1 card overflow-hidden flex flex-col border-t border-slate-200 dark:border-slate-800 rounded-none sm:rounded-t-2xl mx-0 sm:mx-4 sm:mb-4">
        <div className="shrink-0 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800">
          <div className="px-4 py-3 flex items-center justify-between gap-3">
            <h3 className="text-xs font-bold text-slate-400 uppercase">
              {t("clinicalExaminer")}
            </h3>
            <div className="flex items-center gap-2 shrink-0">
              <SpeechLanguageToggle
                value={lang}
                onChange={setLang}
                disabled={sending || isLiveCall || sessionLocked}
                labels={{
                  auto: t('speechLangAuto'),
                  ar: t('speechLangAr'),
                  en: t('speechLangEn'),
                }}
              />
              <LiveCallButton
                isLiveCall={isLiveCall}
                isLiveCallBusy={isLiveCallBusy}
                isLiveCallSupported={isLiveCallSupported}
                onToggleLiveCall={onToggleLiveCall}
                liveCallLabel={liveCallLabel}
                endLiveCallLabel={endLiveCallLabel}
                disabled={sending || sessionLocked}
              />
            </div>
          </div>
        </div>

        <ChatScrollArea
          endRef={chatEndRef}
          scrollDeps={[messages, sending]}
          forceScroll={sending}
          empty={messages.length === 0}
          className="bg-white dark:bg-slate-900 min-h-[120px]"
          emptyContent={
            <p className="text-sm text-slate-400 text-center py-4">
              {t("askExaminer")}
            </p>
          }
        >
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "STUDENT" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${msg.role === "STUDENT" ? "bg-primary text-white" : "bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-800 text-amber-950 dark:text-amber-100"}`}
              >
                <span dir="auto">{msg.content}</span>
              </div>
            </div>
          ))}
          {sending && <ChatTypingIndicator label={t("examinerTyping")} />}
        </ChatScrollArea>

        <div className="shrink-0 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900">
          {(isLiveCall || micError) && (
            <LiveCallMicStatus
              isLiveCall={isLiveCall}
              isBusy={isLiveCallBusy}
              isMicListening={isLiveCallMicListening}
              isSpeaking={isLiveCallSpeaking}
              error={isLiveCall ? micError : undefined}
            />
          )}
          <SimulationChatInput
            input={input}
            setInput={setInput}
            onSend={() => sendMessage()}
            sending={sending}
            placeholder={t("askExaminer")}
            chatError={chatError}
            isListening={isListening}
            isProcessing={isProcessing}
            isMicSupported={isMicSupported}
            onToggleMic={onToggleMic}
            micListeningLabel={t("micListening")}
            micNotSupportedLabel={t("micNotSupported")}
            micProcessingLabel={t("micProcessing")}
            micError={micError}
            disabled={isLiveCall || sessionLocked}
            isLiveCall={isLiveCall}
          />
        </div>
      </div>
    </div>
  );
}

function ClinicalStationPanel({
  maneuverId,
  examImages,
  isAr,
  t,
  compact = false,
}: {
  maneuverId: string;
  examImages: ExamImage[];
  isAr: boolean;
  t: (k: string) => string;
  compact?: boolean;
}) {
  const stationImages = examImages.filter(
    (img) => !img.maneuver || img.maneuver === maneuverId,
  );
  const fallbackUrl =
    DEFAULT_MANEUVER_IMAGES[maneuverId] || DEFAULT_MANEUVER_IMAGES.inspection;
  const displayImages =
    stationImages.length > 0
      ? stationImages.map((img) => ({
          ...img,
          url: resolveExamImageUrl(maneuverId, img.url),
        }))
      : [
          {
            url: fallbackUrl,
            caption: t("clinicalStation"),
            captionAr: t("clinicalStation"),
          },
        ];

  return (
    <div
      className={`bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 ${
        compact ? 'p-2 space-y-2' : 'p-4 space-y-4'
      }`}
    >
      {!compact && (
        <p className="text-xs font-bold text-slate-500 uppercase">
          {t("patientSlideGallery")}
        </p>
      )}

      <div className="grid gap-3">
        {displayImages.map((img, i) => {
          const mediaType = inferMediaType(img);
          return (
          <div
            key={`${img.url}-${i}`}
            className="relative rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-950"
          >
            {mediaType === 'video' ? (
              <video
                src={img.url}
                controls
                playsInline
                className={`w-full object-contain mx-auto bg-black ${compact ? 'max-h-36' : 'max-h-80'}`}
              >
                <track kind="captions" />
              </video>
            ) : mediaType === 'audio' ? (
              <div className={`px-4 bg-slate-900 ${compact ? 'py-3' : 'py-6'}`}>
                <audio src={img.url} controls className="w-full" />
              </div>
            ) : (
              <img
                src={img.url}
                alt={t("clinicalStation")}
                className={`w-full object-contain mx-auto ${compact ? 'max-h-36' : 'max-h-80'}`}
              />
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

interface LabSection {
  id: string;
  title: string;
  titleAr?: string;
  content: string;
  contentAr?: string;
}

const EXTRA_INVESTIGATION_OPTIONS: Array<{
  id: string;
  title: string;
  titleAr: string;
  match: RegExp;
}> = [
  {
    id: 'cbc',
    title: 'CBC / Full blood count',
    titleAr: 'صورة دم كاملة',
    match: /cbc|full blood|blood count|صورة دم/i,
  },
  {
    id: 'renal',
    title: 'U&E / Renal profile',
    titleAr: 'وظائف كلى وأملاح',
    match: /renal|u&e|electrolyte|كلى/i,
  },
  {
    id: 'lft',
    title: 'Liver function tests',
    titleAr: 'وظائف كبد',
    match: /liver|lft|كبد/i,
  },
  {
    id: 'bnp',
    title: 'BNP / NT-proBNP',
    titleAr: 'BNP / NT-proBNP',
    match: /bnp|nt-probnp/i,
  },
  {
    id: 'tft',
    title: 'Thyroid function tests',
    titleAr: 'وظائف الغدة الدرقية',
    match: /thyroid|tft|درقية/i,
  },
  {
    id: 'ddimer',
    title: 'D-dimer',
    titleAr: 'D-dimer',
    match: /d-dimer|ddimer/i,
  },
];

function slugInvestigationId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseInvestigationSections(labResults: string): LabSection[] {
  try {
    const parsed = JSON.parse(labResults);
    if (Array.isArray(parsed.sections)) {
      return parsed.sections.map((section: LabSection, index: number) => ({
        ...section,
        id: section.id || `case-${index}-${slugInvestigationId(section.title)}`,
      }));
    }
  } catch {
    /* plain text fallback */
  }
  if (labResults.trim()) {
    return [
      {
        id: 'case-default',
        title: 'Investigations',
        content: labResults,
      },
    ];
  }
  return [];
}

function buildInvestigationCatalog(caseSections: LabSection[]): LabSection[] {
  const catalog: LabSection[] = caseSections.map((section) => ({ ...section }));
  const usedIds = new Set(catalog.map((s) => s.id));

  for (const extra of EXTRA_INVESTIGATION_OPTIONS) {
    const alreadyCovered = caseSections.some(
      (section) => extra.match.test(section.title) || extra.match.test(section.titleAr || ''),
    );
    if (alreadyCovered || usedIds.has(extra.id)) continue;
    catalog.push({
      id: extra.id,
      title: extra.title,
      titleAr: extra.titleAr,
      content: '',
      contentAr: '',
    });
    usedIds.add(extra.id);
  }

  return catalog;
}

function InvestigationsView({
  t,
  isAr,
  labResults,
}: {
  t: (k: string) => string;
  isAr: boolean;
  labResults: string;
}) {
  const caseSections = parseInvestigationSections(labResults);
  const catalog = buildInvestigationCatalog(caseSections);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleInvestigation = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedSections = catalog.filter((section) => selectedIds.has(section.id));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain">
      <div className="flex flex-col lg:flex-row lg:h-full gap-4 p-4 min-h-0 lg:overflow-hidden">
      <div className="lg:w-[38%] xl:w-[34%] shrink-0 flex flex-col rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm lg:overflow-hidden lg:min-h-0">
        <div className="p-5 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-teal-50 dark:bg-teal-950/50 flex items-center justify-center">
              <FlaskConical size={18} className="text-teal-600 dark:text-teal-400" />
            </div>
            <h3 className="font-bold text-slate-900 dark:text-white">
              {t('investigationsCatalogTitle')}
            </h3>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
            {t('investigationsCatalogDesc')}
          </p>
        </div>

        <div className="lg:flex-1 lg:overflow-y-auto lg:overscroll-y-contain p-4 space-y-2.5 pb-6">
          {catalog.map((section) => {
            const active = selectedIds.has(section.id);
            const label = isAr ? section.titleAr || section.title : section.title;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => toggleInvestigation(section.id)}
                className={`w-full text-start px-4 py-3.5 rounded-xl border text-sm font-semibold transition-all ${
                  active
                    ? 'border-teal-500 bg-teal-50 dark:bg-teal-950/40 text-teal-900 dark:text-teal-100 shadow-sm ring-1 ring-teal-200 dark:ring-teal-800'
                    : 'border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/60 text-slate-700 dark:text-slate-200 hover:border-teal-300 dark:hover:border-teal-700 hover:bg-white dark:hover:bg-slate-800'
                }`}
              >
                <span className="flex items-center justify-between gap-3">
                  <span dir="auto">{label}</span>
                  {active && <CheckCircle2 size={16} className="shrink-0 text-teal-600 dark:text-teal-400" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 flex flex-col rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950 shadow-xl lg:overflow-hidden lg:min-h-0 min-h-[240px]">
        <div className="px-5 py-4 border-b border-slate-800 shrink-0 flex items-center gap-2.5">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
          <h3 className="text-xs sm:text-sm font-bold tracking-[0.14em] text-slate-200 uppercase">
            {t('investigationsConsoleTitle')}
          </h3>
        </div>

        <div className="lg:flex-1 lg:overflow-y-auto lg:overscroll-y-contain p-5 sm:p-6 pb-8">
          {selectedSections.length === 0 ? (
            <div className="min-h-[180px] lg:min-h-[220px] lg:h-full flex flex-col items-center justify-center text-center px-4">
              <div className="w-16 h-16 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center mb-5">
                <FlaskConical size={28} className="text-slate-400" />
              </div>
              <p className="text-lg font-semibold text-slate-200 mb-2">
                {t('investigationsConsoleOffline')}
              </p>
              <p className="text-sm text-slate-500 max-w-sm leading-relaxed">
                {t('investigationsConsoleHint')}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {selectedSections.map((section) => {
                const title = isAr
                  ? section.titleAr || section.title
                  : section.title;
                const body = section.content.trim()
                  ? isAr
                    ? section.contentAr || section.content
                    : section.content
                  : t('investigationsNormalResult');

                return (
                  <div
                    key={section.id}
                    className="rounded-xl border border-slate-700/80 bg-slate-800/60 p-4 sm:p-5"
                  >
                    <h4 className="text-sm font-bold text-teal-300 mb-2 tracking-wide uppercase">
                      {title}
                    </h4>
                    <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed" dir="auto">
                      {body}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function FeedbackPendingView({
  t,
  completing,
  onGoToDiagnosis,
  onGenerate,
}: {
  t: (k: string) => string;
  completing: boolean;
  onGoToDiagnosis: () => void;
  onGenerate: () => void;
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="card max-w-lg w-full p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 dark:bg-amber-950/40 flex items-center justify-center mx-auto mb-4">
          <Lightbulb size={28} className="text-amber-600 dark:text-amber-400" />
        </div>
        <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
          {t("feedbackNotReadyTitle")}
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-6">
          {t("feedbackNotReadyDesc")}
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button type="button" onClick={onGoToDiagnosis} className="btn-secondary text-sm">
            {t("goToDiagnosis")}
          </button>
          <button
            type="button"
            onClick={onGenerate}
            disabled={completing}
            className="btn-primary text-sm inline-flex items-center justify-center gap-2"
          >
            {completing ? (
              <>
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                {t("generatingFeedback")}
              </>
            ) : (
              t("completeSession")
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function FeedbackView({
  result,
  rankProgress,
  t,
  session,
  isAr,
  onRegenerate,
  regenerating,
}: {
  result: Record<string, unknown>;
  rankProgress?: RankSnapshot | null;
  t: (key: string) => string;
  session: Session;
  isAr: boolean;
  onRegenerate?: () => void | Promise<void>;
  regenerating?: boolean;
}) {
  const sections = [
    { key: "strengths", label: t("strengths") },
    { key: "weaknesses", label: t("weaknesses") },
    { key: "missedQuestions", label: t("missedQuestions") },
    { key: "clinicalErrors", label: t("clinicalErrors") },
    { key: "recommendations", label: t("recommendations") },
    { key: "idealApproach", label: t("idealApproach") },
  ];

  const [downloadingReport, setDownloadingReport] = useState(false);

  const downloadReport = async () => {
    setDownloadingReport(true);
    try {
      await downloadOsceReportPdf({
        sessionId: session.id,
        stationTitle: session.case.titleEn,
        patientName: session.case.patientName,
        result,
        isAr: false,
        labels: {
          certificateTitle: t("reportCertificateTitle"),
          officialReport: t("reportOfficialDocument"),
          totalScore: t("totalScore"),
          station: t("reportStation"),
          patient: t("reportPatient"),
          date: t("reportDate"),
          sessionId: t("reportSessionId"),
          scoreCommunication: t("scoreCommunication"),
          scoreHistory: t("scoreHistory"),
          scoreClinicalReason: t("scoreClinicalReason"),
          scoreOrganization: t("scoreOrganization"),
          scoreClosing: t("scoreClosing"),
          strengths: t("strengths"),
          weaknesses: t("weaknesses"),
          missedQuestions: t("missedQuestions"),
          clinicalErrors: t("clinicalErrors"),
          recommendations: t("recommendations"),
          idealApproach: t("idealApproach"),
          fullReport: t("fullReport"),
          certifiedSeal: t("reportCertifiedSeal"),
          platformName: t("appName"),
        },
      });
    } finally {
      setDownloadingReport(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="card p-6 text-center">
        <p className="text-xs text-slate-500 mb-2">{t("feedbackGeneratedFromChat")}</p>
        <p className="text-sm text-slate-500">{t("totalScore")}</p>
        <p className="text-5xl font-bold text-primary">
          {result.totalScore as number}%
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-4">
          <button
            type="button"
            onClick={() => void downloadReport()}
            disabled={downloadingReport}
            className="btn-secondary inline-flex items-center gap-2 min-w-[200px] justify-center"
          >
            {downloadingReport ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Download size={16} />
            )}{" "}
            {t("downloadReport")}
          </button>
          {onRegenerate && (
            <button
              type="button"
              onClick={() => void onRegenerate()}
              disabled={regenerating}
              className="btn-secondary inline-flex items-center gap-2 min-w-[200px] justify-center"
            >
              {regenerating ? t("generatingFeedback") : t("regenerateReport")}
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-6">
          {(
            [
              ["communicationScore", "scoreCommunication"],
              ["historyTakingScore", "scoreHistory"],
              ["clinicalReasonScore", "scoreClinicalReason"],
              ["organizationScore", "scoreOrganization"],
              ["closingScore", "scoreClosing"],
            ] as const
          ).map(([key, labelKey]) => (
            <div
              key={key}
              className="bg-slate-50 dark:bg-slate-800 rounded-lg p-3"
            >
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t(labelKey)}
              </p>
              <p className="font-bold text-slate-900 dark:text-white">
                {result[key] as number}%
              </p>
            </div>
          ))}
        </div>
      </div>
      {sections.map(({ key, label }) => (
        <div key={key} className="card p-5">
          <h4 className="font-semibold mb-2 text-slate-900 dark:text-white">
            {label}
          </h4>
          <p
            className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap leading-relaxed"
            dir="ltr"
            lang="en"
          >
            {result[key] as string}
          </p>
        </div>
      ))}
      {Boolean(result.fullReport) && (
        <div className="card p-5">
          <h4 className="font-semibold mb-2 text-slate-900 dark:text-white">
            {t("fullReport")}
          </h4>
          <div
            className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap prose prose-sm dark:prose-invert max-w-none leading-relaxed"
            dir="ltr"
            lang="en"
          >
            {(result.fullReport as string).replace(/^## /gm, "### ")}
          </div>
        </div>
      )}
      <XpBreakdownSection result={result} rankProgress={rankProgress} isAr={isAr} />
    </div>
  );
}
