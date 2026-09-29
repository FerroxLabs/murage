// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every pack at once, for tests that read a pack's strings directly. The app
// never imports this: it would put all seven packs back in the first paint
// (src/first-paint.test.ts proves they stay out).
import { en, localeLoaders, type LocalePack } from "./index";

/** Each registered code (aliases included) to its pack, English first. */
export async function allLocalePacks(): Promise<Record<string, LocalePack>> {
  const entries = await Promise.all(Object.entries(localeLoaders).map(async ([code, load]) => [code, await load()] as const));
  return { en, ...Object.fromEntries(entries) };
}
