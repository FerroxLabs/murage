import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the real main-process launch blocks share one fresh private token without mutating ambient env", () => {
  const source = readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
  const declaration = source.match(/^const companionToken = .*;$/m)?.[0];
  expect(declaration).toBeTruthy();
  const optionsStart = source.indexOf("function companionLaunchOptions(");
  const optionsEnd = source.indexOf("function ensureManagedCompanionConnector",optionsStart);
  const serverStart = source.indexOf("async function startServerOn(port) {");
  const serverEnd = source.indexOf('  slog(`fork ${entry} port=${port}`)',serverStart);
  expect(Math.min(optionsStart,optionsEnd,serverStart,serverEnd)).toBeGreaterThan(0);
  // Execute the actual environment/option construction, replacing Electron
  // and credential storage. No GUI, utility process, or network is started.
  const launch = new Function("randomBytes","process","path","app",`
    const SERVER_PORT=8799;
    const remoteAccessLaunch=()=>null, slog=()=>{};
    const secureCredentials={}, credentialStoreUnavailable=false;
    const restoredConnections=null,restoredHarnessEnvironment=env=>env;
    const desktopDataDir="/fixture/canonical-installation";
    const desktopDataOwner={utilityServerLeaseEnvironment:()=>({MURAGE_INTERNAL_DATA_DIR_LEASE:"private-lease-fixture"})};
    const assertDesktopStartupActive=()=>{};
    const composioBrokerUrl=()=>null;
    const managedComposioChildEnvironment=(_url,_credentials,env)=>env;
    const harnessResourceEnvironment=()=>({}), workspaceCredentialEnv=()=>({});
    ${declaration}
    ${source.slice(optionsStart,optionsEnd)}
    const env=((port)=>{${source.slice(source.indexOf("{",serverStart)+1,serverEnd)}return childEnv;})(8799);
    return {env,options:companionLaunchOptions()};
  `);
  const ambient = {MURAGE_COMPANION_TOKEN:"untrusted-ambient-value"};
  const process = {env:ambient,resourcesPath:"/fixture/resources"};
  const invoke = () => launch(randomBytes,process,{join:(...parts)=>parts.join("/")},{getPath:()=>"/fixture/user-data"});
  const first = invoke();
  const second = invoke();
  expect(first.env.MURAGE_COMPANION_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(first.options.companionToken).toBe(first.env.MURAGE_COMPANION_TOKEN);
  expect(first.env.MURAGE_INTERNAL_DATA_DIR_LEASE).toBe("private-lease-fixture");
  expect(first.env.MURAGE_DATA_DIR).toBe("/fixture/canonical-installation");
  expect(first.options.MURAGE_INTERNAL_DATA_DIR_LEASE).toBeUndefined();
  expect(second.env.MURAGE_COMPANION_TOKEN).not.toBe(first.env.MURAGE_COMPANION_TOKEN);
  expect(ambient).toEqual({MURAGE_COMPANION_TOKEN:"untrusted-ambient-value"});
});

it("the real companion child environment overrides inherited device state for a restored profile", () => {
  const source = readFileSync(new URL("./companion.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  const childEnvironment = { ...process.env };");
  const end = source.indexOf("  let child;", start);
  expect(start).toBeGreaterThan(0);
  const build = new Function("process", "connectionStorage", `
    const companionToken="fresh-private-token",hostedUrl=null,allocatedOrigin={socketPath:"/owned/private.sock"};
    ${source.slice(start,end)}; return childEnvironment;
  `);
  const ambient = { MURAGE_COMPANION_DIR: "/old/device-bindings", MURAGE_INTERNAL_DATA_DIR_LEASE: "private-parent" };
  expect(build({env:ambient}, {stateDirectory:"/restored/new-bindings"})).toMatchObject({MURAGE_COMPANION_DIR:"/restored/new-bindings"});
  expect(ambient.MURAGE_COMPANION_DIR).toBe("/old/device-bindings");
});
