// Offline stdin-only checker. Never echo inputs or exception details.
import { readFileSync } from 'node:fs';
import { redactSecretsForCard, redactSecretsInText } from '../../server/redact.ts';
import { isDeepStrictEqual } from 'node:util';
try {
 const rows=JSON.parse(readFileSync(0,'utf8'));
 for(const row of rows) {
  if(!isDeepStrictEqual(redactSecretsForCard(row),row))throw Error();
  const text=row.boundedToolInput;
  if(text!==null) {
   if(redactSecretsInText(text)!==text)throw Error();
   let parsed:unknown;
   try { parsed=JSON.parse(text); } catch(e) {
    // A whole-input cap cuts JSON. Only the exact cap marker is accepted.
    if(!row.toolInputTruncated || !/\n\[truncated, \d+ bytes more\]$/.test(text))throw Error();
    // Independently recheck every complete string member in a cut object.
    // JSON escapes are decoded before the structural secret-name check.
    const scalar=/"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    for(const m of text.matchAll(scalar)) {
     const key=JSON.parse('"'+m[1]+'"'),value=JSON.parse('"'+m[2]+'"');
     const member={[key]:value};
     if(!isDeepStrictEqual(redactSecretsForCard(member),member))throw Error();
    }
    // An incomplete secret-valued member cannot pass a structural recheck.
    const tail=/"((?:[^"\\]|\\.)*)"\s*:\s*"(?:[^"\\]|\\.)*$/.exec(text.slice(0,text.lastIndexOf('\n[truncated,')));
    if(tail) {
     const key=JSON.parse('"'+tail[1]+'"');
     const probe={[key]:'fixture-redaction-probe'};
     if(!isDeepStrictEqual(redactSecretsForCard(probe),probe))throw Error();
    }
   }
   if(parsed!==undefined && !isDeepStrictEqual(redactSecretsForCard(parsed),parsed))throw Error();
  }
 }
 process.stdout.write('{"pass":true}\n');
} catch { process.stdout.write('{"pass":false}\n'); process.exitCode=3; }
