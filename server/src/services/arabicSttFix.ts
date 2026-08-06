/** Correct common Whisper mis-hearings of Egyptian Arabic OSCE phrases. */
const ARABIC_STT_FIXES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /^it'?s?\s*my\s*key\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^it'?s?\s*my\s*name\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^it'?s?\s*mike\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^what'?s?\s*(your\s*)?(name|nem|aim)\??\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^what is your name\??\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^(your\s*)?name\??\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^(esmak|ismak|ismik|esmik)\s*(eh|e|a)\??\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^how\s*old\s*(are\s*you|r\s*u)\??\.?$/i, replacement: 'عندك كام سنة' },
  { pattern: /^how\s*are\s*you\??\.?$/i, replacement: 'إزيك' },
  { pattern: /^how\s*are\s*u\??\.?$/i, replacement: 'إزيك' },
  { pattern: /^thank\s*you\.?$/i, replacement: 'إزيك' },
  { pattern: /^thanks\.?$/i, replacement: 'إزيك' },
  { pattern: /^shukran\.?$/i, replacement: 'إزيك' },
  { pattern: /^(eh|eih|ay|e)\s*(el|al)\s*akhbar\??\.?$/i, replacement: 'إيه الأخبار' },
  { pattern: /^what'?s?\s*up\??\.?$/i, replacement: 'إزيك' },
  { pattern: /^where\s*are\s*you\s*from\??\.?$/i, replacement: 'منين' },
  { pattern: /^are\s*you\s*egyptian\??\.?$/i, replacement: 'مصري' },
  { pattern: /^are\s*you\s*married\??\.?$/i, replacement: 'متجوز' },
  { pattern: /^hello\s*doctor\.?$/i, replacement: 'السلام عليكم دكتور' },
  { pattern: /^(هيلو|هالو|حيلو|هلو)\s*(يا\s*)?(دكتور)?\.?$/i, replacement: 'أهلاً دكتور' },
  { pattern: /^good\s*(morning|evening)\??\.?$/i, replacement: 'صباح الخير دكتور' },
  { pattern: /^what\s*(brought|brings)\s*you\??\.?$/i, replacement: 'إيه اللي جابك' },
  { pattern: /^what'?s?\s*wrong\??\.?$/i, replacement: 'إيه اللي جابك' },
  { pattern: /^tell\s*me\s*about\s*your\s*problem\.?$/i, replacement: 'إيه اللي جابك' },
  { pattern: /^what\s*is\s*your\s*complaint\??\.?$/i, replacement: 'إيه المشكلة' },
  { pattern: /^what\s*are\s*you\s*complaining\s*about\??\.?$/i, replacement: 'إيه اللي بتشتكي منه' },
  { pattern: /^(enta|inti)\s*masry\??\.?$/i, replacement: 'مصري' },
  { pattern: /^mtgwz\??\.?$/i, replacement: 'متجوز' },
  { pattern: /^الف\s*سلام[ةه]\.?$/i, replacement: 'الف مليون سلامة' },
  { pattern: /^alf\s*salama\.?$/i, replacement: 'الف مليون سلامة' },
];

export function fixWellbeingMishearing(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return normalized;

  if (/^(شكراً|شكرا|thank\s*you|thanks)\.?$/i.test(normalized)) {
    return 'إزيك';
  }

  if (/^(ايه|إيه|اي|eh|eih|ay)\s*(الاخبار|الأخبار|اخبارك|أخبارك)\??\.?$/i.test(normalized)) {
    return 'إيه الأخبار';
  }

  return normalized;
}

export function prioritizeWellbeingTranscript(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  if (/اسمك\s*إ?يه|اسمك\s*ايه|اسم حضرتك|what is your name/i.test(trimmed)) {
    return trimmed;
  }

  if (/أخبار|اخبار|إزيك|ازيك|عامل إيه|عاملة إيه/i.test(trimmed)) {
    const wellbeingPart = trimmed
      .split(/[؟?،,.]/)
      .map((s) => s.trim())
      .find((s) => /أخبار|اخبار|إزيك|ازيك|عامل/i.test(s));
    if (wellbeingPart) return `${wellbeingPart}؟`;
  }

  return trimmed;
}

/** Whisper / gpt-transcribe filler on silence — not real student speech. */
export function looksLikeSttHallucination(text: string, allowLatinOnly = false): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length < 2) return true;

  if (containsWrongScriptForArabic(normalized)) return true;

  if (
    /شكرا?\s*(للمشاركة|على المشاهدة|لمشاهدتك|للاستماع|جزيلا)|thank\s*you\s*for\s*(watching|listening|your)|subscribe|subtitles\s*by|مترجم|amara\.org/i.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /اشترك(وا|و|ي)?\s*(في|فى)\s*(ال)?قناة|لا\s*تنس(وا|و|ي)?\s*(ال)?اشتراك|فعل(وا|و|ي)?\s*زر\s*(ال)?جرس|(اضغط|اضغطوا|دوس)(وا|و|ي)?\s*(على\s*)?زر\s*(ال)?(اشتراك|جرس)|subscribe\s*(to\s*)?(the\s*)?channel|like\s*(and\s*)?subscribe/i.test(
      normalized,
    )
  ) {
    return true;
  }

  if (/^(thank\s*you|thanks|شكرا|شكراً)\s*(for|لل|على)/i.test(normalized)) {
    return true;
  }

  // Classic silence / noise phantoms (esp. after switching mic language to EN).
  if (
    /^(buch\.?|hello[,.]?\s*world!?|sorry[,.]?\s*could you clarify\??|thank you for (watching|listening)|thanks for watching|subtitle(s)? by|www\.|http)/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /^(um+|uh+|hmm+|ah+|oh+|mm+|mhm)[.!?]*$/i.test(normalized) ||
    /^(testing|test|microphone|mic check)[.!?]*$/i.test(normalized)
  ) {
    return true;
  }

  const arabic = (normalized.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (normalized.match(/[a-zA-Z]/g) || []).length;
  if (!allowLatinOnly && latin >= 5 && arabic === 0 && normalized.length < 100) {
    return true;
  }
  if (allowLatinOnly && /^[A-Za-z]{1,4}[.!?,]*$/i.test(normalized)) {
    return true;
  }

  if (/nancy|conker|نانسي|كونكر|mbc|amara|subtitle|caption/i.test(normalized)) {
    return true;
  }

  return false;
}

