// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.14 F0: a sign-in wall leads with "Use Fuigo instead" (primary) when Fuigo can answer, or (1.0.15 M5) with the Flux key card when
// no Fuigo can answer yet; the engine's own sign-in becomes the secondary action. Any other setup step (install, check) is shown as it
// was. Its own module so ChatView's ErrorRow and anything that renders ErrorRow on its own load the same wall by import.
import type { ReactNode } from "react";
import type { Bot, InstanceInfo } from "@/state/store";
import { setupStep } from "../EngineSetup";
import { UseFuigoInstead, wallLead } from "./UseFuigoInstead";

/** The bot and the engine list a sign-in wall needs to decide what leads it. */
export type FuigoWall = { bot: Pick<Bot, "id" | "threadId" | "modelSelection" | "engineRev">; instances: readonly InstanceInfo[] };

export function signInWall(instance: InstanceInfo, forceSignIn: boolean, wall: FuigoWall | undefined,
  card: (secondary: boolean) => ReactNode): ReactNode {
  const signIn = forceSignIn || setupStep(instance, { authRequired: forceSignIn }) === "signin";
  if (!wall || !signIn || wallLead(wall.bot, wall.instances) === null) return card(false);
  return <UseFuigoInstead className="mt-3" bot={wall.bot} engineName={instance.displayName} instances={wall.instances}>{card(true)}</UseFuigoInstead>;
}
