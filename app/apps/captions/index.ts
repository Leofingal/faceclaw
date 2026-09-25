import { type AppDefinition } from "../app-definition";
import { CAPTIONS_SURFACE_ID, CAPTIONS_WINDOW_ID, createCaptionsAppWindow } from "./captions-app";

/**
 * Captions: one tap from the home screen to live captions (captions-app.ts).
 * The same captions as Microphones > Captions view, sharing its session.
 */
const captionsApp: AppDefinition = {
  appId: "captions",
  title: "Captions",
  icon: "type",
  launch: (ctx) =>
    ctx.launchInProcessApp(CAPTIONS_WINDOW_ID, CAPTIONS_SURFACE_ID, (options) => createCaptionsAppWindow(options)),
  // Opening it switches the glasses mic on, so restarting the phone app must
  // not reopen it on Chris's behalf.
  restoreOnStart: false,
};

export default captionsApp;
