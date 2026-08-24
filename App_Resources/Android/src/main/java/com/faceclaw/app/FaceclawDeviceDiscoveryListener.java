package com.faceclaw.app;

/** Callbacks from FaceclawDeviceDiscovery's live scan to the TypeScript layer. */
public interface FaceclawDeviceDiscoveryListener {
    /**
     * One advertisement (or one bonded device) as a JSON object:
     * {address, name, manufacturerData (hex, company id included), rssi|null,
     *  txPower|null, connectable|null, bonded, source, seenAtMs}.
     * Protocol decoding happens in TypeScript (see app/g2/even-advertisement.ts).
     */
    void onAdvertisement(String json);

    /** The platform refused to start or continue the scan. */
    void onScanFailed(int errorCode, String message);

    /** Diagnostic line for the pairing log. */
    void onLog(String line);
}