/** CJK / other scripts that must never pass as Egyptian Arabic STT. */
export function containsWrongScriptForArabic(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

export function isValidArabicSessionTranscript(text: string, expectArabic: boolean): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (!expectArabic) {
    if (containsWrongScriptForArabic(normalized)) return false;
    return !looksLikeSttHallucination(normalized, true);
  }
  if (containsWrongScriptForArabic(normalized)) return false;
  if (looksLikeSttHallucination(normalized, false)) return false;
  if (transcriptionNeedsArabicFix(normalized, true)) return false;
  return /[\u0600-\u06FF]/.test(normalized);
}

export function fixArabicSpeechTranscript(
  text: string,
  expectArabic: boolean,
  /** AUTO mode: map known English Whisper mishearings of Egyptian OSCE phrases. */
  codeSwitch = false,
): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return normalized;

  if (!expectArabic && !codeSwitch) return normalized;

  const wellbeingFixed = fixWellbeingMishearing(normalized);
  if (wellbeingFixed !== normalized) return wellbeingFixed;

  if (/[\u0600-\u06FF]/.test(normalized)) return normalized;

  for (const { pattern, replacement } of ARABIC_STT_FIXES) {
    if (pattern.test(normalized)) return replacement;
  }

  return normalized;
}

export function transcriptionNeedsArabicFix(text: string, expectArabic: boolean): boolean {
  if (!expectArabic) return false;
  const normalized = text.trim();
  if (!normalized) return false;
  if (containsWrongScriptForArabic(normalized)) return true;
  // Mixed Arabic + English medical terms is valid; only reject pure Latin.
  if (/[\u0600-\u06FF]/.test(normalized)) return false;
  return /[a-zA-Z]/.test(normalized);
}

/** Only force Arabic STT when the student explicitly chose Arabic. AUTO allows code-switching. */
export function shouldForceArabicTranscription(sessionLang: string): boolean {
  return sessionLang === 'AR';
}
