// SPDX-License-Identifier: AGPL-3.0-or-later
const WIPE_SUBSTRINGS=['drop','truncate','delete','flushall','flushdb','dropdatabase','deletemany','remove('];
/** Scan original text in every mode. Comments, quotes and identifier boundaries
 * cannot hide a finding; no dialect interpretation precedes this scan. */
export function rawDatabaseWipe(text:string):boolean {
 const raw=text.toLowerCase();
 return WIPE_SUBSTRINGS.some(part=>raw.includes(part));
}

export function sqlWipe(sql:string,failClosed=false):boolean {
 // All callers, including the MCP prefilter, scan before any early return.
 if(rawDatabaseWipe(sql))return true; // R4-NO-DELETE-EXCEPTION
 if(failClosed&&(sql.includes('\\')||/\b(?:EXEC|EXECUTE|PREPARE|DO)\b/i.test(sql)))return true;
 if(/^\s*EXPLAIN\b/i.test(sql)&&/\b(?:ANALYZE|ANALYSE)\b/i.test(sql))return true;
 return failClosed&&sql.split(';').some(statement=>statement.trim()&&!/^\s*[-+]/.test(statement)&&!/^\s*(?:SELECT|INSERT|UPDATE|ALTER|CREATE|PRAGMA|EXPLAIN|SHOW|DESCRIBE|USE|BEGIN|COMMIT|ROLLBACK|SET|GRANT|REVOKE|VACUUM|ANALYZE)\b/i.test(statement));
}

/** Connector envelopes and unknown tools may carry SQL at any depth. Only
 * executable SQL fields are statements; descriptions and ordinary values stay data. */
export function sqlInputWipe(input:unknown,tool:string):boolean {
 const pending:Array<{value:unknown;sql:boolean}>=[{value:input,sql:/(?:sql|query|migration)/i.test(tool)}],seen=new Set<object>();
 for(let at=0;at<pending.length;at++){
  const {value,sql}=pending[at]!;
  if(typeof value==='string'){if(sql&&sqlWipe(value))return true;continue;}
  if(!value||typeof value!=='object'||seen.has(value))continue;
  seen.add(value);
  for(const [key,child]of Object.entries(value))pending.push({value:child,sql:Array.isArray(value)?sql:/^(?:query|sql|statement|statements|migration)$/i.test(key)});
 }
 return false;

}
