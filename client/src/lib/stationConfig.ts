export const ALL_MANEUVERS = ['inspection', 'palpation', 'percussion', 'auscultation'] as const;
export type ManeuverId = (typeof ALL_MANEUVERS)[number];

export const MAIN_STAGES = ['history', 'examination', 'investigations', 'diagnosis'] as const;
export type MainStageId = (typeof MAIN_STAGES)[number];
export type SimulationStageId = MainStageId | 'feedback';

export type PatientPreferredLanguage = 'AUTO' | 'AR' | 'EN';

export interface PatientBehavior {
  /** Free-form behavioral guidelines / system instructions for this station. */
  instructions: string;
  /** Personality tone, e.g. cooperative, guarded, irritable. */
  tone: string;
  /** Emotional state, e.g. anxious, calm, fearful. */
  emotion: string;
  /** Default speech language for new sessions at this station. */
  preferredLanguage: PatientPreferredLanguage;
  /** Hard constraints the patient must follow (what not to say / reveal). */
  constraints: string;
}

export interface StationConfig {
  enabledManeuvers: ManeuverId[];
  enableHistoryExaminer: boolean;
  enableInvestigations: boolean;
  stageOrder: MainStageId[];
  maneuverOpeningMessages: Partial<Record<ManeuverId, string>>;
  maneuverLabels: Partial<Record<ManeuverId, { en: string; ar: string }>>;
  patientBehavior: PatientBehavior;
}

export const DEFAULT_PATIENT_BEHAVIOR: PatientBehavior = {
  instructions: '',
  tone: '',
  emotion: '',
  preferredLanguage: 'AUTO',
  constraints: '',
};

export const DEFAULT_MANEUVER_OPENING_TEMPLATE =
  'I am evaluating your clinical {{maneuver}}. Take a close look at the clinical presentation and images provided. Describe your findings systematically and explain what you would look for during {{maneuver}}, including any scars, deformities, or visible abnormalities.';

export const MANEUVER_LABELS: Record<ManeuverId, { en: string; ar: string }> = {
  inspection: { en: 'Inspection', ar: 'الفحص البصري' },
  palpation: { en: 'Palpation', ar: 'الجس' },
  percussion: { en: 'Percussion', ar: 'النقر' },
  auscultation: { en: 'Auscultation', ar: 'الاستماع' },
};

export const DEFAULT_STATION_CONFIG: StationConfig = {
  enabledManeuvers: [...ALL_MANEUVERS],
  enableHistoryExaminer: true,
  enableInvestigations: true,
  stageOrder: [...MAIN_STAGES],
  maneuverOpeningMessages: {},
  maneuverLabels: {},
  patientBehavior: { ...DEFAULT_PATIENT_BEHAVIOR },
};

function isManeuverId(value: unknown): value is ManeuverId {
  return typeof value === 'string' && (ALL_MANEUVERS as readonly string[]).includes(value);
}

function isMainStage(value: unknown): value is MainStageId {
  return typeof value === 'string' && (MAIN_STAGES as readonly string[]).includes(value);
}

function isPreferredLanguage(value: unknown): value is PatientPreferredLanguage {
  return value === 'AUTO' || value === 'AR' || value === 'EN';
}

function normalizeStageOrder(order: MainStageId[] | undefined): MainStageId[] {
  const seen = new Set<MainStageId>();
  const normalized: MainStageId[] = [];
  for (const stage of order ?? MAIN_STAGES) {
    if (!isMainStage(stage) || seen.has(stage)) continue;
    seen.add(stage);
    normalized.push(stage);
  }
  for (const stage of MAIN_STAGES) {
    if (!seen.has(stage)) normalized.push(stage);
  }
  return normalized;
}

function parseManeuverOpeningMessages(raw: unknown): Partial<Record<ManeuverId, string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Partial<Record<ManeuverId, string>> = {};
  for (const maneuver of ALL_MANEUVERS) {
    const value = (raw as Record<string, unknown>)[maneuver];
    if (typeof value === 'string' && value.trim()) result[maneuver] = value.trim();
  }
  return result;
}

function parseManeuverLabels(raw: unknown): Partial<Record<ManeuverId, { en: string; ar: string }>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Partial<Record<ManeuverId, { en: string; ar: string }>> = {};
  for (const maneuver of ALL_MANEUVERS) {
    const value = (raw as Record<string, unknown>)[maneuver];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const en = String((value as { en?: unknown }).en ?? '').trim();
    const ar = String((value as { ar?: unknown }).ar ?? '').trim();
    if (en || ar) {
      result[maneuver] = {
        en: en || MANEUVER_LABELS[maneuver].en,
        ar: ar || MANEUVER_LABELS[maneuver].ar,
      };
    }
  }
  return result;
}

export function parsePatientBehavior(raw: unknown): PatientBehavior {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_PATIENT_BEHAVIOR };
  }
  const obj = raw as Record<string, unknown>;
  return {
    instructions: typeof obj.instructions === 'string' ? obj.instructions.trim() : '',
    tone: typeof obj.tone === 'string' ? obj.tone.trim() : '',
    emotion: typeof obj.emotion === 'string' ? obj.emotion.trim() : '',
    preferredLanguage: isPreferredLanguage(obj.preferredLanguage)
      ? obj.preferredLanguage
      : 'AUTO',
    constraints: typeof obj.constraints === 'string' ? obj.constraints.trim() : '',
  };
}

