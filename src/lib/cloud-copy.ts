// SPDX-License-Identifier: AGPL-3.0-or-later
/** Copy for the later paired Cloud client flows. */
export const cloudCopy = {
  pairedDeviceRequired: "Open this on a device you've paired with your Cloud.",
  phoneCredential: "Finish this on your computer.",
  claudeFluxOnHome: "On your Cloud, Claude models on Flux run through Fuigo.",
  /** The Cloud window's banner (B3 WP4). Plain: what is wrong, and what happens to changes. */
  homeUnreachable: "Your Cloud home isn't reachable",
  homeUnreachableDetail: "Changes you make now are not saved, and nothing is kept to send later. Try again when it's back.",
  switchComputer: "This computer",
  switchCloudHome: "Cloud home",
  pairTitle: "Connect to your Cloud home",
  pairSignIn: "Sign in to your Murage account on this computer first, then come back here.",
  pairNoHomes: "You don't have a Cloud home yet.",
  pairOpen: "Open",
  pairPaired: "Connected",
  pairHomeNotReady: "Not ready yet",
  /** Door v2: Connect from the browser. */
  connectButton: "Connect to your Cloud home",
  connectPending: "Finish in your browser. This window carries on by itself.",
  connectCountdown: "Time left",
  connectCancel: "Cancel",
  connectAgain: "Connect again",
  connectOpen: "Open",
  connectDisconnect: "Disconnect this computer",
  connectBrowserNote: "Sign in on the Murage page that opens, then press the button there.",
  /** This build cannot verify a Cloud home yet (no pinned control-plane key): the panel says so instead of offering Connect. */
  cloudNotOpen: "Murage Cloud is not open yet. Connect will be here as soon as it is.",
  linkExpired: "This link has expired. Press Connect again.",
  notConnectLink: "That is not a Murage connect link.",
  reconnecting: "Reconnecting to your Cloud home",
  holdRequired: "Start adding this computer on My Cloud. It can connect after the 72-hour check.",
  computerConnected: "This home already has a computer connected. Use Murage on that computer, or open Murage in your browser.",
  disconnected: "This computer was disconnected from your Cloud home. Connect it again.",
  ownerCredentialCaveat: "Murage's code never reads your sign-in files. If the Murage server itself were compromised, it could reach them.",
  /** The Cloud home door: another tab of this home holds the browser's key store open. */
  doorTabOpen: "Another Murage tab for this home is open. Close it, then try again.",
  doorTryAgain: "Try again",
} as const;
