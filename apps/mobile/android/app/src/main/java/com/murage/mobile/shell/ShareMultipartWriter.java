package com.murage.mobile.shell;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Streams manifest, then item-1...item-n. Caller owns output; this closes each item input.
 * On failure discard the partial output file, never upload it. */
public final class ShareMultipartWriter {
    private ShareMultipartWriter() {}
    public interface ItemSource { InputStream open(PhoneAskContract.ShareItem item) throws IOException; }

    public static String contentType(String boundary) {
        if (!PhoneAskContract.matches(boundary, "[0-9A-Za-z'()+_,./:=?-]{1,70}")) throw new IllegalArgumentException("boundary");
        return "multipart/form-data; boundary=" + boundary;
    }

    public static void write(PhoneAskContract.ShareManifest manifest, String boundary, OutputStream output, ItemSource source) throws IOException {
        contentType(boundary);
        // Encoding validates every item's name length, media type and size before any I/O.
        if (manifest == null || manifest.encode() == null) throw new IllegalArgumentException("manifest");
        for (PhoneAskContract.ShareItem item : manifest.items) {
            if (item.name.equals(".") || item.name.equals("..") || !item.name.matches("[^\"/\\\\\\x00-\\x1f\\x7f-\\x9f]+"))
                throw new IllegalArgumentException("filename");
        }
        write(output, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"manifest\"\r\nContent-Type: application/json\r\n\r\n" + manifestJSON(manifest) + "\r\n");
        byte[] buffer = new byte[32 * 1024];
        for (PhoneAskContract.ShareItem item : manifest.items) {
            write(output, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"item-" + item.n + "\"; filename=\"" + item.name + "\"\r\nContent-Type: " + item.mime + "\r\n\r\n");
            MessageDigest hash;
            try { hash = MessageDigest.getInstance("SHA-256"); }
            catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
            long count = 0;
            try (InputStream input = source.open(item)) {
                if (input == null) throw new IOException("missing item");
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (read == 0) throw new IOException("item stream made no progress");
                    if (read > item.bytes - count) throw new IOException("item length");
                    count += read;
                    hash.update(buffer, 0, read);
                    output.write(buffer, 0, read);
                }
            }
            StringBuilder digest = new StringBuilder();
            for (byte b : hash.digest()) digest.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            if (count != item.bytes || !digest.toString().equals(item.sha256)) throw new IOException("item digest or length");
            write(output, "\r\n");
        }
        write(output, "--" + boundary + "--\r\n");
    }

    private static void write(OutputStream output, String text) throws IOException { output.write(text.getBytes(StandardCharsets.UTF_8)); }

    /** JSON.stringify-compatible escaping, independent of Android/JVM org.json differences. */
    static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (Character.isHighSurrogate(c) && i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1))) {
                        out.append(c).append(value.charAt(++i));
                    } else if (c < 32 || Character.isSurrogate(c)) {
                        out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
                    } else { out.append(c); }
            }
        }
        return out.append('"').toString();
    }

    /** JSONObject key iteration order is not a wire guarantee. */
    private static String manifestJSON(PhoneAskContract.ShareManifest m) {
        StringBuilder out = new StringBuilder("{\"shareId\":").append(quote(m.shareId))
                .append(",\"botId\":").append(quote(m.botId)).append(",\"threadId\":").append(quote(m.threadId));
        if (m.note != null) out.append(",\"note\":").append(quote(m.note));
        if (m.text != null) out.append(",\"text\":").append(quote(m.text));
        if (m.url != null) out.append(",\"url\":").append(quote(m.url));
        out.append(",\"items\":[");
        for (int i = 0; i < m.items.size(); i++) {
            PhoneAskContract.ShareItem item = m.items.get(i);
            if (i > 0) out.append(',');
            out.append("{\"n\":").append(item.n).append(",\"name\":").append(quote(item.name))
                    .append(",\"mime\":").append(quote(item.mime)).append(",\"bytes\":").append(item.bytes)
                    .append(",\"sha256\":").append(quote(item.sha256)).append('}');
        }
        return out.append("]}").toString();
    }
}