export function mergePatientBehavior(
  base: PatientBehavior,
  override?: Partial<PatientBehavior> | null,
): PatientBehavior {
  if (!override) return { ...base };
  return {
    instructions:
      override.instructions !== undefined ? String(override.instructions).trim() : base.instructions,
    tone: override.tone !== undefined ? String(override.tone).trim() : base.tone,
    emotion: override.emotion !== undefined ? String(override.emotion).trim() : base.emotion,
    preferredLanguage: isPreferredLanguage(override.preferredLanguage)
      ? override.preferredLanguage
      : base.preferredLanguage,
    constraints:
      override.constraints !== undefined ? String(override.constraints).trim() : base.constraints,
  };
}

/** Prompt block injected into the patient system prompt when any field is set. */
export function formatPatientBehaviorPrompt(behavior: PatientBehavior | null | undefined): string {
  if (!behavior) return '';
  const lines: string[] = [];
  if (behavior.tone) lines.push(`- Tone: ${behavior.tone}`);
  if (behavior.emotion) lines.push(`- Emotion: ${behavior.emotion}`);
  if (behavior.preferredLanguage && behavior.preferredLanguage !== 'AUTO') {
    lines.push(`- Preferred language: ${behavior.preferredLanguage}`);
  }
  if (behavior.instructions) lines.push(`- Custom instructions:\n${behavior.instructions}`);
  if (behavior.constraints) lines.push(`- Hard constraints (must follow):\n${behavior.constraints}`);
  if (!lines.length) return '';
  return `\nSTATION PATIENT BEHAVIOR (admin overrides — follow these):\n${lines.join('\n')}\n`;
}

export function resolveManeuverLabel(
  maneuverId: string,
  config?: StationConfig | null,
  lang: 'en' | 'ar' = 'en',
): string {
  const id = isManeuverId(maneuverId) ? maneuverId : 'inspection';
  const custom = config?.maneuverLabels?.[id];
  if (custom) {
    const preferred = lang === 'ar' ? custom.ar : custom.en;
    if (preferred?.trim()) return preferred.trim();
    if (custom.en?.trim()) return custom.en.trim();
    if (custom.ar?.trim()) return custom.ar.trim();
  }
  return lang === 'ar' ? MANEUVER_LABELS[id].ar : MANEUVER_LABELS[id].en;
}

export function parseStationConfig(raw: string | null | undefined): StationConfig {
  if (!raw?.trim()) {
    return {
      ...DEFAULT_STATION_CONFIG,
      enabledManeuvers: [...ALL_MANEUVERS],
      stageOrder: [...MAIN_STAGES],
      maneuverOpeningMessages: {},
      maneuverLabels: {},
      patientBehavior: { ...DEFAULT_PATIENT_BEHAVIOR },
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StationConfig>;
    const enabled = Array.isArray(parsed.enabledManeuvers)
      ? parsed.enabledManeuvers.filter(isManeuverId)
      : [...ALL_MANEUVERS];
    return {
      enabledManeuvers: enabled.length > 0 ? enabled : [...ALL_MANEUVERS],
      enableHistoryExaminer: parsed.enableHistoryExaminer !== false,
      enableInvestigations: parsed.enableInvestigations !== false,
      stageOrder: normalizeStageOrder(
        Array.isArray(parsed.stageOrder) ? parsed.stageOrder.filter(isMainStage) : undefined,
      ),
      maneuverOpeningMessages: parseManeuverOpeningMessages(parsed.maneuverOpeningMessages),
      maneuverLabels: parseManeuverLabels(parsed.maneuverLabels),
      patientBehavior: parsePatientBehavior(parsed.patientBehavior),
    };
  } catch {
    return {
      ...DEFAULT_STATION_CONFIG,
      enabledManeuvers: [...ALL_MANEUVERS],
      stageOrder: [...MAIN_STAGES],
      maneuverOpeningMessages: {},
      maneuverLabels: {},
      patientBehavior: { ...DEFAULT_PATIENT_BEHAVIOR },
    };
  }
}

export function getEnabledMainStages(config: StationConfig): MainStageId[] {
  return config.stageOrder.filter((stage) => {
    if (stage === 'investigations') return config.enableInvestigations;
    return true;
  });
}

export function getSimulationStages(config: StationConfig): SimulationStageId[] {
  return [...getEnabledMainStages(config), 'feedback'];
}

export function getNextMainStageAfter(
  current: MainStageId,
  config: StationConfig,
): MainStageId | 'feedback' {
  const stages = getEnabledMainStages(config);
  const index = stages.indexOf(current);
  if (index === -1) return stages[0] ?? 'diagnosis';
  return stages[index + 1] ?? 'feedback';
}

export function isManeuverEnabled(config: StationConfig, maneuverId: string): boolean {
  return config.enabledManeuvers.includes(maneuverId as ManeuverId);
}

export function getSessionStationConfig(session: {
  resolvedStationConfig?: string | null;
  case: { stationConfig?: string };
}): StationConfig {
  if (session.resolvedStationConfig?.trim()) {
    return parseStationConfig(session.resolvedStationConfig);
  }
  return parseStationConfig(session.case.stationConfig);
}
