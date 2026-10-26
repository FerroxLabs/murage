// The create-bot flow on a Cloud home announces each bot it just made, so the "Sign <bot> in to <engine>" step can follow it.
// Plain pub/sub: the store announces, the step listens. Nothing but a bot id and name travels.
export interface NewBotAnnouncement { id: string; name: string }
type Listener = (bot: NewBotAnnouncement) => void;
const listeners = new Set<Listener>();
export function announceNewBot(bot: NewBotAnnouncement): void { for (const listener of [...listeners]) listener(bot); }
export function onNewBot(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
