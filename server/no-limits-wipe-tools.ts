// SPDX-License-Identifier: AGPL-3.0-or-later
import { dispatchedCall, normalizedCallRows } from '../shared/connected-app-calls.ts';

/** Only irreversible bulk deletes or destruction of an entire data container.
 * Ordinary message, product and file deletes deliberately stay outside this list. */
const CONNECTOR_WIPE = /(?:^|_)(?:EMPTY_TRASH|(?:BATCH|BULK)_(?:PERMANENTLY_)?(?:DELETE|DESTROY|PURGE|REMOVE)|(?:DELETE|DESTROY|PURGE|REMOVE)_ALL)(?:_|$)|(?:^|_)(?:DELETE|DROP|TRUNCATE|DESTROY|PURGE|EMPTY)_(?:DRIVE|SHARED_DRIVE|CALENDAR|BASE|DATABASE|TABLE|SHEET|SPREADSHEET|REPO|REPOSITORY|PROJECT|WORKSPACE|ORG|ORGANIZATION|ACCOUNT|STORE|SHOP|SITE|BUCKET|MAILBOX)(?:_|$)/;
const READ_ACTION=/(?:^|_)(?:GET|LIST|FETCH|SEARCH|DESCRIBE|PREVIEW|CHECK|COUNT|VALIDATE)(?:_|$)/;
const operational=(tool:string,pattern:RegExp)=>{const match=pattern.exec(tool);return !!match&&!READ_ACTION.test(tool.slice(0,match.index));};
export function connectorWipes(tool:string,input:unknown):{path:string;op:'delete'}[] {
 // Unlike connectedAppRequirements, keep repeated slugs: 25 single-file
 // deletes in one call are bulk destruction even when all use the same tool.
 const dispatched=dispatchedCall(tool,input);
 if(dispatched.target!=='COMPOSIO_MULTI_EXECUTE_TOOL'&&!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(tool)&&!/connected.?app|bot.?access/i.test(tool))return [];
 const {rows}=normalizedCallRows(tool,input);
 const wipes=rows.filter(row=>operational(row.tool,CONNECTOR_WIPE)).map(row=>({path:`connector:${row.tool}`,op:'delete' as const}));
 if(rows.filter(row=>operational(row.tool,/(?:^|_)(?:DELETE|TRASH)(?:_|$)/)).length>20)wipes.push({path:'connector:bulk-delete',op:'delete'});
 return wipes;
}
