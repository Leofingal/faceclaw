/**
 * Seeding the store with sample data, and the marker that keeps a screenshot
 * of it honest.
 *
 * Without live ring hardware there is nothing in the store, and two empty
 * screens prove nothing. So the preview build seeds `health-fixtures.ts`'
 * generated data and drops `fixture-marker.json` beside it; both surfaces read
 * `isFixtureData()` and show a "Sample data" badge whenever it is there.
 *
 * The badge is the point. A health screen full of plausible numbers with no
 * provenance is the one artefact from this work that could be mistaken for a
 * real capture later, so the marker travels with the data rather than living
 * in someone's memory of how a screenshot was taken.
 *
 * Real ingest never writes the marker, so the first genuine sync leaves it
 * exactly as it was - which is why `clearFixtures()` exists and why the live
 * wiring should call it before its first write.
 */

import { File, knownFolders } from "@nativescript/core";

import { buildFixtures, FIXTURE_VERSION } from "./health-fixtures";
import { healthStore } from "./health-store-files";

const MARKER_FILE = "fixture-marker.json";

function markerPath(): string {
  return `${knownFolders.documents().getFolder("health").path}/${MARKER_FILE}`;
}

type Marker = { version: number; seededAtMs: number; days: number };

function readMarker(): Marker | null {
  try {
    if (!File.exists(markerPath())) return null;
    const parsed = JSON.parse(File.fromPath(markerPath()).readTextSync()) as Marker;
    return typeof parsed?.version === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the store currently holds generated sample data. */
export function isFixtureData(): boolean {
  return readMarker() !== null;
}

/**
 * Seed sample data if none is present, or if the generator has changed since
 * the last seed. A no-op once seeded, so it is safe to call on every launch.
 */
export function seedFixturesIfNeeded(days = 45): boolean {
  const marker = readMarker();
  if (marker && marker.version === FIXTURE_VERSION && marker.days >= days) return false;
  return seedFixtures(days);
}

export function seedFixtures(days = 45): boolean {
  try {
    const store = healthStore();
    const { samples, sleep } = buildFixtures({ days, nowMs: Date.now() });
    store.ingestSamples(samples);
    store.ingestSleep(sleep);
    const marker: Marker = { version: FIXTURE_VERSION, seededAtMs: Date.now(), days };
    File.fromPath(markerPath()).writeTextSync(JSON.stringify(marker));
    return true;
  } catch (error) {
    console.warn("health fixture seed failed", error);
    return false;
  }
}

/** Drop the marker. Call before the first real ingest. */
export function clearFixtureMarker(): void {
  try {
    if (File.exists(markerPath())) File.fromPath(markerPath()).removeSync();
  } catch (error) {
    console.warn("health fixture marker clear failed", error);
  }
}
