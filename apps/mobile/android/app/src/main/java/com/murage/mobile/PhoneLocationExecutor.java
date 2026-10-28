package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import java.util.function.Consumer;

final class PhoneLocationExecutor implements PhoneExecutorSupport.Module {
    static final class Fix {
        final double lat, lon, accuracy; final long at;
        Fix(double lat, double lon, double accuracy, long at) { this.lat = lat; this.lon = lon; this.accuracy = accuracy; this.at = at; }
    }
    interface Access {
        boolean granted(); boolean precise();
        default void cancel() {}
        void current(boolean precise, Consumer<Fix> done) throws Exception;
    }
    private final Access os;
    PhoneLocationExecutor(Access os) { this.os = os; }
    public void cancel() { os.cancel(); }
    public void run(String operationId, String action, PhoneJobsContract.Args args, boolean preciseConsent, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) throws Exception {
        cancellation.check();
        if (!(args instanceof PhoneJobsContract.LocationGetArgs)) throw new PhoneExecutorSupport.Failure("unsupported");
        PhoneExecutorSupport.require(os.granted());
        boolean precise = preciseConsent && "precise".equals(((PhoneJobsContract.LocationGetArgs) args).precision) && os.precise();
        os.current(precise, fix -> {
            if (cancellation.isCancelled() || !os.granted() || fix == null || !Double.isFinite(fix.lat) || !Double.isFinite(fix.lon) || !Double.isFinite(fix.accuracy) || Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180 || fix.accuracy < 0) { done.accept(PhoneJobRunner.Execution.error("denied")); return; }
            boolean full = precise && os.precise();
            done.accept(PhoneExecutorSupport.result(action, PhoneJobRunner.json(
                "lat", full ? fix.lat : Math.round(fix.lat * 1000) / 1000.0,
                "lon", full ? fix.lon : Math.round(fix.lon * 1000) / 1000.0,
                "accuracyMeters", full ? fix.accuracy : Math.max(100, fix.accuracy),
                "precision", full ? "precise" : "approximate", "at", PhoneExecutorSupport.time(fix.at))));
        });
    }
}
