// SPDX-License-Identifier: AGPL-3.0-or-later
export type OwnerBrowserRegistration = { ownerConfirmed:boolean; browser:'chrome'|'edge'|'brave'|'chromium'; platform?:string; registrationHome:string; configPath:string; resourcesPath:string; electronPath:string;
  /** Mac/Linux: private folder for the owned launcher and receipt that survives a restart. Defaults to the config's folder. */
  registrationDirectory?:string;
  /** Linux: the AppImage file Murage runs from; Chrome then starts the helper through it. */
  appImage?:string };
export class BrowserRegistrationError extends Error {code:string;constructor(code:string,message:string);}
export function connectOwnerBrowser(options:OwnerBrowserRegistration):Promise<{status:'installed';browser:string;registrationFamily:string;sharedBrowsers:string[];manifestPath:string;receiptPath:string;connected:false}>;
export function removeOwnerBrowser(options:OwnerBrowserRegistration):Promise<{status:'not_registered'|'removed';registrationFamily:string;sharedBrowsers:string[]}>;
