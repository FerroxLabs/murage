import { randomBytes } from "node:crypto";
// Approval-only native presentation. OS sound settings and DND remain authoritative.
export const APPROVAL_SOUND = "murage-approval.wav";
const fields = new Set(["botId", "threadId", "requestId", "messageId", "requestTurnId", "title", "body"]);
const identity = value => typeof value === "string" && value.length > 0 && value.length <= 512 && /^[\w.:-]+$/.test(value);
export function approvalPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))) return null;
  if (![value.botId, value.threadId, value.requestId, value.messageId].every(identity)) return null;
  if (value.requestTurnId !== undefined && !identity(value.requestTurnId)) return null;
  if (typeof value.title !== "string" || value.title.length > 300 || typeof value.body !== "string" || value.body.length > 1000) return null;
  return { ...value };
}
const xml = value => value.replace(/[<>&"']/g, char => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;", "'":"&apos;" })[char]);
const activationPrefix = "murage-approval:";
const activationToken = value => typeof value === "string" && /^murage-approval:[a-f0-9]{32}$/.test(value);
export function approvalOptions(payload, platform, launch) {
  if (platform === "darwin") return { title: payload.title, body: payload.body, sound: APPROVAL_SOUND, silent: false };
  if (platform === "win32" && launch !== undefined && !activationToken(launch)) return null;
  if (platform === "win32") return {
    toastXml: `<toast${launch ? ` launch="${xml(launch)}"` : ""}><visual><binding template="ToastGeneric"><text>${xml(payload.title)}</text><text>${xml(payload.body)}</text></binding></visual><audio src="ms-winsoundevent:Notification.Reminder" loop="false"/></toast>`,
  };
  return null;
}

/** Bounded identities survive renderer remounts for this desktop launch.
 * Oldest of 1024 identities is evicted; SSE replay suppression is independent. */
export function createApprovalNotifications({ Notification, platform, onOpen, authorize, revalidate, limit = 1024 }) {
  const seen = new Set();
  const active = new Map(), pending = new Set();
  const routes = new Map(), routeKeys = new Map();
  const capacity = platform === "win32" ? (Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1024) : 1024) : limit;
  let activationRegistered = false;
  const forgetRoute = (key, expectedToken) => { const token = routeKeys.get(key); if (expectedToken !== undefined && token !== expectedToken) return; if (token) routes.delete(token); routeKeys.delete(key); };
  const registerActivation = () => {
    if (platform !== "win32" || activationRegistered) return;
    Notification.handleActivation(details => {
      if (stopped || details?.type !== "click" || !activationToken(details.arguments)) return;
      routes.get(details.arguments)?.();
    });
    activationRegistered = true;
  };
  let stopped=false,generation=0;
  const show = input => {
    const payload = approvalPayload(input);
    if (!payload||stopped) return { accepted: false };
    const options = approvalOptions(payload, platform);
    if (!options) return { accepted: false };
    const key = JSON.stringify([payload.botId, payload.threadId, payload.requestTurnId ?? "", payload.requestId]);
    if (seen.has(key)||pending.has(key)||pending.size>=capacity) return { accepted: false };
    seen.add(key);
    if (seen.size > capacity) { const oldest=seen.values().next().value; seen.delete(oldest); forgetRoute(oldest); }
    const present = current => {
    if(stopped||!Notification.isSupported())return {accepted:false};
    try {
      registerActivation();
      const token = platform === "win32" ? activationPrefix + randomBytes(16).toString("hex") : undefined;
      const notice = new Notification(approvalOptions(current,platform,token));
      active.set(key, notice);
      let opened = false;
      const openOnce = () => {
        if (opened || stopped || (token && !routes.has(token))) return;
        opened = true;
        if (token) forgetRoute(key);
        try { onOpen({ botId: payload.botId, threadId: payload.threadId }); } catch { /* Navigation failure never changes authority. */ }
      };
      if (token) { routes.set(token, openOnce); routeKeys.set(key, token); }
      notice.on("click", openOnce);
      const release = () => { if (active.get(key) === notice) active.delete(key); };
      notice.on("close", release);
      notice.on("failed", () => { release(); forgetRoute(key, token); });
      // Keep native callbacks bounded even when an OS omits close events.
      if (active.size > capacity) {
        const oldest = active.keys().next().value;
        const retired = active.get(oldest);
        active.delete(oldest);
        forgetRoute(oldest);
        retired?.removeAllListeners();
      }
      notice.show();
      return { accepted: true };
    } catch {
      active.delete(key); forgetRoute(key);
      return { accepted: false };
    }
    };
    if(platform!=="darwin")return present(payload);
    if(typeof authorize!=="function"||typeof revalidate!=="function")return{accepted:false};
    pending.add(key);const epoch=generation;
    return Promise.resolve().then(authorize).then(async granted=>{
      if(granted!==true||stopped||generation!==epoch)return{accepted:false};
      const current=approvalPayload(await revalidate(payload));
      if(!current||stopped||generation!==epoch||["botId","threadId","requestId","messageId","requestTurnId"].some(field=>current[field]!==payload[field]))return{accepted:false};
      if(await authorize(false)!==true||stopped||generation!==epoch)return{accepted:false};
      return present(current);
    }).catch(()=>({accepted:false})).finally(()=>pending.delete(key));
  };
  show.dispose=()=>{stopped=true;generation++;pending.clear();routes.clear();routeKeys.clear();for(const notice of active.values())notice.removeAllListeners();active.clear();};
  return show;
}
