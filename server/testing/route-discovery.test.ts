// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ROUTE_POLICY } from "../route-policy.ts";
import { discoverRoutes } from "./route-discovery.ts";

import { removeTempDirSync } from "./cleanup.ts";
let root: string | undefined;
afterEach(() => { if (root) removeTempDirSync(root); root = undefined; });

it("discovers actual method/path branches behind a conditional handler factory and catches a newly added unclassified route", () => {
  root = mkdtempSync(join(tmpdir(), "murage-factory-routes-"));
  mkdirSync(join(root, "server"));
  writeFileSync(join(root, "server", "index.ts"), `
    import { createServer } from "node:http";
    import { createHandler as makeHandler } from "./handler.ts";
    const handler = enabled ? makeHandler({}) : undefined;
    createServer(async (req, res) => {
      const url = new URL(req.url, "http://fixture");
      if (handler && await handler(req, res, url)) return;
    });
  `);
  const handler = (extra = "") => `
    export function createHandler(options) {
      return async (req, res, url) => {
        const path = url.pathname, method = req.method;
        let match = null;
        if (method === "GET" && path === "/api/cloud/model-signins") return true;
        if (method === "POST" && (match = /^\\/api\\/cloud\\/model-signins\\/(chatgpt|supergrok)\\/start$/.exec(path))) return true;
        ${extra}
        return false;
      };
    }
  `;
  writeFileSync(join(root, "server", "handler.ts"), handler());
  const found = discoverRoutes(root);
  expect(found).toHaveLength(2);
  expect(found.map(route => ({ methods: route.methods, samples: route.samples }))).toEqual(expect.arrayContaining([
    { methods: ["POST"], samples: ["/api/cloud/model-signins/chatgpt/start", "/api/cloud/model-signins/supergrok/start"] },
    { methods: ["GET"], samples: ["/api/cloud/model-signins"] },
  ]));
  writeFileSync(join(root, "server", "handler.ts"), handler('if (method === "DELETE" && path === "/api/future-factory-admin") return true;'));
  const unclassified = discoverRoutes(root).flatMap(route => (route.methods ?? []).flatMap(method => route.samples
    .filter(path => !ROUTE_POLICY.some(entry => (entry.methods === "*" || entry.methods.includes(method)) && (typeof entry.path === "string" ? entry.path === path : entry.path.test(path))))
    .map(path => `${method} ${path}`)));
  expect(unclassified).toEqual(["DELETE /api/future-factory-admin"]);
});
