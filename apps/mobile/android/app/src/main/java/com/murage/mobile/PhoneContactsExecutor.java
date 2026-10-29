package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import java.util.*;
import java.util.function.Consumer;
import org.json.*;

final class PhoneContactsExecutor implements PhoneExecutorSupport.Module {
    interface Access {
        boolean granted();
        List<JSONObject> search(String query, int limit) throws Exception;
        JSONObject get(String id) throws Exception;
    }
    private final Access os;
    PhoneContactsExecutor(Access os) { this.os = os; }
    static JSONObject trim(JSONObject row) throws Exception {
        JSONObject out = PhoneExecutorSupport.trim(row, "id", 256, "name", 200);
        for (String key : new String[]{"phones", "emails"}) {
            String value = "phones".equals(key) ? "number" : "address"; int max = "phones".equals(key) ? 40 : 254;
            JSONArray rows = row.optJSONArray(key), values = new JSONArray();
            if (rows != null) for (int i = 0; i < rows.length() && values.length() < 10; i++) {
                JSONObject entry = rows.getJSONObject(i);
                if (!PhoneExecutorSupport.text(entry.opt(value), max).isEmpty()) values.put(PhoneExecutorSupport.trim(entry, "label", 50, value, max));
            }
            out.put(key, values);
        }
        return out;
    }
    public void run(String operationId, String action, PhoneJobsContract.Args args, boolean precise, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) throws Exception {
        cancellation.check();
        PhoneExecutorSupport.require(os.granted()); JSONObject result;
        if (args instanceof PhoneJobsContract.ContactsSearchArgs) {
            PhoneJobsContract.ContactsSearchArgs a = (PhoneJobsContract.ContactsSearchArgs) args;
            int limit = a.limit == null ? 25 : a.limit; JSONArray contacts = new JSONArray();
            for (JSONObject row : os.search(a.query, limit)) { if (contacts.length() >= limit) break; contacts.put(trim(row)); }
            result = PhoneJobRunner.json("contacts", contacts, "limited", false);
        } else if (args instanceof PhoneJobsContract.ContactsGetArgs) {
            JSONObject row = os.get(((PhoneJobsContract.ContactsGetArgs) args).id);
            result = PhoneJobRunner.json("contact", row == null ? JSONObject.NULL : trim(row), "limited", false);
        } else throw new PhoneExecutorSupport.Failure("unsupported");
        PhoneExecutorSupport.require(os.granted()); done.accept(PhoneExecutorSupport.result(action, result));
    }
}
