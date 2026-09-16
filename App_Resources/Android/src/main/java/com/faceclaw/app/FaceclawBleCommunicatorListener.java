package com.faceclaw.app;

public interface FaceclawBleCommunicatorListener {
    void onLog(String line);
    void onStateChange(String phase, String status);
    void onRingEvent(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode, int frameId);
    void onBatteryState(int headsetBattery, int headsetCharging);
    /** Ring battery (00:01 / 00:7F frames): level as sent, charging = on the charger, wall ms of arrival. */
    void onRingBatteryState(int level, boolean charging, long atMs);
    void onSilentMode(boolean silent);
    void onWearState(boolean wearing);
    void onPhoneLockState(boolean locked);
    void onEvenAppConflict(String message);
    void onFrameMetrics(int paintMs, int transmitMs, int tileCount);
    void onFrameFinished(int frameId, String outcome);
    void onFirmwareInfo(String leftVersion, String rightVersion, String capabilities);
}
