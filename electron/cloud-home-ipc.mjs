// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP4: the cloud-home:* IPC channels. Registered ONLY when the desktop Cloud flag is on (main.mjs calls
// registerCloudHomeIpc inside `if (cloudHome)`), through the owned-main gate, so the sender and the channel class are
// checked in main before any listener here runs.
//
//   cloud-home:state, :list-homes, :open, :connect-start, :connect-cancel, :connect-paste, :connect-status, :disconnect
//                                                                local-only   the MAIN (local) window's Connect UI.
//        (Door v2 is the one pairing path: there is no emailed-code channel; the add-another-computer mint has no channel.)
//        :connect-paste ("Use copied link") takes NO arguments: main reads the clipboard itself and answers the home id
//        only, so a door link or its ticket never crosses IPC in either direction.
//   cloud-home:list-bots                                         local-only   the bots of a paired home, id and name only:
//        a per-bot engine sign-in (CLOUD-ENGINES-DESIGN.md r8 R4) names the bot it is for.
//        Pairing runs in the local window on purpose: the Cloud window is served by the home's partition and must never
//        be able to pair, unpair or open another home.
//   cloud-home:reachable                                         cloud-only    the Cloud window's "is my home answering".
//   cloud-home:disconnect-this                                   cloud-only    the Cloud window's Settings: disconnect THIS
//        computer from the home the window belongs to (main reads the sender's home; the window passes nothing), then
//        close the Cloud window and show the Connect panel in the local window.
//
// Nothing here returns a token, a key, a code or a signature. The control-plane account token is read in main and
// stays in main.
import { CloudHomeError } from "./cloud-home-client.mjs";
import { HOME_ID } from "./cloud-home-store.mjs";

const GENERIC = "Something went wrong. Try again.";
export const NOT_LIVE = "Cloud isn't available yet.";
/** The bot id shape the home's launcher accepts (server/cloud-home/engine-login.ts). */
const BOT_ID = /^[\w-]{1,64}$/;
const SIGN_IN = "Sign in to your Murage account first, then try again.";

/** What a person may read. CloudHomeError carries plain copy already; anything else is hidden behind a generic line. */
export function friendlyCloudHomeError(error) {
  return error instanceof CloudHomeError && error.message ? error.message : GENERIC;
}

/** An error whose message is already plain copy for a person. */
const plain = (message) => Object.assign(new Error(message), { plain: true });
const noArgs = (args) => { if (args.length) throw plain("Invalid request."); };
const homeIdArg = (args) => {
  if (args.length !== 1 || typeof args[0] !== "string" || !HOME_ID.test(args[0])) throw plain("Invalid request.");
  return args[0];
};

/**
 * @param {{ handle: Function }} gate createOwnedMainIpc result
 * @param {object} deps
 * @param {{ client: any, open: (homeId: string) => unknown, senderHomeId: (event: any) => string | null }} deps.cloudHome installCloudHome's controller
 * @param {() => (string | undefined | null)} deps.getCpToken the signed-in Murage account's bearer, read in main
 * @param {(homeId: string) => void} [deps.showConnect] close the Cloud window and show the Connect panel in the local window
 * @param {"staging" | "prod"} [deps.cpEnvironment] main passes the shared resolver's environment; "prod" when absent
 * @param {{ readText: () => string }} [deps.clipboard] Electron's clipboard, read in main for "Use copied link"
 */
