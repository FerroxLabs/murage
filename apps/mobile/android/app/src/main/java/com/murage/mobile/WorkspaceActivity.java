package com.murage.mobile;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.WindowManager;
import android.view.HapticFeedbackConstants;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.lifecycle.Lifecycle;
import com.murage.mobile.shell.ChannelArgs;
import com.murage.mobile.shell.ChannelGate;
import com.murage.mobile.shell.ChannelScript;
import com.murage.mobile.shell.CloseReason;
import com.murage.mobile.shell.DiagFile;
import com.murage.mobile.shell.LaunchPolicy;
import com.murage.mobile.shell.InPlaceReload;
import com.murage.mobile.shell.Json;
import com.murage.mobile.shell.LoadFailure;
import com.murage.mobile.shell.MainDocument;
import com.murage.mobile.shell.NavigationFailure;
import com.murage.mobile.shell.NavigationPolicy;
import com.murage.mobile.shell.OriginReturn;
import com.murage.mobile.shell.PairingLink;
import com.murage.mobile.shell.PendingOpen;
import com.murage.mobile.shell.ProbeVerdict;
import com.murage.mobile.shell.SameDocument;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.json.JSONObject;

/** The workspace screen (spec §2, §3.2): our own WebView on the user's own Murage origin. */
public class WorkspaceActivity extends AppCompatActivity {
    static final String EXTRA_ORIGIN = "murage.origin";
    static final String EXTRA_CREDENTIAL = "murage.credential";
    static final String EXTRA_MODE = "murage.mode";
    /** True only when the launcher's probe already passed the mobileFeatures >= 1 gate. */
    static final String EXTRA_HOST_OK = "murage.hostOk";
    /** True only when the launcher's probe saw approvalProof >= 1 (SEC-006). */
    static final String EXTRA_APPROVAL_PROOF = "murage.approvalProof";
    private static final long READY_DEADLINE_MS = 8_000;
    /** The whole pairing-time attestation, so a slow relay cannot let the pairing code expire. */
    private static final long ATTEST_BUDGET_MS = 10_000;
    private static final long CRASH_WINDOW_MS = 60_000;
    /** A hung page (renderer alive but not answering) must not swallow Back. */
    private static final long BACK_TIMEOUT_MS = 500;
    private static final int MATCH = ViewGroup.LayoutParams.MATCH_PARENT;

