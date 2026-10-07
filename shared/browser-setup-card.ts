// SPDX-License-Identifier: AGPL-3.0-or-later
export type BrowserSetupCardData = {
  requestKey: string; botId: string; threadId: string; ownerMessageId: string;
  decision?: "accepted" | "declined";
  profileId?: string;
  /** The browser this bot was connected in before, when the card skips the offer. */
  browser?: "chrome" | "edge" | "brave";
  /** Pre-accepted from a connection the owner made before: Not now stays available. */
  remembered?: true;
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
