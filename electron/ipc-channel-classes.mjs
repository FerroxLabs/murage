// Murage Cloud B3 WP3: which desktop IPC channels the Cloud-home window may reach.
//
// Every channel the preload can call (and every channel main registers) belongs to exactly one class:
//
//   local-only  (the default)  The local computer: files, secrets, terminals, credentials, companion, backups,
//                              the browser/computer-use surfaces. Only the main Murage window may call it.
//   cloud-safe                 Harmless to a page that does not run on this computer. The main window AND the
//                              Cloud-home window may call it.
//   cloud-only                 Exists for the Cloud-home window (cloud-home:*). Only that window may call it.
//
// Enforcement is in main, in createOwnedMainIpc (main-ipc-trust.mjs), BEFORE the listener runs, from the sender's
// window kind (isOwnedMainSender -> main, isCloudHomeSender -> cloud). Nothing here trusts the renderer, and a
// channel with no entry is local-only, so forgetting one fails closed. ipc-channel-classes.node-test.mjs fails on
// any registered or preload channel that has no explicit entry below (like server/route-policy.test.ts).
//
// Pure module: no Electron import.

export const CLASS_LOCAL_ONLY = "local-only";
export const CLASS_CLOUD_SAFE = "cloud-safe";
export const CLASS_CLOUD_ONLY = "cloud-only";

/**
 * Channels (exact names or `prefix*`) that can NEVER be reached from the Cloud-home window, whatever the tables
 * below say. A belt over the braces: channelClass checks this first, so promoting one of these by mistake is inert.
 */
export const CLOUD_REFUSED_PATTERNS = Object.freeze([
  "cua:*",
  "engine:open-terminal",
  "engine:open-setup-terminal",
  "desktop:pick-folder",
  "desktop:surface-secret", // sync: the refused sender gets ""
  "credential:set",
  "model-signin:*",
  "backup-*",
  "companion:*",
  "companion-account:*",
  "mcp-servers:*",
]);

/** Cloud-safe channels. Keep this list short; promote a channel only with a reason. */
export const CLOUD_SAFE_CHANNELS = Object.freeze([
  "desktop:open-external", // main re-validates: a credential-free web URL, opened in the default browser
  "desktop:unread-count", // a number; main applies it to the main window only
  "approval-notification:show", // an OS notification; main validates the payload
]);

/**
 * Cloud-only channels registered today (WP4). A cloud-home:* name that is NOT listed here or in LOCAL_ONLY_CHANNELS still
 * falls under the prefix below (cloud-only) so WP5's cloud-home:engine-login:* works, but ipc-channel-classes.node-test.mjs
 * fails on any REGISTERED cloud-home:* channel that is not listed explicitly in one of the two tables.
 */
export const CLOUD_ONLY_CHANNELS = Object.freeze([
  "cloud-home:reachable", // is the home this window belongs to answering (main reads the sender's home; the window passes nothing)
  "cloud-home:disconnect-this", // Settings: disconnect this computer from the window's own home (sender's home only; no arguments)
]);

/** Cloud-only prefixes (WP5 registers cloud-home:engine-login:*). An exact entry in the tables wins over a prefix. */
export const CLOUD_ONLY_PREFIXES = Object.freeze(["cloud-home:"]);

/**
 * cloud-home:* channels that are NOT cloud-only: they serve the MAIN local window (B3 WP5, the engine sign-in
 * terminal, which is started from the desktop) and must be unreachable from the Cloud-home window, whose page is
 * served by a home. They carry the local-only class, so the gate refuses the Cloud-home window by name before any
 * listener runs, and they are exempted from the cloud-home: prefix below. main.mjs registers them only with the Cloud
 * flag on (registerEngineLoginIpc); a flag-off desktop registers none, so the flag-off snapshot is unchanged.
 * `cloud-home:engine-login:data` and `:closed` are main -> renderer sends, listed so the whole family is classified.
 */
export const MAIN_ONLY_CLOUD_CHANNELS = Object.freeze([
  "cloud-home:engine-login:start",
  "cloud-home:engine-login:input",
  "cloud-home:engine-login:stop",
  "cloud-home:engine-login:open-link",
  "cloud-home:engine-login:data",
  "cloud-home:engine-login:closed",
  // main -> local window: show the Connect panel (this computer was disconnected, from Settings or from My Cloud).
  "cloud-home:show-connect",
  // main -> local window: main handled a Cloud link; its kind (and an open-cloud home id) only, never the link.
  "cloud-home:link-event",
]);

