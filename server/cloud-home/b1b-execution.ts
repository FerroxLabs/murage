// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudHomeCopy } from "./copy.ts";
import type { DatabaseSync } from "node:sqlite";
/** Persistence precedes quiescing so a restart cannot resume stopped work. */
export class HomeExecutionGate {
  private readonly db: DatabaseSync;
  private readonly authority: () => boolean;
  /** Safe mode (self-service, until the next start): channels stay held, schedules and the owner's add-ons stay off. */
  readonly safeMode: boolean;
  constructor(db: DatabaseSync, authority: () => boolean = () => false, safeMode = false) {this.db=db;this.authority=authority;this.safeMode=safeMode;}
  holdChannels(): void {for(const channel of ["telegram","slack","discord"])this.db.prepare("INSERT OR REPLACE INTO cloud_meta VALUES (?, '1')").run(`recovery-channel:${channel}`);}
  channelHeld(channel: "telegram"|"slack"|"discord"): boolean {return this.safeMode || Boolean(this.db.prepare("SELECT 1 FROM cloud_meta WHERE key=?").get(`recovery-channel:${channel}`));}
  channelsOpen(channel: "telegram"|"slack"|"discord"): boolean {return this.open() && !this.channelHeld(channel);}
  releaseChannel(channel: "telegram"|"slack"|"discord"): void {this.db.prepare("DELETE FROM cloud_meta WHERE key=?").run(`recovery-channel:${channel}`);}
  explicitHeld(): boolean {return Boolean(this.db.prepare("SELECT 1 FROM cloud_meta WHERE key='execution-hold'").get());}
  leaseHeld(): boolean {return Boolean(this.db.prepare("SELECT 1 FROM cloud_meta WHERE key='lease-hold'").get());}
  open(): boolean { return this.authority() && !this.explicitHeld() && !this.leaseHeld(); }
  leasePriorAutomationPause(): boolean {return (this.db.prepare("SELECT value FROM cloud_meta WHERE key='lease-previous-pause'").get() as {value:string}|undefined)?.value === "1";}
  holdLease(automationsPaused: boolean): void {
    if(!this.leaseHeld())this.db.prepare("INSERT OR REPLACE INTO cloud_meta VALUES ('lease-previous-pause',?)").run((this.explicitHeld()?this.priorAutomationPause():automationsPaused)?"1":"0");
    this.db.prepare("INSERT OR REPLACE INTO cloud_meta VALUES ('lease-hold','1')").run();
  }
  releaseLease(): void {this.db.prepare("DELETE FROM cloud_meta WHERE key IN ('lease-hold','lease-previous-pause')").run();}
  priorAutomationPause(): boolean {return (this.db.prepare("SELECT value FROM cloud_meta WHERE key='execution-previous-pause'").get() as {value:string}|undefined)?.value === "1";}
  hold(reason: "stop" | "drain" | "recovery" | "suspend", automationsPaused = false): void {
    if(!this.explicitHeld())this.db.prepare("INSERT OR REPLACE INTO cloud_meta VALUES ('execution-previous-pause',?)").run((this.leaseHeld()?this.leasePriorAutomationPause():automationsPaused) ? "1" : "0");
    this.db.prepare("INSERT OR REPLACE INTO cloud_meta VALUES ('execution-hold',?)").run(reason);
  }
  resume(): void { this.db.prepare("DELETE FROM cloud_meta WHERE key IN ('execution-hold','execution-previous-pause')").run(); }
  requireOpen(): void { if(!this.open()) throw Object.assign(new Error(cloudHomeCopy.homePaused),{status:403}); }
}
