package com.murage.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.function.Supplier;

/** No send or call API is exposed. Activity ownership is re-read on main for every launch. */
final class PhoneIntentLauncher implements PhoneSystemIntents {
    interface Main { boolean call(Callable<Boolean> operation); }
    private final Supplier<? extends Activity> host; private final Main main;
    PhoneIntentLauncher(Supplier<? extends Activity> host, Main main) { this.host = host; this.main = main; }
    public boolean resolves(String action, String scheme) {
        return main.call(() -> {
            Activity activity = host.get(); if (activity == null) return false;
            Intent intent = new Intent(action);
            if (scheme != null) intent.setData(Uri.parse(scheme + ":"));
            return intent.resolveActivity(activity.getPackageManager()) != null;
        });
    }
    public void open(Request request) throws Exception {
        boolean opened = main.call(() -> {
            Activity activity = host.get();
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) return false;
            Intent intent = new Intent(request.action);
            if (request.scheme != null) intent.setData(Uri.fromParts(request.scheme, request.recipient, null));
            for (Map.Entry<String, Object> entry : request.extras.entrySet()) {
                Object value = entry.getValue();
                if (value instanceof String) intent.putExtra(entry.getKey(), (String) value);
                else if (value instanceof Integer) intent.putExtra(entry.getKey(), (Integer) value);
                else if (value instanceof Boolean) intent.putExtra(entry.getKey(), (Boolean) value);
            }
            if (intent.resolveActivity(activity.getPackageManager()) == null) return false;
            request.cancellation.beginWrite();
            activity.startActivity(intent);
            return true;
        });
        PhoneExecutorSupport.require(opened);
    }
}
