import { Application, Color, EventData, isAndroid, Observable, Page, TextField } from '@nativescript/core'
import { MainViewModel } from './main-view-model'
import { dashboardController } from '../g2/dashboard-controller'

/**
 * Page lifecycle shared by the two pages that bind a MainViewModel: the home
 * hub (main-page) and the glasses mirror (glasses-mirror-page). Both host the
 * glasses-driven text-setting editor, both want the connection/warning state,
 * and both need the orientation metrics, so the wiring is identical and lives
 * here rather than being copied into two code-behinds.
 */

const SETTINGS_TEXT_COLOR = new Color('#222222')
const SETTINGS_BACKGROUND_COLOR = new Color('#ffffff')
const SETTINGS_PLACEHOLDER_COLOR = new Color('#666666')

export function hubPageNavigatingTo(args: EventData) {
  const page = <Page>args.object
  page.bindingContext = new MainViewModel()
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
 * Hide faceclaw's ActionBar while an app's companion is showing, so
 * phone-ui/exocortex-header is the only chrome above the app's own content
 * (see MainViewModel.companionActionBarHidden for why, and for the cost).
 *
 * GUARDED BY THE PAGE, not just by the model. Both pages here bind the same
 * MainViewModel, and `companionActionBarHidden` is true whenever Ghost is
 * foreground ON THE GLASSES — which can perfectly well be the case while the
 * wearer is looking at the glasses-mirror page. Only the page that actually
 * contains the companion body may act on it; the mirror page keeps its bar.
 * `companionChrome` is main-page.xml's companion wrapper, and getViewById
 * finds it whether or not it is currently collapsed.
 *
 * Always assigns, never toggles: the value is derived from which body is
 * showing, so there is no way for a missed event to strand the hub without
 * its ActionBar.
 */
function syncCompanionActionBar(page: Page, model: MainViewModel): void {
  if (!page.getViewById('companionChrome')) {
    return
  }
  page.actionBarHidden = model.companionActionBarHidden
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
  // the home hub's recent list reflects deletions and renames made elsewhere.
  model?.refreshRecentConversations()
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
      // The body swap is driven by the glasses (which app is foreground), not
      // by a navigation, so the ActionBar has to follow it from here.
      if (propertyArgs.propertyName === 'companionActionBarHidden') {
        syncCompanionActionBar(page, model)
      }
    },
  }

  model.on(Observable.propertyChangeEvent, state.propertyChangeHandler)
  Application.on(Application.orientationChangedEvent, state.orientationHandler)
  setPageState(page, state)
  // The fold/foreground state is already settled by the time we get here, so
  // set the bar to match rather than waiting for the next change event.
  syncCompanionActionBar(page, model)
  if (model.isTextSettingEditorActive) {
    focusTextEditor(page)
  }
}

export function hubPageUnloaded(args: EventData) {
  cleanupPage(args.object as Page)
}
