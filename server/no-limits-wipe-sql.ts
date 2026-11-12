// SPDX-License-Identifier: AGPL-3.0-or-later
/** Read SQL statements, not matching words inside comments or string values.
 * Quoted identifiers are retained; single/dollar quoted values are opaque data. */
export function sqlWipe(sql:string):boolean {
 let text='';
 for(let at=0;at<sql.length;){
  if(sql.startsWith('--',at)){const end=sql.indexOf('\n',at+2);at=end<0?sql.length:end;text+=' ';continue;}
  if(sql.startsWith('/*',at)){let depth=1;at+=2;while(at<sql.length&&depth){if(sql.startsWith('/*',at)){depth++;at+=2;}else if(sql.startsWith('*/',at)){depth--;at+=2;}else at++;}text+=' ';continue;}
  const dollar=/^\$(?:[A-Za-z_][\w]*)?\$/.exec(sql.slice(at))?.[0];
  if(dollar){const end=sql.indexOf(dollar,at+dollar.length);at=end<0?sql.length:end+dollar.length;text+=' value ';continue;}
  if(sql[at]==="'"){at++;while(at<sql.length){if(sql[at]==='\\'){at+=2;continue;}if(sql[at++]==="'"){if(sql[at]==="'"){at++;continue;}break;}}text+=' value ';continue;}
  // A semicolon in a quoted identifier is not a statement boundary either.
  if(['"','`','['].includes(sql[at]!)){const close=sql[at]==='['?']':sql[at]!;at++;while(at<sql.length){if(sql[at++]===close){if(sql[at]===close){at++;continue;}break;}}text+=' identifier ';continue;}
  text+=sql[at++];
 }
 return text.split(';').some(statement=>/^\s*(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)\b|TRUNCATE\s+(?:TABLE\s+)?[\w]|DELETE\s+FROM\s+[\w.]+\s*$)/i.test(statement));
}
