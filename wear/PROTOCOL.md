# Watch ⇄ phone protocol

Transport: the Wearable Data Layer (Google Play services). Both apps share the
`com.faceclaw.app` application id and, for release builds, the signing key —
the Data Layer routes only between matching apps. Payloads are UTF-8 JSON
objects. Phone side: `App_Resources/.../FaceclawWearBridge.java` (transport),
`app/native/wear-bridge.ts` (JS wrapper), `app/g2/wear-remote.ts` (meaning).
Watch side: `app/src/main/kotlin/com/faceclaw/wear/Protocol.kt`, `PhoneLink.kt`.

Capabilities (`res/values/wear.xml` on each side): the phone advertises
`faceclaw_phone`, the watch `faceclaw_watch`. Each side finds the other with
`CapabilityClient.getCapability(…, FILTER_REACHABLE)`.

Every watch → phone message carries `seq` (monotonic per watch process) and is
answered on `/faceclaw/ack`.

## Watch → phone (MessageClient)

| Path | Payload | Effect |
| --- | --- | --- |
| `/faceclaw/input` | `{gesture, steps?}` | A ring gesture through the same path as the phone UI's test buttons. `gesture` ∈ `click`, `double-click`, `scroll-up`, `scroll-down`, `long-press` (complete short hold), `long-press-start`, `long-press-release`, `wakeword` ("Hey Even"), `swipe-up`, `swipe-down`, `swipe-left`, `swipe-right` (spatial input only a watch can produce: delivered to the glasses UI as `swipe-*` events for components that navigate spatially — launcher grid, settings columns, sidebar, Music — with a scroll / click / double-click fallback elsewhere). `steps` (1–12) repeats a scroll. Refused while the glasses are disconnected. The lock screen is honoured exactly as for the ring (only a double-click reaches it, toggling the locked display). |
| `/faceclaw/command` | `{command, …}` | `launch-app {appId}`, `focus-window {windowId}`, `close-window {windowId}`, `sidebar`, `wake`, `sleep`, `lock`, `unlock`, `connect`, `disconnect`, `close-assistant`, `display-mode {value}` (`value` ∈ `576x288`, `576x480`, `640x480`; sets the phone's Display > Display mode). Everything but connect/disconnect needs a connection; everything but lock/unlock is refused while locked; `unlock` also needs the phone's "Watch can unlock glasses" setting. |
| `/faceclaw/assistant` | `{text}` | Send a query to the assistant (`shell.sendToAssistant`) — the reply shows on the glasses and streams back to the watch as events. |
| `/faceclaw/text` | `{text}` | Type text into the foreground window (`receiveTextInput`, e.g. the terminal). Refused when the window doesn't take text. |
| `/faceclaw/state/request` | `{}` | Re-publish the state item even if unchanged. |

All of the above except `state/request` are refused with `ok:false` when the
phone's "Watch remote control" setting is off.

## Phone → watch

`/faceclaw/ack` (MessageClient, to the sender):
`{seq, ok, jsReady, message}`. `jsReady:false` means Play services started the
app process for the message but the JS dashboard isn't up (the user has not
opened Faceclaw since boot); the watch shows "Open Faceclaw on the phone".

`/faceclaw/event` (MessageClient, to every reachable watch):
- `{type:"assistant", phase, text}` — `phase` ∈ `thinking`, `streaming` (text so
  far, replace semantics, ≤ 4/s), `done` (final text), `error` (message),
  `closed` (overlay dismissed).
- `{type:"alert", text}` — a `glasses.show_alert` popup.
Both are gated by the phone's "Mirror assistant to watch" setting.

`/faceclaw/state` (DataClient item, keys `json` and `updatedAt`): the mirrored
dashboard state, re-sent whenever it changes (and at least every 30 s):

```json
{
  "protocol": 1, "version": "…",
  "phase": "connected", "status": "…", "connected": true,
  "screenOn": true, "locked": false, "worn": true, "listening": false,
  "battery": 78, "charging": false,
  "foreground": {"appId": "music", "title": "Music"},
  "windows": [{"windowId": "…", "title": "…", "appId": "…", "focused": true, "closeable": true, "acceptsText": false}],
  "apps": [{"appId": "timer", "title": "Timer"}],
  "displayMode": "576x288",
  "remoteEnabled": true, "canUnlock": true, "mirrorAssistant": true,
  "assistantAvailable": true
}
```

`protocol` is reserved for incompatible revisions of this format (nothing
checks it yet); `displayMode` mirrors the phone's Display > Display mode and
is what the `display-mode` command changes.

`apps` is the launcher grid plus installed EvenHub packages, i.e. exactly what
the assistant's `apps.launch` tool accepts.
