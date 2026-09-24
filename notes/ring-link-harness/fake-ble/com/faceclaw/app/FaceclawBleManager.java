package com.faceclaw.app;

import android.content.Context;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Harness-only FAKE of FaceclawBleManager (ring-link harness, 2026-09-24).
 * Compiled INSTEAD of the real class, same package, same public signatures,
 * so the real FaceclawBleCommunicator runs unmodified against it. Never
 * shipped: it lives under notes/ and the Gradle build never sees it.
 *
 * <p>It models two things, and each is a claim worth stating because the
 * harness is only as good as the model:
 *
 * <ol>
 *   <li><b>The real manager's bookkeeping, copied, not reinvented.</b>
 *       {@code gattClients} holds a client from connect until disconnect() or
 *       a DISCONNECTED callback; {@code requireGatt} throws
 *       {@code IllegalStateException("Not connected: " + address)} when there is
 *       none; {@code disconnect()} removes the client and calls
 *       {@code gatt.disconnect(); gatt.close();}.
 *   <li><b>Android's rule that a closed GATT delivers no more callbacks.</b>
 *       {@code BluetoothGatt.close()} unregisters the client and nulls its
 *       callback (AOSP {@code BluetoothGatt.unregisterApp()}), so the
 *       STATE_DISCONNECTED that {@code gatt.disconnect()} would have produced
 *       never reaches {@code onConnectionStateChange}. This is the model's one
 *       load-bearing ASSUMPTION about the phone. The 09-23/24 receipts (26 h of
 *       "state":"up" with no ring push) are consistent with it; nothing here
 *       proves it. {@link #deliverDisconnectAfterClose} flips it, so the harness
 *       also checks the fix does not depend on which way it goes.
 * </ol>
 *
 * <p>The ring itself: every device-channel frame except a page ACK (00:7E)
 * gets an RSP, 00:01 carries a battery level, every health REQ gets an RSP,
 * and {@link #pagesPerHealthRequest} DATA pages follow each health RSP. The
 * 06:02 health-channel DATA frame gets nothing, as on the real ring.
 */
public class FaceclawBleManager {
    // ---- harness controls (static: the communicator builds its own instance) ----
    public static volatile FaceclawBleManager last;
    /** Whether a dial to the ring succeeds. */
    public static volatile boolean ringPresent = true;
    /** Flip Android's close() rule: deliver DISCONNECTED even after close(). */
    public static volatile boolean deliverDisconnectAfterClose = false;
    /** DATA pages the ring sends after each health RSP. */
    public static volatile int pagesPerHealthRequest = 0;
    /** Ring battery level answered on 00:01. */
    public static volatile int batteryLevel = 71;

    private static final String NOT_CONNECTED = "Not connected: ";

    private final Object bluetoothApiLock = new Object();
    private final Map<String, FakeGatt> gattClients = new ConcurrentHashMap<>();
    private final ExecutorService binder = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "harness-binder");
        t.setDaemon(true);
        return t;
    });
    private volatile FaceclawBleListener listener;

    // ---- counters the harness reads ----
    public volatile int dials;
    public volatile int deliberateDisconnects;
    public volatile int healthRequestsAnswered;
    public volatile int writesRejectedNotConnected;
    private int ringSeq;

    private static final class FakeGatt {
        final String address;
        volatile boolean closed;

        FakeGatt(String address) {
            this.address = address;
        }
    }

    public FaceclawBleManager(Context context) {
        last = this;
    }

    // ---- the real class's static API ----
    public static void recordDisplayFrameSent() {
    }

    public static long[] sampleOutboundTraffic() {
        return new long[] {0L, 0L, 0L};
    }

    // ---- the real class's instance API ----
    public void setListener(FaceclawBleListener listener) {
        this.listener = listener;
    }

    public boolean isBonded(String address) {
        return true;
    }

    /**
     * Whether the manager currently holds a GATT client for this address. The
     * real class gained the same method with the fix.
     */
    public boolean hasGattClient(String address) {
        return address != null && gattClients.containsKey(address);
    }

    public boolean connect(String address, int timeoutMs) {
        return connect(address, timeoutMs, false);
    }

    public boolean connect(String address, int timeoutMs, boolean autoConnect) {
        if (address == null || address.trim().isEmpty()) {
            throw new IllegalArgumentException("address is required");
        }
        synchronized (bluetoothApiLock) {
            if (gattClients.get(address) != null) {
                return true;
            }
            dials++;
            if (!ringPresent) {
                // The real one waits out the latch, then removes, disconnects and
                // closes the client it made: no callback, and false.
                android.os.SystemClock.sleep(timeoutMs);
                return false;
            }
            FakeGatt gatt = new FakeGatt(address);
            gattClients.put(address, gatt);
            // STATE_CONNECTED arrives on the binder thread; the real connect()
            // returns once its latch is counted down, which happens just before
            // the dispatch. Waiting for the whole dispatch here keeps the order
            // the phone almost always sees: the communicator's connected
            // callback lands before connectRing() marks notifications ready.
            CountDownLatch done = new CountDownLatch(1);
            binder.execute(() -> {
                try {
                    FaceclawBleListener l = listener;
                    if (l != null && !gatt.closed) {
                        l.onConnectionStateChange(address, true);
                    }
                } finally {
                    done.countDown();
                }
            });
            await(done);
            return true;
        }
    }

    public boolean requestConnectionPriority(String address, int priority) {
        synchronized (bluetoothApiLock) {
            requireGatt(address);
            return true;
        }
    }

    public boolean requestMtu(String address, int mtu, int timeoutMs) {
        synchronized (bluetoothApiLock) {
            requireGatt(address);
            return true;
        }
    }

    public boolean discoverServices(String address, int timeoutMs) {
        synchronized (bluetoothApiLock) {
            requireGatt(address);
            return true;
        }
    }

    public boolean enableNotifications(String address, String characteristicUuid, boolean enable, int timeoutMs) {
        synchronized (bluetoothApiLock) {
            requireGatt(address);
            return true;
        }
    }

    public boolean writeFrames(String address, String characteristicUuid, List<byte[]> frames, int writeType,
            int timeoutMs) {
        if (frames == null || frames.isEmpty()) {
            return true;
        }
        synchronized (bluetoothApiLock) {
            FakeGatt gatt;
            try {
                gatt = requireGatt(address);
            } catch (IllegalStateException e) {
                writesRejectedNotConnected++;
                throw e;
            }
            for (byte[] frame : frames) {
                ringReceives(gatt, frame);
            }
            return true;
        }
    }

    public void disconnect(String address) {
        synchronized (bluetoothApiLock) {
            FakeGatt gatt = gattClients.remove(address);
            if (gatt == null) {
                return;
            }
            deliberateDisconnects++;
            // gatt.disconnect(); gatt.close(); - the close nulls the callback.
            gatt.closed = true;
            if (deliverDisconnectAfterClose) {
                binder.execute(() -> {
                    FaceclawBleListener l = listener;
                    if (l != null) {
                        l.onConnectionStateChange(address, false);
                    }
                });
            }
        }
    }

    public void close() {
        for (String address : new ArrayList<>(gattClients.keySet())) {
            disconnect(address);
        }
    }

    // ---- harness-only events ----

    /**
     * The ring drops the link itself (supervision timeout, out of range): the
     * real manager's DISCONNECTED handler removes and closes the client, then
     * dispatches the state change.
     */
    public void ringDropsLink(String address) {
        FakeGatt gatt;
        synchronized (bluetoothApiLock) {
            gatt = gattClients.remove(address);
        }
        if (gatt == null) {
            return;
        }
        gatt.closed = true;
        binder.execute(() -> {
            FaceclawBleListener l = listener;
            if (l != null) {
                l.onConnectionStateChange(address, false);
            }
        });
        drain();
    }

    /**
     * The client is gone and nothing says so: the state the phone was in on
     * 09-23/24 after the on-demand drop.
     */
    public void loseClientSilently(String address) {
        synchronized (bluetoothApiLock) {
            FakeGatt gatt = gattClients.remove(address);
            if (gatt != null) {
                gatt.closed = true;
            }
        }
    }

    /** Wait until every callback queued so far has run. */
    public void drain() {
        CountDownLatch done = new CountDownLatch(1);
        binder.execute(done::countDown);
        await(done);
    }

    // ---- the fake ring ----

    private FakeGatt requireGatt(String address) {
        FakeGatt gatt = address == null ? null : gattClients.get(address);
        if (gatt == null) {
            throw new IllegalStateException(NOT_CONNECTED + address);
        }
        return gatt;
    }

    private void ringReceives(FakeGatt gatt, byte[] bytes) {
        RingProtocol.Frame frame = RingProtocol.parse(bytes);
        if (frame == null || !frame.crcOk) {
            return;
        }
        if (frame.chan == RingProtocol.CHAN_DEVICE) {
            if (frame.cmdLo == 0x7E) {
                return; // a page ACK: nothing comes back
            }
            byte[] payload = frame.cmdLo == 0x01
                ? new byte[] {nonceLo(frame), nonceHi(frame), (byte) batteryLevel, 0x02}
                : new byte[] {nonceLo(frame), nonceHi(frame)};
            notifyRing(gatt, RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_RSP,
                frame.cmdHi, frame.cmdLo, nextRingSeq(), payload));
            return;
        }
        if (frame.chan == RingProtocol.CHAN_HEALTH && frame.kind == RingProtocol.KIND_REQ) {
            healthRequestsAnswered++;
            notifyRing(gatt, RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_RSP,
                frame.cmdHi, frame.cmdLo, nextRingSeq(), new byte[] {nonceLo(frame), nonceHi(frame)}));
            for (int i = 0; i < pagesPerHealthRequest; i++) {
                // An opaque page: the communicator journals and ACKs pages it
                // cannot decode exactly as it does decodable ones.
                notifyRing(gatt, RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
                    frame.cmdHi, frame.cmdLo, nextRingSeq(),
                    new byte[] {0x11, 0x22, 0x01, (byte) i, 0x00, 0x00}));
            }
        }
        // 06:02 (health-channel DATA) and anything else: no answer.
    }

    private void notifyRing(FakeGatt gatt, byte[] frame) {
        binder.execute(() -> {
            FaceclawBleListener l = listener;
            if (l != null && !gatt.closed) {
                l.onNotification(gatt.address, BleProtocol.R1_NOTIFY_CHAR_UUID, frame);
            }
        });
    }

    private synchronized int nextRingSeq() {
        ringSeq = (ringSeq + 1) & 0xff;
        return ringSeq;
    }

    private static byte nonceLo(RingProtocol.Frame f) {
        return f.payload != null && f.payload.length > 0 ? f.payload[0] : 0;
    }

    private static byte nonceHi(RingProtocol.Frame f) {
        return f.payload != null && f.payload.length > 1 ? f.payload[1] : 0;
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("harness binder thread stuck");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
