package com.murage.mobile;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.*;
import androidx.core.location.LocationManagerCompat;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

final class PhoneLocationProvider implements PhoneLocationExecutor.Access {
    private final Context context; private final LocationManager manager;
    private Runnable cancelCurrent;
    private final Handler main = new Handler(Looper.getMainLooper());
    PhoneLocationProvider(Context context) { this.context = context; manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE); }
    public boolean granted() { return context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED; }
    public boolean precise() { return context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED; }
    public void cancel() { main.post(() -> { if (cancelCurrent != null) { Runnable pending = cancelCurrent; cancelCurrent = null; main.removeCallbacks(pending); pending.run(); } }); }
    public void current(boolean precise, Consumer<PhoneLocationExecutor.Fix> done) throws Exception {
        PhoneExecutorSupport.require(granted() && manager != null);
        main.post(() -> {
            AtomicBoolean completed = new AtomicBoolean(); CancellationSignal cancel = new CancellationSignal();
            Runnable timeout = () -> { if (completed.compareAndSet(false, true)) { cancelCurrent = null; cancel.cancel(); done.accept(null); } };
            cancelCurrent = timeout;
            main.postDelayed(timeout, 15000);
            try {
                // Network provider is the coarse path even when the app holds FINE permission.
                String provider = precise && precise() ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
                if (!manager.isProviderEnabled(provider)) { main.removeCallbacks(timeout); timeout.run(); return; }
                LocationManagerCompat.getCurrentLocation(manager, provider, cancel, command -> main.post(command), location -> {
                    if (!completed.compareAndSet(false, true)) return;
                    main.removeCallbacks(timeout); cancelCurrent = null;
                    done.accept(location == null ? null : new PhoneLocationExecutor.Fix(location.getLatitude(), location.getLongitude(), location.getAccuracy(), location.getTime()));
                });
            } catch (Exception error) { main.removeCallbacks(timeout); timeout.run(); }
        });
    }
}
