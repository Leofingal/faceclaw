/**
 * Arbitrates the glasses' magnetometer compass (CFW mode-10 stream) among
 * running EvenHub apps, mirroring the IMU router. Only the foreground app
 * receives headings, so a backgrounded app can't keep the sensor running.
 *
 * The compass is NOT pre-calibrated — the magnetometer is in the right arm,
 * which rests on the head with a wearer-dependent curl (see compass-app memory);
 * headings are relative, not true north.
 */
import { addCompassListener, setCompassEnabled, COMPASS_CHANGED, type CompassEvent } from "../../native/compass";

export type EvenHubCompassClient = {
  readonly windowId: string;
  isForeground(): boolean;
  deliverCompass(headingDegrees: number): void;
};

class EvenHubCompassRouter {
  private readonly requesting = new Set<EvenHubCompassClient>();
  private active: EvenHubCompassClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private enabled = false;

  requestCompass(client: EvenHubCompassClient): void {
    this.requesting.add(client);
    this.evaluate();
  }

  releaseCompass(client: EvenHubCompassClient): void {
    if (!this.requesting.delete(client)) return;
    this.evaluate();
  }

  notifyEligibilityChanged(): void {
    this.evaluate();
  }

  private eligible(): EvenHubCompassClient | null {
    return Array.from(this.requesting).find((client) => client.isForeground()) ?? null;
  }

  private evaluate(): void {
    const next = this.eligible();
    this.active = next;
    if (next) {
      if (!this.unsubscribe) {
        this.unsubscribe = addCompassListener((event: CompassEvent) => {
          // Only heading updates carry a real heading; calibration events use -1.
          if (event.command === COMPASS_CHANGED && event.headingDegrees >= 0) {
            this.active?.deliverCompass(event.headingDegrees);
          }
        });
      }
      if (!this.enabled) {
        setCompassEnabled(true);
        this.enabled = true;
      }
    } else {
      if (this.enabled) {
        setCompassEnabled(false);
        this.enabled = false;
      }
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }
}

export const evenHubCompassRouter = new EvenHubCompassRouter();
