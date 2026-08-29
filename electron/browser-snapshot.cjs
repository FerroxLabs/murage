// Pure helpers for the built-in browser surface. Nothing here touches
// Electron: the accessibility-tree → element-ref reduction, the navigation
// URL policy and the user-agent scrub are plain functions so they can be
// tested without a window. The ref format and role filter deliberately match
// the cloud box's CDP helper (server/remote-computer.ts) so a bot that learned
// browser_snapshot there reads the same shape here.
"use strict";

/** Roles worth handing to a model as click/fill targets. Structural roles
 * (generic, group, paragraph) are noise; these are the interactive ones plus
 * headings, which anchor "click the link under Pricing" style instructions. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "heading",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

const MAX_SNAPSHOT_ELEMENTS = 250;
const MAX_NAME_LENGTH = 180;
const MAX_VALUE_LENGTH = 120;

/** Value of a CDP AXNode property by name, or undefined. */
function axProperty(node, name) {
  const property = Array.isArray(node?.properties)
    ? node.properties.find((candidate) => candidate?.name === name)
    : undefined;
  return property?.value?.value;
}

/**
 * Reduce a CDP `Accessibility.getFullAXTree` result to the elements a model
 * can act on. Refs are `b<backendDOMNodeId>`: stable for the life of the DOM
 * node, meaningless after the page changes — which is why every action
 * hands back a fresh snapshot.
 */
function snapshotFromAxNodes(nodes, { limit = MAX_SNAPSHOT_ELEMENTS } = {}) {
  const elements = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.ignored === true) continue;
    const role = String(node?.role?.value ?? "").toLowerCase();
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const backend = Number(node?.backendDOMNodeId ?? 0);
    if (!Number.isInteger(backend) || backend <= 0) continue;
    const name = String(node?.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
    const editable = role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton";
    if (!name && !editable) continue;
    const element = { ref: `b${backend}`, role, name: name || "unnamed" };
    if (axProperty(node, "disabled") === true) element.disabled = true;
    const value = node?.value?.value;
    if (editable && value !== undefined && value !== null && String(value).length) {
      element.value = String(value).replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH);
    }
    if (axProperty(node, "checked") !== undefined) element.checked = axProperty(node, "checked");
    elements.push(element);
    if (elements.length >= limit) break;
  }
  return elements;
}

/** One line per element, the shape the box helper's consumers already read. */
function formatSnapshot({ title, url, elements }) {
  const lines = (elements ?? []).map((element) => {
    const flags = [
      element.disabled ? "disabled" : "",
      element.checked === true ? "checked" : element.checked === "mixed" ? "mixed" : "",
      element.value !== undefined ? `value=${JSON.stringify(element.value)}` : "",
    ].filter(Boolean);
    return `${element.ref} ${element.role} ${JSON.stringify(element.name)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  return `Browser snapshot — ${title || "Untitled"}: ${url || "about:blank"}\n${
    lines.join("\n") || "No interactive elements found."
  }`;
}

const NAVIGABLE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The only addresses the surface will load. Bots (and the address bar) may
 * omit the scheme; anything that is not web content — file://, chrome://,
 * javascript:, data: — is refused rather than opened in a privileged shell.
 */
function browserNavigationUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("A web address is required");
  if (text === "about:blank") return text;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (!NAVIGABLE_PROTOCOLS.has(url.protocol)) {
    throw new Error("Only http and https pages can be opened in the browser");
  }
  if (!url.hostname) throw new Error("That web address is invalid");
  return url.toString();
}

/** True when a navigation target is one the surface may follow. */
function browserNavigationAllowed(raw) {
  try {
    browserNavigationUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/** Sites vary behaviour on unfamiliar UA tokens; present as the Chrome that
 * Electron actually is. */
function browserUserAgent(userAgent) {
  return String(userAgent ?? "")
    .replace(/\s?OpenMausBot\/\S+/g, "")
    .replace(/\s?openmausbot\/\S+/g, "")
    .replace(/\s?Electron\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A bot id becomes a durable session partition: logins survive restarts
 * and no two bots share a cookie jar. Only the safe id characters are kept
 * so a hostile id cannot reach outside the partition namespace. */
function browserPartition(botId) {
  const safe = String(botId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) throw new Error("A bot id is required");
  return `persist:openmausbot-browser-${safe}`;
}

/** A named profile is a partition several bots may share — "Work", "Client
 * A" — so one sign-in serves every bot pointed at it. */
function browserProfilePartition(profileId) {
  const safe = String(profileId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) throw new Error("A profile id is required");
  return `persist:openmausbot-browser-profile-${safe}`;
}

const REF = /^b(\d{1,12})$/;

/** The backend DOM node id encoded in a snapshot ref. */
function backendNodeIdFromRef(ref) {
  const match = REF.exec(String(ref ?? "").trim());
  if (!match) throw new Error("invalid or stale browser ref; take a new browser_snapshot");
  return Number(match[1]);
}

module.exports = {
  INTERACTIVE_ROLES,
  MAX_SNAPSHOT_ELEMENTS,
  backendNodeIdFromRef,
  browserNavigationAllowed,
  browserNavigationUrl,
  browserPartition,
  browserProfilePartition,
  browserUserAgent,
  formatSnapshot,
  snapshotFromAxNodes,
};
