/**
 * "Settings" — faceclaw's own hub, which used to be what the phone opened on.
 * Round 3 swapped it with the Exocortex app list (see settings-hub-page.xml).
 *
 * Bound to MainViewModel and sharing its whole lifecycle with main-page and
 * the glasses mirror page; see hub-page.ts.
 */
export { hubPageNavigatingTo as navigatingTo, hubPageLoaded as loaded, hubPageUnloaded as unloaded } from './hub-page'
