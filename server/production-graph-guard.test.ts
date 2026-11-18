// SPDX-License-Identifier: AGPL-3.0-or-later
// Production never reaches test code. (Astra BLOCK on walhang6, H2: server/index.ts -> lineage-warm.ts -> lineage-warm-surface.ts ->
// server/testing/cleanup.ts. A build exclusion hides that from a bundle but does not sever the import.)
import { expect, it } from "vitest";
import { entryPoints, pathsIntoTesting, productionGraph, rel } from "./testing/production-graph.ts";

it("the production import graph from server/index.ts and the bundle entry points never reaches server/testing or a test file", () => {
  const graph = productionGraph();
  expect(graph.size, "the walk found the production files").toBeGreaterThan(200);
  expect(entryPoints().map(rel), "server/index.ts is an entry").toContain("server/index.ts");
  expect(pathsIntoTesting(graph), "no production path reaches test code (each entry is an import chain)").toEqual([]);
});
