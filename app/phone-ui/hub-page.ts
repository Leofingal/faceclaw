import { Application, Color, EventData, isAndroid, Observable, Page, TextField } from '@nativescript/core'
import { MainViewModel } from './main-view-model'
import { dashboardController } from '../g2/dashboard-controller'

/**
 * Page lifecycle shared by the three pages that bind a MainViewModel: the
 * landing page (main-page), Settings — faceclaw's old hub (settings-hub-page)
 * — and the glasses mirror (glasses-mirror-page). All three host the
 * glasses-driven text-setting editor, all three want the connection/warning
 * state, and all three need the orientation metrics, so the wiring is
 * identical and lives here rather than being copied into three code-behinds.
 */

const SETTINGS_TEXT_COLOR = new Color('#222222')
const SETTINGS_BACKGROUND_COLOR = new Color('#ffffff')
const SETTINGS_PLACEHOLDER_COLOR = new Color('#666666')

export function hubPageNavigatingTo(args: EventData) {
  const page = <Page>args.object
  page.bindingContext = new MainViewModel()
  // Before the page is on screen, not after: main-page has no ActionBar and
  // must never paint a frame of the default one. `loaded` repeats it as a
  // backstop, and this is a straight assignment either way.
  syncActionBar(page)
}

type HubPageState = {
  model: MainViewModel
  propertyChangeHandler: (args: EventData & { propertyName?: string }) => void
  orientationHandler: () => void
}

function getPageState(page: Page): HubPageState | undefined {
  return (page as Page & { __hubPageState?: HubPageState }).__hubPageState
}

function setPageState(page: Page, state?: HubPageState): void {
  ;(page as Page & { __hubPageState?: HubPageState }).__hubPageState = state
}

function cleanupPage(page: Page): void {
  const state = getPageState(page)
  if (!state) {
    setPageState(page, undefined)
    return
  }
  state.model.off(Observable.propertyChangeEvent, state.propertyChangeHandler)
  Application.off(Application.orientationChangedEvent, state.orientationHandler)
  // navigatingTo builds a fresh model each visit; drop the old one's
  // controller/settings subscriptions or every navigation leaks a listener.
  state.model.dispose()
  setPageState(page, undefined)
}

function applySettingsTextFieldContrast(textField: TextField): void {
  textField.color = SETTINGS_TEXT_COLOR
  textField.backgroundColor = SETTINGS_BACKGROUND_COLOR
  textField.placeholderColor = SETTINGS_PLACEHOLDER_COLOR

  if (!isAndroid) {
    return
  }

  const nativeTextField = (textField as TextField & { nativeView?: android.widget.EditText }).nativeView
  if (!nativeTextField) {
    return
  }

  nativeTextField.setTextColor(android.graphics.Color.rgb(34, 34, 34))
  nativeTextField.setHintTextColor(android.graphics.Color.rgb(102, 102, 102))
  // Editing an existing value usually means replacing it: select all on focus
  // so typing starts fresh but the current value stays visible.
  nativeTextField.setSelectAllOnFocus(true)
}

/**
 * Leaving keyboard-input mode: the glasses navigated away from the text
 * setting, so the phone's keyboard has nothing to type into any more.
 */
function dismissTextEditorKeyboard(page: Page): void {
  page.getViewById<TextField>('settingsTextField')?.dismissSoftInput()
  page.getViewById<TextField>('secondarySettingsTextField')?.dismissSoftInput()
}

/**
 * True only for main-page, which round 3 left as the one page here with no
 * ActionBar of its own — phone-ui/exocortex-header is its whole chrome, over
 * every body it can show. `exocortexChrome` is that header-plus-body wrapper,
 * and getViewById finds it whether or not it is currently collapsed.
 *
 * The other two pages have real ActionBars they must keep: Settings carries
 * the whole overflow menu, and the mirror page carries the screenshot/record
 * items. So this is a page test, not a model test — all three bind the same
 * MainViewModel and could not tell each other apart from its state.
 */
function isExocortexChromePage(page: Page): boolean {
  return Boolean(page.getViewById('exocortexChrome'))
}

/**
 * main-page declares no <ActionBar>, but NativeScript will still put a default
 * one up unless the page is told not to, and that empty bar is exactly the
 * ~56dp of faceclaw chrome round 2 spent effort removing. Assign rather than
 * toggle, on every load, so no path can leave it showing.
 */
function syncActionBar(page: Page): void {
  if (isExocortexChromePage(page)) {
    page.actionBarHidden = true
  }
}

function focusTextEditor(page: Page): void {
  setTimeout(() => {
    const textField = page.getViewById<TextField>('settingsTextField')
    const secondaryTextField = page.getViewById<TextField>('secondarySettingsTextField')
    if (textField) {
      applySettingsTextFieldContrast(textField)
    }
    if (secondaryTextField) {
      applySettingsTextFieldContrast(secondaryTextField)
    }
    textField?.focus()
  }, 0)
}

export function hubPageLoaded(args: EventData) {
  const page = args.object as Page
  cleanupPage(page)
  dashboardController.refreshEvenAppStatus()

  const model = page.bindingContext as MainViewModel | null
  // Re-subscribe after a suspend/resume cycle (unloaded disposed the model);
  // a no-op on the first load after construction.
  model?.attach()
  // Automatically connect on reaching the page (no-op if already connected or
  // if no glasses are configured).
  void model?.autoConnect()
  // Reopen the apps that were open before the last restart (no-op after the
  // first load).
  void dashboardController.restoreOpenApps()
  const settingsTextField = page.getViewById<TextField>('settingsTextField')
  model?.refreshLayoutMetrics()
  // Jetpack WindowManager needs an Activity, which exists only once a page is
  // up; and a suspend/resume can hand us a different one. Idempotent when the
  // Activity has not changed.
  model?.refreshFoldMetrics()
  // Cheap (three rows, newest-first) and re-run on every back-navigation, so
  // Settings' recent list reflects deletions and renames made elsewhere.
  model?.refreshRecentConversations()
  // The app list is main-page's body, and its two controls are shared state
  // with the glasses — so rebuild it on every arrival rather than trusting
  // whatever the last visit left, and only on the page that shows it.
  if (model && isExocortexChromePage(page)) {
    model.appList.reload()
  }
  if (settingsTextField) {
    applySettingsTextFieldContrast(settingsTextField)
  }
  if (!model) {
    return
  }

  const state: HubPageState = {
    model,
    orientationHandler: () => {
      setTimeout(() => {
        model.refreshLayoutMetrics()
      }, 0)
    },
    propertyChangeHandler: (propertyArgs) => {
      if (propertyArgs.propertyName === 'activeTextSettingId') {
        if (model.isTextSettingEditorActive) {
          focusTextEditor(page)
        } else {
          dismissTextEditorKeyboard(page)
        }
      }
    },
  }

  model.on(Observable.propertyChangeEvent, state.propertyChangeHandler)
  Application.on(Application.orientationChangedEvent, state.orientationHandler)
  setPageState(page, state)
  // Round 2 had to re-run this on every body change, because the bar came and
  // went with the companion. It does not any more — main-page never has one —
  // so once per load is the whole of it.
  syncActionBar(page)
  if (model.isTextSettingEditorActive) {
    focusTextEditor(page)
  }
}

export function hubPageUnloaded(args: EventData) {
  cleanupPage(args.object as Page)
}
