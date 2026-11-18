// SPDX-License-Identifier: AGPL-3.0-or-later
export type BrowserSetupCardData = {
  browserChoice?: {mode:'builtin'|'chrome-extension'|'chrome-direct';profile?:string;browser?:'chrome'|'edge'|'brave';baseRevision:number;disclosureKey:string;lines:string[];copy?:import('./browser-copy.ts').BrowserCopy[]};
  selectionRevision?:number;
  selectedMode?:'builtin'|'chrome-extension'|'chrome-direct';
  requestKey: string; botId: string; threadId: string; ownerMessageId: string;
  decision?: "accepted" | "declined";
  profileId?: string;
  /** The browser this bot was connected in before, when the card skips the offer. */
  browser?: "chrome" | "edge" | "brave";
  /** Pre-accepted from a connection the owner made before: Not now stays available. */
  remembered?: true;
  queuedAcceptance?: boolean;
  continueRequested?: boolean;
  resumed?: boolean;
  error?: string;
};
export function readBrowserSetupCard(card: unknown): BrowserSetupCardData | null {
  if (!card || typeof card !== "object") return null;
  const value = (card as { browserSetup?: BrowserSetupCardData }).browserSetup;
  if (!value || [value.requestKey,value.botId,value.threadId,value.ownerMessageId].some(item=>typeof item!=="string"||!item||item.length>128) || (value.decision!==undefined&&!['accepted','declined'].includes(value.decision)) || (value.browser!==undefined&&!['chrome','edge','brave'].includes(value.browser))) return null;
  return value;
}
