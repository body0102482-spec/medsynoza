import type { Case } from '@prisma/client';
import {
  DEFAULT_PATIENT_BEHAVIOR,
  DEFAULT_STATION_CONFIG,
  parseStationConfig,
  serializeStationConfig,
  type ManeuverId,
  type MainStageId,
  type PatientBehavior,
} from '../lib/stationConfig.js';

export type { ManeuverId };
export type MediaType = 'image' | 'video' | 'audio';

export interface VitalSignForm {
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

export interface ExamImageForm {
  id: string;
  url: string;
  caption: string;
  captionAr: string;
  maneuver: ManeuverId | '';
  mediaType: MediaType;
}

export interface LabSectionForm {
  id: string;
  title: string;
  titleAr: string;
  content: string;
  contentAr: string;
}

export interface RubricItemForm {
  id: string;
  item: string;
  category: string;
}

export interface PhysicalExamForm {
  inspection: string;
  palpation: string;
  percussion: string;
  auscultation: string;
}

export interface ExaminerQuestionForm {
  id: string;
  question: string;
  sampleAnswer: string;
}

export interface StationConfigForm {
  enabledManeuvers: ManeuverId[];
  enableHistoryExaminer: boolean;
  enableInvestigations: boolean;
  stageOrder: MainStageId[];
  maneuverOpeningMessages: Partial<Record<ManeuverId, string>>;
  maneuverLabels: Partial<Record<ManeuverId, { en: string; ar: string }>>;
  patientBehavior: PatientBehavior;
}

export interface CaseFormPayload {
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
  stationConfig: StationConfigForm;
}

const EMPTY_VITALS: VitalSignForm = {
  bpValue: '',
  bpNote: '',
  hrValue: '',
  hrNote: '',
  rrValue: '',
  rrNote: '',
  tempValue: '',
  tempNote: '',
  spo2Value: '',
  spo2Note: '',
};

const EMPTY_PHYSICAL: PhysicalExamForm = {
  inspection: '',
  palpation: '',
  percussion: '',
  auscultation: '',
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseVitalSignsForm(raw: string): VitalSignForm {
  const parsed = parseJson<Record<string, { value?: string; note?: string }>>(raw, {});
  const get = (code: string) => ({
    value: String(parsed[code]?.value ?? ''),
    note: String(parsed[code]?.note ?? ''),
  });
  const bp = get('bp');
  const hr = get('hr');
  const rr = get('rr');
  const temp = get('temp');
  const spo2 = get('spo2');
  return {
    bpValue: bp.value,
    bpNote: bp.note,
    hrValue: hr.value,
    hrNote: hr.note,
    rrValue: rr.value,
    rrNote: rr.note,
    tempValue: temp.value,
    tempNote: temp.note,
    spo2Value: spo2.value,
    spo2Note: spo2.note,
  };
}

export function serializeVitalSigns(form: VitalSignForm): string {
  const out: Record<string, { value: string; note: string }> = {};
  const add = (code: string, value: string, note: string) => {
    if (value.trim() || note.trim()) out[code] = { value: value.trim(), note: note.trim() };
  };
  add('bp', form.bpValue, form.bpNote);
  add('hr', form.hrValue, form.hrNote);
  add('rr', form.rrValue, form.rrNote);
  add('temp', form.tempValue, form.tempNote);
  add('spo2', form.spo2Value, form.spo2Note);
  return JSON.stringify(out);
}

export function parsePhysicalExamForm(raw: string): PhysicalExamForm {
  const parsed = parseJson<Partial<PhysicalExamForm>>(raw, {});
  if (parsed.inspection || parsed.palpation || parsed.percussion || parsed.auscultation) {
    return {
      inspection: String(parsed.inspection ?? ''),
      palpation: String(parsed.palpation ?? ''),
      percussion: String(parsed.percussion ?? ''),
      auscultation: String(parsed.auscultation ?? ''),
    };
  }
  return { ...EMPTY_PHYSICAL, inspection: raw.trim() };
}

export function serializePhysicalExam(form: PhysicalExamForm): string {
  const hasStructured = [form.inspection, form.palpation, form.percussion, form.auscultation].some((v) => v.trim());
  if (!hasStructured) return '';
  return JSON.stringify({
    inspection: form.inspection.trim(),
    palpation: form.palpation.trim(),
    percussion: form.percussion.trim(),
    auscultation: form.auscultation.trim(),
  });
}

export function parseExamImagesForm(raw: string): ExamImageForm[] {
  const parsed = parseJson<ExamImageForm[]>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((row, index) => ({
    id: String(row.id || `img-${index}`),
    url: String(row.url ?? ''),
    caption: String(row.caption ?? ''),
    captionAr: String(row.captionAr ?? ''),
    maneuver: (row.maneuver as ManeuverId) || '',
    mediaType: (row.mediaType as MediaType) || 'image',
  }));
}

export function serializeExamImages(images: ExamImageForm[]): string {
  const rows = images
    .filter((img) => img.url.trim())
    .map(({ url, caption, captionAr, maneuver, mediaType }) => ({
      url: url.trim(),
      caption: caption.trim() || undefined,
      captionAr: captionAr.trim() || undefined,
      maneuver: maneuver || undefined,
      mediaType: mediaType || 'image',
    }));
  return JSON.stringify(rows);
}

export function parseLabSectionsForm(raw: string): LabSectionForm[] {
  const parsed = parseJson<{ sections?: LabSectionForm[] } | LabSectionForm[]>(raw, []);
  const rows = Array.isArray(parsed) ? parsed : parsed.sections ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => ({
    id: String(row.id || `lab-${index}`),
    title: String(row.title ?? ''),
    titleAr: String(row.titleAr ?? ''),
    content: String(row.content ?? ''),
    contentAr: String(row.contentAr ?? ''),
  }));
}

export function serializeLabSections(sections: LabSectionForm[]): string {
  const rows = sections
    .filter((s) => s.title.trim() || s.content.trim())
    .map(({ title, titleAr, content, contentAr }) => ({
      title: title.trim(),
      titleAr: titleAr.trim() || undefined,
      content: content.trim(),
      contentAr: contentAr.trim() || undefined,
    }));
  return JSON.stringify({ sections: rows });
}

export function parseRubricItemsForm(raw: string): RubricItemForm[] {
  const parsed = parseJson<{ checklist?: RubricItemForm[] }>(raw, {});
  if (Array.isArray(parsed)) {
    return parsed.map((row, index) => ({
      id: String(row.id || `rubric-${index}`),
      item: String(row.item ?? ''),
      category: String(row.category ?? 'History'),
    }));
  }
  if (parsed.checklist && Array.isArray(parsed.checklist)) {
    return parsed.checklist.map((row, index) => ({
      id: String(row.id || `rubric-${index}`),
      item: String(row.item ?? ''),
      category: String(row.category ?? 'History'),
    }));
  }
  if (raw.trim()) {
    return [{ id: 'rubric-0', item: raw.trim(), category: 'General' }];
  }
  return [];
}

export function serializeRubricItems(items: RubricItemForm[]): string {
  const checklist = items
    .filter((row) => row.item.trim())
    .map(({ item, category }) => ({ item: item.trim(), category: category.trim() || 'History' }));
  return JSON.stringify({ checklist });
}

export function parseExaminerQuestionsForm(raw: string | null | undefined): ExaminerQuestionForm[] {
  const parsed = parseJson<ExaminerQuestionForm[] | { questions?: ExaminerQuestionForm[] }>(raw ?? '[]', []);
  const rows = Array.isArray(parsed) ? parsed : parsed.questions ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => ({
    id: String(row.id || `viva-${index}`),
    question: String(row.question ?? ''),
    sampleAnswer: String(row.sampleAnswer ?? ''),
  }));
}

