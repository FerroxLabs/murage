package com.murage.mobile.shell;

/** A reply error code (ChannelError.swift has the same names). */
public final class ChannelException extends Exception {
    public final String code;
    public final int id;

    public ChannelException(String code) {
        this(code, -1);
    }

    public ChannelException(String code, int id) {
        super(code);
        this.code = code;
        this.id = id;
    }
}
