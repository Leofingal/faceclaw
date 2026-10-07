package com.faceclaw.app;

/**
 * Which device a forced-phone-mic capture should ask for. Pure: it works on
 * the type labels FaceclawVoiceController.describeAudioDeviceType() writes
 * ("HEARING_AID", "BLE_HEADSET", ...), so it runs without Android in
 * notes/mic-route-selftest/MicRouteSelfTest.java.
 *
 * <p>2026-10-06 (TLC open problem "Why was the 10-06 morning dictation poor?"):
 * at 08:35 the car connected over classic Bluetooth (A2DP + hands-free) while
 * the LE Audio hearing aids stayed connected. The next three capture receipts
 * say {@code "requested":{"found":false}}: the hearing aids' input was no longer
 * in AudioManager.getDevices(GET_DEVICES_INPUTS) at all, so setPreferredDevice()
 * had nothing to ask for and Android used the built-in mic. The first rule
 * below is what openPhoneMic() always did; the second is new: when no hearing
 * aid input is listed but the hearing aids are still offered as a
 * communication device (API 31 getAvailableCommunicationDevices()), make them
 * the communication device for the capture, which is meant to bring their
 * input back. That second step is unverified on real hardware: only a capture
 * in the car can show whether the input reappears.
 */
public final class FaceclawMicRoute {
    public static final String HEARING_AID = "HEARING_AID";
    public static final String BLE_HEADSET = "BLE_HEADSET";

    private FaceclawMicRoute() {
    }

    /**
     * Index of the input to hand to AudioRecord.setPreferredDevice(), or -1.
     * The dedicated hearing-aid type wins over the general LE Audio type when
     * both are present; among equals, the LAST listed, which is what the loop
     * in openPhoneMic() did before this was lifted out.
     */
    public static int chooseInput(String[] inputTypes) {
        return hearingDevice(inputTypes);
    }

    /**
     * Index of the communication device to select when chooseInput() found
     * nothing, or -1. Only hearing devices: selecting the car's hands-free
     * here would move the dictation to the car's microphone, a different
     * choice that nobody has asked for.
     */
    public static int chooseCommunicationDevice(String[] communicationTypes) {
        return hearingDevice(communicationTypes);
    }

    private static int hearingDevice(String[] types) {
        if (types == null) {
            return -1;
        }
        int hearingAid = -1;
        int bleHeadset = -1;
        for (int i = 0; i < types.length; i++) {
            if (HEARING_AID.equals(types[i])) {
                hearingAid = i;
            } else if (BLE_HEADSET.equals(types[i])) {
                bleHeadset = i;
            }
        }
        return hearingAid >= 0 ? hearingAid : bleHeadset;
    }
}
