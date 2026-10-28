package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import java.util.Map;
import java.util.function.Consumer;

/** Only PhoneJobRunner invokes the native capability dispatch. */
final class NativePhoneJobExecutors implements PhoneJobRunner.Executors {
    private final Map<String, PhoneExecutorSupport.Module> modules;
    NativePhoneJobExecutors(Map<String, PhoneExecutorSupport.Module> modules) { this.modules = modules; }
    @Override public void cancel() { for (PhoneExecutorSupport.Module module : modules.values()) module.cancel(); }
    @Override public void run(String operationId, String capability, String action, PhoneJobsContract.Args args,
                              boolean preciseConsent, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) {
        if (cancellation.isCancelled()) { done.accept(PhoneJobRunner.Execution.error("denied")); return; }
        PhoneExecutorSupport.Module module = modules.get(capability);
        if (module == null || !action.startsWith(capability + ".")) { done.accept(PhoneJobRunner.Execution.error("unsupported")); return; }
        try { module.run(operationId, action, args, preciseConsent, cancellation, done); }
        catch (PhoneExecutorSupport.Failure error) { done.accept(PhoneJobRunner.Execution.error(error.code)); }
        catch (Exception error) { done.accept(PhoneJobRunner.Execution.error("denied")); }
    }
}
