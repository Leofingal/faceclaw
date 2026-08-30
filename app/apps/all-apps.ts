import { type AppDefinition } from "./app-definition";
import exocortexApp from "./exocortex";
import ghostApp from "./ghost";
import launcherApp from "./launcher";
import timerApp from "./timer";
import calculatorApp from "./calculator";
import terminalApp from "./terminal";
import filesApp from "./files";
import musicApp from "./music";
import nightscoutApp from "./nightscout";
import transcribeApp from "./transcribe";
import microphonesApp from "./microphones";
import notificationsApp from "./notifications";
import calendarApp from "./calendar";
import weatherApp from "./weather";
import navigateApp from "./navigate";
import compassApp from "./compass";
import roamApp from "./roam";
import blocksApp from "./blocks";
import minesweeperApp from "./minesweeper";
import freecellApp from "./freecell";
import pinballApp from "./pinball";
import developerApp from "./developer";
import evenhubApp from "./evenhub";
import settingsApp from "./settings";

/**
 * Every app, in home-screen order. The sole registry: the controller, the
 * home screen, and the assistant tools all discover apps here.
 *
 * Order is load-bearing at the top of the list. The controller boots apps in
 * this order and the shell foregrounds the first window registered, so
 * Exocortex — the boot launcher — has to come first. It hides itself from the
 * app run it draws, as does the retired stock launcher behind it.
 */
export const ALL_APPS: readonly AppDefinition[] = [
  exocortexApp,
  ghostApp,
  launcherApp,
  timerApp,
  calculatorApp,
  terminalApp,
  filesApp,
  musicApp,
  nightscoutApp,
  transcribeApp,
  microphonesApp,
  notificationsApp,
  calendarApp,
  weatherApp,
  navigateApp,
  compassApp,
  roamApp,
  blocksApp,
  minesweeperApp,
  freecellApp,
  pinballApp,
  developerApp,
  evenhubApp,
  settingsApp,
];
