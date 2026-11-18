// Private in-memory fixture: execute the runner's actual setter/scenario bodies, never a live app.
import { readFileSync } from "node:fs";
import { levelPatch } from "./smooth-config.mjs";
import { evidenceLedger } from "./evidence.mjs";

const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
const section = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error(`runner fixture boundary missing: ${start}`);
  return source.slice(a, b);
};
const compile = (text, env) => new Function(...Object.keys(env), text)(...Object.values(env));

export function levelFixture({ failAt, status = 400, readLevel, readTask, successStatus = 200, eligible = true } = {}) {
  const events = [], results = { scenarios: {} }, writes = [];
  let wanted = "ask", exitCode = 0;
  const threadId = "measured-thread", botId = "fixture-bot";
  const bot = { id: botId, threadId, computer: "local", busy: false };
  const evidence = evidenceLedger({ results, writeResults: () => writes.push(structuredClone(results)), setExitCode: code => { exitCode = code; } });
  const call = async (method, path, body) => {
    const stage = method === "PATCH" ? "patch" : method === "POST" ? (body.rosterId ? "apply" : "preview") : path.includes("/tasks/") ? "readback" : "bot";
    events.push({ stage, method, path, body });
    if (stage === failAt) return { status, json: { error: "fixture refusal" } };
    if (stage === "preview") return { status: successStatus, json: { previewId: "preview", botRev: 4, rosterId: "roster", targetLevel: body.targetLevel, eligible: eligible ? [{ threadId }] : [] } };
    if (stage === "patch") wanted = !body.autoApprove ? "ask" : !body.fullAccess ? "auto" : body.noLimits ? "unlimited" : "full";
    const level = readLevel ?? wanted;
    const task = readTask === undefined ? { threadId, autoApprove: level !== "ask", fullAccess: ["full", "unlimited"].includes(level), noLimits: level === "unlimited", permissionRev: 5 } : readTask;
    return { status: successStatus, json: { permissionRev: 5, bot: { ...bot, ...task, threadId }, task } };
  };
  const setLevel = compile(section("async function setLevel(", "async function api(") + "return setLevel;", {
    call, levelPatch, R: results, evidence, currentScenario: "fixture", keptText: text => text, redact: text => text,
  });
  const runScenario = compile(section("async function scenario(", "// ================================================================== run") + "return scenario;", {
    R: results, SCEN: new Set(["fixture", "later"]), save: evidence.save, log: () => {}, logSize: () => 0,
    keptText: text => text, redact: text => text, stopServer: async () => { events.push({ stage: "stop" }); },
    settleBot: async () => ({ settled: true }), logFrom: () => "", countSignatures: () => ({}), eldWindow: () => ({}), window_: () => ({}), note: () => {},
    currentScenario: "run", scenarioBots: [], scenarioFrom: 0,
  });
  const measure = () => { events.push({ stage: "measure" }); throw Error("fixture reached measurement"); };
  const runLeg = async (name, level = "unlimited") => {
    const bounds = {
      routineBurst: ["await scenario(\"routineBurst\"", "// S2 delegation"],
      trust: ["await scenario(\"trust\"", "// S10 (real engines only)"],
      autoEveryday: ["await scenario(\"autoEveryday\"", "// S5 the longest"],
      askEveryday: ["await scenario(\"autoEveryday\"", "// S5 the longest"],
    };
    const text = section(...bounds[name]);
    return compile("return (async () => {" + text + "})();", {
      scenario: async (_name, fn) => fn({}), ENGINES: "real", makeBot: async () => bot, makeBotOn: async () => bot,
      setLevel, call, levelPatch, getBot: async () => (await call("GET", `/api/bots/${botId}`)).json.bot,
      LEVELS: [level], DEV_COMMANDS: ["git status"], STOP_COMMANDS: [], ctl: () => {}, restore: () => {},
      keptText: text => text, redact: text => text, api: measure, routinePrompt: () => "fixture",
      turn: measure, quiesce: measure, cardTurn: measure, instances: { fixture: { state: "available" } },
      S10_ENGINES: name === "askEveryday" ? [] : ["fixture"], S10_ASK_ENGINE: "fixture", EVERYDAY_TASKS: ["fixture"],
    });
  };
  return { events, results, writes, exitCode: () => exitCode, set: level => setLevel(botId, level, threadId), runLeg, runScenario };
}
