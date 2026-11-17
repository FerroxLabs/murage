import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseRequest, parseResponse, rateLimitErrorSchema } from "./rpc.ts";

const send = { jsonrpc: "2.0", id: 1, method: "send", params: { noteToSelf: true, message: "hello" } };
describe("Signal RPC", () => {
  it.each(["recipient", "groupId", "username", "account", "attachments"])("T-SEND-SCHEMA rejects %s; kills passthrough params", (key) => {
    expect(parseRequest(send)).toEqual(send);
    expect(() => parseRequest({ ...send, params: { ...send.params, [key]: "other" } })).toThrow("invalid-request");
  });
  it.each([false, undefined])("T-SEND-SCHEMA requires noteToSelf true (%s)", (noteToSelf) => {
    expect(parseRequest(send)).toEqual(send);
    expect(() => parseRequest({ ...send, params: { ...send.params, noteToSelf } })).toThrow("invalid-request");
  });
  it("T-SEND-SCHEMA bounds message and permits only verified reserved timestamps", () => {
    for (const message of ["a", "a".repeat(2000)]) expect(parseRequest({ ...send, params: { ...send.params, message } })).toBeTruthy();
    for (const message of ["", "a".repeat(2001)]) expect(() => parseRequest({ ...send, params: { ...send.params, message } })).toThrow();
    const stamped = { ...send, params: { ...send.params, timestamp: 123 } };
    expect(parseRequest(stamped, { timestampSupported: true, isReservedTimestamp: (n) => n === 123 })).toEqual(stamped);
    expect(() => parseRequest(stamped, { timestampSupported: true, isReservedTimestamp: () => false })).toThrow();
    expect(() => parseRequest(stamped, { timestampSupported: false, isReservedTimestamp: () => true })).toThrow();
  });
  it.each(["receive", "listDevices", "sendReaction", "__proto__", "constructor"])("T-RPC-ALLOW rejects %s; kills unrestricted dispatch", (method) => {
    expect(parseRequest({ ...send, method: "version", params: {} })).toBeTruthy();
    expect(() => parseRequest({ ...send, method, params: {} })).toThrow("invalid-request");
  });
  it("T-RPC-ALLOW keeps unresolved G0 link/unlink methods closed", () => {
    const req = { ...send, method: "startLink", params: {} };
    const contracts = { startLink: { params: z.strictObject({}), result: z.strictObject({ uri: z.string() }) } };
    expect(parseRequest(req, { contracts })).toEqual(req);
    expect(() => parseRequest(req)).toThrow("invalid-request");
    expect(() => parseRequest({ ...req, params: { account: "other" } }, { contracts })).toThrow();
  });
  it("T-HOST closes subscribeReceive without a G0 contract; kills unknown result acceptance", () => {
    const response = { jsonrpc: "2.0", id: 1, result: {} };
    // Synthetic schema tests the gate only; it is not pinned-runtime evidence.
    const contracts = { subscribeReceive: { params: z.strictObject({}), result: z.strictObject({}) } };
    expect(parseResponse("subscribeReceive", response, { contracts })).toEqual(response);
    expect(() => parseResponse("subscribeReceive", response)).toThrow("invalid-frame");
    expect(() => parseResponse("subscribeReceive", { ...response, result: { extra: true } }, { contracts })).toThrow("invalid-frame");
  });
  it.each(["startLink", "finishLink", "unregister"] as const)("T-RPC-ALLOW closes unresolved %s responses", method => {
    const response = { jsonrpc: "2.0", id: 1, result: {} };
    const contracts = { [method]: { params: z.strictObject({}), result: z.strictObject({}) } };
    expect(parseResponse(method, response, { contracts })).toEqual(response);
    expect(() => parseResponse(method, response)).toThrow("invalid-frame");
  });
  it("T-HOST response schemas reject extra keys and result/error mixtures", () => {
    const response = { jsonrpc: "2.0", id: 1, result: { version: "fixture" } };
    expect(parseResponse("version", response)).toEqual(response);
    expect(() => parseResponse("version", { ...response, error: { code: -1, message: "private" } })).toThrow("invalid-frame");
    expect(() => parseResponse("version", { ...response, result: { version: "fixture", extra: true } })).toThrow("invalid-frame");
  });
  it("T-RL-PIN validates the source-shaped error.data.response without loosening errors", () => {
    const error = { code: -5, message: "limited", data: { response: { timestamp: 123, results: [{
      recipientAddress: { uuid: "11111111-1111-4111-8111-111111111111", number: null }, type: "RATE_LIMIT_FAILURE",
    }] } } };
    expect(rateLimitErrorSchema.safeParse(error).success).toBe(true);
    expect(rateLimitErrorSchema.safeParse({ ...error, data: error.data.response }).success).toBe(false);
    // Unknown -5 payloads remain errors for B6's uncertain classification.
    expect(parseResponse("send", { jsonrpc: "2.0", id: 1, error: { ...error, data: {} } })).toHaveProperty("error.code", -5);
  });
});

describe("T-RPC-CONTRACT-FIRST", () => {
  it.each(["startLink", "finishLink", "subscribeReceive", "unregister"] as const)("requires %s contracts for requests, successes AND errors", method => {
    const contracts = { [method]: { params: z.strictObject({}), result: z.strictObject({}) } };
    const req = { jsonrpc: "2.0", id: 1, method, params: {} };
    expect(() => parseRequest(req)).toThrow("invalid-request");
    expect(parseRequest(req, { contracts })).toEqual(req);
    for (const payload of [{ result: {} }, { error: { code: -1, message: "refused" } }]) {
      const frame = { jsonrpc: "2.0", id: 1, ...payload };
      expect(() => parseResponse(method, frame)).toThrow("invalid-frame");
      expect(parseResponse(method, frame, { contracts })).toEqual(frame);
    }
    for (const key of ["deleteAccount", "delete-account", "account", "deviceId"]) {
      expect(() => parseRequest({ ...req, params: { [key]: false } }, { contracts })).toThrow();
    }
  });
});

it("T-UNLINK-DELETE-OPTIONS: even an injected contract cannot authorize number deletion", () => {
  for (const key of ["deleteAccount", "delete-account", "delete_account", "account", "deviceId"]) {
    const contracts = { unregister: { params: z.strictObject({ [key]: z.unknown().optional() }), result: z.strictObject({}) } };
    const req = { jsonrpc: "2.0", id: 1, method: "unregister", params: {} };
    expect(parseRequest(req, { contracts })).toEqual(req);
    for (const value of [true, false, null]) expect(() => parseRequest({ ...req, params: { [key]: value } }, { contracts })).toThrow("invalid-request");
  }
});
