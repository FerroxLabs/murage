// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Duplex } from 'node:stream';
export function resolveWindowsBrowserHelper(options?: {resources?:string;arch?:string;exists?:(path:string)=>boolean}): string;
/** Errors carry code (windows_browser_helper_missing | windows_browser_private_storage_unavailable) and helperPath when the helper is at fault. */
export function createPrivateWindowsDirectory(path:string,options?:{helper?:string}):void;
export function readPrivateWindowsJson(path:string):unknown;
export function writePrivateWindowsJson(path:string,value:unknown):void;
export function writePrivateWindowsData(path:string,value:Buffer|string):void;
export function createWindowsBrowserLauncher(options:{launcherPath:string;electronPath:string;hostScriptPath:string;configPath:string}):void;
export function windowsRegistrationAdapter(browser:string):{validate:(registry:{key:string;value:string},manifest:{name:string})=>string;installIfAbsentOrEqual:(registry:{key:string;value:string},manifest:{name:string})=>unknown;removeIfEqual:(registry:{key:string;value:string},manifest:{name:string})=>unknown};
export function createWindowsBrowserServer(pipePath:string,onConnection:(socket:Duplex)=>void):{ready:Promise<void>;close:()=>Promise<void>};
export class WindowsMuxDecoder {constructor(receive:(kind:number,id:number,data:Buffer)=>void);push(chunk:Buffer):void;}
