import { Utils } from "@nativescript/core";

import { type RawAdvertisement } from "../g2/even-advertisement";
import { DiscoveryAggregator } from "../g2/pairing-candidates";

declare const com: any;

export type DiscoveryEvents = {
  onAdvertisement: (raw: RawAdvertisement) => void;
  onScanFailed?: (code: number, message: string) => void;
  onLog?: (line: string) => void;
};

export type DiscoveredAddressSet = {
  left: string;
  right: string;
  ring: string;
  summary: string;
};

/**
 * TS wrapper around the native FaceclawDeviceDiscovery. The live scan streams
 * raw advertisements (see `RawAdvertisement`); protocol decoding happens in
 * `app/g2/even-advertisement.ts` and pair grouping in
 * `app/g2/pairing-candidates.ts`.
 */
export class DeviceDiscoveryBridge {
  private readonly discovery: any;
  private listenerProxy: any = null;
  private events: DiscoveryEvents | null = null;

  constructor() {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");
    this.discovery = new com.faceclaw.app.FaceclawDeviceDiscovery(context);
  }

  get bluetoothEnabled(): boolean {
    return !!this.discovery.isBluetoothEnabled();
  }

  get scanning(): boolean {
    return !!this.discovery.isScanning();
  }

  /** Start (or re-target) the live scan. Returns false when the radio is off. */
  startScan(events: DiscoveryEvents): boolean {
    this.events = events;
    if (!this.listenerProxy) {
      this.listenerProxy = new com.faceclaw.app.FaceclawDeviceDiscoveryListener({
        onAdvertisement: (json: string) => {
          const raw = parseRaw(String(json));
          if (raw) this.events?.onAdvertisement(raw);
        },
        onScanFailed: (code: number, message: string) => this.events?.onScanFailed?.(Number(code), String(message)),
        onLog: (line: string) => this.events?.onLog?.(String(line)),
      });
      this.discovery.setListener(this.listenerProxy);
    }
    return !!this.discovery.startScan();
  }

  stopScan(): void {
    try {
      this.discovery.stopScan();
    } catch {
      // ignore
    }
  }

  /** Push bonded Even devices through the listener as `source: "paired"` entries. */
  emitBondedDevices(): void {
    if (!this.listenerProxy) return;
    this.discovery.emitBondedDevices();
  }

  async getBondedCandidates(): Promise<RawAdvertisement[]> {
    return parseRawArray(String(this.discovery.getBondedCandidatesJson()));
  }

  /**
   * Collect advertisements for `timeoutMs` without blocking the UI thread
   * (scan callbacks are delivered on the main looper, so a blocking sleep
   * there would starve them). Every sample is kept: Android can split one
   * advertisement across reports (name in one, manufacturer data in another),
   * so "latest per address" would drop the informative half — the aggregator
   * in `buildAddressSet` merges them instead.
   */
  scanCandidates(timeoutMs = 6000): Promise<RawAdvertisement[]> {
    return new Promise((resolve, reject) => {
      const samples: RawAdvertisement[] = [];
      const started = this.startScan({
        onAdvertisement: (raw) => samples.push(raw),
        onScanFailed: (code, message) => {
          this.stopScan();
          reject(new Error(`Bluetooth scan failed: ${message} (${code})`));
        },
      });
      if (!started) {
        reject(new Error("Bluetooth is off or BLE scanning is unavailable."));
        return;
      }
      setTimeout(() => {
        this.stopScan();
        resolve(samples);
      }, Math.max(500, timeoutMs));
    });
  }
}

/**
 * Pick one address per role from a batch of raw advertisements — the manual
 * address page's "load" helper and the flash flow's address resolution.
 *
 * Runs the batch through the same `DiscoveryAggregator` the pairing page
 * uses, so left/right come from ONE serial-joined pair (the closest complete
 * one) rather than from whichever arm of whatever pair advertised last —
 * "latest per role" silently welded together arms of two different pairs.
 * When no arm carries a serial at all (a bonded-device listing has no
 * manufacturer data), there is nothing to join on and the latest arm per side
 * is used as before.
 */
export function buildAddressSet(candidates: RawAdvertisement[]): DiscoveredAddressSet {
  const aggregator = new DiscoveryAggregator();
  for (const raw of candidates) aggregator.ingest(raw);
  const classified = aggregator.advertisements();
  const pairs = aggregator.pairs();

  let left = "";
  let right = "";
  const completePair = pairs.find((pair) => pair.completeness === "complete");
  if (completePair) {
    left = completePair.left!.address;
    right = completePair.right!.address;
  } else if (classified.every((candidate) => !candidate.serial)) {
    for (const role of ["left", "right"] as const) {
      const latest = classified
        .filter((candidate) => candidate.role === role)
        .sort((a, b) => b.seenAtMs - a.seenAtMs)[0];
      if (role === "left") left = latest?.address ?? "";
      else right = latest?.address ?? "";
    }
  }
  // Arms with serials but no complete pair: leave the addresses empty. The
  // summary below names what was heard; guessing would defeat the serial join.

  const lines = classified.map((candidate) => {
    const extras = [candidate.serial ? `serial ${candidate.serial}` : null, candidate.rssi != null ? `${candidate.rssi} dBm` : null].filter(Boolean);
    return `${candidate.role}: ${candidate.name} ${candidate.address}${extras.length ? ` (${extras.join(", ")})` : ""}`;
  });
  return {
    left,
    right,
    ring: aggregator.rings()[0]?.advertisement.address ?? "",
    summary: lines.length ? lines.join("\n") : "No matching devices found.",
  };
}

function parseRawArray(json: string): RawAdvertisement[] {
  const items = JSON.parse(json) as unknown[];
  return items.map((item) => parseRawObject(item)).filter((item): item is RawAdvertisement => !!item);
}

function parseRaw(json: string): RawAdvertisement | null {
  try {
    return parseRawObject(JSON.parse(json));
  } catch {
    return null;
  }
}

function parseRawObject(item: unknown): RawAdvertisement | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const address = String(record.address ?? "");
  if (!address) return null;
  return {
    address,
    name: String(record.name ?? ""),
    manufacturerData: String(record.manufacturerData ?? ""),
    rssi: numberOrNull(record.rssi),
    txPower: numberOrNull(record.txPower),
    connectable: typeof record.connectable === "boolean" ? record.connectable : null,
    bonded: record.bonded === true,
    source: record.source === "paired" ? "paired" : "scan",
    seenAtMs: numberOrNull(record.seenAtMs) ?? Date.now(),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
