package com.murage.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Objects;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The launcher's one native door (P22 src/shell.ts types exactly this; iOS
 * twin ShellPlugin.swift). A thin door onto {@link Shell}: snapshot, open,
 * remove. Capacitor's WebView loads only the bundled launcher, and the
 * workspace is our own WebView with no bridge; each call still checks it came
 * from the bundled page, and every path answers (resolve or reject with a
 * code, the iOS codes). Capacitor calls these on its plugin thread; each one
 * runs on the main thread, where Shell.open and the WebView must be touched.
 */
@CapacitorPlugin(name = "MurageShell")
public class ShellPlugin extends Plugin {
    private static final String TAILSCALE = Shell.TAILSCALE;
    private static final String TAILSCALE_STORE = "https://play.google.com/store/apps/details?id=" + TAILSCALE;

    private Shell.Listener closes;
    /** A5: a notice (a tap for a removed computer); retained until the page listens. */
    private final java.util.function.Consumer<String> notices = code -> {
        JSObject event = new JSObject();
        event.put("code", code);
        notifyListeners("notice", event, true);
    };
    /** The launcher's WebView is gone (its renderer died); the activity is about to be recreated. */
    private boolean dead;
    /** One scanner at a time (iOS: the launcher is already presenting one). Main thread. */
    private boolean scanning;

    private Shell shell() {
        return Shell.get(getContext());
    }

    @Override public void load() {
        closes = (origin, reason) -> {
            JSObject event = new JSObject();
            event.put("origin", origin);
            event.put("reason", reason);
            // Retained until the launcher page has attached its listener.
            notifyListeners("workspaceClosed", event, true);
        };
        shell().listener = closes;
        shell().onNotice(notices);
    }

    /** The launcher on screen hears the closes, even after a newer one came and went. */
    @Override protected void handleOnResume() {
        if (dead) return;
        shell().listener = closes;
        shell().onNotice(notices);
    }

    /** Under a workspace, notices wait in Shell until the launcher is shown again. */
    @Override protected void handleOnPause() {
        shell().offNotice(notices);
    }

    /**
     * The launcher's renderer died (it shares one with the workspace): the
     * page can no longer hear an event, and Capacitor would not retain one
     * while the dead page's listener is registered. Stop listening, so the
     * next close waits in Shell and the recreated launcher reads it in state().
     */
    void release() {
        dead = true;
        if (shell().listener == closes) shell().listener = null;
        shell().offNotice(notices);
    }

    @Override protected void handleOnDestroy() {
        // A newer launcher (recreated, or started over this one) may already be listening.
        if (shell().listener == closes) shell().listener = null;
        shell().offNotice(notices);
    }

    @PluginMethod public void state(PluginCall call) {
        onLauncher(call, () -> {
            // Unreadable is not empty: the launcher asks to unlock and try again (P14).
            JSONObject state = shell().snapshot();
            if (state == null) {
                call.reject("unreadable", "unreadable");
                return;
            }
            try {
                call.resolve(JSObject.fromJSONObject(state));
            } catch (JSONException unexpected) {
                call.reject("unreadable", "unreadable");
            }
        });
    }

    @PluginMethod public void scan(PluginCall call) {
        onLauncher(call, () -> {
            if (scanning) {
                call.reject("unavailable", "unavailable");
                return;
            }
            scanning = true;
            QrScanner.scan(getActivity(), new QrScanner.Done() {
                private boolean answered;

                @Override public void text(String value) {
                    if (!answer()) return;
                    JSObject result = new JSObject();
                    result.put("text", value);
                    call.resolve(result);
                }

                @Override public void failed(String code) {
                    if (answer()) call.reject(code, code);
                }

                private boolean answer() {
                    if (answered) return false;
                    answered = true;
                    scanning = false;
                    return true;
                }
            });
        });
    }

    @PluginMethod public void open(PluginCall call) {
        onLauncher(call, () -> {
            String origin = call.getString("origin");
            if (origin == null) {
                call.reject("bad_origin", "bad_origin");
                return;
            }
            shell().open(getActivity(), origin, call.getString("credential"), new Shell.OpenDone() {
                @Override public void opened(com.murage.mobile.shell.ProbeVerdict verdict) {
                    JSObject result = new JSObject();
                    result.put("mode", verdict.mode());
                    if (verdict.hostCapability != null) result.put("hostCapability", verdict.hostCapability);
                    call.resolve(result);
                }

                @Override public void failed(String code) {
                    call.reject(code, code);
                }
            });
        });
    }

    @PluginMethod public void remove(PluginCall call) {
        onLauncher(call, () -> {
            String failure = shell().remove(call.getString("origin"));
            if (failure != null) call.reject(failure, failure);
            else call.resolve();
        });
    }

    /** Spec §3.1: launch Tailscale when installed, else its Play page. */
    @PluginMethod public void openTailscale(PluginCall call) {
        onLauncher(call, () -> {
            Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(TAILSCALE);
            if (launch == null) launch = new Intent(Intent.ACTION_VIEW, Uri.parse(TAILSCALE_STORE));
            try {
                getActivity().startActivity(launch);
            } catch (ActivityNotFoundException none) {
                ShellLog.i("no app for tailscale");
            }
            call.resolve();
        });
    }

    /** On the main thread, from the bundled page only; a refused or failed call still answers. */
    private void onLauncher(PluginCall call, Runnable work) {
        getBridge().executeOnMainThread(() -> {
            if (!fromLauncher()) {
                call.reject("unavailable", "unavailable");
                return;
            }
            try {
                work.run();
            } catch (RuntimeException unexpected) {
                ShellLog.i("launcher call failed method=" + call.getMethodName());
                if ("scan".equals(call.getMethodName())) scanning = false;
                call.reject("unavailable", "unavailable");
            }
        });
    }

    /** The page on the bridge is the app's own bundle (https://localhost), as iOS checks capacitor://localhost. */
    private boolean fromLauncher() {
        try {
            WebView view = getBridge().getWebView();
            String url = view == null ? null : view.getUrl();
            String local = getBridge().getLocalUrl();
            Uri page = url == null ? null : Uri.parse(url);
            Uri home = local == null ? null : Uri.parse(local);
            boolean bundled = page != null && home != null && page.getScheme() != null && page.getHost() != null
                && Objects.equals(page.getScheme(), home.getScheme())
                && Objects.equals(page.getHost(), home.getHost())
                && page.getPort() == home.getPort();
            if (!bundled) ShellLog.i("launcher call refused: not the bundled page");
            return bundled;
        } catch (RuntimeException gone) {
            return false; // the launcher's WebView was destroyed (its renderer died)
        }
    }
}
