/**
 * Caption language handling that needs no NativeScript, so the node tests can
 * pin it (tests/microphones-caption-lang.test.cjs): deciding a caption line's
 * language from the caption model's tag and the text's script, cleaning
 * SenseVoice's spacing, choosing what the glasses show, and the translation
 * log's line format.
 */

/** Settings value of the Microphones "Caption language" setting. */
export type CaptionLanguage = "english" | "asian";

export const CAPTION_LANGUAGES: readonly CaptionLanguage[] = ["english", "asian"];

export function captionLanguageLabel(value: CaptionLanguage): string {
  return value === "asian" ? "Japanese, Korean, Chinese" : "English";
}

/** The caption engine model kind (FaceclawCaptionEngine.MODEL_*) for a setting value. */
export function captionModelKind(value: string): "moonshine" | "sensevoice" {
  return value === "asian" ? "sensevoice" : "moonshine";
}

/** Languages the translation packs cover (ML Kit codes); English is built in. */
export const TRANSLATION_PACK_LANGS: readonly string[] = ["ja", "ko", "zh"];

const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const LATIN = /[A-Za-z]/;

export type ResolvedLang = { lang: string; source: "script" | "model" | "" };

/**
 * A caption line's language, before any ML Kit call. The script decides when
 * it is unambiguous: any kana means Japanese (Chinese never uses it), any
 * hangul means Korean. Otherwise the caption model's audio-based tag decides
 * (SenseVoice tags every utterance). Cantonese ("yue") translates through
 * ML Kit's Chinese model, so it maps to "zh". Returns lang "" when neither
 * settles it (Moonshine gives no tag), and the caller falls back to ML Kit's
 * text language identification.
 *
 * Why the script overrides the tag: on the desktop benchmark SenseVoice's tag
 * was right on 120/120 whole FLEURS clips, but a 5 s crop that began in
 * near-silence came back tagged "en" while the text was Japanese.
 */
export function resolveCaptionLang(modelLang: string, text: string): ResolvedLang {
  if (KANA.test(text)) return { lang: "ja", source: "script" };
  if (HANGUL.test(text)) return { lang: "ko", source: "script" };
  const tag = (modelLang || "").toLowerCase();
  const hasHan = HAN.test(text);
  if (tag === "yue") return { lang: "zh", source: "model" };
  if (tag === "zh" || tag === "ja" || tag === "ko") {
    // A CJK tag on Latin-only text (a stray "OK." or "Yes.") is English.
    if (!hasHan && LATIN.test(text)) return { lang: "en", source: "script" };
    return { lang: tag, source: "model" };
  }
  if (tag === "en") {
    // Han with no kana or hangul, tagged English: Chinese characters don't
    // come out of an English decode, so trust the script.
    if (hasHan) return { lang: "zh", source: "script" };
    return { lang: "en", source: "model" };
  }
  if (tag) return { lang: tag, source: "model" };
  return { lang: "", source: "" };
}

const CJK_CHAR = "[\\u3000-\\u303f\\u3040-\\u30ff\\u31f0-\\u31ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]";
// A space with CJK on one side and CJK or a digit on the other ("村 を", "30 分").
const SPACE_BETWEEN_CJK = new RegExp(`(${CJK_CHAR})\\s+(?=${CJK_CHAR}|[0-9])|([0-9])\\s+(?=${CJK_CHAR})`, "g");

/**
 * SenseVoice sometimes separates Japanese and Chinese tokens with spaces
 * ("興味 を そそ られる 村"). Neither language uses them, and they reach the
 * translator and the log, so drop spaces between two CJK characters, or
 * between a CJK character and a digit. Korean (hangul) keeps its spaces:
 * they are real word breaks there.
 */
export function compactCjkSpaces(text: string): string {
  return text.replace(SPACE_BETWEEN_CJK, "$1$2").trim();
}

export type TranslationState = "none" | "pending" | "done" | "failed";

/**
 * What the glasses show for one caption line, English only (Chris,
 * 2026-09-24): a translated line shows just its translation; a line waiting
 * on the translator shows a placeholder rather than the original, which the
 * glasses font can't draw for Japanese, Korean or Chinese anyway; a line that
 * could not be translated says so with its language. Lines in the target
 * language (and every line when translation is off) show their own text.
 */
export function glassesCaptionText(line: {
  text: string;
  translation: string;
  lang: string;
  translationState: TranslationState;
}): { text: string; dim: boolean } {
  if (line.translation) return { text: line.translation, dim: false };
  const tag = line.lang ? `[${line.lang}] ` : "";
  if (line.translationState === "pending") return { text: `${tag}...`, dim: true };
  if (line.translationState === "failed") {
    return { text: `${tag}(not translated: download the translation packs)`, dim: true };
  }
  return { text: line.text, dim: false };
}

/** Local calendar date YYYY-MM-DD, for the log's one-file-per-day name. */
export function localDateStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** ISO 8601 local time with the UTC offset, e.g. 2026-09-27T14:03:22.123+09:00. */
export function localIsoTime(date: Date): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  return (
    `${localDateStamp(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`
  );
}

export function translationLogFileName(date: Date): string {
  return `translation-log-${localDateStamp(date)}.jsonl`;
}

export type TranslationLogLine = {
  atMs: number;
  lang: string;
  langSource: string;
  text: string;
  english: string;
  translationState: TranslationState;
  speaker: string;
  model: string;
  audioMs: number;
  decodeMs: number;
  sessionId: number;
};

/**
 * One JSONL record per caption line. "en" holds the English: the translation,
 * or the line itself when it was already English; "" when it could not be
 * translated ("enState" says why).
 */
export function translationLogRecord(line: TranslationLogLine): string {
  const at = new Date(line.atMs);
  return JSON.stringify({
    t: localIsoTime(at),
    ms: line.atMs,
    lang: line.lang || "und",
    langFrom: line.langSource || "",
    text: line.text,
    en: line.english,
    enState: line.translationState,
    speaker: line.speaker,
    model: line.model,
    audioMs: Math.round(line.audioMs),
    decodeMs: Math.round(line.decodeMs),
    session: line.sessionId,
  });
}

/** A non-caption record (session start with the model's load cost, or stop). */
export function translationLogEvent(type: "start" | "stop", atMs: number, extra: Record<string, unknown>): string {
  return JSON.stringify({ type, t: localIsoTime(new Date(atMs)), ms: atMs, ...extra });
}
