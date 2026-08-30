/**
 * The glasses mirror: the live lens preview plus the simulated ring/watch
 * input surfaces. This is a debugging view — the phone's own screens are the
 * primary experience and live on the home hub (main-page). Everything here is
 * the layout the home hub used to open on, moved wholesale, so its lifecycle
 * is the same shared one; see hub-page.ts.
 */
export { hubPageNavigatingTo as navigatingTo, hubPageLoaded as loaded, hubPageUnloaded as unloaded } from './hub-page'
