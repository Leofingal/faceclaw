import { Utils } from "@nativescript/core";

import { TRANSLATION_PACK_LANGS } from "./caption-lang";

declare const com: any;
declare const java: any;

/**
 * On-device language identification and translation for captions, over ML
 * Kit (bundled language-id, per-pair translation models downloaded on
 * demand). Foreign-language captions show the original line with the
 * translation to the phone's default language beneath it.
 */

let languageIdentifier: any | null = null;
// Translators are expensive to build (model download on first use); cache by
// "src>dst" and keep the proxies referenced so they aren't GC'd mid-flight.
const translators = new Map<string, any>();
const downloadedPairs = new Set<string>();

/** The phone's default language as a two-letter code (the translation target). */
export function deviceLanguage(): string {
  if (!global.isAndroid) return "en";
  try {
    return String(java.util.Locale.getDefault().getLanguage() || "en");
  } catch {
    return "en";
  }
}

function successListener(resolve: (value: any) => void): any {
  return new com.google.android.gms.tasks.OnSuccessListener({
    onSuccess: (result: any) => resolve(result),
  });
}

function failureListener(reject: (reason: Error) => void): any {
  return new com.google.android.gms.tasks.OnFailureListener({
    onFailure: (error: any) => reject(new Error(String(error?.getMessage?.() ?? error))),
  });
}

/**
 * Identify the language of a caption line. Resolves to a BCP-47 code, or
 * "und" when ML Kit isn't confident. Short lines are noisy; callers should
 * apply hysteresis across consecutive finals before switching languages.
 */
export function identifyLanguage(text: string): Promise<string> {
  if (!global.isAndroid || !text.trim()) return Promise.resolve("und");
  return new Promise((resolve) => {
    try {
      if (!languageIdentifier) {
        languageIdentifier = com.google.mlkit.nl.languageid.LanguageIdentification.getClient();
      }
      languageIdentifier
        .identifyLanguage(text)
        .addOnSuccessListener(successListener((code: any) => resolve(String(code))))
        .addOnFailureListener(failureListener(() => resolve("und")));
    } catch (error) {
      console.warn(`language id failed: ${error}`);
      resolve("und");
    }
  });
}

function translatorFor(sourceLang: string, targetLang: string): any | null {
  const key = `${sourceLang}>${targetLang}`;
  const cached = translators.get(key);
  if (cached) return cached;
  try {
    const TranslateLanguage = com.google.mlkit.nl.translate.TranslateLanguage;
    const source = TranslateLanguage.fromLanguageTag(sourceLang);
    const target = TranslateLanguage.fromLanguageTag(targetLang);
    if (source == null || target == null) return null;
    const options = new com.google.mlkit.nl.translate.TranslatorOptions.Builder()
      .setSourceLanguage(source)
      .setTargetLanguage(target)
      .build();
    const translator = com.google.mlkit.nl.translate.Translation.getClient(options);
    translators.set(key, translator);
    return translator;
  } catch (error) {
    console.warn(`translator setup failed (${key}): ${error}`);
    return null;
  }
}

/**
 * Translate one caption line. Resolves to the translated text, or "" when the
 * pair is unsupported or the model download hasn't finished (translation of
 * later lines picks up once it has; downloads are WiFi-unrestricted since
 * caption sessions are live).
 */
export function translateText(text: string, sourceLang: string, targetLang: string): Promise<string> {
  if (!global.isAndroid || !text.trim() || sourceLang === targetLang) {
    return Promise.resolve("");
  }
  const translator = translatorFor(sourceLang, targetLang);
  if (!translator) return Promise.resolve("");
  const key = `${sourceLang}>${targetLang}`;
  return new Promise((resolve) => {
    const runTranslate = () => {
      translator
        .translate(text)
        .addOnSuccessListener(successListener((result: any) => resolve(String(result))))
        .addOnFailureListener(failureListener(() => resolve("")));
    };
    if (downloadedPairs.has(key)) {
      runTranslate();
      return;
    }
    try {
      const conditions = new com.google.mlkit.common.model.DownloadConditions.Builder().build();
      translator
        .downloadModelIfNeeded(conditions)
        .addOnSuccessListener(
          successListener(() => {
            downloadedPairs.add(key);
            runTranslate();
          }),
        )
        // Offline with the pack already on the phone, a failed download check
        // must not cost the line its translation: try anyway (translate()
        // itself fails if the pack really is missing).
        .addOnFailureListener(failureListener(() => runTranslate()));
    } catch (error) {
      console.warn(`translation model download failed (${key}): ${error}`);
      runTranslate();
    }
  });
}

// ---- translation packs (download before travel, then work offline) ----

export type TranslationPackStatus = "absent" | "downloading" | "ready" | "failed";

const packStatus = new Map<string, TranslationPackStatus>();
const packListeners = new Set<() => void>();

function notifyPacks(): void {
  packListeners.forEach((listener) => listener());
}

export function onTranslationPacksChanged(listener: () => void): () => void {
  packListeners.add(listener);
  return () => packListeners.delete(listener);
}

function remoteModelManager(): any {
  return com.google.mlkit.common.model.RemoteModelManager.getInstance();
}

