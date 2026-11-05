package com.murage.mobile.shell;

/** Why the workspace screen closed, as the launcher receives it. Twin of CloseReason in LaunchPolicy.swift. */
public enum CloseReason {
    UNREACHABLE("unreachable"),
    INSECURE("insecure"),
    SIGNED_OUT("signedOut"),
    SIGN_OUT("signOut"),
    LAUNCHER("launcher"),
    UPDATE_REQUIRED("updateRequired"),
    ACCESSOFF("accessoff"),
    HOSTERROR("hosterror"),
    /** 1.0.16: the computer refused the pairing code on its own /enter page. */
    PAIR_REFUSED("pairRefused");

    public final String wire;

    CloseReason(String wire) {
        this.wire = wire;
    }
}