export function serializeExaminerQuestions(questions: ExaminerQuestionForm[]): string {
  const rows = questions
    .filter((row) => row.question.trim())
    .map(({ id, question, sampleAnswer }) => ({
      id: id.trim() || undefined,
      question: question.trim(),
      sampleAnswer: sampleAnswer.trim() || undefined,
    }));
  return JSON.stringify(rows);
}

export function parseStationConfigForm(raw: string | null | undefined): StationConfigForm {
  const parsed = parseStationConfig(raw);
  return {
    enabledManeuvers: [...parsed.enabledManeuvers],
    enableHistoryExaminer: parsed.enableHistoryExaminer,
    enableInvestigations: parsed.enableInvestigations,
    stageOrder: [...parsed.stageOrder],
    maneuverOpeningMessages: { ...parsed.maneuverOpeningMessages },
    maneuverLabels: { ...parsed.maneuverLabels },
    patientBehavior: { ...parsed.patientBehavior },
  };
}

export function serializeStationConfigForm(config: StationConfigForm): string {
  return serializeStationConfig({
    enabledManeuvers: config.enabledManeuvers,
    enableHistoryExaminer: config.enableHistoryExaminer,
    enableInvestigations: config.enableInvestigations,
    stageOrder: config.stageOrder?.length
      ? config.stageOrder
      : [...parseStationConfig(null).stageOrder],
    maneuverOpeningMessages: config.maneuverOpeningMessages ?? {},
    maneuverLabels: config.maneuverLabels ?? {},
    patientBehavior: config.patientBehavior ?? { ...DEFAULT_PATIENT_BEHAVIOR },
  });
}

