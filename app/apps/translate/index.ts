import { type AppDefinition } from "../app-definition";
import { createTranslateAppWindow, TRANSLATE_SURFACE_ID, TRANSLATE_WINDOW_ID } from "./translate-app";

/**
 * Translate: one tap from the home screen to Japanese/Korean/Chinese captions
 * shown in English (translate-app.ts). The same captions pipeline as
 * Microphones > Captions view, sharing its session. ("Captions" is reserved
 * for a later English app with voice ID.)
 */
const translateApp: AppDefinition = {
  appId: "translate",
  title: "Translate",
  icon: "type",
  launch: (ctx) =>
    ctx.launchInProcessApp(TRANSLATE_WINDOW_ID, TRANSLATE_SURFACE_ID, (options) => createTranslateAppWindow(options)),
  // Opening it switches the glasses mic on, so restarting the phone app must
  // not reopen it on Chris's behalf.
  restoreOnStart: false,
};

export default translateApp;
