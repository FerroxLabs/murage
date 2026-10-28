package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.function.Consumer;
import org.json.JSONObject;

final class PhoneExecutorSupport {
    interface Module {
        default void cancel() {}
        void run(String operationId, String action, PhoneJobsContract.Args args, boolean preciseConsent, PhoneJobRunner.Cancellation cancellation,
                 Consumer<PhoneJobRunner.Execution> done) throws Exception;
    }
    static final class Failure extends Exception {
        final String code;
        Failure(String code) { this.code = code; }
    }
    static void require(boolean value) throws Failure { if (!value) throw new Failure("denied"); }
    static String text(Object value, int max) {
        String s = value instanceof String ? (String) value : "";
        int end = Math.min(s.length(), max);
        if (end > 0 && end < s.length() && Character.isHighSurrogate(s.charAt(end - 1))) end--;
        return s.substring(0, end);
    }
    static JSONObject trim(JSONObject row, Object... fields) throws Exception {
        JSONObject out = new JSONObject();
        for (int i = 0; i < fields.length; i += 2) {
            String key = (String) fields[i]; int max = (Integer) fields[i + 1];
            if (row.has(key) && !row.isNull(key)) out.put(key, max < 0 ? row.get(key) : text(row.get(key), max));
        }
        return out;
    }
    static PhoneJobRunner.Execution result(String action, JSONObject out) {
        String encoded = out.toString();
        if (encoded == null) return PhoneJobRunner.Execution.error("invalid_result");
        if (encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > PhoneJobsContract.RESULT_MAX_BYTES)
            return PhoneJobRunner.Execution.error("too_large");
        PhoneJobsContract.Result parsed = PhoneJobsContract.Result.parse(action, out);
        return parsed == null || parsed.encode() == null ? PhoneJobRunner.Execution.error("invalid_result") : new PhoneJobRunner.Execution(parsed, null);
    }
    static long time(String value) { return OffsetDateTime.parse(value).toInstant().toEpochMilli(); }
    static String time(long value) { return Instant.ofEpochMilli(value).toString(); }
}
