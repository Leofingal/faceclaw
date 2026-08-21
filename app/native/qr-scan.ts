import { Application } from "@nativescript/core";

declare const android: any;
declare const global: any;

/**
 * QR scanning by delegating to whatever scanner app the phone has installed,
 * via the de-facto-standard ZXing "SCAN" intent (Barcode Scanner, Binary Eye,
 * QR & Barcode Scanner, and others register for it). Faceclaw ships no decoder
 * and needs no camera permission of its own: the scanner app owns the camera
 * and hands back the decoded text.
 *
 * The cost is that scanning only works if such an app is installed;
 * isQrScannerAvailable reports that up front so the caller can say so instead
 * of launching into nothing. (resolveActivity can see other apps only because
 * the manifest already holds QUERY_ALL_PACKAGES for notification icons;
 * without it Android 11+ would need a <queries> entry for the action.)
 */

const SCAN_ACTION = "com.google.zxing.client.android.SCAN";
// Arbitrary, only has to be distinct from other startActivityForResult callers.
const SCAN_REQUEST_CODE = 0x51d0;

function buildScanIntent(): any {
  const intent = new android.content.Intent(SCAN_ACTION);
  intent.putExtra("SCAN_MODE", "QR_CODE_MODE");
  // Ask the scanner not to keep its own history of what we scanned.
  intent.putExtra("SAVE_HISTORY", false);
  return intent;
}

/** Whether any installed app answers the scan intent. */
export function isQrScannerAvailable(): boolean {
  if (!global.isAndroid) return false;
  const activity = Application.android?.foregroundActivity ?? Application.android?.startActivity;
  if (!activity) return false;
  try {
    return buildScanIntent().resolveActivity(activity.getPackageManager()) !== null;
  } catch {
    return false;
  }
}

/**
 * Launch the scanner and resolve with the decoded text, or null if the user
 * backed out. Rejects when no scanner app is installed or the activity can't
 * be reached.
 */
export function scanQrCode(): Promise<string | null> {
  if (!global.isAndroid) return Promise.reject(new Error("QR scanning needs Android."));
  const activity = Application.android?.foregroundActivity ?? Application.android?.startActivity;
  if (!activity) return Promise.reject(new Error("No foreground activity to scan from."));
  const intent = buildScanIntent();
  if (intent.resolveActivity(activity.getPackageManager()) === null) {
    return Promise.reject(new Error("No QR scanner app installed."));
  }
  return new Promise<string | null>((resolve, reject) => {
    const onResult = (args: { requestCode: number; resultCode: number; intent: any }) => {
      if (args.requestCode !== SCAN_REQUEST_CODE) return;
      Application.android.off(Application.android.activityResultEvent, onResult);
      if (args.resultCode !== android.app.Activity.RESULT_OK || !args.intent) {
        resolve(null);
        return;
      }
      const text = args.intent.getStringExtra("SCAN_RESULT");
      resolve(text === null || text === undefined ? null : String(text));
    };
    Application.android.on(Application.android.activityResultEvent, onResult);
    try {
      activity.startActivityForResult(intent, SCAN_REQUEST_CODE);
    } catch (error) {
      Application.android.off(Application.android.activityResultEvent, onResult);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
