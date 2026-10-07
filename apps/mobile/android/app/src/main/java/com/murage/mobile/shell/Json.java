package com.murage.mobile.shell;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * android.jar declares JSONException checked; a put with a String key cannot actually fail.
 *
 * <p>Two org.json copies: JVM tests run the standalone library (org.json:json,
 * build.gradle), the device runs Android's own. They differ where it matters here:
 * <ul>
 *   <li>JSONException is a RuntimeException in the standalone library and a checked
 *       Exception on Android.</li>
 *   <li>Nesting: the standalone parser stops at a depth of 512 with a JSONException;
 *       Android's recurses with no limit, so a deep enough message throws
 *       StackOverflowError. {@link #object} maps both to null.</li>
 *   <li>Numbers: Android reads a fraction or exponent as Double, the standalone
 *       library as BigDecimal (and an integer past Long as BigInteger, where Android
 *       gives Double). Integer and Long agree, which is all {@link ChannelArgs#integer} takes.</li>
 *   <li>A duplicate key: the standalone parser throws, Android's keeps the last value.
 *       The page's JSON.stringify never writes one.</li>
 *   <li>Coercion in optLong and friends differs (for example on a "1e3" string), so
 *       stored values are read by type, never with opt*.</li>
 * </ul>
 */
public final class Json {
    private Json() {}

    public static JSONObject put(JSONObject object, String key, Object value) {
        try {
            return object.put(key, value);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** Null for anything unreadable, including what a hostile page can make Android's parser throw. */
    public static JSONObject object(String text) {
        try {
            return new JSONObject(text);
        } catch (JSONException invalid) {
            return null;
        } catch (RuntimeException | StackOverflowError hostile) {
            return null;
        }
    }
}
