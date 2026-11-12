import { SessionGate } from './browser-session-gate.ts';
/** Stored with the selection by BrowserModeStorage. A failed close keeps the
 * reservation in releasing state, so no other bot can attach during cleanup. */
export type DirectReservation = { botId: string; revision: number; state: 'held' | 'releasing' };
/** Lock order: bot lifecycle, this mutex, sorted session keys. */
export const directBrowserMutex = new SessionGate();
