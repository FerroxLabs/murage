package com.murage.mobile.shell;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** One process owns Android sharing. Token changes, removal and publication use this lock. */
public final class ShareFiles {
    public static final Object LOCK = new Object();
    private ShareFiles() {}
    public static String workspace(WorkspaceOrigin origin) {
        return ApprovalProof.base64url(digest().digest(origin.serialized().getBytes(StandardCharsets.UTF_8)));
    }
    public static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    public static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    public static File folder(File root, String id) throws IOException {
        if (id == null || !id.matches("[A-Za-z0-9_-]{16,80}")) throw new IOException("invalid share id");
        File parent = new File(root, "outbox");
        File file = new File(parent, id);
        if (!file.getCanonicalFile().getParentFile().equals(parent.getCanonicalFile())) throw new IOException("share path");
        return file;
    }
    public static void atomic(File file, byte[] bytes) throws IOException {
        synchronized (LOCK) {
            File parent = file.getParentFile();
            if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("directory");
            File temporary = File.createTempFile(".share-", ".tmp", parent);
            try {
                try (FileOutputStream out = new FileOutputStream(temporary)) { out.write(bytes); out.getFD().sync(); }
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } finally { Files.deleteIfExists(temporary.toPath()); }
        }
    }
    public static void json(File file, Object value) throws IOException {
        atomic(file, value.toString().getBytes(StandardCharsets.UTF_8));
    }
    public static String read(File file, int limit) throws IOException {
        try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[32768]; int n;
            while ((n = in.read(buffer)) != -1) {
                if (out.size() + n > limit) throw new IOException("record too large");
                out.write(buffer, 0, n);
            }
            return out.toString("UTF-8");
        }
    }
    public static void delete(File file) throws IOException {
        if (Files.isSymbolicLink(file.toPath())) { Files.delete(file.toPath()); return; }
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        Files.deleteIfExists(file.toPath());
    }
    /** Recursively sorted JSON, matching the receipt fingerprint and the iOS writer. */
    public static String canonical(Object value) throws JSONException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> keys = new ArrayList<>(); object.keys().forEachRemaining(keys::add); Collections.sort(keys);
            StringJoiner parts = new StringJoiner(",", "{", "}");
            for (String key : keys) parts.add(ShareMultipartWriter.quote(key) + ":" + canonical(object.get(key)));
            return parts.toString();
        }
        if (value instanceof JSONArray) {
            StringJoiner parts = new StringJoiner(",", "[", "]"); JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) parts.add(canonical(array.get(i)));
            return parts.toString();
        }
        return value instanceof String ? ShareMultipartWriter.quote((String) value) : String.valueOf(value);
    }
}
