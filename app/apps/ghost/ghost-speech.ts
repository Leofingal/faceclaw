/**
 * Ghost's voice — the hearing-aid half of the design.
 *
 * The G2 has four microphones and no speaker, by Even's design, so the HUD is
 * the eyes and Chris's paired hearing aids are the ears. Nothing here
 * addresses the aids: we play to the phone's ordinary media output and the
 * phone routes it to whatever Bluetooth sink is active. That was already true
 * of the EvenHub build, where an <audio> element in the WebView did the same
 * thing — so this is plain Android audio, not something faceclaw has to
 * mediate over the BLE display channel.
 *
 * CONFIRMED BY CONSTRUCTION, not assumed: android.media.MediaPlayer with
 * USAGE_MEDIA / CONTENT_TYPE_SPEECH is the same route the phone-side
 * conversation player already uses (app/phone-ui/conversation-view-model.ts),
 * which is known to work in this app. What is NOT verified without hardware is
 * whether the aids are the active sink at the moment of playback — that is a
 * routing question owned by Android, and it is the one thing a click-test on
 * the glasses would settle. Flagged in the return doc.
 *
 * The audio itself is fetched by MediaPlayer directly from the box's /tts
 * route, with the auth header attached: setDataSource(Context, Uri, headers)
 * is what makes streaming possible without buffering a blob in JS first.
 */
import { Utils } from "@nativescript/core";

/**
 * Every cancel bumps this. A cancelled utterance's completion callback may
 * still fire, and an onEnd from speech we already abandoned would advance
 * whatever chained on it under Chris's feet.
 */
let speechSeq = 0;
let player: any = null;

export function stopGhostSpeech(): void {
  speechSeq++;
  releasePlayer();
}

function releasePlayer(): void {
  const dying = player;
  player = null;
  if (!dying) return;
  try {
    dying.stop();
  } catch {
    // Not started, or already finished: nothing to stop.
  }
  try {
    dying.release();
  } catch {
    // Already released.
  }
}

/**
 * Speak one line. `onEnd` fires only if nothing has cancelled speech in the
 * meantime — that guard is what lets a caller chain utterances safely.
 *
 * Deliberately fire-and-forget: a failure to speak must never take a screen
 * down, and every failure path still calls onEnd so a chain cannot stall on a
 * line that would not play.
 */
export function speakGhost(url: string, headers: Record<string, string>, onEnd?: () => void): void {
  stopGhostSpeech();
  const mine = speechSeq;
  const finish = () => {
    if (mine !== speechSeq) return;
    releasePlayer();
    onEnd?.();
  };
  try {
    const context = Utils.android?.getApplicationContext?.();
    if (!context) {
      finish();
      return;
    }
    // `any` throughout: the NativeScript Android typings model these as
    // overloaded Java signatures, and the marshalled forms (an interface
    // implemented from an object literal, a HashMap of headers) do not
    // typecheck against them without casts that would say less than this does.
    const media = new android.media.MediaPlayer() as any;
    try {
      media.setAudioAttributes(
        new android.media.AudioAttributes.Builder()
          .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
          .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      );
    } catch {
      // Pre-Lollipop shape, or a vendor build that refuses the attributes:
      // the default stream is still the right one, so play anyway.
    }
    const headerMap = new java.util.HashMap() as any;
    for (const name of Object.keys(headers)) headerMap.put(name, headers[name]);
    media.setDataSource(context, android.net.Uri.parse(url), headerMap);
    media.setOnPreparedListener(
      new android.media.MediaPlayer.OnPreparedListener({
        onPrepared: () => {
          Utils.executeOnMainThread(() => {
            if (mine !== speechSeq) return;
            try {
              media.start();
            } catch (error) {
              console.warn("ghost: tts start failed", error);
              finish();
            }
          });
        },
      }),
    );
    media.setOnCompletionListener(
      new android.media.MediaPlayer.OnCompletionListener({
        onCompletion: () => Utils.executeOnMainThread(finish),
      }),
    );
    media.setOnErrorListener(
      new android.media.MediaPlayer.OnErrorListener({
        onError: (_media: any, what: number, extra: number) => {
          console.warn(`ghost: tts error what=${what} extra=${extra}`);
          Utils.executeOnMainThread(finish);
          // True means "handled": without it the completion listener also
          // fires and the chain would advance twice.
          return true;
        },
      }),
    );
    player = media;
    // Async so a slow box cannot block the render loop the way prepare() would.
    media.prepareAsync();
  } catch (error) {
    console.warn("ghost: tts failed", error);
    finish();
  }
}