/** Every other registered channel, listed explicitly (the test requires it) as local-only. */
export const LOCAL_ONLY_CHANNELS = Object.freeze([
  // android-device
  "android-device:frame",
  "android-device:input",
  "android-device:status",
  // assemblyai
  "assemblyai:set-key",
  "assemblyai:status",
  "assemblyai:streaming-token",
  // backup-mode
  "backup-mode:create-recovery-key",
  "backup-mode:keep-recovery-key",
  "backup-mode:move-recovery-key",
  "backup-mode:recovery-key-cloud-notice",
  "backup-mode:restart",
  "backup-mode:save-recovery-key-copy",
  "backup-mode:status",
  // backup-schedule
  "backup-schedule:clear-review",
  "backup-schedule:configure",
  "backup-schedule:finish-first-run",
  "backup-schedule:run-now",
  "backup-schedule:select",
  "backup-schedule:set-up",
  "backup-schedule:status",
  // browser
  "browser:available",
  "browser:back",
  "browser:close",
  "browser:forget-profile",
  "browser:forward",
  "browser:layout",
  "browser:navigate",
  "browser:reload",
  "browser:set-human-control",
  "browser:state",
  // clipboard
  "clipboard:write",
  // companion-account
  "companion-account:request-code",
  "companion-account:retry",
  "companion-account:sign-out",
  "companion-account:state",
  "companion-account:verify-code",
  // companion
  "companion:cloud-desktop",
  "companion:keep-awake",
  "companion:lan-pairing",
  "companion:pairing",
  "companion:refresh-tailscale",
  "companion:remote-access",
  "companion:revoke",
  "companion:share-ask",
  "companion:start",
  "companion:state",
  "companion:stop",
  // cloud-home (the MAIN window's pairing UI: the Cloud window must never pair, unpair or open another home)
  "cloud-home:connect-cancel",
  "cloud-home:connect-paste",
  "cloud-home:connect-start",
  "cloud-home:connect-status",
  "cloud-home:disconnect",
  "cloud-home:list-bots",
  "cloud-home:list-homes",
  "cloud-home:open",
  "cloud-home:state",
  // composio
  "composio:claim-legacy",
  "composio:reconnect",
  // credential
  "credential:set",
  // cua
  "cua:connection",
  "cua:linux-disable",
  "cua:linux-enable",
  "cua:linux-retry",
  "cua:linux-status",
  "cua:permissions",
  // desktop-viewer
  "desktop-viewer:close",
  "desktop-viewer:open",
  "desktop-viewer:state-now",
  // desktop-workspace
  "desktop-workspace:close",
  "desktop-workspace:layout",
  "desktop-workspace:open",
  "desktop-workspace:set-interactive",
  // desktop
  "desktop:artifact-action",
  "desktop:capabilities",
  "desktop:export-diagnostics",
  "desktop:pick-folder",
  "desktop:quit",
  "desktop:reveal-workspace",
  "desktop:save-file",
  "desktop:skin",
  "desktop:surface-secret",
  "desktop:workspace-file-action",
  // dialog
  "dialog:confirm",
  // email-owner-signin (1.0.9 bot email): the owner act of turning email on; PKCE in main, owner-gated by modelSignInGate, token never reaches the renderer
  "email-owner-signin:cancel",
  "email-owner-signin:start",
  // engine
  "engine:open-setup-terminal",
  "engine:open-terminal",
  // flux-connection, and the desktop Flux sign-in (opens the browser, saves the key in main)
  "flux-connection:mutate",
  "flux-signin:cancel",
  "flux-signin:start",
  // mcp-servers
  "mcp-servers:cancel-sign-in",
  "mcp-servers:mode",
  "mcp-servers:remove",
  "mcp-servers:save-secrets",
  "mcp-servers:sign-in",
  "mcp-servers:sign-out",
  // model-provider
  "model-provider:mutate",
  // model-signin
  "model-signin:cancel",
  "model-signin:sign-out",
  "model-signin:start",
  "model-signin:start-device",
  "model-signin:status",
  "model-signin:submit-code",
  // perm
  "perm:open-settings",
  "perm:request-mic",
  "perm:status",
  // screen
  "screen:frame",
  "screen:preview-intent",
  // skill-recorder
  "skill-recorder:permissions",
  "skill-recorder:save",
  "skill-recorder:start",
  "skill-recorder:stop",
  // speech
  "speech:finish",
  "speech:pcm",
  "speech:start",
  "speech:stop",
  // startup-background
  "startup-background:status",
  "startup-background:update",
  // update
  "update:check",
  "update:download",
  "update:get-state",
  "update:install",
  "update:prepare-previous-version",
  "update:retry",
]);

/**
 * Channels main registers in a loop from a template string (backup-closed:${action}, backup-remote:${action}); the
 * preload calls them by their expanded names. All local-only.
 */
export const LOCAL_ONLY_PREFIXES = Object.freeze(["backup-closed:", "backup-remote:"]);

const mainOnlyCloud = new Set(MAIN_ONLY_CLOUD_CHANNELS);

const exact = new Map([
  ...LOCAL_ONLY_CHANNELS.map((channel) => [channel, CLASS_LOCAL_ONLY]),
  ...CLOUD_SAFE_CHANNELS.map((channel) => [channel, CLASS_CLOUD_SAFE]),
  ...CLOUD_ONLY_CHANNELS.map((channel) => [channel, CLASS_CLOUD_ONLY]),
]);

function matches(channel, pattern) {
  return pattern.endsWith("*") ? channel.startsWith(pattern.slice(0, -1)) : channel === pattern;
}

/** True when `channel` is covered by the never-from-the-cloud list. */
export function isCloudRefusedChannel(channel) {
  return typeof channel === "string" && CLOUD_REFUSED_PATTERNS.some((pattern) => matches(channel, pattern));
}

/** True when the channel has an explicit entry (exact or declared prefix), not just the fail-closed default. */
export function isClassified(channel) {
  if (typeof channel !== "string" || !channel) return false;
  return exact.has(channel) || mainOnlyCloud.has(channel) || CLOUD_ONLY_PREFIXES.some((p) => channel.startsWith(p)) || LOCAL_ONLY_PREFIXES.some((p) => channel.startsWith(p));
}

/**
 * The class of a channel. Unknown channels are local-only; the refused list wins over every table.
 * @param {unknown} channel
 * @returns {"local-only" | "cloud-safe" | "cloud-only"}
 */
export function channelClass(channel) {
  if (typeof channel !== "string" || !channel || isCloudRefusedChannel(channel)) return CLASS_LOCAL_ONLY;
  if (mainOnlyCloud.has(channel)) return CLASS_LOCAL_ONLY;
  const listed = exact.get(channel); // exact entries first: the pairing channels are cloud-home:* yet local-only
  if (listed) return listed;
  if (CLOUD_ONLY_PREFIXES.some((p) => channel.startsWith(p))) return CLASS_CLOUD_ONLY;
  return CLASS_LOCAL_ONLY;
}
