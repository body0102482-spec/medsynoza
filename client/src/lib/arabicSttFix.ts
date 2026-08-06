/** Client-side STT fixes — kept in sync with server/src/services/arabicSttFix.ts */
const ARABIC_STT_FIXES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /^it'?s?\s*my\s*key\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^it'?s?\s*my\s*name\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^what'?s?\s*(your\s*)?(name|nem|aim)\??\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^what is your name\??\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^(esmak|ismak)\s*(eh|e)\??\.?$/i, replacement: 'اسمك إيه' },
  { pattern: /^how\s*old\s*(are\s*you|r\s*u)\??\.?$/i, replacement: 'عندك كام سنة' },
  { pattern: /^how\s*are\s*you\??\.?$/i, replacement: 'إزيك' },
  { pattern: /^how\s*are\s*u\??\.?$/i, replacement: 'إزيك' },
  { pattern: /^(هيلو|هالو|حيلو|هلو)\s*(يا\s*)?(دكتور)?\.?$/i, replacement: 'أهلاً دكتور' },
  { pattern: /^الف\s*سلام[ةه]\.?$/i, replacement: 'الف مليون سلامة' },
];

export function containsWrongScriptForArabic(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

export function looksLikeSttHallucination(text: string, allowLatinOnly = false): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length < 2) return true;
  if (containsWrongScriptForArabic(normalized)) return true;
  if (/شكرا?\s*(للمشاركة|على المشاهدة|لمشاهدتك|للاستماع)/i.test(normalized)) return true;
  if (
    /اشترك(وا|و|ي)?\s*(في|فى)\s*(ال)?قناة|لا\s*تنس(وا|و|ي)?\s*(ال)?اشتراك|فعل(وا|و|ي)?\s*زر\s*(ال)?جرس|subscribe\s*(to\s*)?(the\s*)?channel/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/nancy|conker|نانسي|كونكر|mbc|amara|subtitle|caption/i.test(normalized)) return true;

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

  // Latin-only is fine for EN / AUTO (code-switching); only reject in forced-Arabic mode.
  if (!allowLatinOnly) {
    const arabic = (normalized.match(/[\u0600-\u06FF]/g) || []).length;
    const latin = (normalized.match(/[a-zA-Z]/g) || []).length;
    if (latin >= 5 && arabic === 0 && normalized.length < 100) return true;
  } else {
    // EN mode: reject tiny noise fragments (1–4 letters + optional punct) that aren't real answers.
    if (/^[A-Za-z]{1,4}[.!?,]*$/i.test(normalized)) return true;
  }
  return false;
}

export function transcriptionNeedsArabicFix(text: string, expectArabic: boolean): boolean {
  if (!expectArabic) return false;
  const normalized = text.trim();
  if (!normalized) return true;
  if (containsWrongScriptForArabic(normalized)) return true;
  // Mixed Arabic + English is valid code-switching — only reject pure Latin.
  if (/[\u0600-\u06FF]/.test(normalized)) return false;
  return /[a-zA-Z]/.test(normalized);
}

export function isValidArabicSessionTranscript(text: string, expectArabic: boolean): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  // EN / AUTO: accept Arabic, English, or mixed scripts.
  if (!expectArabic) {
    if (containsWrongScriptForArabic(normalized)) return false;
    return !looksLikeSttHallucination(normalized, true);
  }
  if (looksLikeSttHallucination(normalized, false)) return false;
  if (transcriptionNeedsArabicFix(normalized, true)) return false;
  return /[\u0600-\u06FF]/.test(normalized);
}

export function fixArabicSpeechTranscript(
  text: string,
  expectArabic: boolean,
  codeSwitch = false,
): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return normalized;
  if (!expectArabic && !codeSwitch) return normalized;
  if (/[\u0600-\u06FF]/.test(normalized)) return normalized;

  for (const { pattern, replacement } of ARABIC_STT_FIXES) {
    if (pattern.test(normalized)) return replacement;
  }

  return normalized;
}

/** Only force Arabic STT when the student explicitly chose Arabic. AUTO allows code-switching. */
export function shouldForceArabicTranscription(sessionLang: string): boolean {
  return sessionLang === 'AR';
}

export function allowsMixedLanguageTranscript(sessionLang: string): boolean {
  return sessionLang !== 'AR';
}
