package com.murage.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;

/** Spec §3.5: notification channels. The person can change each one in system settings. */
final class PushChannels {
    private PushChannels() {}

    static void ensure(Context context) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("approvals", "Approvals", NotificationManager.IMPORTANCE_HIGH));
        nm.createNotificationChannel(new NotificationChannel("questions", "Questions", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(new NotificationChannel("requests", "Requests", NotificationManager.IMPORTANCE_DEFAULT));
        NotificationChannel calls = new NotificationChannel("calls_v2", context.getString(R.string.push_calls_channel), NotificationManager.IMPORTANCE_HIGH);
        calls.setSound(android.net.Uri.parse("android.resource://" + context.getPackageName() + "/raw/" + com.murage.mobile.shell.PushContract.CallSound.ANDROID),
            new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[]{0, 800, 600, 800, 600, 800});
        nm.createNotificationChannel(calls);
        nm.deleteNotificationChannel("calls");
        nm.createNotificationChannel(new NotificationChannel("finished", "Finished", NotificationManager.IMPORTANCE_LOW));
    }
}
