// SPDX-License-Identifier: AGPL-3.0-or-later
import { requireFact } from './surface.ts';

// A routine's prose never creates a host target. Use a genuine engine
// permission request; no computer tool is executed by this replay.
export function hostDenyRequest(){return {tool_name:'mcp__murage_host_computer__click',input:{x:1,y:1},tool_use_id:`field-deny-${Date.now()}`};}
export function assertHostDenyRequest(request:ReturnType<typeof hostDenyRequest>){
 requireFact(/host.computer/i.test(request.tool_name),'R8 deny control must request an actual host-computer target',request);
}
