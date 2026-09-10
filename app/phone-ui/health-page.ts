/**
 * Code-behind for the Health graph page.
 *
 * The chart is a bitmap rendered at the current pixel width (see
 * `health-view-model.ts`), so unlike a layout-driven chart it cannot reflow on
 * its own: every event that changes the available width has to ask for a
 * re-render. There are two - the orientation change, and the fold posture,
 * which the model subscribes to itself.
 *
 * `refreshFoldTracking()` needs an Activity and NativeScript has none until a
 * page is up, which is why the model's `attach()` runs from `loaded` rather
 * than at construction; the same reason `hub-page.ts` gives.
 */

import { Application, EventData, NavigatedData, Page } from "@nativescript/core";

import { HealthViewModel } from "./health-view-model";

type PageState = { model: HealthViewModel; orientationHandler: () => void };

function getState(page: Page): PageState | undefined {
  return (page as Page & { __healthState?: PageState }).__healthState;
}

function setState(page: Page, state?: PageState): void {
  (page as Page & { __healthState?: PageState }).__healthState = state;
}

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  page.bindingContext = new HealthViewModel();
}

export function loaded(args: EventData): void {
  const page = args.object as Page;
  cleanup(page);
  const model = page.bindingContext as HealthViewModel | null;
  if (!model) return;
  model.attach();
  const orientationHandler = () => {
    // A tick late: the new screen metrics are not readable from inside the
    // event itself. Same shape as hub-page.ts's handler.
    setTimeout(() => model.refreshLayout(), 0);
  };
  Application.on(Application.orientationChangedEvent, orientationHandler);
  setState(page, { model, orientationHandler });
  model.refreshLayout();
}

export function unloaded(args: EventData): void {
  cleanup(args.object as Page);
}

function cleanup(page: Page): void {
  const state = getState(page);
  if (!state) return;
  Application.off(Application.orientationChangedEvent, state.orientationHandler);
  state.model.dispose();
  setState(page, undefined);
}
