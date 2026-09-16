/**
 * The real, on-device backing for `HealthStore`: files under the app's
 * documents folder, using the same `@nativescript/core` File API that
 * `open-apps-persistence.ts` already uses for the open-window list.
 *
 * Split out from `health-store.ts` purely so that module can stay free of
 * NativeScript imports and run under plain node in `tests/`; all the logic
 * worth testing is over there.
 */

import { File, Folder, knownFolders } from "@nativescript/core";

import { HealthStore, type HealthStorageBackend } from "./health-store";

const FOLDER_NAME = "health";

function healthFolder(): Folder {
  return knownFolders.documents().getFolder(FOLDER_NAME);
}

function pathFor(name: string): string {
  return `${healthFolder().path}/${name}`;
}

class FileBackend implements HealthStorageBackend {
  exists(name: string): boolean {
    try {
      return File.exists(pathFor(name));
    } catch {
      return false;
    }
  }

  read(name: string): string | null {
    try {
      if (!File.exists(pathFor(name))) return null;
      return File.fromPath(pathFor(name)).readTextSync();
    } catch (error) {
      console.warn(`health store read failed (${name})`, error);
      return null;
    }
  }

  append(name: string, text: string): void {
    // `File.fromPath` creates the file when it is missing, and
    // `appendTextSync` is the durable single-call append - deliberately not
    // read-modify-write, which would put every record already on disk at
    // risk on every new one.
    //
    // THROWS on failure (2026-09-16). NativeScript's appendTextSync catches its
    // own Java exception and only reports it to the callback, so the callback
    // records it and it is rethrown here. This used to warn and return, and
    // the store then counted the lines as written: a silent loss.
    const errors: unknown[] = [];
    try {
      File.fromPath(pathFor(name)).appendTextSync(text, (error) => {
        errors.push(error ?? "unknown error");
      });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      console.error(`health store append FAILED (${name})`, errors[0]);
      throw new Error(`health store append failed (${name}): ${String(errors[0])}`);
    }
  }

  write(name: string, text: string): void {
    try {
      File.fromPath(pathFor(name)).writeTextSync(text, (error) => {
        console.warn(`health store write failed (${name})`, error);
      });
    } catch (error) {
      console.warn(`health store write threw (${name})`, error);
    }
  }

  list(): string[] {
    try {
      return healthFolder()
        .getEntitiesSync()
        .map((entity) => entity.name);
    } catch (error) {
      console.warn("health store list failed", error);
      return [];
    }
  }
}

let store: HealthStore | null = null;

/** The app's one health store. Created on first use. */
export function healthStore(): HealthStore {
  if (!store) store = new HealthStore(new FileBackend());
  return store;
}
