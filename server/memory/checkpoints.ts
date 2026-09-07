/** A checkpoint is a bounded index of evidence, not replacement factual authority. */
export function checkpointReferences(records: Array<{id:string;version:number;text:string}>, maximumBytes=1536) {
  const selected: Array<{id:string;version:number;text:string}>=[];let bytes=0;
  for(const record of records){const size=Buffer.byteLength(record.text);if(bytes+size>maximumBytes)continue;selected.push(record);bytes+=size;}
  return {records:selected,omitted:records.length-selected.length,bytes};
}
