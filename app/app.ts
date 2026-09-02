/*
In NativeScript, the app.ts file is the entry point to your application.
You can use this file to perform app-level initialization, but the primary
purpose of the file is to pass control to the app’s first module.
*/

import { Application } from '@nativescript/core'
import { registerShareIntentHandler } from './native/share-intents'
import { installNativeUserAgent } from './util/http'
import { resyncSystemAppearance } from './native/system-appearance'

installNativeUserAgent()
registerShareIntentHandler()

// Live system dark/light switches while the app is running were confirmed
// (Chris, both directions, 2026-09-02) to leave the Ghost companion's Terminal
// and Doc panes white-on-white and Rich View visually dark-locked -- while a
// COLD launch in either theme renders correctly. That proves the app.css
// .ns-dark rules themselves are right and the LIVE-UPDATE signal is the gap,
// not any one pane's styling -- see system-appearance.ts for the actual fix
// and why it resyncs from two triggers instead of trusting the framework's
// own automatic recolor alone.
Application.on(Application.systemAppearanceChangedEvent, resyncSystemAppearance)
Application.on(Application.resumeEvent, resyncSystemAppearance)

Application.run({ moduleName: 'app-root' })

// Don't place any code after the application has been started
