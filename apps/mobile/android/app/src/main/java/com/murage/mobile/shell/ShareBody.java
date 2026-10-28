package com.murage.mobile.shell;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.function.BooleanSupplier;
import org.json.*;

/** Stream/copy before publishing queued state. Provider names are metadata, never paths. */
public final class ShareBody {
    public static final int IMAGE_EDGE = 4096, JPEG_QUALITY = 85;
    private ShareBody() {}
    public static final class InputError extends IOException {
        public final String key;
        public InputError(String key) { super(key); this.key = key; }
    }
    public interface Copy { void to(File destination) throws IOException; }
    public static final class Attachment {
        public final String name, mime;
        public final Copy copy;
        public Attachment(String name, String mime, Copy copy) { this.name = name; this.mime = mime; this.copy = copy; }
    }
    public static final class TextInput {
        public final String text, url, preview;
        public TextInput(String extraText, String subject) {
            String value = absentIfBlank(extraText == null ? subject : extraText);
            boolean link = false;
            if (value != null) try {
                java.net.URI parsed = new java.net.URI(value.trim());
                link = ("https".equalsIgnoreCase(parsed.getScheme()) || "http".equalsIgnoreCase(parsed.getScheme())) && parsed.getHost() != null;
            } catch (java.net.URISyntaxException ignored) { }
            text = link ? null : value; url = link ? value.trim() : null;
            preview = absentIfBlank(subject) != null ? subject : value;
        }
    }
    public static boolean accepts(String mime) {
        return PhoneAskContract.IMAGE_MIMES.contains(mime) || PhoneAskContract.FILE_MIMES.contains(mime)
            || "image/heic".equals(mime) || "image/heif".equals(mime);
    }
    public static void count(int count) throws InputError {
        if (count > PhoneAskContract.ShareLimits.MAX_ITEMS) throw new InputError("share_ten");
    }
    public static void externalStream(String scheme, String authority, String ownPackage,
                                      java.util.function.Function<String, String> providerPackage) throws InputError {
        if (!"content".equals(scheme) || authority == null || authority.isEmpty()) throw new InputError("share_type");
        // Android can qualify content authorities with a user id. Resolve the underlying provider.
        String provider = authority.substring(authority.lastIndexOf('@') + 1);
        if (provider.isEmpty() || ownPackage.equals(providerPackage.apply(provider))) throw new InputError("share_type");
    }
    public static int[] imageSize(int width, int height) {
        if (width <= 0 || height <= 0) throw new IllegalArgumentException("image size");
        double scale = Math.min(1, (double) IMAGE_EDGE / Math.max(width, height));
        return new int[]{Math.max(1, (int) (width * scale)), Math.max(1, (int) (height * scale))};
    }
    public static int imageSample(int width, int height) {
        int sample = 1;
        while ((long) Math.max(width, height) > (long) IMAGE_EDGE * sample) sample *= 2;
        return sample;
    }
    public static String absentIfBlank(String value) {
        return value == null || value.codePoints().allMatch(c -> Character.isWhitespace(c) || Character.isSpaceChar(c)) ? null : value;
    }
    public static String name(String value, int n) {
        if (value == null) return "item-" + n;
        String cleaned = value.replaceAll("[\"/\\\\\\x00-\\x1f\\x7f-\\x9f]", "_");
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) return "item-" + n;
        if (cleaned.length() > 255) cleaned = cleaned.substring(0, Character.isHighSurrogate(cleaned.charAt(254)) ? 254 : 255);
        return cleaned;
    }
    public static String boundary(String id) {
        // The longest legal share id still fits the MIME boundary's 70 character limit.
        return "murage-" + (id.length() <= 63 ? id : ShareFiles.hex(ShareFiles.digest().digest(id.getBytes(StandardCharsets.UTF_8))).substring(0, 63));
    }
    public static void stream(InputStream input, File destination, long limit, String error) throws IOException {
        try (InputStream in = input; FileOutputStream out = new FileOutputStream(destination)) {
            if (in == null) throw new IOException("missing content");
            byte[] buffer = new byte[32768]; long count = 0; int n;
            while ((n = in.read(buffer)) != -1) {
                if (n == 0) throw new IOException("no progress");
                count += n; if (count > limit) throw new InputError(error);
                out.write(buffer, 0, n);
            }
            out.getFD().sync();
        }
    }
    public static JSONObject prepare(File root, WorkspaceOrigin origin, String id, String bot, String thread,
                                     String note, String text, String url, List<Attachment> attachments, long now,
                                     BooleanSupplier allowed) throws IOException {
        count(attachments.size()); File folder = ShareFiles.folder(root, id);
        if (!folder.getParentFile().isDirectory() && !folder.getParentFile().mkdirs()) throw new IOException("outbox directory");
        if (!folder.mkdir()) throw new IOException("share already exists");
        try {
            List<PhoneAskContract.ShareItem> items = new ArrayList<>(); long total = 0;
            for (int i = 0; i < attachments.size(); i++) {
                Attachment a = attachments.get(i); int n = i + 1;
                boolean image = PhoneAskContract.IMAGE_MIMES.contains(a.mime);
                if (!image && !PhoneAskContract.FILE_MIMES.contains(a.mime)) throw new InputError("share_type");
                File destination = new File(folder, Integer.toString(n)); a.copy.to(destination);
                long bytes = destination.length();
                if (bytes > (image ? PhoneAskContract.ShareLimits.IMAGE_MAX_BYTES : PhoneAskContract.ShareLimits.FILE_MAX_BYTES))
                    throw new InputError(image ? "share_photo_large" : "share_file_large");
                total += bytes;
                if (total > PhoneAskContract.ShareLimits.MAX_SHARE_BYTES) throw new InputError("share_file_large");
                MessageDigest hash = ShareFiles.digest();
                try (InputStream in = new FileInputStream(destination)) {
                    byte[] buffer = new byte[32768]; int read;
                    while ((read = in.read(buffer)) != -1) hash.update(buffer, 0, read);
                }
                items.add(new PhoneAskContract.ShareItem(n, name(a.name, n), a.mime, bytes, ShareFiles.hex(hash.digest())));
            }
            PhoneAskContract.ShareManifest manifest = new PhoneAskContract.ShareManifest(id, bot, thread,
                absentIfBlank(note), absentIfBlank(text), absentIfBlank(url), items);
            JSONObject encoded = manifest.encode();
            if (encoded == null) throw new InputError("share_type");
            write(manifest, boundary(id), new File(folder, "body"), item -> new FileInputStream(new File(folder, Integer.toString(item.n))));
            String fingerprint = ShareFiles.hex(ShareFiles.digest().digest(ShareFiles.canonical(encoded).getBytes(StandardCharsets.UTF_8)));
            JSONObject state = new JSONObject().put("shareId", id).put("workspace", ShareFiles.workspace(origin))
                .put("target", new JSONObject().put("botId", bot).put("threadId", thread)).put("fingerprint", fingerprint)
                .put("createdAt", now).put("state", "queued");
            synchronized (ShareFiles.LOCK) {
                if (!allowed.getAsBoolean()) throw new IOException("origin removed");
                ShareFiles.json(new File(folder, "manifest.json"), encoded);
                ShareFiles.json(new File(folder, "state.json"), state);
            }
            return state;
        } catch (Exception failed) {
            ShareFiles.delete(folder);
            if (failed instanceof IOException) throw (IOException) failed;
            throw new IOException("prepare", failed);
        }
    }
    public static void write(PhoneAskContract.ShareManifest manifest, String boundary, File body,
                             ShareMultipartWriter.ItemSource source) throws IOException {
        File temporary = File.createTempFile(".body-", ".tmp", body.getParentFile());
        try {
            try (FileOutputStream out = new FileOutputStream(temporary)) {
                ShareMultipartWriter.write(manifest, boundary, out, source); out.getFD().sync();
            }
            Files.move(temporary.toPath(), body.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        } finally { Files.deleteIfExists(temporary.toPath()); }
    }
    public static JSONObject resend(File root, JSONObject previous, WorkspaceOrigin origin, String bot, String thread,
                                    long now, BooleanSupplier allowed) throws IOException {
        try {
            File folder = ShareFiles.folder(root, previous.getString("shareId"));
            if (!new File(folder, "body").isFile()) throw new IOException("missing body");
            JSONObject encoded = new JSONObject(ShareFiles.read(new File(folder, "manifest.json"), 8 * 1024 * 1024));
            PhoneAskContract.ShareManifest m = PhoneAskContract.ShareManifest.parse(encoded);
            if (m == null || !m.shareId.equals(previous.getString("shareId")) || !previous.getString("fingerprint").equals(
                ShareFiles.hex(ShareFiles.digest().digest(ShareFiles.canonical(encoded).getBytes(StandardCharsets.UTF_8))))) throw new IOException("manifest changed");
            List<Attachment> items = new ArrayList<>();
            for (PhoneAskContract.ShareItem item : m.items) items.add(new Attachment(item.name, item.mime, dest -> {
                MessageDigest hash = ShareFiles.digest();
                try (InputStream in = new java.security.DigestInputStream(new FileInputStream(new File(folder, Integer.toString(item.n))), hash)) {
                    stream(in, dest, item.bytes, "share_type");
                }
                if (dest.length() != item.bytes || !ShareFiles.hex(hash.digest()).equals(item.sha256)) throw new IOException("attachment changed");
            }));
            return prepare(root, origin, UUID.randomUUID().toString(), bot, thread, m.note, m.text, m.url, items, now, allowed);
        } catch (JSONException e) { throw new IOException(e); }
    }
}
