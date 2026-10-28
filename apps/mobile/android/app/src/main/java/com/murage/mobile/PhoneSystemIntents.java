package com.murage.mobile;

import java.util.*;

interface PhoneSystemIntents {
    final class Request {
        final String action, scheme, recipient;
        final Map<String, Object> extras;
        final PhoneJobRunner.Cancellation cancellation;
        Request(String action, String scheme, String recipient, Map<String, Object> extras, PhoneJobRunner.Cancellation cancellation) {
            this.cancellation = cancellation;
            this.action = action; this.scheme = scheme; this.recipient = recipient;
            this.extras = Collections.unmodifiableMap(new HashMap<>(extras));
        }
    }
    boolean resolves(String action, String scheme);
    void open(Request request) throws Exception;
}
