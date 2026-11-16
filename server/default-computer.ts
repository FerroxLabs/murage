// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Default computer for new bots (CONTRACTS-B 2, config computer.defaultForNewBots).
// Read at new-bot creation only: the answer is copied into the new bot's own computer
// choice, so a later change here never touches an existing bot and the bot's own
// Access > Computer choice always wins afterwards.
import type { DefaultComputerChoice } from "./config.ts";

export type NewBotComputer = "off" | "local" | "vm" | "cloud" | undefined;

export interface NewBotComputerEnv {
  /** A Cloud home is a small headless server: no desktop of its own and no VM. */
  cloudHome: boolean;
  /** The local VM is ready for this new bot, not merely a non-Cloud install. */
  vmAvailable: boolean;
  /** A hosted computer (box) can be reached from this install. */
  boxAvailable: boolean;
}

/** The value for the new bot's `computer` field, and whether the choice had to fall back to "this computer". */
export function resolveNewBotComputer(choice: DefaultComputerChoice, env: NewBotComputerEnv): { computer: NewBotComputer; fellBack: boolean } {
  if (choice === "off") return { computer: "off", fellBack: false };
  // "this computer" on a Cloud home has nothing to point at, so the bot keeps the automatic choice.
  const thisComputer: NewBotComputer = env.cloudHome ? undefined : "local";
  if (choice === "vm") return !env.cloudHome && env.vmAvailable ? { computer: "vm", fellBack: false } : { computer: thisComputer, fellBack: true };
  if (choice === "cloud") return env.boxAvailable ? { computer: "cloud", fellBack: false } : { computer: thisComputer, fellBack: true };
  return { computer: thisComputer, fellBack: false };
}

/** Resolve before the creation write. A new per-bot VM has not been created yet;
 * only an existing, ready shared VM can be used immediately. Failed reads also fall back. */
export async function resolveNewBotComputerForCreation(
  choice: DefaultComputerChoice,
  env: Omit<NewBotComputerEnv, "vmAvailable"> & { vmMode: "shared" | "per-bot" },
  readVm: () => Promise<{ runtime: string | null; ready: boolean }>,
): Promise<{ computer: NewBotComputer; fellBack: boolean }> {
  let vmAvailable = false;
  if (choice === "vm" && !env.cloudHome && env.vmMode === "shared") {
    try {
      const status = await readVm();
      vmAvailable = Boolean(status.runtime) && status.ready;
    } catch {
      // No confirmed VM: use this computer and return the normal fallback notice.
    }
  }
  return resolveNewBotComputer(choice, { ...env, vmAvailable });
}
