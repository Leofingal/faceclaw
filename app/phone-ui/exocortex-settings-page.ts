import { NavigatedData, Page } from "@nativescript/core";

import { ExocortexSettingsViewModel } from "./exocortex-settings-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  let model = page.bindingContext as ExocortexSettingsViewModel | undefined;
  if (!model) {
    model = new ExocortexSettingsViewModel();
    page.bindingContext = model;
  }
  // Values can have been changed from the sub-pages while this page sat on the
  // back stack — and `unloaded` released the change listeners, so re-attach
  // before re-reading rather than only refreshing once and going deaf.
  model.attach();
  model.refresh();
}

export function unloaded(args: { object: Page }): void {
  const model = args.object?.bindingContext as ExocortexSettingsViewModel | undefined;
  model?.dispose();
}