export function caseToForm(caseData: Case): CaseFormPayload {
  return {
    titleEn: caseData.titleEn,
    titleAr: caseData.titleAr,
    specialtyId: caseData.specialtyId,
    difficultyId: caseData.difficultyId,
    categoryId: caseData.categoryId ?? '',
    patientName: caseData.patientName,
    patientAge: caseData.patientAge,
    patientGender: caseData.patientGender,
    patientNationality: caseData.patientNationality,
    chiefComplaint: caseData.chiefComplaint,
    medicalHistory: caseData.medicalHistory,
    medicationHistory: caseData.medicationHistory,
    surgicalHistory: caseData.surgicalHistory,
    familyHistory: caseData.familyHistory,
    socialHistory: caseData.socialHistory,
    patientPersonality: caseData.patientPersonality ?? '',
    scenarioPrompt: caseData.scenarioPrompt,
    finalDiagnosis: caseData.finalDiagnosis,
    teachingPoints: caseData.teachingPoints,
    isPublished: caseData.isPublished,
    isFreeTier: caseData.isFreeTier,
    vitalSigns: parseVitalSignsForm(caseData.vitalSigns),
    physicalExam: parsePhysicalExamForm(caseData.physicalExam),
    examImages: parseExamImagesForm(caseData.examImages),
    labSections: parseLabSectionsForm(caseData.labResults),
    rubricItems: parseRubricItemsForm(caseData.evaluationRubric),
    examinerQuestions: parseExaminerQuestionsForm(caseData.examinerQuestions),
    stationConfig: parseStationConfigForm(caseData.stationConfig),
  };
}

export function formToCaseData(form: CaseFormPayload) {
  return {
    titleEn: form.titleEn.trim(),
    titleAr: form.titleAr.trim(),
    specialtyId: form.specialtyId,
    difficultyId: form.difficultyId,
    categoryId: form.categoryId?.trim() || null,
    patientName: form.patientName.trim(),
    patientAge: Number(form.patientAge) || 0,
    patientGender: form.patientGender.trim(),
    patientNationality: form.patientNationality.trim(),
    chiefComplaint: form.chiefComplaint.trim(),
    medicalHistory: form.medicalHistory.trim(),
    medicationHistory: form.medicationHistory.trim(),
    surgicalHistory: form.surgicalHistory.trim(),
    familyHistory: form.familyHistory.trim(),
    socialHistory: form.socialHistory.trim(),
    patientPersonality: form.patientPersonality.trim() || null,
    scenarioPrompt: form.scenarioPrompt.trim(),
    finalDiagnosis: form.finalDiagnosis.trim(),
    teachingPoints: form.teachingPoints.trim(),
    isPublished: !!form.isPublished,
    isFreeTier: !!form.isFreeTier,
    vitalSigns: serializeVitalSigns(form.vitalSigns),
    physicalExam: serializePhysicalExam(form.physicalExam),
    examImages: serializeExamImages(form.examImages),
    labResults: serializeLabSections(form.labSections),
    evaluationRubric: serializeRubricItems(form.rubricItems),
    examinerQuestions: serializeExaminerQuestions(form.examinerQuestions ?? []),
    stationConfig: serializeStationConfigForm(form.stationConfig ?? DEFAULT_STATION_CONFIG),
  };
}
