package com.murage.mobile.shell;

/** Twin of MainDocument in LaunchPolicy.swift: 401 → re-pair, 502-504 → can't-reach (Decision 13). */
public final class MainDocument {
    private MainDocument() {}

    public static CloseReason closeReason(int status) {
        if (status == 401) return CloseReason.SIGNED_OUT;
        if (status == 502 || status == 503 || status == 504) return CloseReason.HOSTERROR;
        return null;
    }

    /** What a main document that loaded says about the computer; twin of MainDocumentArrival. */
    public enum Arrival { SIGNED_IN, IN_USE, NOTHING }

    /**
     * Twin of MainDocument.arrival in LaunchPolicy.swift. SIGNED_IN at "/"
     * (where pairing lands): WorkspaceBook.signedIn, which may add the
     * computer and make it active. IN_USE on any other page but the door's
     * pairing page /enter (the one 200 without a session): only "Last
     * connected" moves on (WorkspaceBook.touched), since a relaunch opens the
     * last conversation and a door without ready() has nothing else to go
     * by. Never adds, activates or evicts.
     */
    public static Arrival arrival(int status, String path) {
        if (status != 200 || "/enter".equals(path)) return Arrival.NOTHING;
        return path == null || path.isEmpty() || "/".equals(path) ? Arrival.SIGNED_IN : Arrival.IN_USE;
    }
}
