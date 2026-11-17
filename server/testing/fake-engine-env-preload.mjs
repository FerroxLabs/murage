// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated fake-engine fixtures own these scripted inputs. They are not part
// of the captured login-shell environment used by production engine turns.
import { registerHooks } from "node:module";

registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith("/server/engine-env.ts")) return loaded;
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  const anchor = "return handEnv(await captureOwnerEnv(), withOwnerTimeZone(options));";
  if (!source.includes(anchor)) throw new Error("Fake engine environment handoff moved");
  return { ...loaded, source: source.replace(anchor, `
    const fixtureNames = Object.fromEntries(Object.entries({ ...process.env, ...cloudBase })
      .filter(([name, value]) => name.startsWith("FAKE_") && typeof value === "string"));
    return handEnv(await captureOwnerEnv(), withOwnerTimeZone({ ...options, extra: { ...options.extra, ...fixtureNames } }));
  `) };
} });
