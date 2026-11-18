// The required fake-native HTTP/SSE replay must cover the entire ruling table.
export function trulyLiveVerdict(report, code, expectedRows) {
 if(code!==0 || report?.verdict!=='PASS' || !Array.isArray(report.rows) || !Array.isArray(expectedRows) || expectedRows.length===0 || report.rows.length!==expectedRows.length)return 'FAIL';
 const seen=new Set();
 for(const expected of expectedRows){
  const rows=report.rows.filter(row=>row.id===expected.id);
  if(rows.length!==1 || seen.has(expected.id))return 'FAIL';
  seen.add(expected.id);const row=rows[0];
  if(row.expected!==expected.expected || row.expectedCards!==expected.expectedCards || row.cards!==expected.expectedCards || row.complete!==true || row.ended!==true || !Array.isArray(row.errors) || row.errors.length)return 'FAIL';
  if(expected.expected==='OFF_WITH_LINE'&&(typeof row.offLine!=='string'||!/channel messages.*off.*settings/i.test(row.offLine)||row.offLine.includes('\n')))return 'FAIL';
  if(expected.expected==='OFF_WITH_LINE'){if(!Array.isArray(row.resolutions)||row.resolutions.length!==0)return 'FAIL';continue;}
  if(!Array.isArray(row.resolutions) || !row.resolutions.length || !row.resolutions.every(item=>item.behavior===(expected.expected==='RUN'?'allow':'deny')))return 'FAIL';
 }
 return 'PASS';
}
