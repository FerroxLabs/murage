// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { HELP_QUERY_MAX, helpRoute, type HelpSearchAnswer } from "./help-routes.ts";

const get = (query: string, method = "GET") => helpRoute({ method, url: new URL(`http://127.0.0.1/api/help/search${query}`) });

describe("GET /api/help/search", () => {
  it("answers from the shipped docs with quotable sections and app places", () => {
    const answer = get("?q=working%20folder");
    expect(answer?.status).toBe(200);
    const body = answer?.body as HelpSearchAnswer;
    expect(body.query).toBe("working folder");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(5);
    for (const result of body.results) {
      expect(result.url).toMatch(/^https:\/\//);
      expect(result.text.length).toBeGreaterThan(0);
    }
  });

  it("an empty question answers nothing rather than everything", () => {
    expect((get("?q=%20%20")?.body as HelpSearchAnswer).results).toEqual([]);
    expect((get("")?.body as HelpSearchAnswer).results).toEqual([]);
  });

  it("honours limit 1 to 5 and refuses anything else", () => {
    expect((get("?q=routine&limit=1")?.body as HelpSearchAnswer).results.length).toBeLessThanOrEqual(1);
    expect(get("?q=routine&limit=9")?.status).toBe(400);
    expect(get("?q=routine&limit=two")?.status).toBe(400);
  });

  it("cuts a very long question instead of searching all of it", () => {
    expect((get(`?q=${"a".repeat(5000)}`)?.body as HelpSearchAnswer).query.length).toBe(HELP_QUERY_MAX);
  });

  it("a word the shared alias table cannot hold does not break the search", () => {
    expect(get("?q=constructor")?.status).toBe(200);
    expect(get("?q=constructor%20routine")?.status).toBe(200);
    for (const q of ["_constructor_", "x.constructor", "CONSTRUCTOR-routine", "__proto__", "hasOwnProperty"]) expect(get(`?q=${encodeURIComponent(q)}`)?.status, q).toBe(200);
    expect((get("?q=constructor%20routine")?.body as HelpSearchAnswer).results.length).toBeGreaterThan(0);
  });

  it("only answers its own path and GET", () => {
    expect(helpRoute({ method: "GET", url: new URL("http://127.0.0.1/api/help/other") })).toBeNull();
    expect(get("?q=x", "POST")?.status).toBe(405);
  });
});
