package com.faceclaw.app;

/**
 * Standalone self-test for {@link FaceclawMicRoute}: which device a
 * forced-phone-mic capture asks for, given the device lists Android reports.
 * No Android APIs. The lists are modelled on the 2026-10-06 capture receipts
 * (TLC open problem "Why was the 10-06 morning dictation poor?").
 *
 * <pre>
 *   javac -d /tmp/mrt App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMicRoute.java \
 *                     notes/mic-route-selftest/MicRouteSelfTest.java
 *   java -cp /tmp/mrt com.faceclaw.app.MicRouteSelfTest
 * </pre>
 *
 * <p>What this cannot show: whether, in the car, making the hearing aids the
 * communication device actually brings their input back. That needs a capture
 * with the car connected; the receipt's "commDevice" block records the answer.
 */
public final class MicRouteSelfTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        // 08:32-08:34: hearing aids connected, no car. The input is listed.
        String[] home = {"BUILTIN_MIC", "BLE_HEADSET", "TYPE_18"};
        check("hearing aids listed -> ask for them", FaceclawMicRoute.chooseInput(home) == 1);

        // 08:35:08 onward: the car's hands-free connected; receipts say
        // requested.found=false, so the aids' input was not listed.
        String[] car = {"BUILTIN_MIC", "BLUETOOTH_SCO", "TYPE_18"};
        check("car only -> no input to ask for", FaceclawMicRoute.chooseInput(car) == -1);
        check("never the car's hands-free mic as the input", FaceclawMicRoute.chooseInput(car) != 1);

        // The new step: the aids still offered as a communication device.
        String[] commWithAids = {"BUILTIN_EARPIECE", "BLUETOOTH_SCO", "BLE_HEADSET"};
        check("aids offered for communication -> select them",
            FaceclawMicRoute.chooseCommunicationDevice(commWithAids) == 2);
        String[] commCarOnly = {"BUILTIN_EARPIECE", "BUILTIN_SPEAKER", "BLUETOOTH_SCO"};
        check("only the car offered -> select nothing (not the car)",
            FaceclawMicRoute.chooseCommunicationDevice(commCarOnly) == -1);

        // Unchanged rules from openPhoneMic()'s old loop.
        check("hearing-aid type beats BLE headset",
            FaceclawMicRoute.chooseInput(new String[] {"BLE_HEADSET", "HEARING_AID"}) == 1);
        check("hearing-aid type beats BLE headset in either order",
            FaceclawMicRoute.chooseInput(new String[] {"HEARING_AID", "BLE_HEADSET"}) == 0);
        check("two BLE headsets -> the last, as before",
            FaceclawMicRoute.chooseInput(new String[] {"BLE_HEADSET", "BUILTIN_MIC", "BLE_HEADSET"}) == 2);
        check("empty list -> none", FaceclawMicRoute.chooseInput(new String[0]) == -1);
        check("null list -> none", FaceclawMicRoute.chooseInput(null) == -1);
        check("null entries are skipped",
            FaceclawMicRoute.chooseCommunicationDevice(new String[] {null, "BLE_HEADSET"}) == 1);

        System.out.println();
        System.out.println(failures == 0
            ? "PASS: all " + checks + " checks"
            : "FAIL: " + failures + " of " + checks + " checks");
        if (failures != 0) {
            System.exit(1);
        }
    }

    private static void check(String name, boolean ok) {
        checks++;
        if (!ok) {
            failures++;
        }
        System.out.println((ok ? "  ok   " : "  FAIL ") + name);
    }
}
