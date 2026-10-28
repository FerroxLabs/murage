package com.murage.mobile;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import com.murage.mobile.shell.PhoneJobsContract;
import java.util.*;
import org.json.JSONObject;

/** CalendarContract access stays behind the executor's narrow provider seam. */
final class PhoneCalendarProvider implements PhoneCalendarExecutor.Access {
    private final Context context; private final ContentResolver resolver;
    PhoneCalendarProvider(Context context) { this.context = context; resolver = context.getContentResolver(); }
    public String access() {
        // Choosing a writable calendar requires READ_CALENDAR on Android.
        return context.checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED
            && context.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED ? "full" : null;
    }
    public List<JSONObject> events(long start, long end, boolean notes) throws Exception {
        PhoneExecutorSupport.require("full".equals(access()));
        Uri.Builder uri = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(uri, start); ContentUris.appendId(uri, end);
        List<String> projection = new ArrayList<>(Arrays.asList(CalendarContract.Instances.EVENT_ID, CalendarContract.Events.TITLE,
            CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Events.ALL_DAY,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CalendarContract.Events.EVENT_LOCATION));
        if (notes) projection.add(CalendarContract.Events.DESCRIPTION);
        List<JSONObject> rows = new ArrayList<>();
        try (Cursor c = resolver.query(uri.build(), projection.toArray(new String[0]), CalendarContract.Events.DELETED + "=0", null, CalendarContract.Instances.BEGIN + " ASC")) {
            PhoneExecutorSupport.require(c != null);
            while (c.moveToNext()) {
                JSONObject row = PhoneJobRunner.json("id", c.getString(0), "title", string(c, 1), "start", PhoneExecutorSupport.time(c.getLong(2)),
                    "end", PhoneExecutorSupport.time(c.getLong(3)), "allDay", c.getInt(4) != 0, "calendar", string(c, 5));
                if (!c.isNull(6)) row.put("location", c.getString(6));
                if (notes && !c.isNull(7)) row.put("notes", c.getString(7));
                rows.add(row);
            }
        }
        return rows;
    }
    private static String string(Cursor c, int i) { return c.isNull(i) ? "" : c.getString(i); }
    private long calendar() throws Exception {
        try (Cursor c = resolver.query(CalendarContract.Calendars.CONTENT_URI, new String[]{CalendarContract.Calendars._ID},
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL + ">=? AND " + CalendarContract.Calendars.VISIBLE + "=1",
            new String[]{String.valueOf(CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR)},
            CalendarContract.Calendars.IS_PRIMARY + " DESC, " + CalendarContract.Calendars._ID + " ASC")) {
            PhoneExecutorSupport.require(c != null && c.moveToFirst()); return c.getLong(0);
        }
    }
    String title(String id) throws Exception {
        PhoneExecutorSupport.require("full".equals(access()));
        Uri uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, Long.parseLong(id));
        try (Cursor c = resolver.query(uri, new String[]{CalendarContract.Events.TITLE}, null, null, null)) {
            PhoneExecutorSupport.require(c != null && c.moveToFirst()); return string(c, 0);
        }
    }
    public String add(PhoneJobsContract.CalendarAddArgs a, PhoneJobRunner.Cancellation cancellation) throws Exception {
        PhoneExecutorSupport.require("full".equals(access()));
        ContentValues values = new ContentValues();
        values.put(CalendarContract.Events.CALENDAR_ID, calendar()); values.put(CalendarContract.Events.TITLE, a.title);
        values.put(CalendarContract.Events.DTSTART, PhoneExecutorSupport.time(a.start)); values.put(CalendarContract.Events.DTEND, PhoneExecutorSupport.time(a.end));
        boolean allDay = Boolean.TRUE.equals(a.allDay);
        values.put(CalendarContract.Events.ALL_DAY, allDay ? 1 : 0);
        values.put(CalendarContract.Events.EVENT_TIMEZONE, allDay ? "UTC" : TimeZone.getDefault().getID());
        if (allDay) {
            // CalendarProvider requires UTC midnight for all-day events. Preserve the supplied dates.
            values.put(CalendarContract.Events.DTSTART, java.time.OffsetDateTime.parse(a.start).toLocalDate().atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli());
            values.put(CalendarContract.Events.DTEND, java.time.OffsetDateTime.parse(a.end).toLocalDate().atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli());
        }
        if (a.location != null) values.put(CalendarContract.Events.EVENT_LOCATION, a.location);
        if (a.notes != null) values.put(CalendarContract.Events.DESCRIPTION, a.notes);
        cancellation.beginWrite();
        Uri saved = resolver.insert(CalendarContract.Events.CONTENT_URI, values);
        PhoneExecutorSupport.require(saved != null); return String.valueOf(ContentUris.parseId(saved));
    }
    public String change(PhoneJobsContract.CalendarChangeArgs a, PhoneJobRunner.Cancellation cancellation) throws Exception {
        PhoneExecutorSupport.require("full".equals(access()));
        long id = Long.parseLong(a.id); Uri uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id);
        ContentValues values = new ContentValues();
        if (a.start != null || a.end != null) {
            try (Cursor c = resolver.query(uri, new String[]{CalendarContract.Events.DTSTART, CalendarContract.Events.DTEND,
                CalendarContract.Events.ALL_DAY, CalendarContract.Events.RRULE, CalendarContract.Events.RDATE, CalendarContract.Events.DURATION}, null, null, null)) {
                PhoneExecutorSupport.require(c != null && c.moveToFirst());
                boolean allDay = c.getInt(2) != 0;
                boolean recurring = !c.isNull(3) && !c.getString(3).isEmpty() || !c.isNull(4) && !c.getString(4).isEmpty();
                long oldStart = c.getLong(0);
                long oldEnd = c.isNull(1) ? oldStart + durationMillis(c.getString(5)) : c.getLong(1);
                long start = a.start == null ? oldStart : eventTime(a.start, allDay);
                long end = a.end == null ? oldEnd : eventTime(a.end, allDay);
                PhoneExecutorSupport.require(end > start);
                if (a.start != null) values.put(CalendarContract.Events.DTSTART, start);
                if (recurring) {
                    // Events IDs address the provider's master. Preserve its recurrence rule.
                    values.put(CalendarContract.Events.DURATION, allDay ? "P" + ((end - start) / 86400000L) + "D" : "PT" + ((end - start) / 1000L) + "S");
                } else if (a.end != null) values.put(CalendarContract.Events.DTEND, end);
            }
        }
        if (a.title != null) values.put(CalendarContract.Events.TITLE, a.title);
        if (a.location != null) values.put(CalendarContract.Events.EVENT_LOCATION, a.location);
        if (a.notes != null) values.put(CalendarContract.Events.DESCRIPTION, a.notes);
        cancellation.beginWrite();
        PhoneExecutorSupport.require(resolver.update(uri, values, null, null) == 1); return a.id;
    }
    private static long durationMillis(String value) throws Exception {
        PhoneExecutorSupport.require(value != null);
        // Some providers use the compact P3600S form in addition to RFC 5545 PT3600S.
        if (value.matches("P[0-9]+S")) return Math.multiplyExact(Long.parseLong(value.substring(1, value.length() - 1)), 1000);
        if (value.matches("P[0-9]+W")) return Math.multiplyExact(Long.parseLong(value.substring(1, value.length() - 1)), 7L * 86400000);
        return java.time.Duration.parse(value).toMillis();
    }
    private static long eventTime(String value, boolean allDay) {
        return allDay ? java.time.OffsetDateTime.parse(value).toLocalDate().atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli() : PhoneExecutorSupport.time(value);
    }
}
