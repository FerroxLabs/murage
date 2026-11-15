// SPDX-License-Identifier: AGPL-3.0-or-later
// A refused Flux key on a Cloud home never tells the customer to check a key or open Models; the desktop copy is unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineNeed } from "./engine-need";
import { engineTag } from "./today-model";
import { healthFromEngines } from "@/components/health/health-status";
import { FLUX_NOT_READY_COPY } from "../../shared/provider-error";

const reading = { engine: null, flux: "key-problem" as const };
const asHome = () => vi.stubGlobal("document", { querySelector: () => ({ getAttribute: () => "home-1" }) });
afterEach(() => { vi.unstubAllGlobals(); });

describe("a refused Flux key", () => {
  it("on the desktop keeps the key wording and the Models button", () => {
    expect(engineNeed(reading, [], false)).toMatchObject({ title: "Flux Router: the key is not working", label: "Open Models" });
    expect(healthFromEngines(null, "key-problem", true).line).toBe("Flux Router: the key is not working");
    expect(engineTag({ engine: null, flux: "key-problem", connectivity: "online" } as never)).toMatchObject({ action: "flux" });
  });

  it("on a Cloud home says the approved line and has no Models button", () => {
    asHome();
    expect(engineNeed(reading, [], false)).toMatchObject({ title: FLUX_NOT_READY_COPY, label: "" });
    expect(healthFromEngines(null, "key-problem", true).line).toBe(FLUX_NOT_READY_COPY);
    const tag = engineTag({ engine: null, flux: "key-problem", connectivity: "online" } as never);
    expect(tag?.text).toBe(FLUX_NOT_READY_COPY);
    expect(tag?.action).toBeUndefined();
  });
});
