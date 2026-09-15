import { type AppDefinition } from "../app-definition";
import { formatWeatherStatus } from "../exocortex/status-line";
import { hasLocationPermission } from "../../g2/android-permissions";
import { weatherBridge } from "../../native/weather";
import { createWeatherAppWindow, WEATHER_SURFACE_ID, WEATHER_WINDOW_ID } from "./weather-app";

const weatherApp: AppDefinition = {
  appId: "weather",
  title: "Weather",
  icon: "cloud-sun",
  launch: (ctx) => ctx.launchInProcessApp(WEATHER_WINDOW_ID, WEATHER_SURFACE_ID, createWeatherAppWindow),
  /**
   * Today's line from the bridge's CACHE — `snapshot()` clones an in-memory
   * object and nothing else. No fetch, no file, no promise.
   *
   * The chance of precipitation comes from the first forecast period rather
   * than from `current`, because the observation the current conditions are
   * built from carries temperature and sky but no probability at all.
   */
  statusLine: () => {
    const state = weatherBridge.snapshot();
    if (!state.current) return null;
    return formatWeatherStatus(
      {
        temperatureF: state.current.temperatureF,
        description: state.current.description,
        precipitationPercent: state.forecast[0]?.precipitationPercent ?? null,
        lastUpdatedMs: state.lastUpdatedMs,
      },
      Date.now(),
    );
  },
  /**
   * ⚠ THIS FETCHES WHILE THE APP IS CLOSED, which the bridge did not do
   * before. Chris asked for the aligned tick to refresh "everything with a
   * menu line, not just the ring", and a weather row whose cache only fills
   * when its app is opened would be blank exactly when it is most useful.
   *
   * Guarded on the permission rather than asking for it: a background tick is
   * the wrong moment to put a permission dialog in front of someone. Without
   * the permission this is a no-op and the row stays bare.
   */
  refreshStatus: () => {
    if (!hasLocationPermission()) return;
    void weatherBridge.refreshNow();
  },
};

export default weatherApp;
