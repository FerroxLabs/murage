// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { topicLabel, TopicSelect } from "./TopicSelect";

describe("the Topic dropdown", () => {
  it("names topics in plain words", () => {
    expect(topicLabel("software-engineering")).toBe("Software engineering");
    expect(topicLabel("sales")).toBe("Sales");
    expect(topicLabel("business-strategy")).toBe("Business strategy");
  });

  it("is one select: All topics first, then each topic with its count", () => {
    const html = renderToStaticMarkup(createElement(TopicSelect, { topics: [{ name: "software-engineering", count: 177 }, { name: "business-strategy", count: 149 }], value: "", onChange: () => {} }));
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html).not.toContain("<button");
    expect(html.indexOf("All topics")).toBeLessThan(html.indexOf("Software engineering (177)"));
    expect(html).toContain("Business strategy (149)");
    expect(html).not.toContain(">software-engineering");
  });
});