export function registerCloudHomeIpc(rawGate, { cloudHome, getCpToken, cpEnvironment = "prod", showConnect, clipboard, active = () => cloudHome.active?.() !== false }) {
  const { client } = cloudHome;
  // Registered at every start as refusing stubs: while Cloud is not live every call that would start new work is refused
  // before any work runs. The one exception is `continuing`: a channel an ALREADY-OPEN Cloud window uses for the task it is
  // in the middle of (going not-live never closes that window, so it must keep working until the person closes it).
  const fromOpenCloudWindow = (event) => { try { return typeof cloudHome.senderHomeId === "function" && cloudHome.senderHomeId(event) !== null; } catch { return false; } };
  const gate = { handle: (channel, fn, { continuing = false } = {}) => rawGate.handle(channel, (event, ...args) => {
    if (!active() && !(continuing && fromOpenCloudWindow(event))) throw new Error(NOT_LIVE);
    return fn(event, ...args);
  }) };
  /** Back to the Connect panel: the Cloud window closes, the local window shows Connect. */
  const backToConnect = (homeId) => { if (typeof showConnect === "function") showConnect(homeId); else cloudHome.close?.(homeId); };
  const cpToken = () => {
    const token = getCpToken();
    if (typeof token !== "string" || !token) throw plain(SIGN_IN);
    return token;
  };
  const guard = async (work) => { try { return await work(); } catch (error) { throw new Error(error?.plain ? error.message : friendlyCloudHomeError(error)); } };

  gate.handle("cloud-home:state", (_event, ...args) => guard(async () => {
    noArgs(args);
    return { enabled: true, cpSignedIn: Boolean(getCpToken()), paired: await client.pairedHomes() };
  }));

  gate.handle("cloud-home:list-homes", (_event, ...args) => guard(async () => {
    noArgs(args);
    const [homes, paired] = await Promise.all([client.listHomes({ cpToken: cpToken(), cpEnvironment }), client.pairedHomes()]);
    const pairedIds = new Set(paired.map((home) => home.homeId));
    return homes.filter((home) => HOME_ID.test(String(home?.id))).map((home) => ({
      id: home.id, name: typeof home.name === "string" ? home.name : "Cloud home", status: String(home.status ?? ""),
      reachable: typeof home.publicOrigin === "string", paired: pairedIds.has(home.id),
    }));
  }));

  gate.handle("cloud-home:connect-start", (_event, ...args) => guard(async () => {
    noArgs(args);
    return client.startConnect({ cpEnvironment });
  }));

  gate.handle("cloud-home:connect-cancel", (_event, ...args) => guard(async () => {
    noArgs(args);
    return client.cancelConnect();
  }));

  gate.handle("cloud-home:connect-paste", (_event, ...args) => guard(async () => {
    noArgs(args); // the window never hands main a link: main reads the clipboard itself
    let text = "";
    try { text = typeof clipboard?.readText === "function" ? String(clipboard.readText() ?? "") : ""; } catch { text = ""; }
    const result = await client.pasteDoorLink(text);
    text = "";
    if (result?.ignored) throw plain("Press Connect first, then use the copied link.");
    return { homeId: result.homeId };
  }));

  gate.handle("cloud-home:connect-status", (_event, ...args) => guard(async () => {
    noArgs(args);
    return client.connectStatus({ cpEnvironment });
  }));

  gate.handle("cloud-home:disconnect", (_event, ...args) => guard(async () => {
    const homeId = homeIdArg(args);
    await client.disconnect(homeId);
    client.deactivate?.(homeId);
    cloudHome.close?.(homeId);
    return { disconnected: true };
  }));

  gate.handle("cloud-home:open", (_event, ...args) => guard(async () => {
    const homeId = homeIdArg(args);
    await client.activate(homeId); // pin + version + token; refuses on a mismatch with plain copy
    cloudHome.open(homeId);
    return { opened: true };
  }));

  gate.handle("cloud-home:list-bots", (_event, ...args) => guard(async () => {
    const homeId = homeIdArg(args);
    // No transcript: `messages=0` pages nothing in, and only each bot's id and name leave main.
    const response = await client.fetch(homeId, "/api/bots?messages=0");
    if (response.status !== 200) throw plain(GENERIC);
    let body;
    try { body = await response.json(); } catch { throw plain(GENERIC); }
    const bots = Array.isArray(body?.bots) ? body.bots : [];
    return bots.filter((bot) => typeof bot?.id === "string" && BOT_ID.test(bot.id))
      .map((bot) => ({ id: bot.id, name: typeof bot.name === "string" && bot.name.trim() ? bot.name.slice(0, 120) : bot.id }));
  }));

  gate.handle("cloud-home:reachable", (event, ...args) => guard(async () => {
    noArgs(args);
    const homeId = cloudHome.senderHomeId(event);
    if (!homeId) throw plain(GENERIC);
    let result = await client.status(homeId);
    if (!result.ok && result.code === "needs-repair" && typeof client.resume === "function") {
      // The home no longer knows this computer: resume() tells a revoked computer (403: forgotten) from a passing failure.
      const resumed = await client.resume(homeId);
      if (resumed.disconnected) { backToConnect(homeId); result = { ok: false, code: "disconnected", message: resumed.message }; }
      // Not removed: a paused account or a passing refusal. The record stays; say what is happening instead of "pair it again".
      else if (resumed.ok) result = { ok: true };
      else result = { ok: false, code: resumed.code, message: resumed.message };
    }
    return result.ok ? { ok: true } : { ok: false, code: String(result.code), message: String(result.message) };
  }), { continuing: true });

  gate.handle("cloud-home:disconnect-this", (event, ...args) => guard(async () => {
    noArgs(args);
    const homeId = cloudHome.senderHomeId(event);
    if (!homeId) throw plain(GENERIC);
    await client.disconnect(homeId); // revokes this device at the home (native confirm), then forgets the record
    client.deactivate?.(homeId);
    // The answer goes back to the window first; then it closes and the local window shows the Connect panel.
    setTimeout(() => backToConnect(homeId), 0);
    return { disconnected: true };
  }));
}