function translateRemoteModel(lang: string): any | null {
  const TranslateLanguage = com.google.mlkit.nl.translate.TranslateLanguage;
  const code = TranslateLanguage.fromLanguageTag(lang);
  if (code == null) return null;
  return new com.google.mlkit.nl.translate.TranslateRemoteModel.Builder(code).build();
}

/**
 * Re-read which packs are on the phone (ML Kit's own record), then notify.
 * A pack mid-download keeps its "downloading" state.
 */
export function refreshTranslationPacks(): void {
  if (!global.isAndroid) return;
  for (const lang of TRANSLATION_PACK_LANGS) {
    if (packStatus.get(lang) === "downloading") continue;
    try {
      const model = translateRemoteModel(lang);
      if (!model) continue;
      remoteModelManager()
        .isModelDownloaded(model)
        .addOnSuccessListener(
          successListener((downloaded: any) => {
            if (packStatus.get(lang) === "downloading") return;
            const ready = Boolean(downloaded?.booleanValue ? downloaded.booleanValue() : downloaded);
            packStatus.set(lang, ready ? "ready" : packStatus.get(lang) === "failed" ? "failed" : "absent");
            notifyPacks();
          }),
        );
    } catch (error) {
      console.warn(`translation pack check failed (${lang}): ${error}`);
    }
  }
}

export function translationPackStatuses(): Array<{ lang: string; status: TranslationPackStatus }> {
  return TRANSLATION_PACK_LANGS.map((lang) => ({ lang, status: packStatus.get(lang) ?? "absent" }));
}

/**
 * Download the Japanese, Korean and Chinese packs (to the phone's language).
 * ML Kit keeps them until the app is uninstalled; after this, captions
 * translate with no network. Allowed on any network: Chris starts it at home.
 */
export function downloadTranslationPacks(): void {
  if (!global.isAndroid) return;
  const target = deviceLanguage();
  for (const lang of TRANSLATION_PACK_LANGS) {
    if (lang === target || packStatus.get(lang) === "downloading" || packStatus.get(lang) === "ready") continue;
    const translator = translatorFor(lang, target);
    if (!translator) {
      packStatus.set(lang, "failed");
      continue;
    }
    packStatus.set(lang, "downloading");
    try {
      const conditions = new com.google.mlkit.common.model.DownloadConditions.Builder().build();
      translator
        .downloadModelIfNeeded(conditions)
        .addOnSuccessListener(
          successListener(() => {
            downloadedPairs.add(`${lang}>${target}`);
            packStatus.set(lang, "ready");
            console.log(`translation pack ready: ${lang}>${target}, packs on disk ${translationPackBytes()} B`);
            notifyPacks();
          }),
        )
        .addOnFailureListener(
          failureListener((error) => {
            console.warn(`translation pack download failed (${lang}): ${error.message}`);
            packStatus.set(lang, "failed");
            notifyPacks();
          }),
        );
    } catch (error) {
      console.warn(`translation pack download failed (${lang}): ${error}`);
      packStatus.set(lang, "failed");
    }
  }
  notifyPacks();
}

/**
 * Bytes ML Kit's downloaded translation models occupy, measured on the phone
 * (its model folders under no_backup/ and files/ whose names mention
 * "translate"); -1 when none are found.
 */
export function translationPackBytes(): number {
  if (!global.isAndroid) return -1;
  try {
    const context = Utils.android.getApplicationContext();
    let total = 0;
    let found = false;
    const roots = [context.getNoBackupFilesDir(), context.getFilesDir()];
    for (const root of roots) {
      const children = root?.listFiles();
      if (!children) continue;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (String(child.getName()).toLowerCase().includes("translate")) {
          found = true;
          total += directoryBytes(child);
        }
      }
    }
    return found ? total : -1;
  } catch (error) {
    console.warn(`translation pack size failed: ${error}`);
    return -1;
  }
}

function directoryBytes(file: any): number {
  if (!file.isDirectory()) return Number(file.length());
  const children = file.listFiles();
  if (!children) return 0;
  let total = 0;
  for (let i = 0; i < children.length; i++) total += directoryBytes(children[i]);
  return total;
}

/** "ja ko zh ready (94 MB)" / "ja ready, ko 50%..." style summary for menus and rows. */
export function translationPacksSummary(): string {
  const statuses = translationPackStatuses();
  if (statuses.every((s) => s.status === "ready")) {
    const bytes = translationPackBytes();
    return bytes > 0 ? `ready (${Math.round(bytes / 1e6)} MB)` : "ready";
  }
  if (statuses.some((s) => s.status === "downloading")) {
    const done = statuses.filter((s) => s.status === "ready").length;
    return `downloading (${done}/${statuses.length})`;
  }
  const failed = statuses.filter((s) => s.status === "failed").map((s) => s.lang);
  if (failed.length) return `failed: ${failed.join(" ")} (tap to retry)`;
  const ready = statuses.filter((s) => s.status === "ready").map((s) => s.lang);
  return ready.length ? `${ready.join(" ")} ready, tap for rest` : "download (about 30 MB each)";
}
