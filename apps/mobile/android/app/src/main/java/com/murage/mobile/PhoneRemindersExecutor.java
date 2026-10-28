package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import java.util.function.Consumer;

/** Android has no reminders capability in this contract. */
final class PhoneRemindersExecutor implements PhoneExecutorSupport.Module {
    public void run(String operationId, String action, PhoneJobsContract.Args args, boolean precise, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) {
        done.accept(PhoneJobRunner.Execution.error("unsupported"));
    }
}
