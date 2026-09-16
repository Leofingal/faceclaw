import { type AppDefinition } from "../app-definition";
import { formatGhostStatus, msUntilGhostStatusChange } from "../exocortex/status-line";
import { createGhostAppWindow, GHOST_SURFACE_ID, GHOST_WINDOW_ID } from "./ghost-app";
import { ghostLastMessageMs } from "./ghost-companion-store";

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
  icon: "tlc",
  launch: (ctx) => ctx.launchInProcessApp(GHOST_WINDOW_ID, GHOST_SURFACE_ID, createGhostAppWindow),
  /**
   * How long ago Ghost's last message arrived. Chris's own observation when
   * he specified this: it needs no fetch at all — the feed has already been
   * polled by the app itself, and the timestamp is sitting in memory.
   *
   * No `refreshStatus`: there is nothing to refresh. The row simply ages.
   */
  statusLine: () => formatGhostStatus(ghostLastMessageMs(), Date.now()),
  /** The row ages by itself, so tell the home screen when to repaint it. */
  statusLineChangesInMs: () => msUntilGhostStatusChange(ghostLastMessageMs(), Date.now()),
};

export default ghostApp;
