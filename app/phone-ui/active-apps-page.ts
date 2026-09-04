import { EventData, NavigatedData, Page } from "@nativescript/core";

import { ActiveAppsViewModel } from "./active-apps-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  const model = new ActiveAppsViewModel();
  page.bindingContext = model;
  model.attach();
}

/** Drop the live subscription when the page leaves, or every visit leaks one. */
export function unloaded(args: EventData): void {
  const page = args.object as Page;
  const model = page.bindingContext as ActiveAppsViewModel | undefined;
  model?.dispose();
}
