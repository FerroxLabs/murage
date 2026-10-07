package com.murage.mobile.shell;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/** Twin of ChannelArgs in ChannelGate.swift. */
public final class ChannelArgs {
    public static final Set<String> HAPTICS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList("tap", "success", "warning", "error")));

    /** Lenient on purpose: java.net.URI throws on the | { } ^ a WHATWG page leaves raw in a query (ruling R2). */
    static final Pattern SCHEME = Pattern.compile("([A-Za-z][A-Za-z0-9+.-]*):(.*)", Pattern.DOTALL);
    private static final Pattern AUTHORITY = Pattern.compile("//([^/?#]*).*", Pattern.DOTALL);
    /** After any userinfo: a non-empty host with no ":", then optionally ":" and digits (so no IPv6 literal). */
    private static final Pattern HOST_PORT = Pattern.compile("[^:]+(?::[0-9]*)?", Pattern.DOTALL);
    private static final Pattern ESCAPE = Pattern.compile("%([0-9A-Fa-f]{2})");

    private ChannelArgs() {}

    public static String string(Object value, int max) {
        return value instanceof String && ((String) value).length() <= max ? (String) value : null;
    }

    /**
     * `diagLine({line})`: a string of at most 600 UTF-16 units that starts with
     * [call-diag] or [call-trace] and holds no control character (twin of
     * ChannelArgs.diagLine in ChannelGate.swift).
     */
    public static String diagLine(JSONObject args) {
        String line = string(args.opt("line"), 600);
        if (line == null || !(line.startsWith("[call-diag]") || line.startsWith("[call-trace]"))) return null;
        for (int i = 0; i < line.length(); i++) {
            if (Character.getType(line.charAt(i)) == Character.CONTROL) return null;
        }
        return line;
    }

    /**
     * A JSON integer in 0…2^31−1: int32 on both twins, and no caller (size,
     * index, the envelope id, the probe's mobile) takes a negative. Booleans
     * and fractions are refused.
     */
    public static Integer integer(Object value) {
        long number;
        if (value instanceof Integer) number = (Integer) value;
        else if (value instanceof Long) number = (Long) value;
        else return null;
        return number >= 0 && number <= Integer.MAX_VALUE ? (int) number : null;
    }

    /**
     * {@code openExternal(url)}: the openExternal rule in src/lib/native-contract.test.ts.
     * No unsafe character; http, https, mailto or tel; http(s) with a host (no ":"
     * in it, then an optional ":digits" port); a mailto
     * without an attach or attachment parameter. The page's string is returned unchanged.
     */
    public static String externalUrl(JSONObject args) {
        String raw = string(args.opt("url"), 4096);
        if (raw == null || Unsafe.any(raw)) return null;
        Matcher parsed = SCHEME.matcher(raw);
        if (!parsed.matches()) return null;
        String rest = parsed.group(2);
        switch (parsed.group(1).toLowerCase(Locale.ROOT)) {
            case "http":
            case "https":
                return hasHost(rest) ? raw : null;
            case "tel":
                return raw;
            case "mailto":
                return attaches(rest) ? null : raw;
            default:
                return null;
        }
    }

    /** The authority after any userinfo (up to the last "@") is a host with no ":" and an optional ":digits" port. */
    private static boolean hasHost(String rest) {
        Matcher authority = AUTHORITY.matcher(rest);
        if (!authority.matches()) return false;
        String hostPort = authority.group(1).substring(authority.group(1).lastIndexOf('@') + 1);
        return HOST_PORT.matcher(hostPort).matches();
    }

    /** Some mail apps attach a local file named by ?attach= or ?attachment=, in any case or %-escaped. */
    private static boolean attaches(String rest) {
        int question = rest.indexOf('?');
        if (question < 0) return false;
        String query = rest.substring(question + 1);
        int hash = query.indexOf('#');
        if (hash >= 0) query = query.substring(0, hash);
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            String name = decode(equals < 0 ? pair : pair.substring(0, equals)).toLowerCase(Locale.ROOT);
            if (name.equals("attach") || name.equals("attachment")) return true;
        }
        return false;
    }

    /** Each %XX becomes the char with that code, as the oracle decodes it. */
    private static String decode(String text) {
        Matcher escape = ESCAPE.matcher(text);
        StringBuffer out = new StringBuffer();
        while (escape.find()) {
            char c = (char) Integer.parseInt(escape.group(1), 16);
            escape.appendReplacement(out, Matcher.quoteReplacement(String.valueOf(c)));
        }
        escape.appendTail(out);
        return out.toString();
    }

    public enum RouteKind { THREAD, KEEP, INVALID }

    public static final class Route {
        public final RouteKind kind;
        public final String threadId;

        Route(RouteKind kind, String threadId) {
            this.kind = kind;
            this.threadId = threadId;
        }
    }

    /** {@code setRoute({threadId})} (Decision 2). A null thread keeps the last one. */
    public static Route route(JSONObject args) {
        Object raw = args.opt("threadId");
        if (raw == null || raw == JSONObject.NULL) return new Route(RouteKind.KEEP, null);
        if (raw instanceof String && OpenHash.valid((String) raw)) return new Route(RouteKind.THREAD, (String) raw);
        return new Route(RouteKind.INVALID, null);
    }
}
