// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import { ensureIoMeter } from "./io-meter.ts";
export * from "node:sqlite";
/** Bootstrap precedes the very first disk open, including constructor writes. */
export class DatabaseSync extends NativeDatabaseSync {
 constructor(...args:ConstructorParameters<typeof NativeDatabaseSync>){ensureIoMeter();super(...args);}
}
export function openSqlite(...args:ConstructorParameters<typeof NativeDatabaseSync>):NativeDatabaseSync{return new DatabaseSync(...args);}
