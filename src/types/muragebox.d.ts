// The narrow bridge the Electron preload exposes. Absent in the browser.

declare global {
type NativeSkillRecordingEvent = {
  type: "app" | "click" | "scroll" | "key" | "typing" | "clipboard" | "download";
  atMs: number;
  app?: string;
  windowTitle?: string;
  x?: number;
  y?: number;
  button?: "left" | "right" | "other";
  deltaY?: number;
  keycode?: number;
  meta?: boolean;
  control?: boolean;
  option?: boolean;
  shift?: boolean;
  /** Element identity for a click, from the accessibility tree. */
  role?: string;
  name?: string;
  identifier?: string;
  ancestry?: string[];
  /** Typed keystroke count (never the characters themselves). */
  keyCount?: number;
  /** Clipboard action kind — never its contents. */
  op?: "copy" | "cut" | "paste";
  /** Downloaded file name and its origin URLs. */
  filename?: string;
  whereFroms?: string[];
};

type SkillRecordingPayload = {
  name: string;
  description: string;
  durationMs: number;
  transcript: string;
  transcription?: { provider: "assemblyai"; model: string };
  audio?: string;
  events: Array<{
    type: "app" | "click" | "scroll" | "shortcut" | "typing" | "clipboard" | "download";
    atMs: number;
    app?: string;
    windowTitle?: string;
    direction?: "up" | "down";
    shortcut?: string;
    keyCount?: number;
    screenshot?: string;
    /** Element identity for a click. */
    role?: string;
    name?: string;
    identifier?: string;
    ancestry?: string[];
    /** Clipboard action kind — never its contents. */
    op?: "copy" | "cut" | "paste";
    /** Downloaded file name and its origin URLs. */
    filename?: string;
    whereFroms?: string[];
  }>;
};

  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      /** The user's home folder, for showing paths as ~/… */
      homeDir?: string;
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "native";
    screenPreview: {
      available: boolean;
      interaction: "direct" | "portal-picker" | "none";
      reasonCode?: string;
    };
    dictation: {
      available: boolean;
      engine: "apple-speech" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
    localComputer: {
      available: boolean;
      support: "supported" | "limited" | "unsupported";
      enabled: boolean;
      status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
      reasonCode?: string;
      message?: string;
      driverPath?: string;
      driverVersion?: string;
      driverSource?: "bundled" | "environment" | "user-local" | "path";
      session?: "x11" | "wayland" | "headless" | "unknown";
      compositor?: "gnome-mutter";
    };
  };

  interface DesktopWorkspaceBounds {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface BrowserSurfaceState {
    botId: string;
    open: boolean;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward?: boolean;
    visible: boolean;
    partition?: string | null;
    profile?: string | null;
    mode?: "compact" | "expanded" | null;
    code?: "renderer-gone" | "profile-deleted" | "evicted";
  }

  interface DesktopWorkspaceState {
    contextId: string;
    open: boolean;
    status: "opening" | "ready" | "error" | "closed";
    interactive: boolean;
    code?: "load-failed" | "renderer-gone";
  }

  interface BackupScheduleStatus {
    supported:boolean; pending:boolean; enabled:boolean; revision:number; phase:string;
    /** Unsupported only for now: the backup tool is still being checked. */
    checking?:boolean;
    preUpgradeSupported?:boolean;
    schedule:import("../../shared/backup-schedule").BackupSchedule;
    lastVerified?:import("../../shared/backup-schedule").BackupReceipt;
    closedAppSupported?:boolean;
    /** Why Murage can't reopen itself here (a BACKUP_RELAUNCH_* code). Every
     * backup reopens Murage, so setup is refused while this is set. */
    relaunchBlocked?:string;
    /** The last backup that couldn't start because these bots were waiting
     * for the person's answer: a due daily one (retried every minute) or a
     * Back up now. See shared/backup-waiting.ts. */
    heldBy?:{occasion:"daily"|"manual";since:number;bots:import("../../shared/backup-waiting").BackupWaitingBot[]};
    lastClosedResult?:import("../../shared/backup-schedule").BackupClosedResult;
    refs?:{installationRef:string;destinationRef:string;recoveryRef:string;destinationLabel:string;recoveryLabel:string};
    error?:string|null;
    /** Why the last backup stopped, while it waits to be cleared. */
    reviewReason?:string;
    /** The step it stopped on and the refusal that stopped it, both from
     * closed sets. Never a path, a filename or a secret. */
    captureFailure?:{stage:string;code:string};
  }
  interface BackupClosedStatus {
    supported:boolean;
    state:"unconfigured"|"staged"|"installed"|"disabled"|"disabled-removal-pending"|"unavailable";
    closedApp:boolean;
    lastClosedResult?:import("../../shared/backup-schedule").BackupClosedResult;
    /** Why the job can't be set up, when Murage can tell. */
    blocked?:"data-folder-shared"|"volume-app"|"volume-data"|"volume-both"|"app-file-shared"|"app-moved"|"job-wont-run"|"job-outdated";
    /** With blocked "app-file-shared": the app file to fix (chmod 755). */
    appFile?:string;
  }
  interface Window {
    muragebox?: {
      platform: NodeJS.Platform;
      backup?: {
        status(): Promise<{ supported:boolean; pending:boolean }>; restart(): Promise<{ restarting:boolean }>;
        /** Native save dialog; the private key never reaches the renderer. */
        createRecoveryKey(): Promise<{ cancelled:true }|{ saved:true; label:string; publicKey:string }>;
        /** A second copy of the key Murage made, saved where the person picks.
         * The secret is read and written in the desktop process. */
        saveRecoveryKeyCopy?(): Promise<{ cancelled:true }|{ saved:true; label:string; publicKey:string }|{ refused:string }>;
      };
      backupSchedule?: {
        status():Promise<BackupScheduleStatus>;
        selectReferences():Promise<BackupScheduleStatus|{cancelled:true}>;
        /** One act of setup: choose the backup folder, Murage writes the
         * recovery key itself, one confirmation. Older apps do not have it. */
        setUp?(options?:{existingKey?:boolean}):Promise<(BackupScheduleStatus|{cancelled:true})&{created?:{label:string;publicKey:string|null;folder:string};refused?:string}>;
        configure(revision:number,choices:import("../../shared/backup-schedule").BackupSchedule&{allowIdleRestart?:boolean;allowClosedApp?:boolean}):Promise<BackupScheduleStatus>;
        /** One backup now through the Backup-mode restart; resolves as Murage restarts. */
        runNow(revision:number):Promise<BackupScheduleStatus>;
        /** Clears a backup that stopped without a confirmed result. */
        clearReview?(revision:number):Promise<BackupScheduleStatus>;
      };
      backupClosed?: {
        status():Promise<BackupClosedStatus>;
        stage():Promise<BackupClosedStatus>;
        install():Promise<BackupClosedStatus&{cancelled?:boolean}>;
        disable():Promise<BackupClosedStatus>;
      };
      backupRemote?: {
        status():Promise<import("../../server/backup-remote-host").BackupRemoteStatus>;
        save(revision:number,input:{kind?:"s3";label:string;endpoint:string;bucket:string;prefix:string;region:string;bucketLookup:"auto"|"path"|"dns";credentials:{accessKeyId:string;secretAccessKey:string;sessionToken?:string}}|{kind:"sftp";label:string;host:string;port:number;user:string;folder:string}):Promise<{saved:boolean}>;
        testConnection?(remoteRef:string,revision:number):Promise<{state:"trust-required";fingerprint:string;keyType:string}|{state:"connected";created:boolean;remoteRef:string;revision:number;repositoryId:string}>;
        trustServer?(remoteRef:string,revision:number,fingerprint:string):Promise<{trusted:boolean;fingerprint:string}>;
        remove?(remoteRef:string,revision:number):Promise<{removed:boolean}>;
        createRepositoryPassword?(remoteRef:string,revision:number):Promise<{created:boolean;path:string}>;
        saveRepositoryPasswordCopy?(remoteRef:string,revision:number):Promise<{saved?:boolean;path?:string;cancelled?:boolean}>;
        selectRepositoryPassword(remoteRef:string,revision:number):Promise<{cancelled?:boolean;selected?:boolean}>;
        connect(remoteRef:string,revision:number):Promise<{connected:boolean;remoteRef:string;revision:number;repositoryId:string}>;
        uploadLatest(remoteRef:string,revision:number,jobId:string):Promise<{state:string;jobId:string;remoteRef:string;revision:number;snapshotId?:string}>;
        reconcileLatest(remoteRef:string,revision:number,jobId:string):Promise<{state:string;jobId:string;snapshotId?:string}>;
        listBackups(remoteRef:string,revision:number):Promise<{repositoryId:string;backups:{snapshotId:string;jobId:string;createdAt:number;verified:false}[];ignored:number}>;
        downloadBackup(remoteRef:string,revision:number,snapshotId:string):Promise<{cancelled?:boolean;saved?:boolean;archivePath?:string;directory?:string}>;
        setAutomaticUpload(remoteRef:string,revision:number,enabled:boolean):Promise<{saved:boolean}>;
        saveMaintenanceCredentials?(remoteRef:string,revision:number,credentials:{accessKeyId:string;secretAccessKey:string;sessionToken?:string}):Promise<{saved:boolean}>;
        previewRetention?(remoteRef:string,revision:number,policy:{keepLast?:number;keepDaily?:number;keepWeekly?:number;keepMonthly?:number;keepYearly?:number}):Promise<{previewId:string;remove:string[];keep:number;lockRelease?:"unconfirmed"}>;
        applyRetention?(remoteRef:string,revision:number,policy:{keepLast?:number;keepDaily?:number;keepWeekly?:number;keepMonthly?:number;keepYearly?:number},previewId:string):Promise<{state:"nothing-to-remove"|"complete"|"needs-review";previewId:string;removed:number;error?:"repository-locked"|"forget-failed"|"prune-failed"|"operation-failed";lockRelease?:"unconfirmed"}>;
        clearRetentionReview?(remoteRef:string,revision:number,previewId:string):Promise<{cleared:boolean}>;
      };
      approvalNotifications?: {
        show(payload: { botId: string; threadId: string; requestId: string; messageId: string; requestTurnId?: string; title: string; body: string; silent?: boolean }): Promise<{ accepted: boolean }>;
        onOpen(callback: (target: { botId: string; threadId: string; messageId?: string }) => void): () => void;
      };
      /** Menu bar / system tray menu intents (electron/background-lifecycle.mjs). */
      tray?: {
        onOpen(callback: (target: TrayOpenTarget) => void): () => void;
      };
      startup?: {
        status(): Promise<StartupBackgroundState>;
        update(patch:{keepRunning?:boolean;startAtLogin?:boolean}):Promise<StartupBackgroundState>;
        onChange(callback:(state:StartupBackgroundState)=>void):()=>void;
        onOpenInbox(callback:()=>void):()=>void;
      };
      getCapabilities(): Promise<DesktopCapabilities>;
      onCapabilitiesChanged(cb: (capabilities: DesktopCapabilities) => void): () => void;
      /** Whether the engine is alive, and whether it is coming back. A dead
       *  server presents as a dozen broken features; this is how the renderer
       *  can tell the difference and say which. */
      onServerLifecycle(cb: (state: { state: "running" | "restarting" | "failed"; since: number | null; attempt: number }) => void): () => void;
      companionAccount?: {
        state(): Promise<CompanionAccountState>;
        requestCode(email: string): Promise<CompanionAccountState>;
        verifyCode(email: string, code: string): Promise<CompanionAccountState>;
        retry(): Promise<CompanionAccountState>;
        signOut(): Promise<CompanionAccountState>;
      };
      localControl: {
        status(): Promise<LinuxLocalControlStatus>;
        enable(): Promise<LinuxLocalControlStatus>;
        disable(): Promise<LinuxLocalControlStatus>;
        retry(): Promise<LinuxLocalControlStatus>;
      };
      /** Arms one user-initiated display capture request from this frame. */
      beginScreenPreviewIntent(): boolean;
      screenFrame(): Promise<string | null>;
      androidDevice?: {
        status(): Promise<AndroidDeviceStatus>;
        frame(serial: string): Promise<{ serial: string; dataUrl: string }>;
        input(serial: string, payload: AndroidDeviceInput): Promise<void>;
      };
      /** Start native dictation. Call mode supplies endpointMs so silence
       * finalizes a turn; composer dictation omits it and remains manual. */
      speechStart(options?: { endpointMs?: number; fed?: boolean; hints?: string[] }): Promise<void>;
      /** Call mode: echo-cancelled microphone audio (16 kHz mono s16le) for a fed session. */
      speechFeed?(bytes: Uint8Array): void;
      speechStop(): Promise<void>;
      /** Finish capture and emit the recognizer's final transcript. */
      speechFinish?(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      skillRecorder?: {
        permissions(): Promise<{ supported: boolean; reason?: string }>;
        start(): Promise<{ recording: boolean }>;
        stop(): Promise<{ recording: boolean }>;
        save(payload: SkillRecordingPayload): Promise<{ id: string; path: string; events: number }>;
        onEvent(cb: (event: NativeSkillRecordingEvent) => void): () => void;
        onEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      };
      transcription?: {
        status(): Promise<{ configured: boolean }>;
        setKey(value: string): Promise<{ configured: boolean }>;
        streamingToken(): Promise<{ token: string; expiresInSeconds: number }>;
      };
      /** Absolute path of a dropped File ("" when the drag carried no
       * file on disk). Absent in older builds of the shell. */
      getPathForFile?(file: File): string;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech|accessibility. */
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      /** Copies an engine install command and opens a blank terminal. False
       * when no terminal could be launched; the clipboard still has it. */
      openInstallTerminal?(command: string): Promise<boolean>;
      openEngineSetupTerminal?(input: { instanceId: string; action: "install" | "connect" }): Promise<boolean>;
      /** Opens an http(s) link in the user's default browser. */
      openExternal?(url: string): Promise<boolean>;
      /** Recolor the native window chrome for a skin; absent on older builds. */
      applySkin?(skin: string): Promise<boolean>;
      /** Receives a GitHub package URL opened through murage://install. */
      onPackageInstall?(cb: (url: string) => void): () => void;
      /** Updates the native Dock/taskbar unread indicator. */
      setUnreadCount?(count: number): void;
      /** Opens a live desktop as a sandboxed window owned by Murage. */
      desktopViewer?: {
        open(url: string, title: string, contextId: string): Promise<boolean>;
        /** Closes the live-desktop window, but only when it belongs to this bot. */
        close(contextId: string): Promise<boolean>;
        /** The current viewer state, for a panel to initialize from on mount. */
        currentState(): Promise<{ open: boolean; contextId: string | null }>;
        onState(cb: (state: { open: boolean; contextId: string | null }) => void): () => void;
      };
      /** Two Local VM viewers embedded in one app window. URLs are accepted
       * only by main-process validation and never return over this bridge. */
      /** The built-in browser surface; absent in a browser tab or an older shell. */
      browser?: {
        available(): Promise<boolean>;
        state(botId: string): Promise<BrowserSurfaceState>;
        layout(
          botId: string,
          bounds: DesktopWorkspaceBounds | null,
          profile?: string,
          mode?: "compact" | "expanded",
          layoutOwner?: string,
        ): Promise<BrowserSurfaceState>;
        navigate(botId: string, url: string, profile?: string): Promise<{ url: string; title: string }>;
        back(botId: string, profile?: string): Promise<{ url: string; title: string }>;
        forward?(botId: string, profile?: string): Promise<{ url: string; title: string }>;
        reload?(botId: string, profile?: string): Promise<{ url: string; title: string }>;
        /** Immediately gates native browser mutations while the durable
         * server-side human-control snapshot catches up. */
        setHumanControl?(botId: string, held: boolean, profile?: string): Promise<boolean>;
        /** Native page focus/input means the person has taken the wheel. */
        onUserInteraction?(cb: (event: { botId: string; profile: string }) => void): () => void;
        forgetProfile?(partitionId: string): Promise<{ dropped: number }>;
        close(botId: string): Promise<boolean>;
        onState(cb: (state: BrowserSurfaceState) => void): () => void;
      };
      desktopWorkspace?: {
        open(input: {
          contextId: string;
          url: string;
          title: string;
          bounds: DesktopWorkspaceBounds;
        }): Promise<DesktopWorkspaceState>;
        layout(items: Array<{
          contextId: string;
          bounds: DesktopWorkspaceBounds;
          visible: boolean;
        }>): Promise<boolean>;
        setInteractive(contextId: string | null): Promise<boolean>;
        close(contextId?: string): Promise<boolean>;
        onState(cb: (state: DesktopWorkspaceState) => void): () => void;
      };
      /** Native folder picker; resolves null when the user cancels. */
      pickFolder?(current?: string): Promise<string | null>;
      /** Writes the redacted diagnostics report to a user-chosen file;
       * resolves the path, or null when cancelled. */
      exportDiagnostics?(selection?: {threadId:string;messageId:string;diagnosticId:string}): Promise<string | null>;
      /** Asks where to save a bot-created file (inside ~/.murage), copies
       * it there and reveals it. Resolves the chosen path, or null if the
       * user cancelled the dialog. */
      saveFile?(filePath: string): Promise<string | null>;
      artifactAction?(id: string, action: "open" | "reveal"): Promise<void>;
      revealWorkspace?(botId: string, threadId: string): Promise<void>;
      /** Open or reveal one live workspace file (F4-T5). The renderer names
       * the conversation and a validated relative path; the main process
       * resolves, authorizes and revalidates the real path. Rejects with the
       * user-facing refusal; `open` resolves without acting when the owner
       * cancels the browser warning. */
      workspaceFileAction?(
        scope: { botId: string; threadId: string },
        relativePath: string,
        action: "open" | "reveal",
      ): Promise<void>;
      /** Save a provider credential through Electron's OS-backed store. */
      mutateProviderConnection?(input: import("../../shared/provider-connections").ProviderConnectionMutation): Promise<{ connections: import("../../shared/provider-connections").PublicProviderConnection[]; storage: "encrypted" | "local-config" }>;
      mutateFluxConnection?(input: import("../../shared/flux-connection").FluxConnectionMutation): Promise<import("../../shared/flux-connection").FluxConnectionStatus>;
      /** Run the legacy connected-apps claim once (user consent). */
      claimLegacyComposio?(): Promise<{ state: "none" | "offered" | "pending" | "claimed" | "conflict" | "abandoned"; code?: string; installationId?: string; at?: string; confirmPending?: boolean }>;
      setCredential?(
        name: "composioApiKey" | "xaiApiKey" | "boxToken" | "opencodeGoApiKey" | "ttsKey" | "openaiImageApiKey" | "tavilySearchApiKey" | "exaSearchApiKey" | "firecrawlSearchApiKey" | "telegramBotToken" | "slackAppToken" | "slackBotToken" | "discordBotToken",
        value: string,
      ): Promise<ConfigStatus>;
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** apply the download: quit-and-install, or copy the command and open a terminal */
        install(): Promise<void>;
        retry(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface LinuxLocalControlStatus {
  enabled: boolean;
  status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
  reasonCode?: string;
  message?: string;
  driverPath?: string;
  driverVersion?: string;
  driverSource?: "bundled" | "environment" | "user-local" | "path";
  session?: "x11" | "wayland" | "headless" | "unknown";
  compositor?: "gnome-mutter";
  warnings?: Array<{ label: string; status: string; message: string; detail?: string }>;
}

export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    | "deferred"
    /** the command is on the clipboard; the user finishes in a terminal */
    | "handed-off"
    | "error";
  version?: string;
  /** The version of the app that is running now (app.getVersion()). */
  currentVersion?: string;
  percent?: number;
  message?: string;
  /**
   * How the download gets applied. "restart" quits and installs in place;
   * "handoff" copies the install command and opens a terminal so the user
   * can finish — Ubuntu .deb (and rpm/pacman) builds use this.
   */
  installMode?: "restart" | "handoff";
  /** hand-off only: the install command, already on the clipboard */
  command?: string;
  /** hand-off only: whether a terminal was opened to paste it into */
  terminalOpened?: boolean;
}

export type TrayOpenTarget =
  | { kind: "approval"; botId?: string; threadId: string; messageId: string }
  | { kind: "conversation"; botId: string; threadId: string }
  | { kind: "compose"; botId: string };

export interface StartupBackgroundState {
  platform:NodeJS.Platform;
  keepRunning:boolean; defaultInherited:boolean; configurable:boolean;
  trayAvailable:boolean; canKeepRunning:boolean; effectiveKeepRunning:boolean;
  windowVisible:boolean; suspended:boolean; quitting:boolean; automationsPaused:boolean|null;
  login:{supported:boolean;openAtLogin:boolean;wasOpenedAtLogin?:boolean;requiresApproval?:boolean;reason?:string};
}

export interface CompanionAccountState {
  available: boolean;
  status: "signed-out" | "connecting" | "ready" | "error";
  email?: string;
  endpoint?: string;
  message?: string;
}

export type AndroidUsbDevice = {
  serial: string;
  state: string;
  connection: "usb";
  model: string;
  product?: string;
  transportId?: string;
};

export type AndroidDeviceStatus = {
  available: boolean;
  reasonCode?: "adb-unavailable" | "adb-failed";
  message?: string;
  devices: AndroidUsbDevice[];
};

export type AndroidDeviceInput =
  | { type: "tap"; x: number; y: number; width: number; height: number }
  | {
      type: "swipe";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs: number;
      width: number;
      height: number;
    }
  | { type: "key"; key: string; width?: number; height?: number }
  | { type: "text"; text: string; width?: number; height?: number };
