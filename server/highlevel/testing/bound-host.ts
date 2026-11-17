// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated provider fixtures own the response binding just as the real HTTP
// transport does. Explicit bindings, including revoked ones, pass unchanged.
import { HighLevelHost as ProductHost } from "../host.ts";
import { highlevelFixtureBinding } from "./release-fixture.ts";
export * from "../host.ts";

export class HighLevelHost extends ProductHost {
  override handle(...[claim, message, binding]: Parameters<ProductHost["handle"]>) {
    return super.handle(claim, message, binding === undefined ? highlevelFixtureBinding(claim) : binding);
  }
}
