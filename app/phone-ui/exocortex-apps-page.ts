import { NavigatedData, Page } from "@nativescript/core";

import { ExocortexAppsViewModel } from "./exocortex-apps-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  let model = page.bindingContext as ExocortexAppsViewModel | undefined;
  if (!model) {
    model = new ExocortexAppsViewModel();
    page.bindingContext = model;
  }
  model.reload();
}
