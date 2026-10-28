package com.murage.mobile;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import java.util.*;
import org.json.*;

final class PhoneContactsProvider implements PhoneContactsExecutor.Access {
    private final Context context; private final ContentResolver resolver;
    PhoneContactsProvider(Context context) { this.context = context; resolver = context.getContentResolver(); }
    public boolean granted() { return context.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED; }
    public List<JSONObject> search(String query, int limit) throws Exception {
        Uri uri = Uri.withAppendedPath(ContactsContract.Contacts.CONTENT_FILTER_URI, Uri.encode(query));
        return read(uri, limit);
    }
    public JSONObject get(String id) throws Exception {
        List<JSONObject> rows = read(ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, Long.parseLong(id)), 1);
        return rows.isEmpty() ? null : rows.get(0);
    }
    private List<JSONObject> read(Uri uri, int limit) throws Exception {
        PhoneExecutorSupport.require(granted()); List<JSONObject> rows = new ArrayList<>();
        try (Cursor c = resolver.query(uri, new String[]{ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY}, null, null, ContactsContract.Contacts.SORT_KEY_PRIMARY + " ASC")) {
            PhoneExecutorSupport.require(c != null);
            while (rows.size() < limit && c.moveToNext()) {
                String id = c.getString(0); JSONArray phones = new JSONArray(), emails = new JSONArray();
                try (Cursor data = resolver.query(ContactsContract.Data.CONTENT_URI,
                    new String[]{ContactsContract.Data.MIMETYPE, ContactsContract.Data.DATA1, ContactsContract.Data.DATA2, ContactsContract.Data.DATA3},
                    ContactsContract.Data.CONTACT_ID + "=? AND " + ContactsContract.Data.MIMETYPE + " IN (?,?)",
                    new String[]{id, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE}, null)) {
                    PhoneExecutorSupport.require(data != null);
                    while (data.moveToNext()) {
                        boolean phone = ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE.equals(data.getString(0));
                        JSONArray list = phone ? phones : emails;
                        if (list.length() >= 10 || data.isNull(1) || data.getString(1).isEmpty()) continue;
                        CharSequence label = phone
                            ? ContactsContract.CommonDataKinds.Phone.getTypeLabel(context.getResources(), data.getInt(2), data.getString(3))
                            : ContactsContract.CommonDataKinds.Email.getTypeLabel(context.getResources(), data.getInt(2), data.getString(3));
                        list.put(PhoneJobRunner.json(phone ? "number" : "address", data.getString(1), "label", label == null ? "" : label.toString()));
                    }
                }
                rows.add(PhoneJobRunner.json("id", id, "name", c.isNull(1) ? "" : c.getString(1), "phones", phones, "emails", emails));
            }
        }
        return rows;
    }
}
