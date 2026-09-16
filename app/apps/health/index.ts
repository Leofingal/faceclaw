import { type AppDefinition } from "../app-definition";
import { formatStepsStatus } from "../exocortex/status-line";
import { healthStepsToday, refreshHealthStatus } from "../../health/health-status";
import { createHealthAppWindow, HEALTH_SURFACE_ID, HEALTH_WINDOW_ID } from "./health-app";

const healthApp: AppDefinition = {
  appId: "health",
  title: "Health",
  icon: "activity",
  launch: (ctx) => ctx.launchInProcessApp(HEALTH_WINDOW_ID, HEALTH_SURFACE_ID, createHealthAppWindow),
  /**
   * Today's steps, from memory. The store read is in `refreshStatus` below;
   * this side of the contract never touches disk and never touches the ring.
   */
  statusLine: () => formatStepsStatus(healthStepsToday()),
  refreshStatus: () => refreshHealthStatus(),
};

export default healthApp;
