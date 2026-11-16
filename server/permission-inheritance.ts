// SPDX-License-Identifier: AGPL-3.0-or-later
// Sean ruling 2026-11-12 02:05Z. Resolve the owner's default at decision time.
export interface PermissionSetting {
 autoApprove?:boolean;fullAccess?:boolean;noLimits?:boolean;
 permissionExplicit?:boolean;permissionRev?:number;draftOnly?:boolean;
}
let ownerDefault:()=>boolean|PermissionSetting=()=>false;
export function installPermissionInheritance(read:()=>boolean|PermissionSetting):()=>void {
 const previous=ownerDefault;ownerDefault=read;
 return ()=>{ownerDefault=previous;};
}
/** Legacy Ask/Auto were defaults and have no reliable provenance. A revision
 * records an owner level edit; legacy Full access alone has no stored level choice. */
export function explicitPermission(value:PermissionSetting):boolean {
 return value.permissionExplicit??((value.permissionRev??0)>0);
}
export function inheritedPermissions<T extends PermissionSetting>(value:T):T {
 if(value.draftOnly || explicitPermission(value))return value;
 const setting=ownerDefault();if(setting===false)return value;
 // Only the 1.0.19 No limits default is inherited. Lower owner levels
 // preserve each bot's stored 1.0.18 fallback, including Ask/Auto/Full.
 if(setting!==true && !(setting.autoApprove===true && setting.fullAccess===true && setting.noLimits===true)){
  if(value.noLimits!==true)return value;
  // A copied 1.0.19 No limits default has no lower stored fallback yet.
  return {...value,permissionExplicit:false,autoApprove:setting.autoApprove===true,fullAccess:setting.fullAccess===true,noLimits:false};
 }
 return {...value,permissionExplicit:false,autoApprove:true,fullAccess:true,noLimits:true};
}
export function routineFollowsNoLimits(value:{permissionMode?:string;permissionExplicit?:boolean}):boolean {
 return value.permissionExplicit===false || value.permissionExplicit!==true && value.permissionMode===undefined;
}

/** A recorded owner selection; it never authorizes a guest thread. */
export function explicitNoLimits(value:PermissionSetting):boolean {
 return !value.draftOnly && value.autoApprove===true && value.fullAccess===true && value.noLimits===true && value.permissionExplicit===true;
}
export function permissionsForOrigin<T extends PermissionSetting>(value:T, ownerOrigin:boolean):T {
 if(ownerOrigin)return inheritedPermissions(value);
 return {...value,permissionExplicit:true,autoApprove:false,fullAccess:false,noLimits:false};
}
