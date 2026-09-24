import java.io.File;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.Objects;

/**
 * Enumerate RingProtocol's three ring-link gates over a grid of inputs and
 * compare two builds of the class answer for answer (2026-09-24). Used to show
 * that ringLinkWanted / ringLinkShouldDrop / ringLinkState give the same
 * answers after the open-only change as on 0878764 - Direct's inputs
 * (onDemand=false) above all.
 *
 * <pre>
 *   java GateDiff.java &lt;classes-dir-A&gt; &lt;classes-dir-B&gt;
 * </pre>
 * Each dir holds a compiled com.faceclaw.app.RingProtocol.
 */
public final class GateDiff {
    static final long[] T = {0L, 1L, 4_999L, 5_000L, 5_001L, 59_999L, 60_000L, 60_001L,
        995_000L, 995_001L, 1_000_000L, 10_000_000L, Long.MAX_VALUE};
    static final int[] RETRIES = {-1, 0, 1, 2, 3};
    static final boolean[] B = {false, true};

    public static void main(String[] args) throws Exception {
        Class<?> a = load(args[0]);
        Class<?> b = load(args[1]);
        Method wa = a.getMethod("ringLinkWanted", boolean.class, boolean.class, long.class, long.class, int.class);
        Method wb = b.getMethod("ringLinkWanted", boolean.class, boolean.class, long.class, long.class, int.class);
        Method da = a.getMethod("ringLinkShouldDrop", boolean.class, boolean.class, boolean.class, boolean.class,
            boolean.class, long.class, long.class);
        Method db = b.getMethod("ringLinkShouldDrop", boolean.class, boolean.class, boolean.class, boolean.class,
            boolean.class, long.class, long.class);
        Method sa = a.getMethod("ringLinkState", boolean.class, boolean.class, boolean.class, boolean.class,
            long.class, long.class);
        Method sb = b.getMethod("ringLinkState", boolean.class, boolean.class, boolean.class, boolean.class,
            long.class, long.class);

        long[] n = new long[3], nDirect = new long[3], diff = new long[3];
        for (boolean onDemand : B) for (boolean explicit : B) for (long now : T) for (long until : T)
            for (int r : RETRIES) {
                Object x = wa.invoke(null, onDemand, explicit, now, until, r);
                Object y = wb.invoke(null, onDemand, explicit, now, until, r);
                n[0]++; if (!onDemand) nDirect[0]++;
                if (!Objects.equals(x, y)) diff[0]++;
            }
        for (boolean onDemand : B) for (boolean conn : B) for (boolean wanted : B) for (boolean req : B)
            for (boolean empty : B) for (long now : T) for (long last : T) {
                Object x = da.invoke(null, onDemand, conn, wanted, req, empty, now, last);
                Object y = db.invoke(null, onDemand, conn, wanted, req, empty, now, last);
                n[1]++; if (!onDemand) nDirect[1]++;
                if (!Objects.equals(x, y)) diff[1]++;
            }
        for (boolean addr : B) for (boolean conn : B) for (boolean ready : B) for (boolean wanted : B)
            for (long now : T) for (long after : T) {
                Object x = sa.invoke(null, addr, conn, ready, wanted, now, after);
                Object y = sb.invoke(null, addr, conn, ready, wanted, now, after);
                n[2]++;
                if (!Objects.equals(x, y)) diff[2]++;
            }
        System.out.println("ringLinkWanted:     " + n[0] + " inputs (" + nDirect[0] + " with onDemand=false), "
            + diff[0] + " differ");
        System.out.println("ringLinkShouldDrop: " + n[1] + " inputs (" + nDirect[1] + " with onDemand=false), "
            + diff[1] + " differ");
        System.out.println("ringLinkState:      " + n[2] + " inputs, " + diff[2] + " differ");
        System.exit(diff[0] + diff[1] + diff[2] == 0 ? 0 : 1);
    }

    static Class<?> load(String dir) throws Exception {
        URLClassLoader loader = new URLClassLoader(new URL[] {new File(dir).toURI().toURL()}, null);
        return Class.forName("com.faceclaw.app.RingProtocol", true, loader);
    }
}
