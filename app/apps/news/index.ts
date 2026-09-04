import { type AppDefinition } from "../app-definition";
import { createNewsAppWindow, NEWS_SURFACE_ID, NEWS_WINDOW_ID } from "./news-app";

/**
 * News: the three-depth morning brief, as its own real app rather than a
 * mode folded into Ghost's pager.
 *
 * Ported from the retired EvenHub build (TheLimitCase apps/ghost/src/main.ts
 * and news-fixture.ts) — headline at rest, Ghost's take and why-it's-here one
 * tap in, an open mic to ask a follow-up one tap further, narrated over the
 * box's live /tts route (Piper) as it walks.
 *
 * Deliberately its own window, not a mode inside Ghost: opening News is now
 * the whole invocation. Ghost's own feed poll no longer surfaces `kind:
 * 'news'` items at all (see ghost-client.ts's fetchFeed) — so a morning
 * that starts with a pushed deck no longer means Ghost opens showing news
 * whether Chris wants it or not.
 */
const newsApp: AppDefinition = {
  appId: "news",
  title: "News",
  icon: "file-text",
  launch: (ctx) => ctx.launchInProcessApp(NEWS_WINDOW_ID, NEWS_SURFACE_ID, createNewsAppWindow),
};

export default newsApp;
