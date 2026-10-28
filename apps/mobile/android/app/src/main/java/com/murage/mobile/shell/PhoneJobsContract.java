package com.murage.mobile.shell;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Native twin of shared/phone-jobs-contract.ts and phone-jobs-hash.ts. */
public final class PhoneJobsContract {
    private PhoneJobsContract() {}
    public static final String TAG = "murage-phone-jobs/1";
    public static final int TTL_MS = 60000, RESULT_MAX_BYTES = 262144;
    public static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList("calendar", "reminders", "contacts", "location", "alarms", "messages", "calls"));
    public static final List<String> RESULT_CODES = Collections.unmodifiableList(Arrays.asList("denied", "unsupported", "too_large", "invalid_result", "declined"));

    public static String approvalKeyId(String point) {
        if (point == null || !point.matches("[A-Za-z0-9_-]{87}")) return null;
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(point);
            if (bytes.length != 65 || bytes[0] != 4) return null;
            return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (IllegalArgumentException e) { return null; }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    public static String phoneJobsMessage(String origin, String keyId, String nonce, long expiresAt) {
        return TAG + "\n" + origin + "\n" + keyId + "\n" + nonce + "\n" + expiresAt;
    }

    public static boolean tokenValid(String value) { return value != null && value.matches("murage_pj_[A-Za-z0-9_-]{43}"); }

    public static final class Event {
        public final String id;
        public final String title;
        public final String start;
        public final String end;
        public final Boolean allDay;
        public final String calendar;
        public final String location;
        public final String notes;

        public Event(String id, String title, String start, String end, Boolean allDay, String calendar, String location, String notes) {
            this.id = id;
            this.title = title;
            this.start = start;
            this.end = end;
            this.allDay = allDay;
            this.calendar = calendar;
            this.location = location;
            this.notes = notes;
        }

        public static Event parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("Event", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new Event(
                (String) o.opt("id"),
                (String) o.opt("title"),
                (String) o.opt("start"),
                (String) o.opt("end"),
                (Boolean) o.opt("allDay"),
                (String) o.opt("calendar"),
                (o.has("location") ? (String) o.opt("location") : null),
                (o.has("notes") ? (String) o.opt("notes") : null)
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "id", id);
            put(o, "title", title);
            put(o, "start", start);
            put(o, "end", end);
            put(o, "allDay", allDay);
            put(o, "calendar", calendar);
            if (location != null) put(o, "location", location);
            if (notes != null) put(o, "notes", notes);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("Event", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class ContactPhone {
        public final String label;
        public final String number;

        public ContactPhone(String label, String number) {
            this.label = label;
            this.number = number;
        }

        public static ContactPhone parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("ContactPhone", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new ContactPhone(
                (o.has("label") ? (String) o.opt("label") : null),
                (String) o.opt("number")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            if (label != null) put(o, "label", label);
            put(o, "number", number);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("ContactPhone", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class ContactEmail {
        public final String label;
        public final String address;

        public ContactEmail(String label, String address) {
            this.label = label;
            this.address = address;
        }

        public static ContactEmail parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("ContactEmail", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new ContactEmail(
                (o.has("label") ? (String) o.opt("label") : null),
                (String) o.opt("address")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            if (label != null) put(o, "label", label);
            put(o, "address", address);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("ContactEmail", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class Contact {
        public final String id;
        public final String name;
        public final List<ContactPhone> phones;
        public final List<ContactEmail> emails;

        public Contact(String id, String name, List<ContactPhone> phones, List<ContactEmail> emails) {
            this.id = id;
            this.name = name;
            this.phones = (phones == null ? null : Collections.unmodifiableList(new ArrayList<>(phones)));
            this.emails = (emails == null ? null : Collections.unmodifiableList(new ArrayList<>(emails)));
        }

        public static Contact parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("Contact", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new Contact(
                (String) o.opt("id"),
                (String) o.opt("name"),
                readList((JSONArray) o.opt("phones"), item -> ContactPhone.parse(item)),
                readList((JSONArray) o.opt("emails"), item -> ContactEmail.parse(item))
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "id", id);
            put(o, "name", name);
            put(o, "phones", writeList(phones, item -> item.wire()));
            put(o, "emails", writeList(emails, item -> item.wire()));
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("Contact", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class Slot {
        public final String start;
        public final String end;

        public Slot(String start, String end) {
            this.start = start;
            this.end = end;
        }

        public static Slot parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("Slot", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new Slot(
                (String) o.opt("start"),
                (String) o.opt("end")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "start", start);
            put(o, "end", end);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("Slot", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class Reminder {
        public final String id;
        public final String title;
        public final String due;
        public final Boolean completed;
        public final String list;

        public Reminder(String id, String title, String due, Boolean completed, String list) {
            this.id = id;
            this.title = title;
            this.due = due;
            this.completed = completed;
            this.list = list;
        }

        public static Reminder parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("Reminder", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new Reminder(
                (String) o.opt("id"),
                (String) o.opt("title"),
                (o.has("due") ? (String) o.opt("due") : null),
                (Boolean) o.opt("completed"),
                (String) o.opt("list")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "id", id);
            put(o, "title", title);
            if (due != null) put(o, "due", due);
            put(o, "completed", completed);
            put(o, "list", list);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("Reminder", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class CalendarReadArgs extends Args {
        public final String start;
        public final String end;
        public final Boolean includeNotes;
        public final Integer limit;

        public CalendarReadArgs(String start, String end, Boolean includeNotes, Integer limit) {
            this.start = start;
            this.end = end;
            this.includeNotes = includeNotes;
            this.limit = limit;
        }

        public static CalendarReadArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CalendarReadArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CalendarReadArgs(
                (String) o.opt("start"),
                (String) o.opt("end"),
                (o.has("includeNotes") ? (Boolean) o.opt("includeNotes") : null),
                (o.has("limit") ? ((Number) o.opt("limit")).intValue() : null)
            );
        }
    }

    public static final class CalendarReadResult extends Result {
        public final List<Event> events;
        public final Boolean truncated;

        public CalendarReadResult(List<Event> events, Boolean truncated) {
            this.events = (events == null ? null : Collections.unmodifiableList(new ArrayList<>(events)));
            this.truncated = truncated;
        }

        public static CalendarReadResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CalendarReadResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CalendarReadResult(
                readList((JSONArray) o.opt("events"), item -> Event.parse(item)),
                (Boolean) o.opt("truncated")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "events", writeList(events, item -> item.wire()));
            put(o, "truncated", truncated);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("CalendarReadResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class CalendarFreeTimeArgs extends Args {
        public final String start;
        public final String end;
        public final Integer durationMinutes;
        public final Integer limit;

        public CalendarFreeTimeArgs(String start, String end, Integer durationMinutes, Integer limit) {
            this.start = start;
            this.end = end;
            this.durationMinutes = durationMinutes;
            this.limit = limit;
        }

        public static CalendarFreeTimeArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CalendarFreeTimeArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CalendarFreeTimeArgs(
                (String) o.opt("start"),
                (String) o.opt("end"),
                ((Number) o.opt("durationMinutes")).intValue(),
                (o.has("limit") ? ((Number) o.opt("limit")).intValue() : null)
            );
        }
    }

    public static final class CalendarFreeTimeResult extends Result {
        public final List<Slot> slots;

        public CalendarFreeTimeResult(List<Slot> slots) {
            this.slots = (slots == null ? null : Collections.unmodifiableList(new ArrayList<>(slots)));
        }

        public static CalendarFreeTimeResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CalendarFreeTimeResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CalendarFreeTimeResult(
                readList((JSONArray) o.opt("slots"), item -> Slot.parse(item))
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "slots", writeList(slots, item -> item.wire()));
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("CalendarFreeTimeResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class CalendarAddArgs extends Args {
        public final String title;
        public final String start;
        public final String end;
        public final Boolean allDay;
        public final String location;
        public final String notes;

        public CalendarAddArgs(String title, String start, String end, Boolean allDay, String location, String notes) {
            this.title = title;
            this.start = start;
            this.end = end;
            this.allDay = allDay;
            this.location = location;
            this.notes = notes;
        }

        public static CalendarAddArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CalendarAddArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CalendarAddArgs(
                (String) o.opt("title"),
                (String) o.opt("start"),
                (String) o.opt("end"),
                (o.has("allDay") ? (Boolean) o.opt("allDay") : null),
                (o.has("location") ? (String) o.opt("location") : null),
                (o.has("notes") ? (String) o.opt("notes") : null)
            );
        }
    }

    public static final class CalendarAddResult extends Result {
        public final String id;
        public final Boolean writeOnly;

        public CalendarAddResult(String id, Boolean writeOnly) {
            this.id = id;
            this.writeOnly = writeOnly;
        }

        public static CalendarAddResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CalendarAddResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CalendarAddResult(
                (String) o.opt("id"),
                (Boolean) o.opt("writeOnly")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "id", id);
            put(o, "writeOnly", writeOnly);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("CalendarAddResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class CalendarChangeArgs extends Args {
        public final String id;
        public final String title;
        public final String start;
        public final String end;
        public final String location;
        public final String notes;

        public CalendarChangeArgs(String id, String title, String start, String end, String location, String notes) {
            this.id = id;
            this.title = title;
            this.start = start;
            this.end = end;
            this.location = location;
            this.notes = notes;
        }

        public static CalendarChangeArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CalendarChangeArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CalendarChangeArgs(
                (String) o.opt("id"),
                (o.has("title") ? (String) o.opt("title") : null),
                (o.has("start") ? (String) o.opt("start") : null),
                (o.has("end") ? (String) o.opt("end") : null),
                (o.has("location") ? (String) o.opt("location") : null),
                (o.has("notes") ? (String) o.opt("notes") : null)
            );
        }
    }

    public static final class CalendarChangeResult extends Result {
        public final String id;

        public CalendarChangeResult(String id) {
            this.id = id;
        }

        public static CalendarChangeResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CalendarChangeResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CalendarChangeResult(
                (String) o.opt("id")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "id", id);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("CalendarChangeResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class RemindersReadArgs extends Args {
        public final Boolean includeCompleted;
        public final Integer limit;

        public RemindersReadArgs(Boolean includeCompleted, Integer limit) {
            this.includeCompleted = includeCompleted;
            this.limit = limit;
        }

        public static RemindersReadArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("RemindersReadArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new RemindersReadArgs(
                (o.has("includeCompleted") ? (Boolean) o.opt("includeCompleted") : null),
                (o.has("limit") ? ((Number) o.opt("limit")).intValue() : null)
            );
        }
    }

    public static final class RemindersReadResult extends Result {
        public final List<Reminder> reminders;
        public final Boolean truncated;

        public RemindersReadResult(List<Reminder> reminders, Boolean truncated) {
            this.reminders = (reminders == null ? null : Collections.unmodifiableList(new ArrayList<>(reminders)));
            this.truncated = truncated;
        }

        public static RemindersReadResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("RemindersReadResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new RemindersReadResult(
                readList((JSONArray) o.opt("reminders"), item -> Reminder.parse(item)),
                (Boolean) o.opt("truncated")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "reminders", writeList(reminders, item -> item.wire()));
            put(o, "truncated", truncated);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("RemindersReadResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class RemindersAddArgs extends Args {
        public final String title;
        public final String due;
        public final String notes;

        public RemindersAddArgs(String title, String due, String notes) {
            this.title = title;
            this.due = due;
            this.notes = notes;
        }

        public static RemindersAddArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("RemindersAddArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new RemindersAddArgs(
                (String) o.opt("title"),
                (o.has("due") ? (String) o.opt("due") : null),
                (o.has("notes") ? (String) o.opt("notes") : null)
            );
        }
    }

    public static final class RemindersAddResult extends Result {
        public final String id;

        public RemindersAddResult(String id) {
            this.id = id;
        }

        public static RemindersAddResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("RemindersAddResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new RemindersAddResult(
                (String) o.opt("id")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "id", id);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("RemindersAddResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class RemindersCompleteArgs extends Args {
        public final String id;

        public RemindersCompleteArgs(String id) {
            this.id = id;
        }

        public static RemindersCompleteArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("RemindersCompleteArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new RemindersCompleteArgs(
                (String) o.opt("id")
            );
        }
    }

    public static final class RemindersCompleteResult extends Result {
        public final String id;
        public final Boolean completed;

        public RemindersCompleteResult(String id, Boolean completed) {
            this.id = id;
            this.completed = completed;
        }

        public static RemindersCompleteResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("RemindersCompleteResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new RemindersCompleteResult(
                (String) o.opt("id"),
                (Boolean) o.opt("completed")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "id", id);
            put(o, "completed", completed);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("RemindersCompleteResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class ContactsSearchArgs extends Args {
        public final String query;
        public final Integer limit;

        public ContactsSearchArgs(String query, Integer limit) {
            this.query = query;
            this.limit = limit;
        }

        public static ContactsSearchArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("ContactsSearchArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new ContactsSearchArgs(
                (String) o.opt("query"),
                (o.has("limit") ? ((Number) o.opt("limit")).intValue() : null)
            );
        }
    }

    public static final class ContactsSearchResult extends Result {
        public final List<Contact> contacts;
        public final Boolean limited;

        public ContactsSearchResult(List<Contact> contacts, Boolean limited) {
            this.contacts = (contacts == null ? null : Collections.unmodifiableList(new ArrayList<>(contacts)));
            this.limited = limited;
        }

        public static ContactsSearchResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("ContactsSearchResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new ContactsSearchResult(
                readList((JSONArray) o.opt("contacts"), item -> Contact.parse(item)),
                (Boolean) o.opt("limited")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "contacts", writeList(contacts, item -> item.wire()));
            put(o, "limited", limited);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("ContactsSearchResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class ContactsGetArgs extends Args {
        public final String id;

        public ContactsGetArgs(String id) {
            this.id = id;
        }

        public static ContactsGetArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("ContactsGetArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new ContactsGetArgs(
                (String) o.opt("id")
            );
        }
    }

    public static final class ContactsGetResult extends Result {
        public final Contact contact;
        public final Boolean limited;

        public ContactsGetResult(Contact contact, Boolean limited) {
            this.contact = contact;
            this.limited = limited;
        }

        public static ContactsGetResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("ContactsGetResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new ContactsGetResult(
                (o.opt("contact") == JSONObject.NULL ? null : Contact.parse(o.opt("contact"))),
                (Boolean) o.opt("limited")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "contact", (contact == null ? JSONObject.NULL : contact.wire()));
            put(o, "limited", limited);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("ContactsGetResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class LocationGetArgs extends Args {
        public final String precision;

        public LocationGetArgs(String precision) {
            this.precision = precision;
        }

        public static LocationGetArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("LocationGetArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new LocationGetArgs(
                (String) o.opt("precision")
            );
        }
    }

    public static final class LocationGetResult extends Result {
        public final Double lat;
        public final Double lon;
        public final Double accuracyMeters;
        public final String precision;
        public final String at;

        public LocationGetResult(Double lat, Double lon, Double accuracyMeters, String precision, String at) {
            this.lat = lat;
            this.lon = lon;
            this.accuracyMeters = accuracyMeters;
            this.precision = precision;
            this.at = at;
        }

        public static LocationGetResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("LocationGetResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new LocationGetResult(
                ((Number) o.opt("lat")).doubleValue(),
                ((Number) o.opt("lon")).doubleValue(),
                ((Number) o.opt("accuracyMeters")).doubleValue(),
                (String) o.opt("precision"),
                (String) o.opt("at")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "lat", lat);
            put(o, "lon", lon);
            put(o, "accuracyMeters", accuracyMeters);
            put(o, "precision", precision);
            put(o, "at", at);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("LocationGetResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class AlarmsSetArgs extends Args {
        public final Integer hour;
        public final Integer minute;
        public final String label;

        public AlarmsSetArgs(Integer hour, Integer minute, String label) {
            this.hour = hour;
            this.minute = minute;
            this.label = label;
        }

        public static AlarmsSetArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("AlarmsSetArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new AlarmsSetArgs(
                ((Number) o.opt("hour")).intValue(),
                ((Number) o.opt("minute")).intValue(),
                (o.has("label") ? (String) o.opt("label") : null)
            );
        }
    }

    public static final class AlarmsSetResult extends Result {
        public final String outcome;

        public AlarmsSetResult(String outcome) {
            this.outcome = outcome;
        }

        public static AlarmsSetResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("AlarmsSetResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new AlarmsSetResult(
                (String) o.opt("outcome")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "outcome", outcome);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("AlarmsSetResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class AlarmsTimerArgs extends Args {
        public final Integer seconds;
        public final String label;

        public AlarmsTimerArgs(Integer seconds, String label) {
            this.seconds = seconds;
            this.label = label;
        }

        public static AlarmsTimerArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("AlarmsTimerArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new AlarmsTimerArgs(
                ((Number) o.opt("seconds")).intValue(),
                (o.has("label") ? (String) o.opt("label") : null)
            );
        }
    }

    public static final class AlarmsTimerResult extends Result {
        public final String outcome;

        public AlarmsTimerResult(String outcome) {
            this.outcome = outcome;
        }

        public static AlarmsTimerResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("AlarmsTimerResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new AlarmsTimerResult(
                (String) o.opt("outcome")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "outcome", outcome);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("AlarmsTimerResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    /** Approval and dialer share this exact ASCII alphabet; never normalize a destination.
     * This contract has no iMessage-specific email recipient mode. */
    public static boolean isDialNumber(String value) {
        return value != null && value.length() <= 40 && value.matches("[0-9+ .()\\-]+");
    }

    public static boolean isMessageBody(String value) {
        return value != null && value.length() <= 2000 && value.codePoints().allMatch(cp ->
            cp == '\n' || (Character.getType(cp) != Character.CONTROL && Character.getType(cp) != Character.FORMAT));
    }

    /** The wire shape can carry arbitrary text. Native approval is stricter and never sanitizes it. */
    private static Args approvalArgs(String action, JSONObject raw) {
        Args args = Args.parse(action, raw);
        if (args instanceof CallsDialArgs && !isDialNumber(((CallsDialArgs) args).number)) return null;
        if (args instanceof MessagesComposeArgs) {
            MessagesComposeArgs a = (MessagesComposeArgs) args;
            if (!a.to.stream().allMatch(PhoneJobsContract::isDialNumber) || !isMessageBody(a.body)) return null;
        }
        return args;
    }

    public static final class MessagesComposeArgs extends Args {
        public final List<String> to;
        public final String body;

        public MessagesComposeArgs(List<String> to, String body) {
            this.to = (to == null ? null : Collections.unmodifiableList(new ArrayList<>(to)));
            this.body = body;
        }

        public static MessagesComposeArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("MessagesComposeArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new MessagesComposeArgs(
                readList((JSONArray) o.opt("to"), item -> (String) item),
                (String) o.opt("body")
            );
        }
    }

    public static final class MessagesComposeResult extends Result {
        public final String outcome;

        public MessagesComposeResult(String outcome) {
            this.outcome = outcome;
        }

        public static MessagesComposeResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("MessagesComposeResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new MessagesComposeResult(
                (String) o.opt("outcome")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "outcome", outcome);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("MessagesComposeResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public static final class CallsDialArgs extends Args {
        public final String number;

        public CallsDialArgs(String number) {
            this.number = number;
        }

        public static CallsDialArgs parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CallsDialArgs", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CallsDialArgs(
                (String) o.opt("number")
            );
        }
    }

    public static final class CallsDialResult extends Result {
        public final String outcome;

        public CallsDialResult(String outcome) {
            this.outcome = outcome;
        }

        public static CallsDialResult parse(Object any) {
            if (!(any instanceof JSONObject) || !valid("CallsDialResult", (JSONObject) any)) return null;
            JSONObject o = (JSONObject) any;
            return new CallsDialResult(
                (String) o.opt("outcome")
            );
        }

        private JSONObject wire() {
            JSONObject o = new JSONObject();
            put(o, "outcome", outcome);
            return o;
        }

        public JSONObject encode() {
            try {
                JSONObject o = wire();
                return valid("CallsDialResult", o) && withinResultBound(o) ? o : null;
            } catch (IllegalArgumentException | NullPointerException e) { return null; }
        }
    }

    public abstract static class Args {
        private Args() {}
        public static Args parse(String action, Object any) {
            if (action == null) return null;
            switch (action) {
                case "calendar.read": return CalendarReadArgs.parse(any);
                case "calendar.free_time": return CalendarFreeTimeArgs.parse(any);
                case "calendar.add": return CalendarAddArgs.parse(any);
                case "calendar.change": return CalendarChangeArgs.parse(any);
                case "reminders.read": return RemindersReadArgs.parse(any);
                case "reminders.add": return RemindersAddArgs.parse(any);
                case "reminders.complete": return RemindersCompleteArgs.parse(any);
                case "contacts.search": return ContactsSearchArgs.parse(any);
                case "contacts.get": return ContactsGetArgs.parse(any);
                case "location.get": return LocationGetArgs.parse(any);
                case "alarms.set": return AlarmsSetArgs.parse(any);
                case "alarms.timer": return AlarmsTimerArgs.parse(any);
                case "messages.compose": return MessagesComposeArgs.parse(any);
                case "calls.dial": return CallsDialArgs.parse(any);
                default: return null;
            }
        }
    }

    public abstract static class Result {
        private Result() {}
        public abstract JSONObject encode();
        public static Result parse(String action, Object any) {
            if (action == null) return null;
            switch (action) {
                case "calendar.read": return CalendarReadResult.parse(any);
                case "calendar.free_time": return CalendarFreeTimeResult.parse(any);
                case "calendar.add": return CalendarAddResult.parse(any);
                case "calendar.change": return CalendarChangeResult.parse(any);
                case "reminders.read": return RemindersReadResult.parse(any);
                case "reminders.add": return RemindersAddResult.parse(any);
                case "reminders.complete": return RemindersCompleteResult.parse(any);
                case "contacts.search": return ContactsSearchResult.parse(any);
                case "contacts.get": return ContactsGetResult.parse(any);
                case "location.get": return LocationGetResult.parse(any);
                case "alarms.set": return AlarmsSetResult.parse(any);
                case "alarms.timer": return AlarmsTimerResult.parse(any);
                case "messages.compose": return MessagesComposeResult.parse(any);
                case "calls.dial": return CallsDialResult.parse(any);
                default: return null;
            }
        }
    }

    private static Map<String, Map<String, Rule>> schemas() {
        Map<String, Map<String, Rule>> schemas = new HashMap<>();
        schemas.put("Event", fields("id", text(1, 256), "title", text(0, 500), "start", TIME, "end", TIME, "allDay", BOOLEAN, "calendar", text(0, 200), "location?", text(0, 500), "notes?", text(0, 4000)));
        schemas.put("ContactPhone", fields("label?", text(0, 50), "number", text(1, 40)));
        schemas.put("ContactEmail", fields("label?", text(0, 50), "address", text(1, 254)));
        schemas.put("Contact", fields("id", text(1, 256), "name", text(0, 200), "phones", array(object("ContactPhone"), 0, 10), "emails", array(object("ContactEmail"), 0, 10)));
        schemas.put("Slot", fields("start", TIME, "end", TIME));
        schemas.put("Reminder", fields("id", text(1, 256), "title", text(0, 500), "due?", text(0, 64), "completed", BOOLEAN, "list", text(0, 200)));
        schemas.put("CalendarReadArgs", fields("start", TIME, "end", TIME, "includeNotes?", BOOLEAN, "limit?", integer(1, 200)));
        schemas.put("CalendarReadResult", fields("events", array(object("Event"), 0, 200), "truncated", BOOLEAN));
        schemas.put("CalendarFreeTimeArgs", fields("start", TIME, "end", TIME, "durationMinutes", integer(5, 480), "limit?", integer(1, 20)));
        schemas.put("CalendarFreeTimeResult", fields("slots", array(object("Slot"), 0, 20)));
        schemas.put("CalendarAddArgs", fields("title", text(1, 500), "start", TIME, "end", TIME, "allDay?", BOOLEAN, "location?", text(0, 500), "notes?", text(0, 4000)));
        schemas.put("CalendarAddResult", fields("id", text(1, 256), "writeOnly", BOOLEAN));
        schemas.put("CalendarChangeArgs", fields("id", text(1, 256), "title?", text(1, 500), "start?", TIME, "end?", TIME, "location?", text(0, 500), "notes?", text(0, 4000)));
        schemas.put("CalendarChangeResult", fields("id", text(1, 256)));
        schemas.put("RemindersReadArgs", fields("includeCompleted?", BOOLEAN, "limit?", integer(1, 200)));
        schemas.put("RemindersReadResult", fields("reminders", array(object("Reminder"), 0, 200), "truncated", BOOLEAN));
        schemas.put("RemindersAddArgs", fields("title", text(1, 500), "due?", text(0, 64), "notes?", text(0, 4000)));
        schemas.put("RemindersAddResult", fields("id", text(1, 256)));
        schemas.put("RemindersCompleteArgs", fields("id", text(1, 256)));
        schemas.put("RemindersCompleteResult", fields("id", text(1, 256), "completed", TRUE));
        schemas.put("ContactsSearchArgs", fields("query", text(1, 100), "limit?", integer(1, 25)));
        schemas.put("ContactsSearchResult", fields("contacts", array(object("Contact"), 0, 25), "limited", BOOLEAN));
        schemas.put("ContactsGetArgs", fields("id", text(1, 256)));
        schemas.put("ContactsGetResult", fields("contact", nullable(object("Contact")), "limited", BOOLEAN));
        schemas.put("LocationGetArgs", fields("precision", oneOf("approximate", "precise")));
        schemas.put("LocationGetResult", fields("lat", number(-90, 90), "lon", number(-180, 180), "accuracyMeters", number(0, Double.MAX_VALUE), "precision", oneOf("approximate", "precise"), "at", text(1, 64)));
        schemas.put("AlarmsSetArgs", fields("hour", integer(0, 23), "minute", integer(0, 59), "label?", text(0, 100)));
        schemas.put("AlarmsSetResult", fields("outcome", oneOf("set", "clock_app_opened")));
        schemas.put("AlarmsTimerArgs", fields("seconds", integer(1, 86400), "label?", text(0, 100)));
        schemas.put("AlarmsTimerResult", fields("outcome", oneOf("set", "clock_app_opened")));
        schemas.put("MessagesComposeArgs", fields("to", array(text(1, 40), 1, 10), "body", text(0, 2000)));
        schemas.put("MessagesComposeResult", fields("outcome", oneOf("opened_for_you_to_send")));
        schemas.put("CallsDialArgs", fields("number", text(1, 40)));
        schemas.put("CallsDialResult", fields("outcome", oneOf("dialer_opened")));
        return schemas;
    }

    private interface Rule { boolean accepts(Object value); }
    private static final Rule BOOLEAN = v -> v instanceof Boolean;
    private static final Rule TRUE = v -> Boolean.TRUE.equals(v);
    private static final Rule TIME = v -> v instanceof String && instant((String) v) != null;
    private static Rule text(int min, int max) { return v -> v instanceof String && ((String) v).length() >= min && ((String) v).length() <= max; }
    private static Rule integer(int min, int max) { return v -> numeric(v) && ((Number) v).doubleValue() == Math.rint(((Number) v).doubleValue()) && ((Number) v).doubleValue() >= min && ((Number) v).doubleValue() <= max; }
    private static Rule number(double min, double max) { return v -> numeric(v) && ((Number) v).doubleValue() >= min && ((Number) v).doubleValue() <= max; }
    private static Rule oneOf(String... values) { return v -> v instanceof String && Arrays.asList(values).contains(v); }
    private static Rule nullable(Rule rule) { return v -> v == JSONObject.NULL || rule.accepts(v); }
    private static Rule object(String name) { return v -> v instanceof JSONObject && valid(name, (JSONObject) v); }
    private static Rule array(Rule rule, int min, int max) {
        return v -> {
            if (!(v instanceof JSONArray)) return false;
            JSONArray a = (JSONArray) v;
            if (a.length() < min || a.length() > max) return false;
            for (int i = 0; i < a.length(); i++) if (!rule.accepts(a.opt(i))) return false;
            return true;
        };
    }

    private static Map<String, Rule> fields(Object... pairs) {
        Map<String, Rule> fields = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) fields.put((String) pairs[i], (Rule) pairs[i + 1]);
        return fields;
    }

    private static boolean accepts(Map<String, Rule> fields, JSONObject o) {
        for (Iterator<String> it = o.keys(); it.hasNext();) {
            String key = it.next();
            // The question mark is schema notation, never part of a wire key.
            if (key.endsWith("?") || (!fields.containsKey(key) && !fields.containsKey(key + "?"))) return false;
        }
        for (Map.Entry<String, Rule> entry : fields.entrySet()) {
            String field = entry.getKey();
            boolean optional = field.endsWith("?");
            String key = optional ? field.substring(0, field.length() - 1) : field;
            if (!o.has(key)) { if (optional) continue; return false; }
            if (!entry.getValue().accepts(o.opt(key))) return false;
        }
        return true;
    }

    private static boolean valid(String name, JSONObject o) {
        Map<String, Rule> fields = SCHEMAS.get(name);
        if (fields == null || !accepts(fields, o)) return false;
        switch (name) {
            case "CalendarReadArgs": case "CalendarFreeTimeArgs": case "CalendarAddArgs":
                long start = instant((String) o.opt("start")), end = instant((String) o.opt("end"));
                int days = name.equals("CalendarReadArgs") ? 31 : 14;
                return end > start && (name.equals("CalendarAddArgs") || end - start <= days * 86400000L);
            case "CalendarChangeArgs": return o.length() > 1;
            default: return true;
        }
    }

    private interface Reader<T> { T read(Object value); }
    private interface Writer<T> { Object write(T value); }
    private static <T> List<T> readList(JSONArray a, Reader<T> reader) {
        List<T> list = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) list.add(reader.read(a.opt(i)));
        return list;
    }
    private static <T> JSONArray writeList(List<T> list, Writer<T> writer) {
        JSONArray a = new JSONArray();
        for (T item : list) a.put(writer.write(item));
        return a;
    }
    private static void put(JSONObject o, String key, Object value) {
        try { o.put(key, value == null ? JSONObject.NULL : value); }
        catch (JSONException e) { throw new IllegalArgumentException(e); }
    }
    private static boolean numeric(Object v) { return v instanceof Number && Double.isFinite(((Number) v).doubleValue()); }
    private static Long positiveInteger(Object v) {
        if (!numeric(v)) return null;
        double n = ((Number) v).doubleValue();
        return n > 0 && n <= 9007199254740991d && n == Math.rint(n) ? (long) n : null;
    }
    private static boolean matches(Object v, String pattern) { return v instanceof String && ((String) v).matches(pattern); }
    private static final String UUID4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    private static final String LEASE_PATTERN = "[A-Za-z0-9_-]{43}";
    private static final Pattern ISO_TIME = Pattern.compile("([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]{1,9}))?(Z|([+-])([0-9]{2}):([0-9]{2}))");

    /** Date.parse ISO semantics: day 1..31 rolls, 24:00 is next midnight,
     * and sub-millisecond digits are truncated. No locale or default zone. */
    private static Long instant(String s) {
        if (s.length() > 40) return null;
        Matcher m = ISO_TIME.matcher(s);
        if (!m.matches()) return null;
        int year = Integer.parseInt(m.group(1)), month = Integer.parseInt(m.group(2)), day = Integer.parseInt(m.group(3));
        int hour = Integer.parseInt(m.group(4)), minute = Integer.parseInt(m.group(5)), second = Integer.parseInt(m.group(6));
        int millis = m.group(7) == null ? 0 : Integer.parseInt((m.group(7) + "000").substring(0, 3));
        if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59) return null;
        if (hour == 24 && (minute != 0 || second != 0 || millis != 0)) return null;
        int offset = 0;
        if (!m.group(8).equals("Z")) {
            int h = Integer.parseInt(m.group(10)), min = Integer.parseInt(m.group(11));
            if (h > 23 || min > 59) return null;
            offset = (h * 60 + min) * (m.group(9).equals("+") ? 1 : -1);
        }
        long days = LocalDate.of(year, month, 1).toEpochDay() + day - 1;
        return days * 86400000L + hour * 3600000L + minute * 60000L + second * 1000L + millis - offset * 60000L;
    }

    /** JSON.stringify byte count, including UTF-8, controls, null, and decimal cutovers. */
    private static Long jsonBytes(Object v) {
        if (v == JSONObject.NULL) return 4L;
        if (v instanceof Boolean) return (Boolean) v ? 4L : 5L;
        if (v instanceof String) {
            String s = (String) v;
            long size = 2;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c == '"' || c == '\\' || c == '\b' || c == '\t' || c == '\n' || c == '\f' || c == '\r') size += 2;
                else if (c < 32) size += 6;
                else if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) { size += 4; i++; }
                else if (Character.isSurrogate(c)) size += 6;
                else size += c < 128 ? 1 : c < 2048 ? 2 : 3;
            }
            return size;
        }
        if (numeric(v)) return (long) numberText(((Number) v).doubleValue()).length();
        if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            long size = 2L + Math.max(0, a.length() - 1);
            for (int i = 0; i < a.length(); i++) { Long count = jsonBytes(a.opt(i)); if (count == null) return null; size += count; }
            return size;
        }
        if (v instanceof JSONObject) {
            JSONObject o = (JSONObject) v;
            long size = 2L + Math.max(0, o.length() - 1);
            for (Iterator<String> it = o.keys(); it.hasNext();) {
                String key = it.next();
                Long count = jsonBytes(o.opt(key));
                if (count == null) return null;
                size += jsonBytes(key) + 1 + count;
            }
            return size;
        }
        return null;
    }

    private static String numberText(double n) {
        if (n == 0) return "0";
        // Choose the shortest decimal which rounds back to the same double.
        // BigDecimal(double) starts with the exact binary value, avoiding Java's
        // older Double.toString choices at e.g. 1e23 and the smallest subnormal.
        BigDecimal exact = new BigDecimal(Math.abs(n)), shortest = exact;
        for (int precision = 1; precision <= 17; precision++) {
            BigDecimal candidate = exact.round(new MathContext(precision, RoundingMode.HALF_EVEN));
            if (candidate.doubleValue() == Math.abs(n)) { shortest = candidate.stripTrailingZeros(); break; }
        }
        String digits = shortest.unscaledValue().toString();
        int decimal = digits.length() - shortest.scale();
        String sign = n < 0 ? "-" : "";
        if (decimal > 0 && decimal <= 21) {
            if (decimal >= digits.length()) return sign + digits + zeros(decimal - digits.length());
            return sign + digits.substring(0, decimal) + "." + digits.substring(decimal);
        }
        if (decimal <= 0 && decimal > -6) return sign + "0." + zeros(-decimal) + digits;
        int exponent = decimal - 1;
        return sign + digits.substring(0, 1) + (digits.length() > 1 ? "." + digits.substring(1) : "") + "e" + (exponent >= 0 ? "+" : "") + exponent;
    }
    private static String zeros(int count) { char[] chars = new char[count]; Arrays.fill(chars, '0'); return new String(chars); }

    public static boolean withinResultBound(Object value) {
        Long count = jsonBytes(value);
        return count != null && count <= RESULT_MAX_BYTES;
    }

    public static final class NamedParty {
        public final String id, name;
        private NamedParty(JSONObject o) { id = (String) o.opt("id"); name = (String) o.opt("name"); }
    }

    public static final class Offer {
        public final String operationId, offerId, workspace, capability, action, say;
        public final NamedParty bot, provider;
        public final long expiresAt;
        public final int leaseMs;
        private final String argsJson;
        // One immutable validated snapshot shared by the card and executor.
        private final Args decodedArgs;
        private Offer(JSONObject o) {
            operationId = (String) o.opt("operationId"); offerId = (String) o.opt("offerId"); workspace = (String) o.opt("workspace");
            capability = (String) o.opt("capability"); action = (String) o.opt("action"); say = (String) o.opt("say");
            bot = new NamedParty((JSONObject) o.opt("bot")); provider = new NamedParty((JSONObject) o.opt("provider"));
            expiresAt = positiveInteger(o.opt("expiresAt")); leaseMs = ((Number) o.opt("leaseMs")).intValue();
            argsJson = o.opt("args").toString();
            decodedArgs = action.substring(0, action.indexOf('.')).equals(capability) ? approvalArgs(action, args()) : null;
        }
        public JSONObject args() { return jsonObject(argsJson); }
        /** Mirrors offerSchema. Use decodedArgs before executing an action. */
        public static Offer parse(Object any) {
            if (!(any instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) any;
            if (!keys(o, "operationId", "offerId", "workspace", "bot", "capability", "action", "args", "say", "provider", "expiresAt", "leaseMs")) return null;
            if (!matches(o.opt("operationId"), UUID4) || !matches(o.opt("offerId"), UUID4) || !text(1, 120).accepts(o.opt("workspace"))) return null;
            if (!(o.opt("bot") instanceof JSONObject) || !accepts(fields("id", text(1, 128), "name", text(1, 120)), (JSONObject) o.opt("bot"))) return null;
            if (!CAPABILITIES.contains(o.opt("capability")) || !text(1, 48).accepts(o.opt("action")) || !matches(o.opt("action"), "[a-z]+\\.[a-z_]+")) return null;
            if (!(o.opt("args") instanceof JSONObject) || !text(1, 240).accepts(o.opt("say"))) return null;
            if (!(o.opt("provider") instanceof JSONObject) || !accepts(fields("id", text(1, 64), "name", text(1, 120)), (JSONObject) o.opt("provider"))) return null;
            if (positiveInteger(o.opt("expiresAt")) == null || !numeric(o.opt("leaseMs"))) return null;
            double lease = ((Number) o.opt("leaseMs")).doubleValue();
            if (lease != 45000 && lease != 180000) return null;
            return new Offer(o);
        }
        public Args decodedArgs() {
            return decodedArgs;
        }
    }

    public static final class PollAnswer {
        public final List<Offer> jobs;
        private PollAnswer(List<Offer> jobs) { this.jobs = Collections.unmodifiableList(jobs); }
        public static PollAnswer parse(Object any) {
            if (!(any instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) any;
            if (!keys(o, "jobs") || !(o.opt("jobs") instanceof JSONArray)) return null;
            JSONArray jobs = (JSONArray) o.opt("jobs");
            if (jobs.length() > 1) return null;
            List<Offer> parsed = new ArrayList<>();
            for (int i = 0; i < jobs.length(); i++) { Offer offer = Offer.parse(jobs.opt(i)); if (offer == null) return null; parsed.add(offer); }
            return new PollAnswer(parsed);
        }
    }

    public static final class TargetedAnswer {
        public enum Kind { JOBS, LEASED, HANDLED }
        public final Kind kind;
        public final Offer job;
        public final Long expiresAt;
        public final String reason;
        private TargetedAnswer(Kind kind, Offer job, Long expiresAt, String reason) { this.kind = kind; this.job = job; this.expiresAt = expiresAt; this.reason = reason; }
        public static TargetedAnswer parse(Object any) {
            if (!(any instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) any;
            PollAnswer poll = PollAnswer.parse(o);
            if (poll != null && poll.jobs.size() == 1) return new TargetedAnswer(Kind.JOBS, poll.jobs.get(0), null, null);
            if (keys(o, "leased", "expiresAt") && Boolean.TRUE.equals(o.opt("leased")) && positiveInteger(o.opt("expiresAt")) != null)
                return new TargetedAnswer(Kind.LEASED, null, positiveInteger(o.opt("expiresAt")), null);
            if (keys(o, "handled", "reason") && Boolean.TRUE.equals(o.opt("handled")) && oneOf("done", "revoked", "ended", "unknown").accepts(o.opt("reason")))
                return new TargetedAnswer(Kind.HANDLED, null, null, (String) o.opt("reason"));
            return null;
        }
    }

    public static final class LeaseRequest {
        public final String offerId;
        private LeaseRequest(String offerId) { this.offerId = offerId; }
        public static LeaseRequest parse(Object any) {
            if (!(any instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) any;
            return keys(o, "offerId") && matches(o.opt("offerId"), UUID4) ? new LeaseRequest((String) o.opt("offerId")) : null;
        }
    }

    public static final class LeaseAnswer {
        public final boolean active;
        public final String leaseToken;
        private LeaseAnswer(boolean active, String token) { this.active = active; this.leaseToken = token; }
        public static LeaseAnswer parse(Object any) {
            if (!(any instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) any;
            if (keys(o, "active") && Boolean.FALSE.equals(o.opt("active"))) return new LeaseAnswer(false, null);
            if (keys(o, "active", "leaseToken") && Boolean.TRUE.equals(o.opt("active")) && matches(o.opt("leaseToken"), LEASE_PATTERN))
                return new LeaseAnswer(true, (String) o.opt("leaseToken"));
            return null;
        }
    }

    public static final class ResultBody {
        public final String leaseToken, error, code;
        public final boolean ok, hasResult;
        private final String resultJson;
        private ResultBody(JSONObject o) {
            leaseToken = (String) o.opt("leaseToken"); ok = (Boolean) o.opt("ok"); error = (String) o.opt("error"); code = (String) o.opt("code");
            hasResult = o.has("result");
            // A single-element array preserves scalars and explicit JSON null.
            resultJson = hasResult ? new JSONArray().put(o.opt("result")).toString() : null;
        }
        public Object result() {
            if (!hasResult) return null;
            try { return new JSONArray(resultJson).opt(0); } catch (JSONException e) { throw new IllegalStateException(e); }
        }
        public static ResultBody parse(Object any) {
            if (!(any instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) any;
            for (Iterator<String> it = o.keys(); it.hasNext();) if (!Arrays.asList("leaseToken", "ok", "result", "error", "code").contains(it.next())) return null;
            if (!matches(o.opt("leaseToken"), LEASE_PATTERN) || !(o.opt("ok") instanceof Boolean)) return null;
            if (o.has("error") && !text(1, 500).accepts(o.opt("error"))) return null;
            if (o.has("code") && !RESULT_CODES.contains(o.opt("code"))) return null;
            boolean ok = (Boolean) o.opt("ok");
            if (ok ? (o.has("error") || o.has("code")) : (!o.has("code") || o.has("result"))) return null;
            if (o.has("result") && !withinResultBound(o.opt("result"))) return null;
            return new ResultBody(o);
        }
    }

    public static boolean registrationValid(Object any) {
        if (!(any instanceof JSONObject)) return false;
        JSONObject o = (JSONObject) any;
        if (!keys(o, "name", "platform", "osVersion", "appVersion", "timeZone", "protocol", "capabilities")) return false;
        if (!text(1, 80).accepts(o.opt("name")) || !oneOf("ios", "android").accepts(o.opt("platform")) || !text(1, 40).accepts(o.opt("osVersion")) || !text(1, 40).accepts(o.opt("appVersion")) || !text(1, 64).accepts(o.opt("timeZone"))) return false;
        if (!numeric(o.opt("protocol")) || ((Number) o.opt("protocol")).doubleValue() != 1 || !(o.opt("capabilities") instanceof JSONObject)) return false;
        return accepts(fields("calendar?", oneOf("full", "write-only"), "reminders?", BOOLEAN, "contacts?", oneOf("full", "limited"),
            "location?", oneOf("approximate", "precise"), "alarms?", BOOLEAN, "messages?", BOOLEAN, "calls?", BOOLEAN), (JSONObject) o.opt("capabilities"));
    }

    private static boolean keys(JSONObject o, String... keys) {
        if (o.length() != keys.length) return false;
        for (String key : keys) if (!o.has(key)) return false;
        return true;
    }
    private static JSONObject jsonObject(String json) {
        try { return new JSONObject(json); } catch (JSONException e) { throw new IllegalStateException(e); }
    }
    private static final Map<String, Map<String, Rule>> SCHEMAS = schemas();

}
