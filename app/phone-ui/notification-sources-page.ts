import { NavigatedData, Page } from "@nativescript/core";

import { NotificationSourcesViewModel } from "./notification-sources-view-model";

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  let model = page.bindingContext as NotificationSourcesViewModel | undefined;
  if (!model) {
    model = new NotificationSourcesViewModel();
    page.bindingContext = model;
  }
  // Reload on every arrival: the list grows as notifications arrive, so
  // coming back to it should show anything discovered in the meantime.
  model.reload();
}
