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
export function approvalOptions(payload, platform) {
  if (platform === "darwin") return { title: payload.title, body: payload.body, sound: APPROVAL_SOUND, silent: false };
  if (platform === "win32") return {
    toastXml: `<toast><visual><binding template="ToastGeneric"><text>${xml(payload.title)}</text><text>${xml(payload.body)}</text></binding></visual><audio src="ms-winsoundevent:Notification.Reminder" loop="false"/></toast>`,
  };
  return null;
}

/** Bounded identities survive renderer remounts for this desktop launch.
 * Oldest of 1024 identities is evicted; SSE replay suppression is independent. */
export function createApprovalNotifications({ Notification, platform, onOpen, authorize, revalidate, limit = 1024 }) {
  const seen = new Set();
  const active = new Map(), pending = new Set();
  let stopped=false,generation=0;
  const show = input => {
    const payload = approvalPayload(input);
    if (!payload||stopped) return { accepted: false };
    const options = approvalOptions(payload, platform);
    if (!options) return { accepted: false };
    const key = JSON.stringify([payload.botId, payload.threadId, payload.requestTurnId ?? "", payload.requestId]);
    if (seen.has(key)||pending.has(key)||pending.size>=limit) return { accepted: false };
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value);
    const present = current => {
    if(stopped||!Notification.isSupported())return {accepted:false};
    try {
      const notice = new Notification(approvalOptions(current,platform));
      active.set(key, notice);
      let opened = false;
      notice.on("click", () => {
        if (opened) return;
        opened = true;
        try { onOpen({ botId: payload.botId, threadId: payload.threadId }); } catch { /* Navigation failure never changes authority. */ }
      });
      const release = () => active.delete(key);
      notice.on("close", release);
      notice.on("failed", release);
      // Keep native callbacks bounded even when an OS omits close events.
      if (active.size > limit) {
        const oldest = active.keys().next().value;
        const retired = active.get(oldest);
        active.delete(oldest);
        retired?.removeAllListeners();
      }
      notice.show();
      return { accepted: true };
    } catch {
      active.delete(key);
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
  show.dispose=()=>{stopped=true;generation++;pending.clear();for(const notice of active.values())notice.removeAllListeners();active.clear();};
  return show;
}
