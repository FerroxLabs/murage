import {readFileSync,lstatSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {executableTarget} from "./prepare-cloudflared.mjs";
export function validateNotificationAuthorizationResource(resources,arch){
 if(!["arm64","x64"].includes(arch))throw Error("NOTIFICATION_AUTH_TARGET_REQUIRED");
 const file=path.join(resources,"notification-authorization.node"),receiptFile=path.join(resources,"notification-authorization-build.json");
 for(const item of [file,receiptFile]){const s=lstatSync(item);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>4*1024*1024)throw Error("NOTIFICATION_AUTH_RESOURCE_INVALID");}
 const bytes=readFileSync(file),receipt=JSON.parse(readFileSync(receiptFile,"utf8"));
 if(receipt.target!=="darwin-"+arch||receipt.napiVersion!==9||executableTarget(bytes)!==receipt.target||receipt.sha256!==createHash("sha256").update(bytes).digest("hex"))throw Error("NOTIFICATION_AUTH_RESOURCE_MISMATCH");
 return receipt;
}
