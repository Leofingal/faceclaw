import { CLOUD_STT_SAMPLE_RATE, CloudSttClient, CloudSttOptions } from "./cloud-stt";
import { ghostHostSetting, ghostSessionSetting, ghostTokenSetting } from "../ui/dashboard-settings";
import { fetchWithUserAgent } from "../util/http";

/**
 * Box-side speech-to-text: send the whole push-to-talk utterance to Chris's
 * own Ghost box (Fedora Server N150 mini PC, no GPU/NPU) over Tailscale, and
 * get text back. A genuinely local, non-third-party fourth CloudSttClient,
 * alongside ElevenLabs/OpenAI/Soniox -- distinct from the two On-device
 * options in that audio still leaves the phone (just not to a vendor), so
 * it's a home-network option, not one for use anywhere the phone's own mic
 * models are (e.g. at work, per Chris's own constraint on this feature).
 *
 * IMPORTANT — this reuses an EXISTING route, not a new one. The dispatch
 * instruction that asked for this asked for "a new route, modeled on the
 * existing /tts pattern"; investigating apps/claude-code-web/src/server.js
 * found `POST /api/glasses/:sessionId/audio` already does exactly this,
 * already tuned against real glasses captures (see
 * apps/claude-code-web/src/utils/stt.js: transformers.js running
 * onnx-community/whisper-base.en at q8, base.en chosen over tiny.en/small.en
 * by measured RTF + accuracy on this exact box). Pointing this client at the
 * existing route instead of duplicating that engine choice was a judgment
 * call made in the dispatch, not something the instruction anticipated --
 * flagged in the return doc. It also means this client, unlike its three
 * WebSocket-based siblings, does not stream: sherpa-onnx/whisper.cpp/
 * transformers.js all transcribe a complete buffer at once, and push-to-talk
 * already gives a clean utterance boundary, so PCM is buffered locally and
 * sent as ONE request on finish() -- no partial/live transcript, matching
 * how /tts is a single request/response rather than a socket.
 *
 * Auth and host resolution intentionally duplicate the tiny helpers in
 * apps/ghost/ghost-client.ts (ghostHost() / ghostAuthHeaders()) rather than
 * importing them: native/ never imports from apps/ in this codebase (see
 * native/nightscout-bridge.ts for the established native/ -> ui/ direction
 * instead), so the settings objects moved to ui/dashboard-settings.ts and
 * this file re-derives the same three-line logic from them. Keep both in
 * sync if the auth/host scheme ever changes.
 */

export type GhostSttOptions = CloudSttOptions;

export class GhostSttClient implements CloudSttClient {
  private closed = false;
  private readonly chunks: Uint8Array[] = [];
  private totalBytes = 0;

  constructor(private readonly options: GhostSttOptions) {}

  start(): void {
    this.closed = false;
    this.chunks.length = 0;
    this.totalBytes = 0;
    const sessionId = ghostSessionSetting.get().trim();
    if (!sessionId) {
      // Mirrors the "no key set; using on-device voice" UX the three cloud
      // providers use for a missing API key -- voice-control.ts's
      // createCloudClient() checks this BEFORE constructing this client, so
      // reaching here with no session id would only happen if that check and
      // this one drift apart. Kept as a real (if redundant) guard rather
      // than an assertion, since a silent no-op here would be a much worse
      // failure than a status message.
      this.options.onError("No Ghost session id set (Settings > Voice); using on-device voice.");
      return;
    }
    this.options.onStatus("Listening (Ghost box)...");
  }

  /** Feed PCM (16 kHz signed-16-bit LE); buffered, not streamed -- see class comment. */
  acceptPcm(pcm: Uint8Array): void {
    if (this.closed || pcm.length === 0) return;
    this.chunks.push(pcm);
    this.totalBytes += pcm.length;
  }

  /** End of utterance: POST the whole buffer and wait for one transcript. */
  finish(): void {
    if (this.closed) return;
    const sessionId = ghostSessionSetting.get().trim();
    if (!sessionId) {
      this.options.onError("No Ghost session id set (Settings > Voice).");
      return;
    }
    // Silence must not become a fabricated message: an utterance too short
    // to plausibly contain speech is reported as empty locally, same as the
    // box's own "[BLANK_AUDIO]" handling in utils/stt.js, without spending a
    // round trip on it. ~0.1s at 16 kHz 16-bit mono.
    const MIN_BYTES = 3200;
    if (this.totalBytes < MIN_BYTES) {
      this.options.onTranscript({ text: "", isFinal: true });
      return;
    }
    const body = concatChunks(this.chunks, this.totalBytes);
    const ms = Math.round((this.totalBytes / 2 / CLOUD_STT_SAMPLE_RATE) * 1000);
    this.options.onStatus("Transcribing (Ghost box)...");
    const url = `${ghostHost()}/api/glasses/${encodeURIComponent(sessionId)}/audio?ms=${ms}`;
    fetchWithUserAgent(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...ghostAuthHeaders() },
      // UNVERIFIED (no device to test on): NativeScript's fetch is documented
      // to accept an ArrayBufferView/ArrayBuffer body, matching the standard
      // Fetch BodyInit -- but nothing else in this codebase currently POSTs
      // binary data through fetchWithUserAgent to confirm it works exactly
      // this way here (the three WebSocket cloud clients send binary over a
      // separate custom Java bridge, not this path). Flagged in the dispatch
      // return doc as the one real-hardware check this feature most needs.
      body,
    })
      .then(async (response) => {
        if (this.closed) return;
        const data = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
        if (!response.ok) {
          this.options.onError(`Ghost box: ${String(data?.error ?? response.status)}`);
          return;
        }
        this.options.onTranscript({ text: String(data?.text ?? ""), isFinal: true });
      })
      .catch((error) => {
        if (this.closed) return;
        this.options.onError(`Ghost box connection failed: ${String((error as Error)?.message ?? error)}`);
      });
  }

  stop(): void {
    this.closed = true;
    this.chunks.length = 0;
    this.totalBytes = 0;
  }
}

/** Same address the Ghost app's feed poller uses -- see apps/ghost/ghost-client.ts's ghostHost(). */
function ghostHost(): string {
  return ghostHostSetting.get();
}

/** Same bearer-token derivation as apps/ghost/ghost-client.ts's ghostAuthHeaders(). */
function ghostAuthHeaders(): Record<string, string> {
  const token = ghostTokenSetting.get();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
