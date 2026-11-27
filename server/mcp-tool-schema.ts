// Provider-safe MCP tool input schemas.
//
// Every engine hands an MCP tool's inputSchema to its model provider as the
// function's parameters. The strict providers (OpenAI and the OpenAI-
// compatible ones Flux routes to, xAI, Bedrock, Kimi…) require that root to
// be a plain `type: "object"` and refuse a root anyOf/oneOf/allOf/not
// outright, and a refused schema fails the whole turn, not just the one
// tool. cua-driver ships exactly that shape on browser_prepare (upstream
// #1390 hit it on 0.22.1), and the container driver pinned in
// container-computer.ts comes from the same line.
//
// The rewrite only relaxes what the model is TOLD. The MCP server still
// validates every call against its own schema; upstream cua-driver made the
// same move (trycua/cua#3311): a plain object root, with the conditional
// rules enforced in the tool itself. Nested schemas are left as written.
// Ported by content from upstream 5ef9a59e.
type JsonObject = Record<string, unknown>;

/** Kimi measures parameters after expanding local references. Bound the walk
 * as well as the encoded size, including Go JSON's HTML escaping. A cycle or
 * an unresolved reference cannot be proved to fit and is withheld. */
export function toolSchemaOverBudget(schema: unknown, limit: number): boolean {
  let bytes = 0, nodes = 0;
  const root = schema;
  const size = (value: unknown) => {
    const text = JSON.stringify(value) ?? "";
    return Buffer.byteLength(text) + 5 * (text.match(/[<>&]/g)?.length ?? 0) + 3 * (text.match(/[\u2028\u2029]/g)?.length ?? 0);
  };
  const walk = (value: unknown, refs: Set<string>, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 30 || bytes > limit) return true;
    if (value === null || typeof value !== "object") { bytes += size(value); return bytes > limit; }
    if (Array.isArray(value)) {
      bytes += 2 + Math.max(0, value.length - 1);
      return value.some(item => walk(item, refs, depth + 1)) || bytes > limit;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string") {
      const ref = object.$ref;
      if (!ref.startsWith("#/") || refs.has(ref)) return true;
      let target: unknown = root;
      for (const key of ref.slice(2).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) return true;
        target = (target as Record<string, unknown>)[key];
      }
      if (!target || typeof target !== "object" || Array.isArray(target)) return true;
      const { $ref: _, ...siblings } = object;
      return walk({ ...target, ...siblings }, new Set([...refs, ref]), depth + 1);
    }
    const entries = Object.entries(object);
    bytes += 2 + Math.max(0, entries.length - 1);
    for (const [key, child] of entries) {
      bytes += size(key) + 1;
      if (walk(child, refs, depth + 1)) return true;
    }
    return bytes > limit;
  };
  return walk(schema, new Set(), 0);
}

