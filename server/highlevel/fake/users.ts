// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { usersOperations } from "../operations/users.ts";
import { f6Record } from "../operations/location.ts";
import type { FakeHighLevelRoute } from "./location.ts";
export const usersRoutes: readonly FakeHighLevelRoute[] = usersOperations.filter(spec => spec.id !== "users.create").map(spec => ({
  operation: spec.id, method: spec.endpoint.method, path: spec.endpoint.path,
  handle(request) {
    const user = { id: "user1", firstName: "Fixture", lastName: "User", roles: { type: "account", role: "user", locationIds: [request.query?.locationId ?? "loc1"] }, ...f6Record(request.body) };
    return spec.id === "users.list" ? { users: [user] } : spec.id === "users.delete" ? { succeeded: true } : user;
  },
}));
export default usersRoutes;
