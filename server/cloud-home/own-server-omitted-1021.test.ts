// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VerificationServer } from "../../scripts/control-murage.ts";
import { readBotRecords } from "../bot-turn-state.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { ENGINE_OWN_REFUSAL } from "../consuming-turn-response.ts";
import { createMcpMountAdmission } from "../drivers/mcp-mounts.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { waitForExit } from "../testing/cleanup.ts";
import { VPS_MCP_RELAY_PATH } from "./vps-mcp-relay.ts";
import { COMPUTER_UNAVAILABLE } from "../bot-shapes.ts";
import { CloudSessions } from "../cloud-sessions.ts";
import {
  BASE_IMAGE_DIGEST, BASE_IMAGE_LABEL, CUA_DRIVER_VERSION, DRIVER_LABEL,
  IMAGE_LAYER_LABEL, IMAGE_LAYER_VERSION, MANAGED_LABEL,
} from "../container-computer.ts";
import { LEDGER_REFUSAL_LINE } from "../ledger-refusal.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { launchMemoryVerificationServer } from "../testing/memory-verification-fixture.ts";
import { openSse } from "../testing/sse.ts";
import { prepareFixtureRecall } from "../testing/recall-ready-fixture.ts";
import { VPS_CONTAINER_LABEL, VPS_IMAGE, VPS_MANAGED_LABEL, VPS_VIEWER_LABEL } from "../vps-computer.ts";

const origin = "https://home.example.test";
const notice = "Your own-server computer isn't available on Murage Cloud yet, so this bot is running without a computer here. It works when the bot runs on your own computer.";
// Turn preparation and witness owner: O12. Both production admission barriers: MAIN.
const fakeCli = fileURLToPath(new URL("../testing/fake-acp-cli.ts", import.meta.url));
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);

function imageInspectJson(): string {
  return JSON.stringify([
    {
      Id: IMAGE_ID,
      Config: {
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
        },
      },
    },
  ]);
}

/** __NAME__ is substituted by the fake docker from the inspect argv, because
 * the container name derives from a bot id that only exists at runtime. */
function containerInspectTemplate(): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Image: IMAGE_ID,
      Config: {
        Image: VPS_IMAGE,
        Env: ["VNC_PW=fixture-viewer"],
        Labels: {
          [VPS_MANAGED_LABEL]: "1",
          [VPS_CONTAINER_LABEL]: "__NAME__",
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          [VPS_VIEWER_LABEL]: "1",
        },
      },
      State: { Running: true },
      NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.5" } } },
      Mounts: [],
      HostConfig: {
        Binds: [],
        VolumesFrom: [],
        NetworkMode: "bridge",
        PortBindings: {},
        PublishAllPorts: false,
        Memory: 4 * 1024 * 1024 * 1024,
        MemorySwap: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        PidMode: "",
        IpcMode: "private",
        UTSMode: "",
        ShmSize: 512 * 1024 * 1024,
        Devices: [],
        DeviceRequests: [],
        SecurityOpt: [],
        UsernsMode: "",
        CgroupnsMode: "private",
        OomKillDisable: false,
        AutoRemove: false,
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      },
    },
  ]);
}

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" image inspect "*) cat "$FAKE_DOCKER_DIR/image.json" ;;
  *" exec "*"--version"*) echo "cua-driver ${CUA_DRIVER_VERSION}" ;;
  *" exec "*"--screenshot-out-file"*) echo "{}" ;;
  *" exec "*"health_report"*) echo '{"schema_version":"1","overall":"ok","checks":[]}' ;;
  *" exec "*"get_desktop_state"*) echo "{}" ;;
  *" exec "*"base64"*) cat "$FAKE_DOCKER_DIR/screenshot.b64" ;;
  *" exec "*"status"*) echo "running" ;;
  *" exec "*"rm -f"*) : ;;
  *" inspect "*) for arg in "$@"; do name="$arg"; done; sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 64 ;;