    WorkspaceOrigin origin;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** Answers to load()'s same-document reload: the first for the newest load wins. */
    private final InPlaceReload inPlace = new InPlaceReload();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** One writer for files/murage-call-diag.log (app-private, like iOS's Caches copy). */
    /** One thread for the pairing-time attestation (RelayClient's own pool is private). */
    /** The pairing attestation's deadline, removed in onDestroy so it never pins the Activity. */
    private Runnable attestTimeout;
    private final ExecutorService attestIo = Executors.newSingleThreadExecutor();
    private final ExecutorService diagIo = Executors.newSingleThreadExecutor();
    private DiagFile callDiagFile;

    /** The page's [call-diag]/[call-trace] lines, off the main thread (channel diagLine). */
    private void writeCallDiag(String line) {
        long now = System.currentTimeMillis();
        diagIo.execute(() -> {
            if (callDiagFile == null) {
                callDiagFile = new DiagFile(new java.io.File(getFilesDir(), DiagFile.FILE_NAME), DiagFile.MAX_BYTES);
            }
            callDiagFile.append(line, now);
        });
    }
    private final Runnable readyDeadline = this::readyDeadlinePassed;
    private Shell shell;
    private String mode;
    /** SEC-006: a device approval is waiting on the prompt. */
    private boolean approving;
    private android.os.CancellationSignal approvalCancel;
    /** SEC-006: this pairing's approval public point (base64url), sent with its relay statement; null when none was made. */
    private boolean pairWithApprovalKey;
    private boolean hostCapabilityChecked;
    private FrameLayout root;
    private WebView webView;
    private LoadingOverlay overlay;
    private SaveController saves;
    private boolean ready;
    /** The splash is covering the page and waiting for ready() (or a reveal). */
    private boolean splashUp;
    private boolean closing;
    private boolean resumedOnce;
    private boolean mainDocumentFailed;
    /**
     * The main document's HTTP status as WebView reports it: 200 from
     * onPageStarted, since WebView only reports error statuses
     * (onReceivedHttpError), which then set it and mainDocumentFailed.
     */
    private int mainDocumentStatus = 200;
    private boolean pageFinishedOnOrigin;
    /** A page on the origin loaded or called ready(): this computer was reached. */
    private boolean signedInSeen;
    /** A main frame that left the origin, on its way back (P26 F1); one per WebView. */
    private OriginReturn originReturn = new OriginReturn();
    private long loadStarted;
    /** When the renderer last died: a second death within a minute stops the reloads. */
    private long lastCrash = -CRASH_WINDOW_MS;
    /** A notification that arrived while the splash was up, opened on ready(). */
    private PendingOpen queuedOpen;
    /** True while the page says a call is live (callSessionOpen/Close,
     * callbar-rereview.md M4): unlike iOS, Android has no call-audio engine
     * of its own to ask, so this is the page's own signal. Guards the same
     * reload deliver() would otherwise commit over a live call. Reset on
     * every real navigation start (onPageStarted) and on a renderer crash
     * (onRenderProcessGone), so a page that dies mid-call never leaves
     * this stuck true until the activity is recreated (callbar-rereview2.md
     * G4). */
    private boolean callSessionOpen;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private ActivityResultLauncher<Intent> filePicker;
    private ActivityResultLauncher<String[]> permissionAsk;
    private ActivityResultLauncher<String> pushPermissionAsk;
    /** registerPush calls waiting on the notification prompt; granted or denied, each then registers (the plan answers "denied"). */
    private final List<Runnable> pendingPushRegistrations = new ArrayList<>();

    private final OnBackPressedCallback back = new OnBackPressedCallback(true) {
        @Override public void handleOnBackPressed() {
            // Spec §4: the page may close a sheet first (Decision 10); then history; then away
            // to the home screen, never to the launcher (Phase 0 surprise 2). A page that has
            // not answered within BACK_TIMEOUT_MS is treated as not handling it.
            boolean[] settled = {false};
            Runnable fallback = () -> {
                if (settled[0]) return;
                settled[0] = true;
                ShellLog.i("back: page did not answer; native back");
                backWithoutPage();
            };
            main.postDelayed(fallback, BACK_TIMEOUT_MS);
            emit("backButton", null, handled -> {
                if (settled[0]) return;
                settled[0] = true;
                main.removeCallbacks(fallback);
                if (!handled) backWithoutPage();
            });
        }
    };

    /** History, else the home screen; never finish() onto the launcher. */
    private void backWithoutPage() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else moveTaskToBack(true);
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        // The app-switcher snapshot is the exposure (SEC-008). Android 13+ can hide just that
        // thumbnail, so owners can still screenshot or share a chat; 10-12 have no narrower
        // switch, so this workspace window alone is marked secure.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) setRecentsScreenshotEnabled(false);
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        shell = Shell.get(this);
        origin = WorkspaceOrigin.parse(getIntent().getStringExtra(EXTRA_ORIGIN));
        if (origin == null) {
            finish();
            return;
        }
        mode = getIntent().getStringExtra(EXTRA_MODE);
        if (mode == null || state != null) mode = "unknown";
        // Set only by Shell.finishOpen, after hostCapabilityOk(); a restored activity probes again.
        hostCapabilityChecked = state == null && getIntent().getBooleanExtra(EXTRA_HOST_OK, false);
        // A pairing code is single-use. The system keeps its own copy of the intent, so a
        // restored activity (state != null) ignores the extra rather than replay a spent code.
        String credential = state == null ? getIntent().getStringExtra(EXTRA_CREDENTIAL) : null;
        getIntent().removeExtra(EXTRA_CREDENTIAL);
        shell.attach(this);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        root = new FrameLayout(this);
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.murage_canvas));
        setContentView(root);
        // Decision 1: native owns the insets on Android and consumes them, so the page's
        // env(safe-area-inset-*) resolves to 0 and nothing is padded twice.
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            ShellLog.i("insets top=" + bars.top + " bottom=" + bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        applyAppearance(getResources().getConfiguration());

        filePicker = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (fileCallback == null) return;
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData()));
            fileCallback = null;
        });
        permissionAsk = registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), granted -> {
            PermissionRequest request = pendingPermission;
            pendingPermission = null;
            if (request == null) return;
            if (!granted.containsValue(false)) request.grant(request.getResources());
            else request.deny();
        });

        pushPermissionAsk = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            List<Runnable> waiting = new ArrayList<>(pendingPushRegistrations);
            pendingPushRegistrations.clear();
            for (Runnable go : waiting) go.run();
        });

        overlay = new LoadingOverlay(this, this::reloadRoute, () -> close(CloseReason.LAUNCHER));
        root.addView(overlay, new FrameLayout.LayoutParams(MATCH, MATCH));
        getOnBackPressedDispatcher().addCallback(this, back);

        createWebView();
        String path = credential != null ? enterPath(credential) : shell.routes.startPath(origin);
        if (path == null) {
            close(CloseReason.SIGNED_OUT);
            return;
        }
        beginProgress();
        if (credential != null && pairWithApprovalKey) {
            loadPairing(credential, path);
            return;
        }
        if (hostCapabilityChecked) load(path);
        else probeBeforeLoading(path);
    }

    /**
     * SEC-006 (P9): the pairing page with the approval key and the relay's statement for it.
     * One attestation attempt off the main thread, under the splash, capped at ATTEST_BUDGET_MS.
     * Without a statement (no Play Services, no network, a refusal, the hourly limit, the cap)
     * the link is the plain path, with no key: a key never goes without its statement.
     */
    private void loadPairing(String credential, String plainPath) {
        String installId = shell.installId();
        AtomicBoolean proceeded = new AtomicBoolean();
        Consumer<String[]> proceed = made -> {
            if (!proceeded.compareAndSet(false, true)) return;
            if (isFinishing() || isDestroyed() || closing) return;
            String key = made == null ? null : made[0];
            String statement = made == null ? null : made[1];
            String path = statement == null ? plainPath : ApprovalAttestation.enterPath(credential, installId, key, statement);
            if (path == null) path = plainPath;
            ShellLog.i(statement == null ? "approval statement: no" : "approval statement: yes");
            if (hostCapabilityChecked) load(path);
            else probeBeforeLoading(path);
        };
        attestTimeout = () -> proceed.accept(null);
        main.postDelayed(attestTimeout, ATTEST_BUDGET_MS);
        attestIo.execute(() -> {
            // Key generation can take seconds on a StrongBox part: off the main thread, inside the same budget.
            String key = ApprovalKeys.enrol(getApplicationContext(), origin);
            if (key == null) {
                runOnUiThread(() -> proceed.accept(null));
                return;
            }
            String statement = ApprovalAttestation.statement(RelayClient::call, nonce -> PushRegistrar.integrityToken(getApplicationContext(), nonce),
                RelayClient.ENVIRONMENT, installId, key);
            if (statement == null || proceeded.get()) ApprovalKeys.remove(origin); // a key with no statement is never kept
            String[] made = statement == null ? null : new String[] {key, statement};
            runOnUiThread(() -> proceed.accept(made));
        });
    }

    /** The bar icons and the canvas follow light/dark; uiMode is in configChanges, so a switch never reloads the page. */
    private void applyAppearance(Configuration configuration) {
        boolean dark = (configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), root);
        bars.setAppearanceLightStatusBars(!dark);
        bars.setAppearanceLightNavigationBars(!dark);
        int canvas = ContextCompat.getColor(this, R.color.murage_canvas);
        root.setBackgroundColor(canvas);
        if (webView != null) webView.setBackgroundColor(canvas);
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (root != null) applyAppearance(configuration);
    }

    private void createWebView() {
        originReturn = new OriginReturn();
        webView = new WebView(this);
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.murage_canvas));
        root.addView(webView, 0, new FrameLayout.LayoutParams(MATCH, MATCH));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // No second windows: window.open and target=_blank navigate this WebView, where
        // shouldOverrideUrlLoading keeps the saved origin here and sends the rest out.
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(settings.getUserAgentString() + " " + Shell.USER_AGENT_TOKEN);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        boolean channel = ChannelBridge.install(webView, origin, this::onChannel);
        ShellLog.i("channel " + (channel ? "enabled" : "failed closed"));
        if (saves == null) saves = new SaveController(this, origin, settings.getUserAgentString());
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new Chrome());
        // Android parity (iOS checks the frame): DownloadListener names no frame, so
        // Android cannot tell which frame started a download. The page must be on the
        // saved origin and not closing, and SaveController requires the URL and every
        // redirect to be on it too. So a foreign iframe (which the page's CSP should
        // not allow anyway) can at most put a same-origin file in the user's Downloads,
        // which that frame can never read; the session cookie never leaves the origin.
        webView.setDownloadListener((url, agent, disposition, mime, length) -> {
            if (closing || webView == null || !origin.contains(webView.getUrl())) {
                ShellLog.i("download refused: the page is not on the saved origin");
                return;
            }
            saves.onDownload(url, agent, disposition, mime, length);
        });
    }

    /**
     * The door's pairing page. The install id goes only to a door that
     * answered mobile: 1 (Review Focus 5), and a full door is never paired
     * without one: null then, and the screen closes. Shell.startWorkspace has
     * already read (and cached) the id, so this is a second check, not a first.
     */
    private String enterPath(String credential) {
        pairWithApprovalKey = false;
        if (!"full".equals(mode)) {
            ApprovalKeys.remove(origin); // a basic door pairs keyless: an older key goes (SEC-006)
            return PairingLink.enterPath(credential, null);
        }
        String installId = shell.installId();
        if (installId == null) {
            ApprovalKeys.remove(origin);
            return null;
        }
        // SEC-006: the key is made off the main thread in loadPairing, when the computer can check one.
        // It is sent only with the relay's statement; this path is the keyless fallback.
        // enrol deletes this computer's old key first; with no approvalProof the old key just goes.
        if (getIntent().getBooleanExtra(EXTRA_APPROVAL_PROOF, false)) pairWithApprovalKey = true;
        else ApprovalKeys.remove(origin);
        return PairingLink.enterPath(credential, installId);
    }

    /** The live WebView, or null (Shell clears the HTTP cache through it on sign-out). */
    WebView webView() {
        return webView;
    }

    // ---- loading and readiness ----

    private void load(String path) {
        if (closing || webView == null || !hostCapabilityChecked) return;
        long ticket = inPlace.begin();
        ready = false;
        loadStarted = SystemClock.elapsedRealtime();
        if (!splashUp) beginProgress();
        armDeadline();
        String target = origin.serialized() + path;
        // A target that differs only by the fragment is a same-document
        // navigation, not a load: the page would never call ready() again.
        // Reload it at the target instead; if the page can't, load as before.
        if (!SameDocument.of(webView.getUrl(), target)) {
            webView.loadUrl(target);
            return;
        }
        // A hung page may never answer: the timeout loads, and whichever
        // comes second, or belongs to an older load(), does nothing.
        WebView view = webView;
        main.postDelayed(() -> fallBack(ticket, view, target, false), InPlaceReload.TIMEOUT_MS);
        view.evaluateJavascript(SameDocument.reloadScript(target), value -> fallBack(ticket, view, target, "true".equals(value)));
    }

    private void fallBack(long ticket, WebView view, String target, boolean reloaded) {
        if (!inPlace.fallBack(ticket, reloaded) || closing || view != webView) return;
        view.loadUrl(target);
    }

    private long progressStarted;
    private boolean slowShown;
    private int probeAttempt;

    private void beginProgress() {
        progressStarted = SystemClock.elapsedRealtime();
        slowShown = false;
        splashUp = true;
        overlay.showSplash();
        armDeadline();
    }

    private void reloadRoute() {
        beginProgress();
        String path = shell.routes.startPath(origin);
        if (hostCapabilityChecked) load(path);
        else probeBeforeLoading(path);
    }

    /** OriginReturn's RELOAD: the saved route; onPageFinished clears the history behind it. */
    private void reloadAndForget() {
        if (closing || webView == null) return;
        webView.stopLoading();
        reloadRoute();
    }

    /** One deadline per attempt, including its probe; page finish keeps the remaining time. */
    private void armDeadline() {
        main.removeCallbacks(readyDeadline);
        if (!splashUp || ready || closing || slowShown) return;
        main.postDelayed(readyDeadline, Math.max(0, READY_DEADLINE_MS - (SystemClock.elapsedRealtime() - progressStarted)));
    }

    private void readyDeadlinePassed() {
        if (!splashUp || ready || closing || slowShown) return;
        slowShown = true;
        ShellLog.i("ready deadline passed");
        overlay.showSlow();
    }

    /** Takes the splash down without ready(): the door's /enter page, basic mode. */
    private void reveal() {
        splashUp = false;
        main.removeCallbacks(readyDeadline);
        overlay.hide();
    }

    private void markReady() {
        if (ready) return;
        // A late ready() after sign-out must not put the computer back on the list.
        if (closing) return;
        ready = true;
        reveal();
        PendingOpen open = queuedOpen;
        queuedOpen = null;
        if (open != null) deliver(open); // clears the pending open once the page handles it
        else shell.routes.clearPending(origin);
        signedIn();
        ShellLog.i("ready after " + (SystemClock.elapsedRealtime() - loadStarted) + " ms");
        E2EProbe.run(webView);
    }

    private void signedIn() {
        signedInSeen = true;
        shell.signedIn(origin);
    }

    /**
     * Still in use after signing in (going to the background, "Switch
     * computer"): "Last connected" moves on and nothing is added. Never once
     * closing, so a sign-out leaves no fresh time behind.
     */
    private void stillInUse() {
        if (!signedInSeen || closing) return;
        shell.inUse(origin);
    }

    /** A page other than "/" loaded: reached, so "Last connected" moves on; touch only, never an add. */
    private void loadedInUse() {
        signedInSeen = true;
        stillInUse();
    }

    /** Kept for a lowered gate: with mobileFeatures >= 1 required, only a lowered gate reaches basic here. */
    private void revealBasic() {
        if (!splashUp) return;
        reveal();
        Toast.makeText(this, R.string.basic_mode_note, Toast.LENGTH_LONG).show();
    }

    private void probeBeforeLoading(String path) {
        int attempt = ++probeAttempt;
        io.execute(() -> {
            ProbeVerdict verdict = ProbeClient.probe(origin, Shell.USER_AGENT_TOKEN);
            runOnUiThread(() -> {
                if (isFinishing() || closing || attempt != probeAttempt) return;
                if (verdict.kind == ProbeVerdict.Kind.UNREACHABLE) { close(CloseReason.UNREACHABLE); return; }
                if (verdict.kind == ProbeVerdict.Kind.INSECURE) { close(CloseReason.INSECURE); return; }
                if (verdict.kind == ProbeVerdict.Kind.ACCESSOFF) { close(CloseReason.ACCESSOFF); return; }
                if (verdict.kind == ProbeVerdict.Kind.HOSTERROR) { close(CloseReason.HOSTERROR); return; }
                if (!verdict.hostCapabilityOk()) { close(CloseReason.UPDATE_REQUIRED); return; }
                hostCapabilityChecked = true;
                mode = verdict.mode();
                shell.rememberName(origin, verdict.name);
                load(path);
            });
        });
    }

    // ---- closing, events, deep links ----

    void close(CloseReason reason) {
        if (closing) return;
        if (reason == CloseReason.LAUNCHER) stillInUse();
        closing = true;
        main.removeCallbacks(readyDeadline);
        if (saves != null) saves.cancelAll(); // every save in flight stops; the page hears unavailable
        ShellLog.i("workspace closed reason=" + reason.wire);
        shell.closed(this, reason);
        finish();
        overridePendingTransition(0, 0);
        // B6: this workspace is gone for any reason -- a cross-computer
        // notification held because it had an open call is no longer
        // blocked by anything.
        if (LaunchPolicy.deliversHeldOpenAfter(reason)) shell.deliverPendingCrossComputerOpen(this);
        else shell.takePendingCrossComputerOpen(); // N-7: a deliberate return to the launcher drops it
    }

    /** True while the page says a call is live (B6: the same question
     * reloadOrKeepPending() already asks, read by Shell before it would
     * otherwise replace this workspace for a different computer's
     * notification). */
    boolean hasOpenCall() {
        return callSessionOpen;
    }

    /** Replaced by another workspace (Shell.startWorkspace): closes properly, telling no one. */
    void closeFromShell() {
        if (closing) return;
        closing = true;
        main.removeCallbacks(readyDeadline);
        if (saves != null) saves.cancelAll();
        ShellLog.i("workspace replaced");
        shell.detach(this);
        finish();
        overridePendingTransition(0, 0);
    }

    /** window.__murageNativeEmit in the main frame, only while the page is on the saved origin: checked here and inside the script (M6). */
    void emit(String name, JSONObject detail, ValueCallback<Boolean> done) {
        if (webView == null || !origin.contains(webView.getUrl())) {
            if (done != null) done.onReceiveValue(false);
            return;
        }
        webView.evaluateJavascript(ChannelScript.emit(name, detail, origin.serialized()), value -> {
            if (done != null) done.onReceiveValue("true".equals(value));
        });
    }

    /**
     * A conversation to open now (Shell.queueOpen). The caller has saved it
     * as the pending open first. While the splash is up it waits for ready()
     * (the newest one wins); a revealed page that never called ready(), or
     * one that does not handle the event, reloads once onto the pending route
     * -- unless a call is open (reloadOrKeepPending, below).
     */
    void deliver(PendingOpen open) {
        if (closing || webView == null) return;
        if (!ready) {
            if (splashUp) queuedOpen = open;
            else reloadOrKeepPending();
            return;
        }
        JSONObject detail = new JSONObject();
        Json.put(detail, "threadId", open.threadId);
        if (open.messageId != null) Json.put(detail, "messageId", open.messageId);
        emit("notificationOpened", detail, handled -> {
            if (closing) return;
            if (handled) shell.routes.clearPending(origin);
            else reloadOrKeepPending();
        });
    }

    /**
     * A reload here commits a navigation, which ends any call in progress the
     * same way the moss-approval-bug did (callbar-review.md M4). Android has
     * no call-audio engine of its own to ask -- a call here is always the
     * web audio path, which this native layer would otherwise have no
     * visibility into at all. The page tells it directly instead
     * (callSessionOpen/Close, onChannel below; callbar-rereview.md M4). Both
     * platforms now guard this the same way, page-signalled: iOS's own
     * call-audio engine fires its teardown on a retry or `lost` too, not
     * only a real hang-up, so it cannot be used for this guard either
     * (callbar-rereview2.md G3). If a call is open, skip the reload and
     * leave `routes`' pending flag for this origin exactly as it was --
     * `open` itself is not requeued here, since the route book already
     * tracks it and callSessionClose delivers it the moment the call ends
     * (deliverKeptRoute, below), without waiting for some other trigger.
     */
    private void reloadOrKeepPending() {
        if (callSessionOpen) {
            ShellLog.i("deliver unhandled during call");
            return;
        }
        reloadRoute();
    }

    /** The call that made reloadOrKeepPending hold a route has just ended.
     * Re-runs deliver for whatever is still pending on this origin -- a
     * no-op if nothing was held, or if it was already cleared (the page
     * handled it on some other path in the meantime). */
    private void deliverKeptRoute() {
        PendingOpen open = shell.routes.pending();
        if (open == null || !open.origin.equals(origin.serialized())) return;
        deliver(open);
    }

    /** Only what the openExternal rule admits (http, https, tel, mailto without attach) leaves the app. */
    private void openOutside(Uri uri) {
        JSONObject args = new JSONObject();
        Json.put(args, "url", uri.toString());
        String url = ChannelArgs.externalUrl(args);
        if (url == null) {
            ShellLog.i("navigation external refused scheme=" + uri.getScheme());
            return;
        }
        openExternal(Uri.parse(url));
    }

    void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException none) {
            ShellLog.i("no app for scheme=" + uri.getScheme());
        }
    }

    // ---- the channel ----

    /** Every branch replies exactly once, including saveFile, whose controller owns the reply. */
    private void onChannel(ChannelGate.Request request, ChannelBridge.Reply reply) {
        switch (request.method) {
            case "hello":
                reply.ok(ChannelGate.hello());
                break;
            case "ready":
                markReady();
                reply.ok(true);
                break;
            case "saveFile":
                saves.handle(request.args, reply);
                break;
            case "openExternal": {
                String url = ChannelArgs.externalUrl(request.args);
                if (url == null) {
                    reply.error("bad_args");
                    break;
                }
                openExternal(Uri.parse(url));
                reply.ok(true);
                break;
            }
            case "haptic": {
                Object kind = request.args.opt("kind");
                if (!(kind instanceof String) || !ChannelArgs.HAPTICS.contains(kind)) {
                    reply.error("bad_args");
                    break;
                }
                root.performHapticFeedback(haptic((String) kind));
                reply.ok(true);
                break;
            }
            case "signOut":
                ApprovalKeys.remove(origin);
                reply.ok(true);
                close(CloseReason.SIGN_OUT);
                break;
            case "rePair":
                ApprovalKeys.remove(origin);
                reply.ok(true);
                close(CloseReason.SIGNED_OUT);
                break;
            case "setRoute": {
                ChannelArgs.Route route = ChannelArgs.route(request.args);
                if (route.kind == ChannelArgs.RouteKind.INVALID) {
                    reply.error("bad_args");
                    break;
                }
                if (route.kind == ChannelArgs.RouteKind.THREAD) shell.routes.remember(route.threadId, origin);
                reply.ok(true);
                break;
            }
            case "showLauncher":
                reply.ok(true);
                close(CloseReason.LAUNCHER);
                break;
            case "callSessionOpen":
                callSessionOpen = true;
                ShellLog.i("call session open");
                reply.ok(true);
                break;
            case "diagLine": {
                String line = ChannelArgs.diagLine(request.args);
                if (line == null) { reply.error("bad_args"); break; }
                writeCallDiag(line);
                reply.ok(true);
                break;
            }
            case "approveWithDevice": {
                com.murage.mobile.shell.ApprovalProof.Request approval = com.murage.mobile.shell.ApprovalProof.Request.parse(request.args);
                if (approval == null) { reply.error("bad_args"); break; }
                if (!hasWindowFocus()) { reply.error("unavailable"); break; }
                if (approving) { reply.error("busy"); break; }
                approving = true;
                try {
                    approvalCancel = ApprovalKeys.sign(this, origin, approval, new ApprovalKeys.Callback() {
                        @Override public void ok(String signature) { approving = false; approvalCancel = null; JSONObject out = new JSONObject(); Json.put(out, "signature", signature); reply.ok(out); }
                        @Override public void error(String code) { approving = false; approvalCancel = null; reply.error(code); }
                    });
                } catch (RuntimeException e) {
                    approving = false; // sign answers its own failures once; this is the last resort
                    approvalCancel = null;
                }
                break;
            }
            case "callSessionClose":
                callSessionOpen = false;
                ShellLog.i("call session closed");
                reply.ok(true);
                deliverKeptRoute();
                shell.deliverPendingCrossComputerOpen(this);
                break;
            case "pushStatus":
                reply.ok(PushServices.get(this).pushStatus(origin));
                break;
            case "issuePushTokens": {
                com.murage.mobile.shell.PushContract.Issued tokens = com.murage.mobile.shell.PushContract.Issued.parse(request.args);
                if (tokens == null) { reply.error("bad_args"); break; }
                if (!pushWhilePresent("issue")) { reply.error("unavailable"); break; }
                if (!PushServices.get(this).issue(origin, tokens)) { reply.error("unavailable"); break; }
                reply.ok(true);
                break;
            }
            case "setBadgeCount": {
                Integer count = ChannelArgs.integer(request.args.opt("count"));
                if (count == null) { reply.error("bad_args"); break; }
                PushServices.get(this).setBadge(origin, count);
                reply.ok(true);
                break;
            }
            case "registerPush": {
                if (!pushWhilePresent("register")) { reply.error("unavailable"); break; }
                boolean fresh = Boolean.TRUE.equals(request.args.opt("fresh"));
                Runnable go = () -> PushRegistrar.get(this).register(origin, fresh, result -> {
                    if (result == null) reply.error("unavailable"); else reply.ok(result);
                });
                // B2: POST_NOTIFICATIONS is asked once, on API 33 and later; after that
                // the plan answers "denied" until the person turns it on in Settings.
                SharedPreferences prefs = getSharedPreferences("murage_push", MODE_PRIVATE);
                if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("asked", false)
                        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    prefs.edit().putBoolean("asked", true).apply();
                    pendingPushRegistrations.add(go);
                    if (pendingPushRegistrations.size() == 1) pushPermissionAsk.launch(Manifest.permission.POST_NOTIFICATIONS);
                } else if (!pendingPushRegistrations.isEmpty()) {
                    pendingPushRegistrations.add(go); // the prompt is still up: answer with the rest
                } else {
                    go.run();
                }
                break;
            }
            default:
                reply.error("unknown_method");
        }
    }

    /**
     * Push enrolment runs only while the person is here: not on a locked phone
     * (the respond key needs an unlocked device, so its seal would fail) and not
     * once the activity has stopped (the page may be torn down before it hands a
     * new grant to the host). The refusal is "unavailable", which the page reads
     * as "failed": it posts nothing and replaces nothing, and the next resume
     * runs it again.
     */
    private boolean pushWhilePresent(String step) {
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        boolean locked = keyguard != null && keyguard.isDeviceLocked();
        if (!locked && getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)) return true;
        ShellLog.i("push " + step + " deferred");
        return false;
    }

    private static int haptic(String kind) {
        boolean modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        switch (kind) {
            case "success":
                return modern ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
            case "warning":
            case "error":
                return modern ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
            default:
                return HapticFeedbackConstants.KEYBOARD_TAP;
        }
    }

    // ---- lifecycle ----

    /** singleTop: a start while this one is on top replaces it rather than being dropped. */
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getStringExtra(EXTRA_ORIGIN) == null) return;
        closeFromShell();
        startActivity(intent);
    }

    @Override protected void onResume() {
        super.onResume();
        PushReconciler.run(this); // A5: clears what was answered elsewhere, off the main thread
        PushRegistrar.get(this).refreshIfDue(); // at most daily: keeps the relay from sweeping an idle registration
        if (resumedOnce) emit("resume", null, null);
        resumedOnce = true;
    }

    @Override protected void onPause() {
        super.onPause();
        stillInUse();
        CookieManager.getInstance().flush(); // Phase 0 Q2: the session survives a kill
        emit("pause", null, null);
    }

    @Override protected void onDestroy() {
        if (approvalCancel != null) approvalCancel.cancel();
        main.removeCallbacksAndMessages(null);
        io.shutdownNow();
        attestIo.shutdownNow();
        if (attestTimeout != null) main.removeCallbacks(attestTimeout);
        if (shell != null) shell.detach(this);
        if (saves != null) saves.dispose();
        // Nothing the page is waiting on is left unanswered.
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (pendingPermission != null) {
            pendingPermission.deny();
            pendingPermission = null;
        }
        pendingPushRegistrations.clear(); // their page has gone with the WebView
        if (webView != null && root != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ---- WebView clients ----

    private final class Client extends WebViewClient {
        private boolean mayShowInMainFrame(String url) {
            return NavigationPolicy.decide(url, NavigationPolicy.Target.MAIN_FRAME, origin) == NavigationPolicy.Decision.ALLOW;
        }

        /**
         * NavigationPolicy decides (contract/navigation.json). No second windows here
         * (setSupportMultipleWindows(false)), so window.open and target=_blank arrive
         * as main-frame navigations and never as NEW_WINDOW.
         */
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            switch (NavigationPolicy.decide(url, request.isForMainFrame() ? NavigationPolicy.Target.MAIN_FRAME : NavigationPolicy.Target.SUBFRAME, origin)) {
                case ALLOW:
                    return false;
                case SEND_OUT:
                    ShellLog.i("navigation external host=" + request.getUrl().getHost());
                    openOutside(request.getUrl()); // another origin, mailto:, tel:
                    return true;
                default:
                    return true;
            }
        }

        /**
         * shouldOverrideUrlLoading never sees a POST, so a form posted to another
         * origin arrives here first (review ruling): stop it and send the URL out
         * through the same openExternal rule. The origin's own blob: pages are
         * allowed, as there; an about: page no longer is (final review M7).
         */
        @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
            mainDocumentFailed = false;
            mainDocumentStatus = 200;
            pageFinishedOnOrigin = false;
            // A foreign-origin navigation is stopped below, not shown: the
            // page (and its call, if any) is still the one on screen, so
            // the flag must not clear here, or a call survives this but
            // the reload guard goes dark for the rest of it
            // (callbar-rereview3.md R4). Cleared only once a real
            // navigation on this origin is actually proceeding (never a
            // same-document reload, which calls no WebView navigation
            // method at all): the call, if any, really is ending with it,
            // and the new page cannot tell native otherwise -- without
            // this the flag would stay stuck true after a page-initiated
            // reload mid-call, the same way a renderer crash would
            // (callbar-rereview2.md G4).
            if (url == null || mayShowInMainFrame(url)) {
                boolean wasOpen = callSessionOpen;
                callSessionOpen = false;
                if (wasOpen) shell.deliverPendingCrossComputerOpen(WorkspaceActivity.this); // B6: the call is gone with the old page
                return;
            }
            view.stopLoading();
            leftOrigin(view, url);
        }

        /** The main frame is showing (or committing) a URL it may not show: send it out once and go back. */
        private void leftOrigin(WebView view, String url) {
            switch (originReturn.left()) {
                case SEND_OUT_AND_RETURN:
                    ShellLog.i("main frame left the origin; stopped");
                    openOutside(Uri.parse(url));
                    returnToOrigin(view);
                    break;
                case RELOAD: // going back reached a foreign entry: never sent out again
                    ShellLog.i("main frame return reached another origin; reloading");
                    reloadAndForget();
                    break;
                default: // a return is already on its way
                    break;
            }
        }

        /**
         * P26 (S25): onPageStarted arrives after the commit, so the foreign
         * reply is already the document; stopLoading alone left it on screen.
         * Back to the page it replaced, else the saved route. Where it lands is
         * checked in doUpdateVisitedHistory and onPageFinished (OriginReturn).
         */
        private void returnToOrigin(WebView view) {
            main.post(() -> {
                if (closing || view != webView) return;
                switch (originReturn.run(view.canGoBack())) {
                    case GO_BACK:
                        view.goBack();
                        break;
                    case RELOAD:
                        reloadAndForget();
                        break;
                    default:
                        break;
                }
            });
        }

        /** Back on the saved origin, and not the door's /enter page (its spent token). */
        private boolean mayLandOn(String url) {
            return url != null && origin.contains(url) && !"/enter".equals(Uri.parse(url).getPath());
        }

        /** Sees same-document entries too: a pushState the foreign page left behind. */
        @Override public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (view != webView || closing) return;
            if (originReturn.landed(mayLandOn(url)) == OriginReturn.Action.RELOAD) {
                ShellLog.i("main frame return landed off the route; reloading");
                reloadAndForget();
            }
        }

        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (!request.isForMainFrame() || !origin.contains(request.getUrl().toString())) return;
            mainDocumentFailed = true;
            mainDocumentStatus = response.getStatusCode();
            ShellLog.i("main-document status=" + response.getStatusCode());
            CloseReason reason = MainDocument.closeReason(response.getStatusCode());
            if (reason != null) close(reason);
            else armDeadline();
        }

        /**
         * M3: only the workspace's own main document failing closes it. A foreign form
         * POST that fails (DNS, refused) never reached onPageStarted, and the person's
         * computer is not unreachable: if its error page is showing, return as there.
         */
        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            if (!NavigationPolicy.isOwnMainDocument(request.getUrl().toString(), true, origin)) {
                ShellLog.i("main-frame error off the origin=" + error.getErrorCode() + "; not closing");
                String showing = view.getUrl();
                if (view == webView && !closing && showing != null && !mayShowInMainFrame(showing)) leftOrigin(view, request.getUrl().toString());
                else armDeadline();
                return;
            }
            mainDocumentFailed = true;
            LoadFailure outcome = NavigationFailure.classify(error.getErrorCode());
            ShellLog.i("main-document error=" + error.getErrorCode() + " outcome=" + outcome);
            if (outcome == LoadFailure.UNREACHABLE) close(CloseReason.UNREACHABLE);
            else if (outcome == LoadFailure.INSECURE) close(CloseReason.INSECURE);
            else if (outcome == LoadFailure.IGNORE) armDeadline();
        }

        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            ShellLog.i("tls error primary=" + error.getPrimaryError());
            if (origin.contains(error.getUrl())) close(CloseReason.INSECURE);
        }

        @Override public void onPageFinished(WebView view, String url) {
            CookieManager.getInstance().flush();
            if (closing) return; // a load finishing after sign-out never signs back in
            if (view == webView) {
                if (originReturn.landed(mayLandOn(url)) == OriginReturn.Action.RELOAD) {
                    reloadAndForget();
                    return;
                }
                // the reload after a return: nothing foreign is left to go back to
                if (originReturn.reloaded(origin.contains(url))) view.clearHistory();
            }
            if (mainDocumentFailed || !origin.contains(url)) return;
            String path = Uri.parse(url).getPath();
            if ("/enter".equals(path)) { // the door's pairing page never calls ready()
                reveal();
                return;
            }
            pageFinishedOnOrigin = true;
            // "/" signs in; any other page only moves "Last connected" on
            // (MainDocument.arrival): a relaunch opens the last conversation,
            // and basic mode has no ready().
            switch (MainDocument.arrival(mainDocumentStatus, path)) {
                case SIGNED_IN:
                    signedIn();
                    break;
                case IN_USE:
                    loadedInUse();
                    break;
                default:
                    break;
            }
            if ("basic".equals(mode)) {
                revealBasic();
                return;
            }
            armDeadline(); // keep the original progress deadline
        }

        /** Phase 0 Q5: Android forbids reusing a WebView whose renderer died. */
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            ShellLog.i("renderer gone crashed=" + detail.didCrash() + "; recreating");
            // The dead renderer cannot call callSessionClose either
            // (callbar-rereview2.md G4 -- the same reset onPageStarted does
            // for a page-initiated reload).
            boolean wasOpen = callSessionOpen;
            callSessionOpen = false;
            if (wasOpen) shell.deliverPendingCrossComputerOpen(WorkspaceActivity.this); // B6
            root.removeView(view);
            view.destroy();
            if (view == webView) {
                webView = null;
                if (!isFinishing() && !closing) {
                    createWebView();
                    if (mayReloadAfterCrash()) reloadRoute();
                }
            }
            return true;
        }
    }

    /**
     * A second renderer death within a minute stops the reloads: the slow
     * panel's Try again is the person's call, so a page that kills its
     * renderer cannot loop (the iOS P15 rule).
     */
    private boolean mayReloadAfterCrash() {
        long now = SystemClock.elapsedRealtime();
        boolean again = now - lastCrash < CRASH_WINDOW_MS;
        lastCrash = now;
        if (!again) return true;
        ShellLog.i("renderer gone again; waiting for the person");
        ready = false;
        splashUp = true;
        main.removeCallbacks(readyDeadline);
        overlay.showSlow();
        return false;
    }

    private final class Chrome extends WebChromeClient {
        @Override public void onPermissionRequest(PermissionRequest request) {
            // Android names no frame here, so the origin decides alone (M8, Plan 3).
            if (!NavigationPolicy.mayCapture(request.getOrigin().toString(), null, origin)) {
                request.deny();
                return;
            }
            List<String> needed = new ArrayList<>();
            for (String resource : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needed.add(Manifest.permission.RECORD_AUDIO);
                else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needed.add(Manifest.permission.CAMERA);
                else {
                    request.deny(); // protected media and MIDI are not ours to grant
                    return;
                }
            }
            List<String> missing = new ArrayList<>();
            for (String permission : needed) {
                if (ContextCompat.checkSelfPermission(WorkspaceActivity.this, permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
            }
            if (missing.isEmpty()) {
                request.grant(request.getResources());
                return;
            }
            if (pendingPermission != null) pendingPermission.deny();
            pendingPermission = request;
            permissionAsk.launch(missing.toArray(new String[0]));
        }

        @Override public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingPermission == request) pendingPermission = null;
        }

        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                filePicker.launch(params.createIntent());
                return true;
            } catch (ActivityNotFoundException none) {
                fileCallback = null;
                return false;
            }
        }

        // JavaScript dialogs only for the workspace page itself; anything else gets the
        // dismissive answer without a word (iOS fromPage). Android gives no frame, so the
        // page URL's origin is the check.
        @Override public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            if (!origin.contains(url)) {
                result.cancel();
                return true;
            }
            return false; // the WebView's own dialog
        }

        @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            if (!origin.contains(url)) {
                result.cancel();
                return true;
            }
            return false;
        }

        @Override public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
            if (!origin.contains(url)) {
                result.cancel();
                return true;
            }
            return false;
        }

        @Override public boolean onConsoleMessage(ConsoleMessage message) {
            if (E2EProbe.isProbeOutput(message.message())) ShellLog.i(message.message());
            return true; // the page's console never reaches logcat (content-free logs)
        }
    }
}
