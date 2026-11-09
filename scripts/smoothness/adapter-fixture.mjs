// Execute the production adapter bodies with private, in-memory transports.
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { evidenceLedger } from "./evidence.mjs";
import { firstSendRecorder } from "./smooth-config.mjs";
export function adapterFixture(results = {}, source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8")) {
  const events = [], writes = [];
  let attempts = 0, clock = 9000;
  const evidence = evidenceLedger({ results, writeResults: () => writes.push(structuredClone(results)), setExitCode: () => {} });
  const markSend = firstSendRecorder({ results, runId: "fixture", runStart: 0, now: () => clock++,
    logSize: () => 0, ready: () => true, persist: mark => events.push(["mark", mark]),
    save: evidence.save, fail: evidence.fail, requestId: () => "first" });
  const transport = () => { events.push(["network"]); if (++attempts === 1) throw Error("transport rejected"); };
  const http = { request(url, options, receive) {
    const req = new EventEmitter(); req.write = () => {}; req.destroy = error => req.emit("error", error);
    req.end = () => queueMicrotask(() => {
      try { transport(); } catch (error) { req.emit("error", error); return; }
      const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {};
      receive(res); res.emit("data", "{}"); res.emit("end");
    });
    return req;
  } };
  const fetch = async () => { transport(); return { status: 200, text: async () => "{}" }; };
  const start = source.indexOf("function request("), end = source.indexOf("async function setLevel(");
  if (start < 0 || end <= start) throw Error("adapter source missing");
  const adapters = new Function("http", "fetch", "markSend", "evidence", "R", "URL_", "H", "agent", "drainFailureEnrichments", "registerOwnedThreads", "sleep",
    source.slice(start, end) + "; return { call, roomCall };"
  )(http, fetch, markSend, evidence, results, "http://fixture", {}, {}, async () => {}, () => {}, async () => {});
  return { results, events, writes, attempts: () => attempts,
    send: path => path === "call" ? adapters.call("POST", "/api/bots/b/messages", {})
      : adapters.roomCall("POST", "/api/groups/g/messages", {}, { timeout: 1000, remaining: x => x }) };
}
