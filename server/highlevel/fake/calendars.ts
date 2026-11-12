// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HighLevelMethod } from "../provider-contract.ts";

import type { FakeHighLevelRequest, FakeHighLevelRoute } from "../fake-provider.ts";
const locationId = "loc_1", calendarId = "cal_1";
export const calendarFixture = { id: calendarId, locationId, name: "Fixture calendar", slotDuration: 30, slotDurationUnit: "mins", calendarType: "event", isActive: true };
export const appointmentFixture = { id: "event_1", locationId, calendarId, contactId: "contact_1", startTime: "2026-11-12T10:00:00Z", endTime: "2026-11-12T10:30:00Z", title: "Fixture appointment", appointmentStatus: "confirmed" };
export const blockFixture = { id: "block_1", locationId, calendarId, startTime: "2026-11-12T09:00:00Z", endTime: "2026-11-12T09:30:00Z" };
const note = { id: "note_1", body: "Fixture note", contactId: "contact_1" };
const body = (r: FakeHighLevelRequest): Record<string, unknown> => r.body && typeof r.body === "object" ? r.body as Record<string, unknown> : {};
const route = (verb: string, method: HighLevelMethod, path: RegExp, handle: FakeHighLevelRoute["handle"]): FakeHighLevelRoute => ({ operation: `calendars.${verb}`, method, path, handle });
// Reuses the existing FakeHighLevel scripted-route pattern: only explicit
// method/path/operation triples match; no live account, sockets or tokens.
export const calendarsRoutes: readonly FakeHighLevelRoute[] = [
  route("list", "GET", /^\/calendars\/$/u, () => ({ calendars: [calendarFixture] })),
  route("get", "GET", /^\/calendars\/cal_1$/u, () => ({ calendar: calendarFixture })),
  route("freeSlots", "GET", /^\/calendars\/cal_1\/free-slots$/u, () => ({ "2026-11-12": { slots: [appointmentFixture.startTime] } })),
  route("groups.list", "GET", /^\/calendars\/groups$/u, () => ({ groups: [{ id: "group_1", locationId, name: "Fixture group" }] })),
  route("resources.list", "GET", /^\/calendars\/resources\/(rooms|equipments)$/u, () => [{ locationId, name: "Fixture room", resourceType: "rooms", calendarIds: [calendarId], quantity: 1 }]),
  route("create", "POST", /^\/calendars\/$/u, r => ({ calendar: { ...calendarFixture, ...body(r), id: "cal_new" } })),
  route("update", "PUT", /^\/calendars\/cal_1$/u, r => ({ calendar: { ...calendarFixture, ...body(r) } })),
  route("delete", "DELETE", /^\/calendars\/cal_1$/u, () => ({ success: true })),
  route("events.list", "GET", /^\/calendars\/events$/u, () => ({ events: [appointmentFixture] })),
  route("appointment.get", "GET", /^\/calendars\/events\/appointments\/event_1$/u, () => ({ event: appointmentFixture })),
  route("appointment.book", "POST", /^\/calendars\/events\/appointments$/u, r => ({ ...appointmentFixture, ...body(r), id: "event_new" })),
  route("appointment.reschedule", "PUT", /^\/calendars\/events\/appointments\/event_1$/u, r => ({ ...appointmentFixture, ...body(r) })),
  route("appointment.cancel", "PUT", /^\/calendars\/events\/appointments\/event_1$/u, r => ({ ...appointmentFixture, ...body(r) })),
  route("event.delete", "DELETE", /^\/calendars\/events\/(event_1|block_1)$/u, () => ({ succeeded: true })),
  route("blockSlot.create", "POST", /^\/calendars\/events\/block-slots$/u, r => ({ ...blockFixture, ...body(r) })),
  route("blockSlot.update", "PUT", /^\/calendars\/events\/block-slots\/block_1$/u, r => ({ ...blockFixture, ...body(r) })),
  route("appointmentNotes.list", "GET", /^\/calendars\/appointments\/event_1\/notes$/u, () => ({ notes: [note], hasMore: false })),
  route("appointmentNotes.create", "POST", /^\/calendars\/appointments\/event_1\/notes$/u, r => ({ note: { ...note, ...body(r), id: "note_new" } })),
  route("appointmentNotes.update", "PUT", /^\/calendars\/appointments\/event_1\/notes\/note_1$/u, r => ({ note: { ...note, ...body(r) } })),
  route("appointmentNotes.delete", "DELETE", /^\/calendars\/appointments\/event_1\/notes\/note_1$/u, () => ({ success: true })),

];
export default calendarsRoutes;
