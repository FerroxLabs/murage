package com.murage.mobile;

import android.content.Context;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** A separate authenticated SecureStore entry for each workspace. */
final class PhoneConsentStore implements PhoneForBotsModel.Store {
    private final PhoneJobsTokenStore.Stores stores;
    PhoneConsentStore(Context context) { this(key -> new SecureStore(context.getApplicationContext(), key)); }
    PhoneConsentStore(PhoneJobsTokenStore.Stores stores) { this.stores = stores; }
    static String key(WorkspaceOrigin workspace) { return "phone_consent.v1." + PhoneJobsTokenStore.key(workspace); }
    boolean remove(WorkspaceOrigin workspace) { return stores.named(key(workspace)).remove(); }
    @Override public PhoneForBotsModel.Consent read(WorkspaceOrigin workspace) throws Exception {
        SecureStore.Read read = stores.named(key(workspace)).read();
        if (read.state == SecureStore.Read.State.EMPTY) return new PhoneForBotsModel.Consent();
        if (read.state != SecureStore.Read.State.OK) throw new IllegalStateException();
        return decode(new String(read.bytes, StandardCharsets.UTF_8));
    }
    static PhoneForBotsModel.Consent decode(String data) throws Exception {
        JSONObject json = new JSONObject(data);
        PhoneForBotsModel.Consent c = new PhoneForBotsModel.Consent();
        c.enabled = json.getBoolean("enabled"); c.sharing = json.getBoolean("sharing");
        JSONArray rows = json.getJSONArray("rows"), providers = json.getJSONArray("providers");
        for (int i = 0; i < rows.length(); i++) c.rows.add(rows.getString(i));
        for (int i = 0; i < providers.length(); i++) c.providers.add(providers.getString(i));
        return c;
    }
    static String encode(PhoneForBotsModel.Consent c) throws Exception {
        return new JSONObject().put("enabled", c.enabled).put("sharing", c.sharing)
            .put("rows", new JSONArray(c.rows)).put("providers", new JSONArray(c.providers)).toString();
    }
    @Override public void write(WorkspaceOrigin workspace, PhoneForBotsModel.Consent c) throws Exception {
        if (!stores.named(key(workspace)).write(encode(c).getBytes(StandardCharsets.UTF_8))) throw new IllegalStateException();
    }
}
