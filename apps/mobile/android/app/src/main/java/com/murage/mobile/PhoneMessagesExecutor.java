package com.murage.mobile;

import android.content.Intent;
import com.murage.mobile.shell.PhoneJobsContract;
import java.util.*;
import java.util.function.Consumer;

final class PhoneMessagesExecutor implements PhoneExecutorSupport.Module {
    private final PhoneSystemIntents os;
    PhoneMessagesExecutor(PhoneSystemIntents os) { this.os = os; }
    public void run(String operationId, String action, PhoneJobsContract.Args args, boolean precise, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) throws Exception {
        cancellation.check();
        if (!(args instanceof PhoneJobsContract.MessagesComposeArgs)) throw new PhoneExecutorSupport.Failure("unsupported");
        if (!os.resolves(Intent.ACTION_SENDTO, "smsto")) throw new PhoneExecutorSupport.Failure("unsupported");
        PhoneJobsContract.MessagesComposeArgs a = (PhoneJobsContract.MessagesComposeArgs) args;
        cancellation.check();
        os.open(new PhoneSystemIntents.Request(Intent.ACTION_SENDTO, "smsto", String.join(";", a.to), Collections.singletonMap("sms_body", a.body), cancellation));
        done.accept(PhoneExecutorSupport.result(action, PhoneJobRunner.json("outcome", "opened_for_you_to_send")));
    }
}
