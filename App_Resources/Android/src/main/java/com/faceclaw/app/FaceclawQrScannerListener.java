package com.faceclaw.app;

/** Callbacks for one FaceclawQrScanner.scan; exactly one method fires. */
public interface FaceclawQrScannerListener {
    void onResult(String text);

    void onCancelled();

    void onError(String message);
}
