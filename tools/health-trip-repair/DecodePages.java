package com.faceclaw.app;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.regex.Matcher;
import java.util.regex.Pattern;


/**
 * One-off (2026-10-04, health trip repair): decode every page of a
 * `ring-pages.jsonl` snapshot with THIS tree's `RingProtocol.decode` and print
 * one JSON object per page on stdout, for `repair.cjs`. Nothing is dated
 * here: ring seconds come out raw, exactly as the app's toWire sees them.
 *
 * Usage: java -cp <classes> com.faceclaw.app.DecodePages ring-pages.jsonl [more.jsonl ...]
 *
 * Several journals are merged by page number `n` (the first file's line wins),
 * so a fresh snapshot can be topped up with an older one's pages: the journal
 * trims committed lines once it passes 128 KB (RingPageJournal.COMPACT_AT_BYTES),
 * which would otherwise take the damaged 10-03 pages out of a later snapshot.
 */
public final class DecodePages {
    private static final Pattern LINE = Pattern.compile(
        "\"n\":(\\d+).*\"rxMs\":(\\d+).*\"cmd\":\"([0-9a-f:]+)\".*\"rawHex\":\"([0-9a-f]+)\"");

    public static void main(String[] args) throws Exception {
        java.util.TreeMap<Long, String> byN = new java.util.TreeMap<>();
        for (String file : args) {
            for (String line : Files.readAllLines(Paths.get(file), StandardCharsets.UTF_8)) {
                Matcher m = LINE.matcher(line);
                if (m.find()) byN.putIfAbsent(Long.parseLong(m.group(1)), line);
                else if (!line.isEmpty()) System.err.println("unparsed journal line in " + file);
            }
        }
        for (String line : byN.values()) {
            Matcher m = LINE.matcher(line);
            m.find();
            String hex = m.group(4);
            byte[] raw = new byte[hex.length() / 2];
            for (int i = 0; i < raw.length; i++) raw[i] = (byte) Integer.parseInt(hex.substring(2 * i, 2 * i + 2), 16);
            long rxMs = Long.parseLong(m.group(2));
            StringBuilder out = new StringBuilder();
            out.append("{\"n\":").append(m.group(1)).append(",\"rxMs\":").append(rxMs)
                .append(",\"cmd\":\"").append(m.group(3)).append('"');
            RingProtocol.Frame frame = RingProtocol.parse(raw);
            if (frame == null) {
                System.out.println(out.append(",\"frame\":null}"));
                continue;
            }
            out.append(",\"crcOk\":").append(frame.crcOk)
                .append(",\"trailerSec\":").append(RingProtocol.pageTrailerSeconds(frame));
            RingProtocol.HealthRecord r = RingProtocol.decode(frame, rxMs);
            if (r == null) {
                System.out.println(out.append(",\"rec\":null}"));
                continue;
            }
            out.append(",\"cmdHi\":").append(r.cmdHi).append(",\"rec\":{");
            if (r instanceof RingProtocol.HourlyRecord) {
                RingProtocol.HourlyRecord h = (RingProtocol.HourlyRecord) r;
                out.append("\"kind\":\"hourly\",\"anchorUnixSeconds\":").append(h.anchorUnixSeconds)
                    .append(",\"tagRaw\":").append(h.tagRaw).append(",\"current\":").append(h.current)
                    .append(",\"groups\":[");
                for (int i = 0; i < h.groups.length; i++) {
                    RingProtocol.HourlyGroup g = h.groups[i];
                    if (i > 0) out.append(',');
                    out.append("{\"hourIndex\":").append(g.hourIndex).append(",\"avg\":").append(g.avg)
                        .append(",\"max\":").append(g.max).append(",\"min\":").append(g.min).append('}');
                }
                out.append(']');
            } else if (r instanceof RingProtocol.StepsRecord) {
                RingProtocol.StepsRecord s = (RingProtocol.StepsRecord) r;
                out.append("\"kind\":\"steps\",\"anchorUnixSeconds\":").append(s.anchorUnixSeconds).append(",\"buckets\":[");
                for (int i = 0; i < s.buckets.length; i++) {
                    RingProtocol.StepsBucket b = s.buckets[i];
                    if (i > 0) out.append(',');
                    out.append("{\"index\":").append(b.index).append(",\"steps\":").append(b.steps)
                        .append(",\"calorieLike2\":").append(b.calorieLike2)
                        .append(",\"calorieLike3\":").append(b.calorieLike3).append('}');
                }
                out.append(']');
            } else if (r instanceof RingProtocol.SleepRecord) {
                RingProtocol.SleepRecord s = (RingProtocol.SleepRecord) r;
                out.append("\"kind\":\"sleep\",\"recordState\":").append(s.recordState)
                    .append(",\"startTs\":").append(s.startTs).append(",\"endTs\":").append(s.endTs)
                    .append(",\"totalTime\":").append(s.totalTime).append(",\"wakeTime\":").append(s.wakeTime)
                    .append(",\"remTime\":").append(s.remTime).append(",\"lightTime\":").append(s.lightTime)
                    .append(",\"deepTime\":").append(s.deepTime).append(",\"receivedAtMs\":").append(s.receivedAtMs)
                    .append(",\"segments\":[");
                for (int i = 0; i < s.segments.length; i++) {
                    if (i > 0) out.append(',');
                    out.append("{\"stage\":").append(s.segments[i].stage)
                        .append(",\"halfMinutes\":").append(s.segments[i].halfMinutes).append('}');
                }
                out.append(']');
            }
            System.out.println(out.append("}}"));
        }
    }
}
