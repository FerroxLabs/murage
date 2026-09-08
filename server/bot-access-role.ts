import { createHash } from "node:crypto";
import { connectedAppAccessSchema, type ConnectedAppAccess } from "../shared/bot-access.ts";
export interface AccessRole { id: string; accessRoleEpoch?: number; section?: string; chiefOfStaff?: boolean; chiefScope?: string; individual?: boolean; hidden?: boolean; title?: string; description?: string; composio?: boolean; modelSelection?: unknown; connectedAppAccess?: ConnectedAppAccess }
export function accessRoleBinding(bot: AccessRole): string {
  return createHash("sha256").update(JSON.stringify([bot.id,bot.section??"",!!bot.chiefOfStaff,bot.chiefScope??"",!!bot.individual,!!bot.hidden,bot.title??"",bot.description??"",bot.composio!==false,bot.modelSelection,bot.accessRoleEpoch??0])).digest("hex");
}
export function botAccessPolicy(bot: AccessRole): ConnectedAppAccess {
  const binding=accessRoleBinding(bot);
  if (bot.connectedAppAccess === undefined) return { revision:0,roleBinding:binding,mode:"unrestricted",allowWrites:true,grants:[],requests:[] };
  const parsed=connectedAppAccessSchema.safeParse(bot.connectedAppAccess);
  if (!parsed.success) return { revision:0,roleBinding:binding,mode:"restricted",allowWrites:false,grants:[],requests:[] };
  if (parsed.data.roleBinding !== binding) return { revision:parsed.data.revision+1,roleBinding:binding,mode:"restricted",allowWrites:false,grants:[],requests:[] };
  return parsed.data;
}
