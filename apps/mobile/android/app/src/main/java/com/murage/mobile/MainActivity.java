package com.murage.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.core.splashscreen.SplashScreen;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;
import com.murage.mobile.shell.LaunchPolicy;
import com.murage.mobile.shell.WorkspaceBook;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.net.CookieHandler;

/** The launcher (spec §3.1): Capacitor's activity, showing only the bundled page. */
public class MainActivity extends BridgeActivity {
    static final String ACTION_SWITCH = "com.murage.mobile.SWITCH";
    private boolean launcherWebViewDead;
    /** BridgeActivity's onCreate replays the launch intent through onNewIntent; onCreate reads it itself. */
    private boolean created;
    /** A throwaway instance (LaunchPolicy.isLauncherReentry): it only finishes. */
    private boolean reentry;

    @Override protected void onCreate(Bundle state) {
        // P26 F2: the icon over a task another intent started (the "Switch computer"
        // shortcut) stacks a new launcher on the live workspace. Android has already
        // brought the task forward, so finishing reveals what it shows. No ShellPlugin:
        // its load() would take the real launcher's listener, and its destroy clear it.
        // No bridge either (load() below): building one loads CapacitorCookies, which
        // wipes the session cookies and installs the WebView jar as the process-wide
        // CookieHandler while a workspace is live (final review I2).
        Intent launch = getIntent();
        if (launch != null && LaunchPolicy.isLauncherReentry(launch.getAction(), launch.hasCategory(Intent.CATEGORY_LAUNCHER), isTaskRoot())) {
            reentry = true;
            super.onCreate(state);
            // Belt and braces: no bridge ran, but nothing may leave a handler behind.
            CookieHandler.setDefault(null);
            ShellLog.i("launcher re-entry over a live task; finishing");
            finish();
            return;
        }
        SplashScreen.installSplashScreen(this);
        registerPlugin(ShellPlugin.class);
        super.onCreate(state);
        // Capacitor always loads CapacitorCookies, whose load() makes the WebView's
        // cookie jar the process-wide CookieHandler. Nothing here uses CapacitorHttp
        // or CapacitorCookies, and native HTTP (the probe) must never carry cookies.
        CookieHandler.setDefault(null);
        // The splash hands over to this WebView: the canvas (light or dark), not
        // WebView white, until the launcher page paints.
        getBridge().getWebView().setBackgroundColor(getColor(R.color.murage_canvas));
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        // Phase 0 surprise 1: every WebView in the app shares one renderer. If this one does
        // not handle the renderer dying, Android kills the whole app when the workspace's does.
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                ShellLog.i("launcher renderer gone crashed=" + detail.didCrash() + "; recreating");
                if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
                view.destroy();
                launcherWebViewDead = true;
                releaseShell();
                // On screen now: rebuild at once. Under the workspace: when it is shown again.
                if (getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) getWindow().getDecorView().post(MainActivity.this::recreateIfDead);
                return true;
            }
        });

        Shell shell = Shell.get(this);
        if (BuildConfig.DEBUG) applyDebugExtras(getIntent());
        created = true;
        if (state == null) {
            boolean switching = ACTION_SWITCH.equals(getIntent().getAction());
            // A tap chooses its own computer (openFromPush below), never the last one used.
            // Only a tap this process handed over counts: this activity is exported.
            boolean fromPush = PushIntents.OPEN.equals(getIntent().getAction()) && shell.hasPushTap();
            // Unreadable (P18) opens nothing: the launcher's state() is refused as
            // unreadable and the page offers unlock / try again.
            WorkspaceBook book = shell.book();
            if (book != null) {
                PushServices.get(this).sweep(book);
                WorkspaceOrigin target = fromPush ? null : LaunchPolicy.autoOpen(book, shell.autoOpened, switching, shell.hasPendingClose());
                if (target != null) {
                    String failure = shell.startWorkspace(this, target, null, "unknown");
                    if (failure != null) ShellLog.i("auto-open failed code=" + failure);
                }
            } else {
                ShellLog.i("auto-open skipped: book unreadable");
            }
            shell.autoOpened = true;
            if (fromPush) openFromPush(getIntent());
        }
    }

    /**
     * BridgeActivity.onCreate ends here, and this is where Capacitor builds the
     * bridge: its plugins, CapacitorCookies among them, and the launcher page.
     * The throwaway re-entry instance skips it; every BridgeActivity lifecycle
     * method already copes with a null bridge. Its layout's idle WebView never
     * loads a page and goes with the activity.
     */
    @Override protected void load() {
        if (reentry) return;
        super.load();
    }

    /** Closes wait as pending until the recreated launcher asks for state(). */
    private void releaseShell() {
        PluginHandle handle = getBridge().getPlugin("MurageShell");
        Plugin plugin = handle == null ? null : handle.getInstance();
        if (plugin instanceof ShellPlugin) ((ShellPlugin) plugin).release();
    }

    @Override public void onResume() {
        super.onResume();
        recreateIfDead();
        PushRegistrar.get(this).refreshIfDue(); // at most daily: keeps the relay from sweeping an idle registration
    }

    private void recreateIfDead() {
        if (!launcherWebViewDead || isFinishing() || isDestroyed()) return;
        launcherWebViewDead = false;
        recreate();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (created && BuildConfig.DEBUG) applyDebugExtras(intent);
        if (created) openFromPush(intent);
    }

    /**
     * Spec §3.5 "Tapping a notification", from PushOpenActivity when no workspace was
     * live. The tap is the one that activity handed over in memory; an intent's extras
     * choose nothing here, because this activity is exported (A5 review Minor 2). A
     * computer no longer on this phone opens nothing and says so.
     */
    private void openFromPush(Intent intent) {
        if (intent == null || !PushIntents.OPEN.equals(intent.getAction())) return;
        setIntent(new Intent(this, MainActivity.class)); // a recreation must not open it twice
        Shell shell = Shell.get(this);
        Shell.PushTap tap = shell.takePushTap();
        if (tap == null) return;
        if (tap.origin == null) {
            shell.showNotice("removedWorkspace");
            return;
        }
        shell.openFromNotification(this, tap.origin, tap.threadId, tap.messageId);
    }

    /** Debug builds only (P26): murage.e2eProbe and murage.openThread; A4: murage.relay, an https relay origin. */
    private void applyDebugExtras(Intent intent) {
        if (!BuildConfig.DEBUG) return;
        if (intent.getBooleanExtra("murage.e2eProbe", false)) E2EProbe.requested = true;
        String relay = intent.getStringExtra("murage.relay");
        if (relay != null && RelayClient.overrideOrigin(relay) == null) ShellLog.i("relay override refused");
        String thread = intent.getStringExtra("murage.openThread");
        if (thread == null) return;
        Shell.get(this).queueOpen(this, thread, null);
        if (!isTaskRoot()) finish(); // a trampoline over a live workspace
    }
}
