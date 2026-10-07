package com.murage.mobile.shell;

import org.json.JSONObject;

/** {@code murageNative.saveFile(request)}, exactly src/lib/save-file.ts NativeSaveRequest. Twin of SaveRequest.swift. */
public final class SaveRequest {
    public static final int CHUNK_BYTES = 1_048_576;
    public static final int MAX_BYTES = 26_214_400;
    static final int MAX_BASE64 = 1_398_104;

    public final String kind;
    public final String url;
    public final String filename;
    public final String id;
    public final String mime;
    public final int size;
    public final int index;
    public final String base64;

    private SaveRequest(String kind, String url, String filename, String id, String mime, int size, int index, String base64) {
        this.kind = kind;
        this.url = url;
        this.filename = filename;
        this.id = id;
        this.mime = mime;
        this.size = size;
        this.index = index;
        this.base64 = base64;
    }

    public static SaveRequest parse(JSONObject args, WorkspaceOrigin origin) throws ChannelException {
        String kind = ChannelArgs.string(args.opt("kind"), 16);
        if (kind == null) throw new ChannelException("bad_args");
        switch (kind) {
            case "url": {
                String url = ChannelArgs.string(args.opt("url"), 8192);
                String filename = ChannelArgs.string(args.opt("filename"), 1024);
                if (url == null || filename == null) throw new ChannelException("bad_args");
                // Clean and absolute first: a "\" or control must never reach a parser (bad_args).
                if (Unsafe.any(url) || !ChannelArgs.SCHEME.matcher(url).matches()) throw new ChannelException("bad_args");
                // blob:, data:, userinfo and every other origin are foreign_url (R3).
                if (origin == null || !origin.contains(url)) throw new ChannelException("foreign_url");
                return new SaveRequest(kind, url, FileNames.safe(filename), null, null, 0, 0, null);
            }
            case "begin": {
                String id = transferId(args.opt("id"));
                String filename = ChannelArgs.string(args.opt("filename"), 1024);
                String mime = ChannelArgs.string(args.opt("mime"), 255);
                Integer size = ChannelArgs.integer(args.opt("size"));
                if (id == null || filename == null || mime == null || size == null || size < 0) throw new ChannelException("bad_args");
                if (size > MAX_BYTES) throw new ChannelException("too_large");
                return new SaveRequest(kind, null, FileNames.safe(filename), id, mime, size, 0, null);
            }
            case "chunk": {
                String id = transferId(args.opt("id"));
                Integer index = ChannelArgs.integer(args.opt("index"));
                Object base64 = args.opt("base64");
                if (id == null || index == null || index < 0 || !(base64 instanceof String)) throw new ChannelException("bad_args");
                if (((String) base64).length() > MAX_BASE64) throw new ChannelException("too_large");
                return new SaveRequest(kind, null, null, id, null, 0, index, (String) base64);
            }
            case "end":
            case "abort": {
                String id = transferId(args.opt("id"));
                if (id == null) throw new ChannelException("bad_args");
                return new SaveRequest(kind, null, null, id, null, 0, 0, null);
            }
            default:
                throw new ChannelException("bad_args");
        }
    }

    private static String transferId(Object value) {
        String id = ChannelArgs.string(value, 128);
        return id == null || id.isEmpty() ? null : id;
    }
}
