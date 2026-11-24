// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { projectMissingPermissions } from "../../server/highlevel/scope-policy.ts";
import { INVOCATION_DESCRIPTORS } from "../../server/highlevel/operations/invocation-plans.ts";
const path = "lanes/highlevel-secret-policy/locale-inventory.json";
const inventory: Record<string, string> = JSON.parse(readFileSync(path, "utf8"));
for (const row of projectMissingPermissions(INVOCATION_DESCRIPTORS.flatMap(d => [d.endpointScope, ...d.readers.map(r => r.scope)]))) inventory[row.localeKey] = row.label;
writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
