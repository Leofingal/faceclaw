import { type AppDefinition } from "../app-definition";
import { createGhostAppWindow, GHOST_SURFACE_ID, GHOST_WINDOW_ID } from "./ghost-app";

/**
 * Ghost: a pager onto the live cc-web session on Chris's own box — the
 * status/notification feed, live approval prompts with scroll-and-tap answers,
 * dictation back into the session, and the full reply on demand.
 *
 * Ported from the EvenHub SDK app it replaces. The phone-side companion panel
 * was built across rounds 1-5. The news deck (the three-depth walk over a
 * pushed brief) is deliberately NOT part of Ghost at all any more — it
 * shipped as its own app, `app/apps/news/`, and this app's own feed poll
 * (ghost-client.ts's fetchFeed) filters `kind: 'news'` items out, so opening
 * Ghost never surfaces news whether Chris wants it or not.
 */
const ghostApp: AppDefinition = {
  appId: "ghost",
  title: "Ghost",
  icon: "activity",
  launch: (ctx) => ctx.launchInProcessApp(GHOST_WINDOW_ID, GHOST_SURFACE_ID, createGhostAppWindow),
};

export default ghostApp;
