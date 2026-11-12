/** In-memory fake requester: no sockets, credentials, or provider-origin override. */
import type { Family, OperationId } from "../../shared/highlevel.ts";

import type { HighLevelMethod } from "./provider-contract.ts";
import { contactsRoutes } from "./fake/contacts.ts";
import { opportunitiesRoutes } from "./fake/opportunities.ts";
import { conversationsRoutes } from "./fake/conversations.ts";
import { calendarsRoutes } from "./fake/calendars.ts";
import { automationsRoutes } from "./fake/automations.ts";
import { locationRoutes } from "./fake/location.ts";
import { usersRoutes } from "./fake/users.ts";
import { formsRoutes } from "./fake/forms.ts";
import { paymentsRoutes } from "./fake/payments.ts";
import { socialRoutes } from "./fake/social.ts";
import { funnelsRoutes } from "./fake/funnels.ts";
import { blogsRoutes } from "./fake/blogs.ts";
import { coursesRoutes } from "./fake/courses.ts";
import { mediaRoutes } from "./fake/media.ts";
import { documentsRoutes } from "./fake/documents.ts";
import { saasRoutes } from "./fake/saas.ts";
import { snapshotsRoutes } from "./fake/snapshots.ts";

export interface FakeHighLevelRequest { operation: OperationId; method: HighLevelMethod; path: string; body?: unknown; query?: Record<string, string> }
export interface FakeHighLevelRoute {
  operation: OperationId; method: HighLevelMethod; path: RegExp;
  handle(request: FakeHighLevelRequest): unknown | Promise<unknown>;
}
export const HIGHLEVEL_FAKE_ROUTES: Readonly<Record<Family, readonly FakeHighLevelRoute[]>> = {
  contacts: contactsRoutes,
  opportunities: opportunitiesRoutes,
  conversations: conversationsRoutes,
  calendars: calendarsRoutes,
  automations: automationsRoutes,
  location: locationRoutes,
  users: usersRoutes,
  forms: formsRoutes,
  payments: paymentsRoutes,
  social: socialRoutes,
  funnels: funnelsRoutes,
  blogs: blogsRoutes,
  courses: coursesRoutes,
  media: mediaRoutes,
  documents: documentsRoutes,
  saas: saasRoutes,
  snapshots: snapshotsRoutes,
};
export function fakeHighLevelRequester(routes: readonly FakeHighLevelRoute[] = Object.values(HIGHLEVEL_FAKE_ROUTES).flat()): { request(op: OperationId, method: HighLevelMethod, path: string, body?: unknown, query?: Record<string, string>): Promise<unknown>; calls: FakeHighLevelRequest[] } {
  const calls: FakeHighLevelRequest[] = [];
  return { calls, async request(operation, method, path, body, query) {
    const route = routes.find(r => r.operation === operation && r.method === method && r.path.test(path));
    if (!route) throw new Error("No frozen fake HighLevel route");
    const call = { operation, method, path, body, query }; calls.push(call);
    return route.handle(call);
  } };
}
