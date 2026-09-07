import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import * as messages from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";
import { recordMemorySettlement, reconcileInterruptedMemoryTurns } from "./settlement.ts";
import { Store } from "../store.ts";

beforeEach(() => {closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});setMemoryMode("capture");});
const message = (id: string, text: string, parentId: string | null = null) => ({id,text,parentId,at:1,role:"user" as const,kind:"text" as const});
it("captures a source/job atomically and deduplicates identical patches", () => {
  messages.appendMessage("thread",message("m","Durable source"));
  messages.updateMessage("thread",message("m","Durable source"));
  expect(database().prepare("SELECT count(*) AS n FROM memory_jobs").get()?.n).toBe(1);
  messages.updateMessage("thread",message("m","Corrected source"));
  expect(database().prepare("SELECT revision FROM memory_sources").get()?.revision).toBe(2);
  expect(database().prepare("SELECT count(*) AS n FROM memory_source_versions").get()?.n).toBe(2);
  expect(database().prepare("SELECT status FROM memory_jobs WHERE source_revision=1").get()?.status).toBe("cancelled");
});
it("rolls back the message if capture intent cannot persist", () => {
  database().exec("CREATE TRIGGER fixture_capture_failure BEFORE INSERT ON memory_jobs BEGIN SELECT RAISE(ABORT,'injected capture failure'); END;");
  expect(() => messages.appendMessage("thread",message("m","must not acknowledge"))).toThrow("injected capture failure");
  expect(database().prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(0);
  expect(database().prepare("SELECT count(*) AS n FROM memory_sources").get()?.n).toBe(0);
  database().exec("DROP TRIGGER fixture_capture_failure");
});
it("retires the abandoned branch and restores it on switch-back", () => {
  messages.appendMessage("thread",message("root","Base"));
  messages.appendMessage("thread",message("a","Old decision","root"));
  messages.appendMessage("thread",message("b","New decision","root"));
  expect(database().prepare("SELECT state FROM memory_sources WHERE message_id='a'").get()?.state).toBe("retired");
  messages.setActiveLeaf("thread","a");
  expect(database().prepare("SELECT state FROM memory_sources WHERE message_id='a'").get()?.state).toBe("active");
  expect(database().prepare("SELECT state FROM memory_sources WHERE message_id='b'").get()?.state).toBe("retired");
});
it("never captures screen/control payloads and waits for terminal assistant text", () => {
  messages.appendMessage("thread",{id:"private",at:1,role:"bot",kind:"options",text:"PRIVATE_CONTROL_CANARY"});
  messages.appendMessage("thread",{id:"progress",at:2,role:"bot",kind:"text",turnId:"turn",text:"partial"});
  expect(database().prepare("SELECT payload FROM memory_source_versions").all().some(r=>String(r.payload).includes("PRIVATE_CONTROL_CANARY"))).toBe(false);
  expect(database().prepare("SELECT 1 FROM memory_sources WHERE message_id='progress'").get()).toBeUndefined();
  messages.updateMessage("thread",{id:"progress",at:2,role:"bot",kind:"text",turnId:"turn",turnTerminal:true,text:"Final result"});
  expect(database().prepare("SELECT 1 FROM memory_sources WHERE message_id='progress'").get()).toBeDefined();
});
it("preserves large source bytes and prevents deleted-source recreation", () => {
  const text = "ไทย".repeat(180000);
  messages.appendMessage("thread",message("large",text));
  expect(JSON.parse(String(database().prepare("SELECT payload FROM memory_source_versions").get()?.payload)).text).toBe(text);
  messages.deleteThread("thread");
  messages.appendMessage("thread",message("large",text));
  expect(database().prepare("SELECT state FROM memory_sources").get()?.state).toBe("deleted");
});
it("normalizes missing terminal events on restart without erasing completed effects", () => {
  recordMemorySettlement("thread","turn","working");
  messages.appendMessage("thread",{id:"tool",at:1,role:"bot",kind:"activity",tool:{name:"Saved the file",ok:true},turnId:"turn"});
  reconcileInterruptedMemoryTurns();
  expect(database().prepare("SELECT outcome FROM memory_sources WHERE kind='turn'").get()?.outcome).toBe("interrupted");
  expect(database().prepare("SELECT outcome FROM memory_sources WHERE kind='tool-outcome'").get()?.outcome).toBe("completed");
});
it("commits terminal text and settlement together through the real Store", () => {
  const store = new Store(()=>({instanceId:"fake",model:"fake"}));
  store.appendMessage("fixture-thread",{role:"bot",kind:"text",turnId:"turn",text:"The final result"});
  store.markTerminalAssistantMessage("fixture-thread","turn","failed");
  expect(database().prepare("SELECT outcome FROM memory_sources WHERE kind='turn'").get()?.outcome).toBe("failed");
  expect(database().prepare("SELECT count(*) AS n FROM memory_sources WHERE kind='text'").get()?.n).toBe(1);
});