type StdioMount = { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

/** A separate guard for each mount. It runs from an inline program so source
 * and packaged servers use the same code without a new executable asset.
 * The engine still owns the whole child tree, including the original server. */
export function budgetMcpServers(servers: StdioMount[], limit: number): StdioMount[] {
  const source = `
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const overBudget = ${toolSchemaOverBudget.toString()};
const limit = ${JSON.stringify(limit)};
const child = spawn(process.argv[1], process.argv.slice(2), {stdio:['pipe','pipe','pipe'],windowsHide:true});
let blocked = false, closing = false, diagnosticBytes = 0, privateBlock = false;
const lists = new Map();
const key = id => typeof id + ':' + String(id);
const write = (stream, line) => new Promise((resolve,reject) => stream.write(line+'\\n', error => error ? reject(error) : resolve()));
// Frame stderr before masking: credentials may straddle child writes. Drop an
// overlong/incomplete line, and cap the total diagnostic output per mount.
const diagnostic = raw => {
 if(diagnosticBytes>=4096)return;
 let text=String(raw).replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g,' ');
 const keyStart=/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), keyEnd=/-----END [A-Z ]*PRIVATE KEY-----/.test(text);
 if(privateBlock && !keyStart) {if(keyEnd)privateBlock=false;return;}
 if(keyStart) {privateBlock=!keyEnd;text='[redacted private key]';}
 for(const value of [...Object.values(process.env),...process.argv.slice(1)].filter(value=>value && value.length>=4).sort((a,b)=>b.length-a.length)) text=text.split(value).join('[redacted]');
 text=text.replace(/(?:https?:\\/\\/)[^\\s]+/gi,'[redacted URL]').replace(/(?:(?:bearer|basic)\\s+|(?:token|password|passwd|secret|cookie|credential|api[_-]?key|authorization|access[_-]?key)\\s*[=:]\\s*).*/gi,'[redacted credential]');
 text=text.replace(/[A-Za-z0-9_+/=-]{24,}/g,'[redacted value]');
 const line=Buffer.from('MCP: '+text+'\\n');
 if(line.length>4096-diagnosticBytes)return;
 diagnosticBytes+=line.length;process.stderr.write(line);
};
const stop = () => { if(closing)return; closing=true; child.stdin.end(); child.kill(); };
const failed = error => { diagnostic(error?.code ? error.code+': '+error.message : error?.message??'stream failure');process.exitCode=1;stop();process.stdin.destroy(); };
async function pipe(source, handle) {
 source.setEncoding('utf8');
 let buffer='';
 for await (const chunk of source) {
  buffer += chunk;
  if(Buffer.byteLength(buffer)>8*1024*1024) throw Error('frame bound');
  let end;
  while((end=buffer.indexOf('\\n'))>=0) {const line=buffer.slice(0,end);buffer=buffer.slice(end+1);await handle(line);}
 }
 if(buffer.trim()) await handle(buffer);
}
const parse = line => {try{return JSON.parse(line)}catch{return null}};
let stderrLine='', stderrOverflow=false;
child.stderr.setEncoding('utf8');
child.stderr.on('data',chunk=>{
 for(const part of chunk.split(/(\\n)/)) {
  if(part==='\\n') {diagnostic(stderrOverflow?'child diagnostic line exceeded bound':stderrLine);stderrLine='';stderrOverflow=false;}
  else if(!stderrOverflow) {stderrLine+=part;if(Buffer.byteLength(stderrLine)>4096){stderrLine='';stderrOverflow=true;}}
 }
});
child.stderr.on('end',()=>{if(stderrLine||stderrOverflow)diagnostic('child diagnostic ended without a complete bounded line');});
child.stderr.on('error',failed);
child.on('error',failed);
child.on('close',code=>{process.exitCode=process.exitCode??code??0;process.stdin.destroy();});
child.stdin.on('error',failed);
process.stdout.on('error',failed);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
pipe(process.stdin, async line => {
 const m=parse(line);
 if(m && typeof m.method==='string' && m.id!==undefined) {
  if(blocked && m.method==='tools/call') return write(process.stdout,JSON.stringify({jsonrpc:'2.0',id:m.id,result:{isError:true,content:[{type:'text',text:'This server was left out because its tool schemas exceed Kimi’s size limit.'}]}}));
  if(m.method==='tools/list') {
   if(blocked)return write(process.stdout,JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[]}}));
   if(lists.size>=256)throw Error('request bound');
   lists.set(key(m.id),{id:m.id,tools:[],bytes:0,cursors:new Set()});
  }
 }
 await write(child.stdin,line);
}).then(stop).catch(failed);
pipe(child.stdout, async line => {
 const m=parse(line);
 const catalog=m && !m.method && lists.get(key(m.id));
 if(catalog) {
  lists.delete(key(m.id));
  if(Array.isArray(m.result?.tools)) {
   if(!blocked && m.result.tools.some(tool=>overBudget(tool?.inputSchema,limit))) {
    blocked=true;diagnostic('Murage left out one MCP server: its tool schemas exceed Kimi’s size limit.');
   }
   if(!blocked) {
    catalog.bytes+=Buffer.byteLength(line);
    if(catalog.bytes>8*1024*1024)throw Error('catalog bound');
    catalog.tools.push(...m.result.tools);
    const cursor=m.result.nextCursor;
    if(cursor!==undefined) {
     if(typeof cursor!=='string'||catalog.cursors.has(cursor)||catalog.cursors.size>=256)throw Error('catalog cursor bound');
     catalog.cursors.add(cursor);
     const id='murage-schema:'+randomUUID();lists.set(key(id),catalog);
     return write(child.stdin,JSON.stringify({jsonrpc:'2.0',id,method:'tools/list',params:{cursor}}));
    }
   }
   m.result={...m.result,tools:blocked?[]:catalog.tools};delete m.result.nextCursor;
  }
  // A page error aborts the whole withheld catalog; no earlier tools escape.
  m.id=catalog.id;line=JSON.stringify(m);
 }
 await write(process.stdout,line);
}).catch(failed);
`;
  return servers.map(server => ({ ...server, command: process.execPath, args: ["-e", source, "--", server.command, ...server.args],
    env: [...server.env.filter(entry => entry.name !== "ELECTRON_RUN_AS_NODE"), { name: "ELECTRON_RUN_AS_NODE", value: "1" }] }));
}

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function branches(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** The object shape a schema implies, gathered through its combinators.
 * Its own declarations win over a branch's narrower copy; a property that
 * only a branch declares is kept so the model still knows it exists. A name
 * is required when the schema or an allOf branch requires it, or when every
 * anyOf/oneOf choice does. A requirement of only one choice is not. */
function objectShape(schema: JsonObject): { properties: JsonObject; required: string[] } {
  const properties: JsonObject = isObject(schema.properties) ? { ...schema.properties } : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);

  const adopt = (shape: { properties: JsonObject }) => {
    for (const [key, value] of Object.entries(shape.properties)) if (!(key in properties)) properties[key] = value;
  };

  for (const branch of branches(schema.allOf)) {
    const shape = objectShape(branch);
    adopt(shape);
    for (const key of shape.required) required.add(key);
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const choices = branches(schema[keyword]).map(objectShape);
    if (choices.length === 0) continue;
    for (const choice of choices) adopt(choice);
    for (const key of choices[0]!.required) {
      if (choices.every((choice) => choice.required.includes(key))) required.add(key);
    }
  }
  return { properties, required: [...required] };
}

function describesObject(type: unknown): boolean {
  return type === undefined || type === "object" || (Array.isArray(type) && type.includes("object"));
}

/** A strict-provider-safe version of an MCP tool's inputSchema. A schema
 * that is already safe is returned as the same object, so callers can tell
 * whether anything changed. The input is never mutated. */
export function providerSafeInputSchema(schema: unknown): JsonObject {
  if (!isObject(schema) || !describesObject(schema.type)) return { type: "object", properties: {} };
  if (schema.type === "object" && ROOT_COMBINATORS.every((keyword) => !(keyword in schema))) return schema;

  const { properties, required } = objectShape(schema);
  const safe: JsonObject = { ...schema, type: "object", properties };
  for (const keyword of ROOT_COMBINATORS) delete safe[keyword];
  if (required.length > 0) safe.required = required;
  else delete safe.required;
  return safe;
}

/** Rewrites tools/list responses on an MCP stdio stream. Only a response to
 * a tools/list the agent actually sent is touched; every other line (tool
 * results, notifications, errors, non-JSON) passes through byte-for-byte. */
export function createToolListNormalizer(schemaBudget?: number): {
  /** Record an agent → server line. */
  observeRequest: (line: string) => void;
  /** Map a server → agent line to what the agent should receive. */
  rewriteResponse: (line: string) => string;
  /** The request with this id will never be answered (cancelled, superseded, undeliverable): stop waiting for it. */
  forget: (id: unknown) => void;
} {
  // JSON-RPC ids may be numbers or strings, and 7 is not "7".
  const pending = new Set<string>();
  let blocked = false;
  const idKey = (id: unknown) => `${typeof id}:${String(id)}`;

  return {
    forget(id) {
      pending.delete(idKey(id));
    },
    observeRequest(line) {
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (isObject(frame) && frame.method === "tools/list" && (typeof frame.id === "number" || typeof frame.id === "string")) {
        pending.add(idKey(frame.id));
      }
    },
    rewriteResponse(line) {
      if (pending.size === 0) return line;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return line;
      }
      if (!isObject(frame) || "method" in frame || !pending.delete(idKey(frame.id))) return line;
      if (!isObject(frame.result) || !Array.isArray(frame.result.tools)) return line;

      if (schemaBudget !== undefined && (blocked || frame.result.tools.some((tool: unknown) => isObject(tool) && toolSchemaOverBudget(tool.inputSchema, schemaBudget)))) {
        blocked = true;
        const result: JsonObject = { ...frame.result, tools: [] };
        delete result.nextCursor;
        return JSON.stringify({ ...frame, result });
      }

      let changed = false;
      const tools = frame.result.tools.map((tool: unknown) => {
        if (!isObject(tool)) return tool;
        const inputSchema = providerSafeInputSchema(tool.inputSchema);
        if (inputSchema === tool.inputSchema) return tool;
        changed = true;
        return { ...tool, inputSchema };
      });
      return changed ? JSON.stringify({ ...frame, result: { ...frame.result, tools } }) : line;
    },
  };
}
