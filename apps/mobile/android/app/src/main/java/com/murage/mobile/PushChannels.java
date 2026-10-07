package com.murage.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;

/** Spec §3.5: three channels. The person can change each one in system settings. */
final class PushChannels {
    private PushChannels() {}

    static void ensure(Context context) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("approvals", "Approvals", NotificationManager.IMPORTANCE_HIGH));
        nm.createNotificationChannel(new NotificationChannel("questions", "Questions", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(new NotificationChannel("finished", "Finished", NotificationManager.IMPORTANCE_LOW));
    }
}
