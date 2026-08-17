# faceclaw-extensions

Type definitions and a tiny helper for EvenHub apps that want to detect and use
**Faceclaw**-specific extension APIs.

[Faceclaw](https://github.com/jimrandomh/faceclaw) is an alternative host for
EvenHub apps: it runs them directly on the Even Realities G2 glasses instead of
through the stock Even Realities phone app. An app built against the standard
[`@evenrealities/even_hub_sdk`](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)
runs unchanged. This package lets it *optionally* light up a few extra
capabilities when it detects it's running inside Faceclaw.

## Design

There is exactly one entry point: the injected global
`window.getFaceclawExtensions`.

- Inside Faceclaw it is `(() => FaceclawExtensions) | null`.
- In the stock Even app (and browsers, and any other host) it is `undefined`.

Nothing on the standard SDK, on `window`, or on any built-in prototype is
modified — every Faceclaw capability lives behind this single global. That keeps
it obvious what is an extension, and means an app that uses these APIs still runs
correctly everywhere else (it just skips the extras). New capabilities are only
ever *added*, never changed, so pinning a version stays backwards-compatible.

## Install

```sh
npm install faceclaw-extensions
```

(Type-only today; no runtime dependencies.)

## Usage

```ts
import { getFaceclawExtensions } from "faceclaw-extensions";

const fc = getFaceclawExtensions();
if (!fc) {
  // Not running in Faceclaw — use only the standard EvenHub SDK.
} else {
  console.log("host:", fc.getVersion()); // e.g. "Faceclaw/0.4.0"

  // Pause work while the app isn't on-screen.
  const off = fc.addWindowLifecycleListener((e) => {
    if (e.type === "hidden" || e.type === "blurred") pause();
    if (e.type === "visible" || e.type === "focused") resume();
  });

  // Ask for the user's OpenAI key (opens a consent prompt on the glasses).
  const configured = await fc.getConfiguredApiKeys();
  if (configured.includes("openai")) {
    const granted = await fc.requestApiKeyAccess(["openai"]);
    if (granted.openai) startCloudFeature(granted.openai);
  }

  // Beep.
  await fc.playBuzzer([
    { freq: 880, ms: 90 },
    { freq: 0, duty: 0, ms: 40 }, // a rest
    { freq: 1320, ms: 160 },
  ]);
}
```

## API

See `src/index.ts` for the full, documented `FaceclawExtensions` interface. In
brief:

| Method | Description |
| --- | --- |
| `getVersion(): string` | Host version, e.g. `"Faceclaw/0.4.0"`. |
| `returnToAppSwitcher(): void` | Yield focus to the app switcher; keep running. |
| `quit(): void` | Close the app for real (not overridable). |
| `addWindowLifecycleListener(fn): () => void` | `visible`/`hidden` and `focused`/`blurred` events. |
| `getConfiguredApiKeys(): Promise<ApiKeyService[]>` | Which keys the user configured (names only). |
| `requestApiKeyAccess(services): Promise<Partial<Record<ApiKeyService, string>>>` | Prompt for and return key values. |
| `playBuzzer(steps): Promise<void>` | Play a piezo tone sequence. |

`ApiKeyService` is one of `"openai" | "anthropic" | "soniox" | "elevenlabs" | "mapbox"`.

## Stability

Pre-1.0: the surface may still change. Once it stabilizes, additive-only changes
are the rule.