esac
`;

type Bot = { id: string; threadId: string; busy?: boolean };
type Message = { id: string; role?: string; text?: string; kind: string; murage?: { kind: string } };
type Method = "GET" | "POST" | "PATCH";

describe.skipIf(process.platform === "win32")("Cloud-home own-server omission", () => {
  let fixture: VerificationServer;
  let ownerToken: string;
  const lastSend = new Map<string, string>();
  const file = (name: string) => join(fixture.info.dataDir, name);
  const dockerLog = () => readFileSync(file("fakebin/docker.log"), "utf8");
  const serverLog = () => readFileSync(fixture.info.logPath, "utf8");

  async function api(method: Method, path: string, status: number, body?: unknown) {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<any>((resolve, reject) => {
      const req = request(fixture.info.url + path, { method, headers: {
        host: new URL(origin).host, origin, authorization: `Bearer ${ownerToken}`,
        ...(encoded ? { "content-type": "application/json", "content-length": encoded.length } : {}),
      } }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            expect(res.statusCode, raw).toBe(status);
            resolve(JSON.parse(raw));
          } catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(encoded);
    });
  }

  beforeAll(async () => {
    fixture = await launchMemoryVerificationServer(process.env, undefined, {
      cloud: { publicOrigin: origin, bootstrapSecret: randomBytes(32).toString("hex") },
      instrumentationSource: String.raw`
        import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
        import { registerHooks } from "node:module";
        import { join } from "node:path";
        const root = process.env.MURAGE_DATA_DIR;
        const bin = join(root, "fakebin");
        mkdirSync(bin, { recursive: true });
        process.env.PATH = [bin, ${JSON.stringify(dirname(process.execPath))}, "/usr/bin", "/bin"].join(":");
        process.env.MURAGE_EXTRA_PATH = bin;
        process.env.MURAGE_TURN_TRACE = "1";
        process.env.FAKE_DOCKER_DIR = bin;
        process.env.FAKE_DOCKER_LOG = join(bin, "docker.log");
        globalThis[Symbol.for("murage.hostPower.testUnwrapped")] = true;
        const { installVerificationControl } = await import(${JSON.stringify(new URL("./control-state-verification.fixture.mjs", import.meta.url).href)});
        installVerificationControl(${JSON.stringify(origin)});
        const observation = ${JSON.stringify(`
          import { openBulkRevoke } from "./memory/revoke-commit.ts";
          import { currentTurnLineage } from "./memory/lineage-write.ts";
          process.on("message", command => {
            if (!command?.ownServerWitness) return;
            const { ownServerWitness: id, op, threadId, sourceId, sources, revokeId } = command;
            const reply = value => process.send?.({ ownServerWitness: id, ...value });
            try {
              const db = database();
              const sourceLsn = (thread, messageId) => Number(db.prepare(
                "SELECT l.lsn FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id=? AND l.message_id=?"
              ).get(thread, messageId)?.lsn);
              const owner = internalTurnOwners.get(threadId);
              if (op === "seed") {
                const row = store.appendMessage(threadId, { role: "bot", kind: "text", text: command.text });
                if (!sourceLsn(threadId, row.id)) throw new Error("Fixture source has no recorded lineage");
                reply({ sourceId: row.id });
              } else if (op === "retained") {
                const turn = currentTurnLineage(threadId);
                if (!turn) throw new Error("No real turn lineage recorded");
                const member = checkedOpenTurns(turn)[0];
                const lsn = sourceLsn(threadId, sourceId);
                const ref = { kind: "line", threadId, messageId: sourceId };
                const cited = member.parents.some(parent => parent.kind === "line" && parent.threadId === threadId && parent.messageId === sourceId
                  || parent.kind === "prefix" && parent.threadId === threadId && parent.shown?.includes(sourceId));
                const held = member.parents.some(parent => parent.kind === "prefix" && parent.threadId === threadId
                  && parent.held != null && lsn >= (parent.heldFrom ?? 0) && lsn <= parent.held);
                reply({ cited, held, verdict: refsLookup(db, [ref], member.reader) });
              } else if (op === "pending" || op === "withhold") {
                // Use the serving process's database. A seeding job owns the pending window until this fixture settles it.
                const job = transaction(tx => {
                  const job = op === "pending" ? openBulkRevoke(tx, "fixture-hold", false) : revokeId;
                  for (const source of sources) {
                    const lsn = sourceLsn(source.threadId, source.id);
                    if (!lsn || !job) throw new Error("Fixture obligation requires a concrete source");
                    if (op === "pending") tx.prepare("INSERT INTO memory_deny_pending VALUES (?, ?, ?)").run(source.threadId, lsn, job);
                    else tx.prepare("INSERT INTO memory_deny_point VALUES (?, ?, ?, ?, 'fixture-withheld')").run(source.threadId, lsn, job, lsn);
                  }
                  if (op === "withhold") {
                    tx.prepare("DELETE FROM memory_deny_pending WHERE revoke_id=?").run(job);
                    tx.prepare("UPDATE memory_revoke_jobs SET state='done', phase='done' WHERE revoke_id=? AND state='seeding'").run(job);
                  }
                  tx.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
                  return job;
                });
                reply({ revokeId: job });
              } else if (op === "capability") {
                if (!owner) throw new Error("No live turn owns the fixture thread");
                const token = internalToken(owner.botId, threadId, owner.generation, "computer");
                reply({ token });
              }
            } catch (error) { process.send?.({ ownServerWitness: id, error: String(error) }); }
          });
        `)};
        // The isolated fixture runs the repository's fake engine in place of the image's privileged launcher.
        registerHooks({ load(url, context, next) {
          const loaded = next(url, context);
          if (url.endsWith("/drivers/mcp-mounts.ts")) {
            const source = String(loaded.source);
            const anchor = "    // External Pi and the nested VPS pipe";
            if (!source.includes(anchor)) throw new Error("Missing mount observation point");
            return { ...loaded, source: source.replace(anchor,
              '    if (role === "vpsRelayMcp") console.warn("[fixture] admitted mount candidate vpsRelayMcp");\n' + anchor) };
          }
          if (url.endsWith("/server/index.ts")) {
            const source = String(loaded.source);
            const anchor = "installCloudProcessHooks();";
            if (source.split(anchor).length !== 2) throw new Error("Missing fixture process-hook anchor");
            // The normal host process tree observes and closes the real local fake engine and proxies.
            return { ...loaded, source: source.replace(anchor, 'installCloudProcessHooks("fixture");') + observation };
          }
          if (!["/cloud-home/turn-process.ts", "/server/procs.ts", "/drivers/cli-mount-relay.ts"].some(path => url.endsWith(path))) return loaded;
          return { ...loaded, source: String(loaded.source).replaceAll("process.env.MURAGE_CLOUD_ROLE", '"fixture"') };
        } });
        const { Store } = await import(${JSON.stringify(new URL("../store.ts", import.meta.url).href)});
        const append = Store.prototype.appendMessage;
        Store.prototype.appendMessage = function (thread, row, ...args) {
          const fault = join(root, "append-fault");
          if (row.murage?.kind === "status" && row.text === ${JSON.stringify(notice)} &&
              existsSync(fault) && readFileSync(fault, "utf8") === thread) {
            unlinkSync(fault);
            throw new Error("Fixture status append failure");
          }
          return append.call(this, thread, row, ...args);
        };
        const cli = join(bin, "fixture-acp");
        const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
        writeFileSync(cli, "#!/bin/sh\nexec " + quote(process.execPath) + " " +
          quote(${JSON.stringify(fakeCli)}) + " \"$@\"\n", { mode: 0o755 });
        const cfgPath = join(root, "config.json");
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        cfg.vps = { sshAlias: "fixture-server" };
        cfg.localVm = { mode: "per-bot" };
        cfg.instances.omission = {
          driver: "grokAgent", config: { cli, fullAuto: true },
          environment: { FAKE_ACP_VERSION: "grok 1.0.62", FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: join(root, "turn.gate"),
            FAKE_ACP_DUMP: join(root, "acp.json"), FAKE_ACP_PROMPT_DUMP: join(root, "prompt.json"),
            FAKE_ACP_MCP_LIST: "all:ready", FAKE_ACP_MCP_READY: "1",
            FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" },
        };
        const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The twin sent its answer." } };
        for (const name of ["ownTwin", "offTwin"]) {
          cfg.instances[name] = { ...cfg.instances.omission, environment: {
            ...cfg.instances.omission.environment, FAKE_ACP_MODE: "fuigo-script",
            FAKE_ACP_DUMP: join(root, name + ".json"), FAKE_ACP_PROMPT_DUMP: join(root, name + ".prompt.json"),
            FAKE_ACP_OUTPUT_LOG: join(root, name + ".frames.jsonl"),
            FAKE_ACP_SCRIPT: JSON.stringify([
              { gate: join(root, "twin-chunk"), notify: { method: "session/update", raw: true, params: { update } } },
              { gate: join(root, "twin-finish"), result: { stopReason: "end_turn" } },
            ]),
          } };
        }
        writeFileSync(cfgPath, JSON.stringify(cfg));
        await import(${JSON.stringify(new URL("../testing/recall-ready-preload.mjs", import.meta.url).href)});
      `,
    });
    mkdirSync(file("fakebin"), { recursive: true });
    writeFileSync(file("fakebin/docker"), FAKE_DOCKER, { mode: 0o755 });
    writeFileSync(file("fakebin/ssh"), '#!/bin/sh\nprintf "ssh %s\\n" "$*" >> "$FAKE_DOCKER_LOG"\nexit 0\n', { mode: 0o755 });
    writeFileSync(file("fakebin/image.json"), imageInspectJson());
    writeFileSync(file("fakebin/container.json.tpl"), containerInspectTemplate());
    writeFileSync(file("fakebin/docker.log"), "");
    writeFileSync(file("turn.gate"), "open");
    const db = new DatabaseSync(file("messages.db"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const sessions = new CloudSessions(db, Date.now, origin);
      const device = randomUUID();
      const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
      db.prepare("INSERT INTO cloud_meta VALUES ('account', 'fixture-owner')").run();
      db.prepare("INSERT INTO cloud_devices (id, account, scope, publicKey, assertionKey) VALUES (?, 'fixture-owner', 'owner-desktop', ?, ?)")
        .run(device, key, key);
      ownerToken = sessions.issue(device).accessToken;
    } finally { db.close(); }
  }, 120_000);

  afterAll(async () => { await fixture?.close(); });

  async function newBot(computer: "cloud" | "off" | null, backend = "vps", instanceId = "omission"): Promise<Bot> {
    const { bot } = await api("POST", "/api/bots", 201, {
      name: "Fixture bot", modelSelection: { instanceId, model: "fake-model" },
    });
    await api("PATCH", `/api/bots/${bot.id}`, 200, { cloudBackend: backend, computer, browser: false, composio: false });
    await prepareFixtureRecall(fixture.info.dataDir, bot.id, bot.threadId);
    return bot;
  }

  async function messages(bot: Bot): Promise<Message[]> {
    return (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`, 200)).messages;
  }

  const prompt = (name: string) => existsSync(file(name)) ? readFileSync(file(name), "utf8") : "";

  async function send(bot: Bot, text: string, replyToId?: string) {
    const sendId = randomUUID();
    await api("POST", `/api/bots/${bot.id}/messages`, 202, { threadId: bot.threadId, text, sendId, noSteer: true, replyToId });
    lastSend.set(bot.threadId, sendId);
    return sendId;
  }

  function observe(command: { op: string; threadId: string; [key: string]: unknown }) {
    const child = fixture.child, id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("message", onMessage);
        reject(new Error(`No server observation for ${command.op}`));
      }, 5000);
      const onMessage = (row: any) => {
        if (row?.ownServerWitness !== id) return;
        child.off("message", onMessage);
        clearTimeout(timer);
        if (row.error) reject(new Error(row.error));
        else resolve(row);
      };
      child.on("message", onMessage);
      child.send({ ownServerWitness: id, ...command });
    });
  }

  function turnState(bot: Bot, sendId: string) {
    return api("GET", `/api/bots/${bot.id}/turn-state?threadId=${bot.threadId}&sendId=${sendId}`, 200);
  }

  async function settled(bot: Bot) {
    await expect.poll(async () => {
      const receipt = await turnState(bot, lastSend.get(bot.threadId)!);
      if (!receipt.terminalOutcome) return false;
      const { bots } = await api("GET", "/api/bots?messages=0", 200);
      return bots.some((entry: Bot) => entry.id === bot.id && entry.busy === false);
    }, { timeout: 15_000 }).toBe(true);
    return messages(bot);
  }

  it.each([["O1 Auto", null], ["O2 explicit Cloud", "cloud"]] as const)("%s runs without its own server", async (_witness, computer) => {
    writeFileSync(file("fakebin/docker.log"), "");
    const bot = await newBot(computer);
    await send(bot, "First fixture question");
    const first = await settled(bot);
    expect(first.find(row => row.text?.startsWith("echo: ")), JSON.stringify(first) + "\n" + serverLog().slice(-6000)).toBeDefined();
    expect(first.find(row => row.text?.startsWith("echo: "))?.text).toContain(COMPUTER_UNAVAILABLE.trim());
    expect(first.filter(row => row.murage?.kind === "status" && row.text === notice)).toHaveLength(1);
    expect(first.filter(row => row.text === LEDGER_REFUSAL_LINE)).toEqual([]);
    expect(existsSync(file("acp.json.mcp.json"))).toBe(true);
    const mounts = JSON.parse(readFileSync(file("acp.json.mcp.json"), "utf8")) as { name: string; args?: string[] }[];
    expect(mounts.find(mount => mount.name === "computer" || mount.args?.includes(SPAWNED_PROXIES.vpsRelayMcp))).toBeUndefined();
    expect(dockerLog()).toBe("");

    await send(bot, "Second fixture question");
    const second = await settled(bot);
    expect(echoes(second), serverLog().slice(-4500)).toHaveLength(2);
    expect(second.filter(row => row.text === notice)).toHaveLength(1);
    expect(second.filter(row => row.text === LEDGER_REFUSAL_LINE)).toEqual([]);
    expect(dockerLog()).toBe("");
  }, 60_000);

  async function running(bot: Bot, sendId: string) {
    const read = () => turnState(bot, sendId);
    await expect.poll(async () => {
      const receipt = await read();
      if (receipt.terminalOutcome) throw new Error("Turn ended before engine acceptance: " + serverLog().slice(-3500));
      return receipt.state;
    }, { timeout: 15_000 }).toBe("running");
    return read();
  }

  async function stop(bot: Bot, sendId: string, target: any) {
    return api("POST", `/api/bots/${bot.id}/interrupt`, 200, {
      contract: 1, actionId: randomUUID(), threadId: bot.threadId, sendId,
      attemptId: target.attemptId, receiptRevision: target.receiptRevision,
      bindingEpoch: target.bindingEpoch, turnId: target.turnId,
    });
  }

  const refusalRows = (rows: Message[]) => rows.filter(row => row.text === LEDGER_REFUSAL_LINE);
  const noticeRows = (rows: Message[]) => rows.filter(row => row.murage?.kind === "status" && row.text === notice);
  const echoes = (rows: Message[]) => rows.filter(row => row.text?.startsWith("echo: "));

  it("O3 keeps an owner turn with live held context on the ordinary fence path", async () => {
    const secret = "The fixture lighthouse has a copper staircase.";
    const vps = await newBot(null, "vps", "ownTwin");
    const control = await newBot("off", "vps", "offTwin");
    const twins = [{ bot: vps, name: "ownTwin" }, { bot: control, name: "offTwin" }];
    const reply = "The twin sent its answer.";
    const firstText = "Remember the saved line from earlier.";
    const secondText = "Give the next twin answer.";
    const thirdText = "Make a prospective release.";
    const gates = ["twin-chunk", "twin-finish"];
    const allow = (gate: string) => writeFileSync(file(gate), "");
    const expectPrompt = (name: string, text: string) =>
      expect.poll(() => prompt(name + ".prompt.json"), { timeout: 15_000 }).toContain(text);
    const ids: string[] = [];
    const inspect = (i: number) => observe({ op: "retained", threadId: twins[i]!.bot.threadId, sourceId: ids[i] });
    const start = async (text: string, quote = false) => {
      await Promise.all(twins.map(({ bot }, i) => send(bot, text, quote ? ids[i] : undefined)));
      try {
        await Promise.all(twins.map(({ name }) => expectPrompt(name, text)));
      } catch (error) {
        throw new Error("Twin engine did not accept its prompt: " + serverLog().slice(-9000), { cause: error });
      }
    };
    const idle = () => Promise.all(twins.map(({ bot }) => settled(bot)));
    const statuses = (rows: Message[]) => rows.filter(row => row.murage?.kind === "status" && row.text !== notice).map(row => row.text);

    const feed = await openSse(fixture.info.url + "/api/events", {
      host: new URL(origin).host, origin, authorization: `Bearer ${ownerToken}`,
    });
    const chunkCount = (name: string) => prompt(name + ".frames.jsonl").split("\n")
      .filter(frame => frame.includes('"agent_message_chunk"') && frame.includes(reply)).length;
    const sawBothChunks = (count: number) => expect.poll(() => twins.map(({ name }) => chunkCount(name)), { timeout: 10_000 })
      .toEqual([count, count]);
    try {
      // Start each retained session before the generated line so its LSN is inside the session's recorded held interval.
      for (const gate of gates) allow(gate);
      await start("Open both fixture sessions.");
      await idle();
      for (const gate of gates) unlinkSync(file(gate));
      for (const { bot } of twins) {
        ids.push((await observe({ op: "seed", threadId: bot.threadId, text: secret })).sourceId);
        await prepareFixtureRecall(fixture.info.dataDir, bot.id, bot.threadId);
      }
      await start(firstText, true);
      for (const [i, { name }] of twins.entries()) {
        expect(prompt(name + ".prompt.json")).toContain(secret);
        expect(await inspect(i)).toMatchObject({ cited: true, verdict: { state: "shown" } });
      }
      allow("twin-chunk");
      await sawBothChunks(2);
      allow("twin-finish");
      const first = await idle();
      for (const rows of first) expect(rows.some(row => row.text === reply), JSON.stringify(rows) + "\n" + serverLog().slice(-9000)).toBe(true);
      for (const gate of gates) unlinkSync(file(gate));

      await start(secondText);
      for (const i of twins.keys()) {
        expect(await inspect(i)).toMatchObject({ held: true, verdict: { state: "shown" } });
      }
      const startLog = serverLog().length;
      const sources = twins.map(({ bot }, i) => ({ threadId: bot.threadId, id: ids[i] }));
      const { revokeId } = await observe({ op: "pending", threadId: vps.threadId, sources });
      for (const i of twins.keys()) expect(await inspect(i)).toMatchObject({ verdict: { state: "checking", reason: "pending" } });
      allow("twin-chunk");
      await sawBothChunks(3);
      await new Promise(resolve => setTimeout(resolve, 50)); // Two fence poll intervals while the obligation remains open.
      for (const i of twins.keys()) expect(await inspect(i)).toMatchObject({ verdict: { state: "checking", reason: "pending" } });
      expect(serverLog().slice(startLog)).not.toMatch(/vps relay|vpsRelayMcp|\/vps-mcp|ledger refusal cause=checking:not-built/);
      expect(dockerLog()).toBe("");

      const withheldAt = feed.frames.length;
      await observe({ op: "withhold", threadId: vps.threadId, sources, revokeId });
      for (const i of twins.keys()) expect(await inspect(i)).toMatchObject({ verdict: { state: "withheld" } });
      allow("twin-finish");
      const second = await idle();
      const outcome = (rows: Message[], before: Message[], threadId: string, log: string) => {
        const added = rows.filter(row => !before.some(prior => prior.id === row.id));
        return {
          replies: added.filter(row => row.text === reply).length,
          refusals: refusalRows(added).map(row => row.text),
          statuses: statuses(added),
          rebuilds: log.split("\n").filter(line => line.includes(threadId) && /re-preparing|continuation reset/.test(line)).length,
        };
      };
      const outcomes = (rows: Message[][], before: Message[][], log: string) =>
        twins.map(({ bot }, i) => outcome(rows[i]!, before[i]!, bot.threadId, log));
      const afterSecond = outcomes(second, first, serverLog().slice(startLog));
      expect(afterSecond[0]).toEqual(afterSecond[1]);
      expect(afterSecond[0]).toMatchObject({ replies: 1, refusals: [], rebuilds: 0 });

      const thirdLog = serverLog().length;
      await start(thirdText, true);
      const third = await idle();
      const afterThird = outcomes(third, second, serverLog().slice(thirdLog));
      expect(afterThird[0]).toEqual(afterThird[1]);
      expect(afterThird[0]?.replies).toBe(1);
      for (const { name } of twins) expect(prompt(name + ".prompt.json")).not.toContain(secret);
      for (const [i, rows] of third.entries()) {
        expect(JSON.stringify(rows.filter(row => !first[i]!.some(prior => prior.id === row.id)))).not.toContain(secret);
      }
      await expect.poll(() => feed.frames.slice(withheldAt).map(frame => JSON.stringify(frame)).join("\n"), { timeout: 10_000 }).toContain(thirdText);
      expect(JSON.stringify(feed.frames.slice(withheldAt))).not.toContain(secret);
      expect(dockerLog()).toBe("");
    } finally {
      feed.close();
      for (const gate of gates) allow(gate);
    }
  }, 120_000);

  it("O4 confirms the owner's Stop while another thread starts without a computer wait", async () => {
    const bot = await newBot(null);
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, 201, { title: "Sibling thread" });
    const sibling = { ...bot, threadId: task.threadId };
    await prepareFixtureRecall(fixture.info.dataDir, sibling.id, sibling.threadId);
    const firstId = await send(bot, "__fixture_cancel_ack__ Hold the first thread");
    const first = await running(bot, firstId);
    await expect.poll(() => prompt("prompt.json"), { timeout: 15_000 }).toContain("Hold the first thread");
    const secondId = await send(sibling, "__fixture_cancel_ack__ Hold the sibling thread");
    const second = await running(sibling, secondId);
    await expect.poll(() => prompt("prompt.json"), { timeout: 15_000 }).toContain("Hold the sibling thread");
    expect(await stop(bot, firstId, first)).toMatchObject({
      stopped: true, unconfirmed: false, receipt: { state: "stopped", terminalOutcome: "stopped" },
    });
    expect(await stop(sibling, secondId, second)).toMatchObject({
      stopped: true, unconfirmed: false, receipt: { state: "stopped", terminalOutcome: "stopped" },
    });
    for (const thread of [bot, sibling]) {
      const rows = await messages(thread);
      expect(refusalRows(rows)).toEqual([]);
      expect(rows.some(row => /computer.*in use/i.test(row.text ?? ""))).toBe(false);
    }
    expect(dockerLog()).toBe("");
  }, 60_000);

  it("O5a retries the notice on the next turn after one real append throws", async () => {
    const bot = await newBot(null);
    writeFileSync(file("append-fault"), bot.threadId);
    await send(bot, "Turn with the failed status append");
    const first = await settled(bot);
    expect(echoes(first)).toHaveLength(1);
    expect(noticeRows(first)).toHaveLength(0);
    expect(existsSync(file("append-fault"))).toBe(false);
    const flagAfterFailure = readBotRecords(fixture.info.dataDir).find(row => row.id === bot.id)?.ownServerCloudNoted;
    await send(bot, "Turn after the failed status append");
    const second = await settled(bot);
    expect(echoes(second), serverLog().slice(-4500)).toHaveLength(2);
    expect(noticeRows(second)).toHaveLength(1);
    expect(flagAfterFailure).toBeUndefined();
    expect(refusalRows(second)).toEqual([]);
  }, 60_000);

  it("O6 shows the notice again after backend and computer changes", async () => {
    const bot = await newBot(null);
    await send(bot, "Before changing settings");
    expect(noticeRows(await settled(bot))).toHaveLength(1);
    const patch = (body: object) => api("PATCH", `/api/bots/${bot.id}`, 200, body);
    await patch({ cloudBackend: "vps", computer: null });
    await send(bot, "After resaving the same settings");
    expect(noticeRows(await settled(bot))).toHaveLength(1);
    await patch({ cloudBackend: "box" });
    await patch({ cloudBackend: "vps" });
    await send(bot, "After changing the backend and switching it back");
    expect(noticeRows(await settled(bot))).toHaveLength(2);
    await patch({ computer: "cloud" });
    await send(bot, "After choosing Cloud explicitly");
    expect(noticeRows(await settled(bot))).toHaveLength(3);
  }, 60_000);

  it("B2 pins parked P-3: the production relay admits no upgrade and refuses the live claim's turn", async () => {
    const bot = await newBot(null);
    const sendId = await send(bot, "__fixture_cancel_ack__ Hold for the relay backstop");
    await running(bot, sendId);
    await expect.poll(() => prompt("prompt.json"), { timeout: 15_000 }).toContain("Hold for the relay backstop");
    const { token } = await observe({ op: "capability", threadId: bot.threadId });
    expect(typeof token).toBe("string");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(fixture.info.url + VPS_MCP_RELAY_PATH, {
        headers: { authorization: `Bearer ${token}`, connection: "Upgrade", upgrade: "websocket",
          "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") },
      });
      req.once("response", res => { res.resume(); resolve(res.statusCode!); });
      req.once("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
      req.once("error", reject);
      req.end();
    });
    expect(status).toBe(409);
    const refusals = async () => refusalRows(await messages(bot)).length;
    try {
      await expect.poll(refusals, { timeout: 8000 }).toBe(1);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, 200, { threadId: bot.threadId });
    }
    expect(await refusals()).toBe(1);
    expect(dockerLog()).toBe("");
  }, 60_000);

  it("O5b a SIGKILL mid-turn leaves an ordinary interrupted send, no replay, and no second notice", async () => {
    const logAtStart = serverLog().length;
    const bot = await newBot(null);
    await send(bot, "Before the restart");
    expect(noticeRows(await settled(bot))).toHaveLength(1);
    const text = "__fixture_cancel_ack__ Interrupt this reply by restarting";
    const sendId = await send(bot, text);
    const interrupted = await running(bot, sendId);
    await expect.poll(() => prompt("prompt.json"), { timeout: 15_000 }).toContain(text);
    expect(serverLog().slice(logAtStart)).not.toMatch(/vps relay|\/vps-mcp/);
    unlinkSync(file("prompt.json"));
    await waitForExit(fixture.child, { signal: "SIGKILL" });
    expect(fixture.child.signalCode).toBe("SIGKILL");
    await fixture.restart();
    await prepareFixtureRecall(fixture.info.dataDir, bot.id, bot.threadId);
    const receipt = await turnState(bot, sendId);
    expect(receipt).toMatchObject({ attemptId: interrupted.attemptId, state: "unknown", actions: { stop: false } });
    expect(prompt("prompt.json")).toBe("");
    await send(bot, "After the restart");
    const rows = await settled(bot);
    expect(rows.filter(row => row.text === text)).toHaveLength(1);
    expect(echoes(rows)).toHaveLength(2);
    expect(noticeRows(rows)).toHaveLength(1);
    expect(refusalRows(rows)).toEqual([]);
    expect(dockerLog()).toBe("");
    expect(serverLog()).not.toMatch(/vps relay|\/vps-mcp/);
  }, 120_000);
});

it("B1 refuses the VPS proxy at real MCP mount admission", () => {
  const verdicts: unknown[] = [];
  const f = consumingFixture(undefined, { onRefused: verdict => verdicts.push(verdict) });
  const caps = new InternalCapabilities();
  caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  try {
    expect(() => admission.mount({ command: process.execPath, args: [SPAWNED_PROXIES.vpsRelayMcp] })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(verdicts).toEqual([ENGINE_OWN_REFUSAL]);
  } finally {
    admission.dispose();
    f.close();
  }
});
