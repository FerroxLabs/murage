package com.murage.mobile;

import android.provider.AlarmClock;
import com.murage.mobile.shell.PhoneJobsContract;
import java.util.*;
import java.util.function.Consumer;

final class PhoneAlarmsExecutor implements PhoneExecutorSupport.Module {
    private final PhoneSystemIntents os; private final PhoneOperationLedger ledger;
    PhoneAlarmsExecutor(PhoneSystemIntents os, PhoneOperationLedger ledger) { this.os = os; this.ledger = ledger; }
    public void run(String operationId, String action, PhoneJobsContract.Args args, boolean precise, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) throws Exception {
        cancellation.check();
        Map<String, Object> extras = new HashMap<>(); String intent;
        if (args instanceof PhoneJobsContract.AlarmsSetArgs) {
            PhoneJobsContract.AlarmsSetArgs a = (PhoneJobsContract.AlarmsSetArgs) args;
            intent = AlarmClock.ACTION_SET_ALARM; extras.put(AlarmClock.EXTRA_HOUR, a.hour); extras.put(AlarmClock.EXTRA_MINUTES, a.minute);
            if (a.label != null) extras.put(AlarmClock.EXTRA_MESSAGE, a.label);
        } else if (args instanceof PhoneJobsContract.AlarmsTimerArgs) {
            PhoneJobsContract.AlarmsTimerArgs a = (PhoneJobsContract.AlarmsTimerArgs) args;
            intent = AlarmClock.ACTION_SET_TIMER; extras.put(AlarmClock.EXTRA_LENGTH, a.seconds);
            if (a.label != null) extras.put(AlarmClock.EXTRA_MESSAGE, a.label);
        } else throw new PhoneExecutorSupport.Failure("unsupported");
        if (!os.resolves(intent, null)) throw new PhoneExecutorSupport.Failure("unsupported");
        extras.put(AlarmClock.EXTRA_SKIP_UI, false);
        PhoneSystemIntents.Request request = new PhoneSystemIntents.Request(intent, null, null, extras, cancellation);
        ledger.perform(operationId, () -> { cancellation.check(); os.open(request); return PhoneOperationLedger.key(operationId); });
        done.accept(PhoneExecutorSupport.result(action, PhoneJobRunner.json("outcome", "clock_app_opened")));
    }
}
