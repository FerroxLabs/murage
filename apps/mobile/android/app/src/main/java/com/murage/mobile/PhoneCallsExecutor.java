package com.murage.mobile;

import android.content.Intent;
import com.murage.mobile.shell.PhoneJobsContract;
import java.util.*;
import java.util.function.Consumer;

final class PhoneCallsExecutor implements PhoneExecutorSupport.Module {
    private final PhoneSystemIntents os;
    PhoneCallsExecutor(PhoneSystemIntents os) { this.os = os; }
    public void run(String operationId, String action, PhoneJobsContract.Args args, boolean precise, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) throws Exception {
        cancellation.check();
        if (!(args instanceof PhoneJobsContract.CallsDialArgs)) throw new PhoneExecutorSupport.Failure("unsupported");
        String number = ((PhoneJobsContract.CallsDialArgs) args).number;
        PhoneExecutorSupport.require(PhoneJobsContract.isDialNumber(number));
        if (!os.resolves(Intent.ACTION_DIAL, "tel")) throw new PhoneExecutorSupport.Failure("unsupported");
        cancellation.check();
        os.open(new PhoneSystemIntents.Request(Intent.ACTION_DIAL, "tel", number, Collections.emptyMap(), cancellation));
        done.accept(PhoneExecutorSupport.result(action, PhoneJobRunner.json("outcome", "dialer_opened")));
    }
}
