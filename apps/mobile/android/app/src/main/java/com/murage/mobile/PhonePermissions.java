package com.murage.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.AlarmClock;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;

final class PhonePermissions implements PhoneForBotsModel.Permissions {
    private final AppCompatActivity activity;
    private final ActivityResultLauncher<String[]> ask;
    private Runnable pending;
    PhonePermissions(AppCompatActivity activity) {
        this.activity = activity;
        ask = activity.registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> {
            Runnable answer = pending; pending = null;
            if (answer != null) answer.run();
        });
    }
    private boolean granted(String permission) { return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED; }
    private boolean resolves(Intent intent) { return intent.resolveActivity(activity.getPackageManager()) != null; }
    @Override public Object value(String row) {
        switch (row) {
            case "calendar":
                if (!granted(Manifest.permission.WRITE_CALENDAR)) return null;
                return granted(Manifest.permission.READ_CALENDAR) ? "full" : "write-only";
            case "contacts": return granted(Manifest.permission.READ_CONTACTS) ? "full" : null;
            case "location":
                if (!granted(Manifest.permission.ACCESS_COARSE_LOCATION)) return null;
                return granted(Manifest.permission.ACCESS_FINE_LOCATION) ? "precise" : "approximate";
            case "precise": return granted(Manifest.permission.ACCESS_COARSE_LOCATION) && granted(Manifest.permission.ACCESS_FINE_LOCATION) ? true : null;
            case "alarms": return resolves(new Intent(AlarmClock.ACTION_SET_ALARM)) && resolves(new Intent(AlarmClock.ACTION_SET_TIMER)) ? true : null;
            case "messages": return resolves(new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:"))) ? true : null;
            case "calls": return resolves(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:"))) ? true : null;
            default: return null; // Android never reports reminders.
        }
    }
    @Override public void request(String row, Runnable done) {
        String[] permissions;
        switch (row) {
            case "calendar": permissions = new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR}; break;
            case "contacts": permissions = new String[]{Manifest.permission.READ_CONTACTS}; break;
            case "location": permissions = new String[]{Manifest.permission.ACCESS_COARSE_LOCATION}; break;
            case "precise": permissions = new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION}; break;
            default: done.run(); return;
        }
        boolean all = true;
        for (String permission : permissions) all &= granted(permission);
        if (all) { done.run(); return; }
        pending = done;
        ask.launch(permissions);
    }
}
