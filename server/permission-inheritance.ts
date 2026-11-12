// SPDX-License-Identifier: AGPL-3.0-or-later
// Sean ruling 2026-11-12 02:05Z. Resolve the owner's default at decision time.
export interface PermissionSetting {
 autoApprove?:boolean;fullAccess?:boolean;noLimits?:boolean;
 permissionExplicit?:boolean;permissionRev?:number;draftOnly?:boolean;
}
let ownerNoLimits:()=>boolean=()=>false;
export function installPermissionInheritance(read:()=>boolean):()=>void {
 const previous=ownerNoLimits;ownerNoLimits=read;
 return ()=>{ownerNoLimits=previous;};
}
/** Legacy Ask/Auto were defaults and have no reliable provenance. A revision
 * records an owner level edit; legacy Full access/No limits were affirmative choices. */
export function explicitPermission(value:PermissionSetting):boolean {
 return value.permissionExplicit??((value.permissionRev??0)>0 || value.fullAccess===true);
}
export function inheritedPermissions<T extends PermissionSetting>(value:T):T {
 if(value.draftOnly || !ownerNoLimits() || explicitPermission(value))return value;
 return {...value,permissionExplicit:false,autoApprove:true,fullAccess:true,noLimits:true};
}
export function routineFollowsNoLimits(value:{permissionMode?:string;permissionExplicit?:boolean}):boolean {
 return value.permissionExplicit===false || value.permissionExplicit!==true && value.permissionMode===undefined;
}

/** Non-owner threads never inherit. Only a recorded new No limits bot choice applies.
 * Mark the projection explicit so it cannot inherit again. */
export function explicitNoLimits(value:PermissionSetting):boolean {
 return !value.draftOnly && value.autoApprove===true && value.fullAccess===true && value.noLimits===true && value.permissionExplicit===true;
}
export function permissionsForOrigin<T extends PermissionSetting>(value:T, ownerOrigin:boolean):T {
 if(ownerOrigin)return inheritedPermissions(value);
 if(explicitNoLimits(value))return value;
 return {...value,permissionExplicit:true,autoApprove:false,fullAccess:false,noLimits:false};
}
