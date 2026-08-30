import { type AppDefinition } from "../app-definition";
import { createGhostAppWindow, GHOST_SURFACE_ID, GHOST_WINDOW_ID } from "./ghost-app";

/**
 * Ghost: a pager onto the live cc-web session on Chris's own box — the
 * status/notification feed, live approval prompts with scroll-and-tap answers,
 * dictation back into the session, and the full reply on demand.
 *
 * Ported from the EvenHub SDK app it replaces. Deferred from this first pass
 * and tracked rather than dropped: the news deck (the three-depth walk over a
 * pushed brief) and the phone-side companion panel.
 */
const ghostApp: AppDefinition = {
  appId: "ghost",
  title: "Ghost",
  icon: "activity",
  launch: (ctx) => ctx.launchInProcessApp(GHOST_WINDOW_ID, GHOST_SURFACE_ID, createGhostAppWindow),
};

export default ghostApp;
