import { frozenOperationExtension } from './operation-extension.ts';
import { calendarContextFor } from "./calendar-context.ts";
import { heldOperationHooks } from './operation-hooks.ts';
import { createHash } from "node:crypto";
import { heldRequestBody } from './held-body.ts';
import { HIGHLEVEL_RETURNED_CONFIRMATION_SCHEMAS } from "./operations/returned-confirmation-schemas.ts";
import { tagPostStateFor, validTagSet } from "./returned-confirmation-state.ts";
import type { FrozenRequest, HeldRequest } from "./held-request.ts";
import { canonicalBindingJson as canonicalJson } from "./binding-json.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./operations/manifest.ts";
import { highlevelIdSchema } from "./operations/schemas/common.ts";
import { HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS, isReturnedIdentityKey, returnedIdentityRole, type ReturnedIdentitySchema } from "./operations/returned-identity-schemas.ts";

export type ReturnedIdentityResult =
  | { readonly status: "applied" }
  | { readonly status: "not_applied"; readonly reason: "negative_confirmation" }
  | { readonly status: "conflict"; readonly reason: "request_binding" | "unknown_identity" | "identity_mismatch" | "follower_set" | "unconfirmed" | "malformed_response"; readonly keys: readonly string[] };
export interface BoundReturnedIdentitySchema {
  readonly operation: FrozenRequest["operation"];
  readonly requestDigest: string;
  readonly schema: ReturnedIdentitySchema;
}
interface Binding {
  frozen: FrozenRequest;
  approved: Map<string, Set<string>>;
  body: unknown;
  followers: Set<string> | undefined;
  collections: IdentityCollection[];
}
interface IdentityCollection {
  path: string[];
  member: string[];
  role: string;
  ids: unknown[];
  ordered: boolean;
  items: unknown[];
}
const bindings = new WeakMap<BoundReturnedIdentitySchema, Binding>();
const requestSchemas = new WeakMap<FrozenRequest, BoundReturnedIdentitySchema>();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const validId = (v: unknown): v is string => typeof v === "string" && highlevelIdSchema.safeParse(v).success;
function valuesAt(value: unknown, path: readonly string[]): unknown[] {
  if (!path.length) return [value];
  if (path[0] === "*") return Array.isArray(value) ? value.flatMap(v => valuesAt(v, path.slice(1))) : [];
  if (!value || typeof value !== "object" || !Object.hasOwn(value, path[0])) return [];
  return valuesAt((value as Record<string, unknown>)[path[0]], path.slice(1));
}
const samePath = (pattern: string, path: readonly string[]) => {
  const parts = pattern.split(".");
  return parts.length === path.length && parts.every((p, i) => p === path[i] || (p === "*" && /^\d+$/u.test(path[i])));
};
/** Call only after beginDispatch verified approval/current authority. This binds
 * schema expectations to the exact retained object and wire bytes, without
 * changing FrozenRequest or trusting mutable tool arguments. */
export function prepareReturnedIdentitySchema(held: HeldRequest, locationId: string): BoundReturnedIdentitySchema {
  const frozen = held.frozen;
  const previous = requestSchemas.get(frozen);
  if (previous && !bindings.get(previous)?.approved.get("locationId")?.has(locationId)) throw new Error("HighLevel identity request binding refused");
  const extension = frozenOperationExtension(frozen);
  const row = extension?.row ?? HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === frozen.operation);
  const refuse = (): never => { throw new Error("HighLevel identity request binding refused"); };
  if (!row || row.disposition !== "ready" || row.risk === "R" || row.method !== frozen.method || !validId(locationId)) return refuse();
  const schema = extension?.identities ?? HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS[frozen.operation];
  const copy = held.sendCopy();
  const bytes = copy.body ?? new Uint8Array();
  if (hash(bytes) !== frozen.bodySha256 || copy.method !== frozen.method || copy.url.pathname !== frozen.path
    || hash(canonicalJson(["highlevel-request", 2, frozen.operation, frozen.method, frozen.path, frozen.resource, frozen.query, frozen.bodyKind, frozen.contentType, frozen.bodySha256, frozen.upload,
      ...(frozen.completionKind ? [frozen.completionKind] : [])])) !== frozen.requestDigest) return refuse();
  const approved = new Map<string, Set<string>>();
  const add = (role: string, value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    if (!values.every(validId)) return refuse();
    const set = approved.get(role) ?? new Set<string>();
    for (const id of values) set.add(id);
    approved.set(role, set);
  };
  add("locationId", locationId);
  // Proofs come only from the retained, server-prepared ownership context.
  for (const [role, ids] of Object.entries(held.approvalContextCopy?.()?.identities ?? {})) add(role, ids);
  const actual = frozen.path.replace(/\/$/u, "").split("/");
  const template = row.path.replace(/\/$/u, "").split("/");
  if (actual.length !== template.length) return refuse();
  template.forEach((part, i) => {
    if (!part.startsWith(":")) { if (part !== actual[i]) refuse(); return; }
    const key = part.slice(1);
    if (isReturnedIdentityKey(key)) add(schema.identities[key] ?? key, decodeURIComponent(actual[i]));
  });
  const body = heldRequestBody(frozen, copy);
  for (const [role, value] of Object.entries(calendarContextFor(frozen)?.parents ?? {})) {
    if (!frozen.operation.startsWith("calendars.") || !["calendarId", "contactId", "assignedUserId", "appointmentId", "userId", "groupId"].includes(role)) return refuse();
    // An explicit reassignment supersedes the observed pre-change assignee.
    if (role === "assignedUserId" && body && typeof body === "object" && Object.hasOwn(body, "assignedUserId")) continue;
    add(role, value);
  }
  for (const source of schema.sources) {
    for (const value of valuesAt(body, source.path.split("."))) add(source.role, value);
  }
  for (const [key, value] of frozen.query) if (Object.hasOwn(schema.identities, key)) add(schema.identities[key], value);
  if (approved.get("locationId")?.size !== 1) return refuse();
  const bodyRecord = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const followers = Array.isArray(bodyRecord.followers) ? new Set(bodyRecord.followers as string[]) : undefined;
  if (followers && followers.size !== (bodyRecord.followers as unknown[]).length) return refuse();
  if (frozen.operation.includes(".followers.") && !followers) return refuse();
  // Preserve each array's identity slots instead of reducing all request IDs
  // to a role-wide set. Wildcard sources describe keyed members; created
  // missing_request_id slots additionally bind children by array position.
  const collections: IdentityCollection[] = [];
  for (const source of schema.sources) {
    const collect = (value: unknown, parts: string[], path: string[]): void => {
      if (Array.isArray(value) && (!parts.length || (parts[0] === "*" && !parts.slice(1).includes("*")))) {
        const member = parts.slice(1);
        const ids = value.map(item => valuesAt(item, member)[0]);
        const ordered = schema.created.some(s => s.role === source.role && s.when === "missing_request_id");
        if (!ids.some(id => id !== undefined) && !ordered && value.length) return;
        if (collections.some(c => c.role === source.role && c.path.join(".") === path.join(".") && c.member.join(".") === member.join("."))) return;
        const present = ids.filter(id => id !== undefined);
        if (new Set(present).size !== present.length) return refuse();
        collections.push({ path, member, role: source.role, ids, ordered, items: value });
        return;
      }
      if (!parts.length) return;
      if (parts[0] === "*") {
        if (Array.isArray(value)) value.forEach((item, i) => collect(item, parts.slice(1), [...path, String(i)]));
      } else if (value && typeof value === "object" && Object.hasOwn(value, parts[0])) {
        collect((value as Record<string, unknown>)[parts[0]], parts.slice(1), [...path, parts[0]]);
      }
    };
    collect(body, source.path.split("."), []);
  }
  const bound = Object.freeze({ operation: frozen.operation, requestDigest: frozen.requestDigest, schema });
  bindings.set(bound, { frozen, approved, body, followers, collections });
  requestSchemas.set(frozen, bound);
  return bound;
}

/** Existing two-argument family hooks retrieve only the binding installed for
 * their exact retained frozen object. Missing preparation refuses; no shared
 * last-prepared state and no signature change to recordId/project are needed. */
export function returnedIdentitySchemaFor(frozen: FrozenRequest): BoundReturnedIdentitySchema {
  const schema = requestSchemas.get(frozen);
  if (!schema) throw new Error("HighLevel identity request binding missing");
  return schema;
}

/** Complete structural validation before projection, receipt or applied settlement.
 * No response value is returned or logged, including in refusal diagnostics. */
export function bindReturnedIdentities(response: unknown, frozen: FrozenRequest, opSchema: BoundReturnedIdentitySchema): ReturnedIdentityResult {
  const conflict = (reason: Extract<ReturnedIdentityResult, { status: "conflict" }>["reason"], keys: string[] = []): ReturnedIdentityResult => ({ status: "conflict", reason, keys: [...new Set(keys)].sort() });
  const binding = bindings.get(opSchema);
  if (!binding || binding.frozen !== frozen || opSchema.requestDigest !== frozen.requestDigest || opSchema.operation !== frozen.operation) return conflict("request_binding");
  if (!response || typeof response !== "object") return conflict("malformed_response");
  try {
    if (hash(canonicalJson(["highlevel-request", 2, frozen.operation, frozen.method, frozen.path, frozen.resource, frozen.query, frozen.bodyKind, frozen.contentType, frozen.bodySha256, frozen.upload,
      ...(frozen.completionKind ? [frozen.completionKind] : [])])) !== opSchema.requestDigest) return conflict("request_binding");
  } catch { return conflict("request_binding"); }
  const schema = opSchema.schema;
  const confirmation = HIGHLEVEL_RETURNED_CONFIRMATION_SCHEMAS[schema.operation];
  const expectedTags = tagPostStateFor(frozen);
  let tagsConfirmed = false, tagsMismatch = false;
  const unknown = new Set<string>(), mismatched = new Set<string>();
  const newIds = new Map<string, string>();
  const collectionSeen = new Set<IdentityCollection>();
  // The wire request calls these items; the documented invoice response calls
  // them invoiceItems. Match slots in both paths without replacing or dropping
  // any original response fields, including conflicting sibling aliases.
  const identityPath = (path: readonly string[]) =>
    ['payments.invoice.create', 'payments.invoice.text2pay'].includes(frozen.operation)
      ? path.map(part => part === 'invoiceItems' ? 'items' : part) : path;
  const endsWithPath = (path: readonly string[], suffix: readonly string[]) => path.length >= suffix.length && suffix.every((p, i) => identityPath(path)[path.length - suffix.length + i] === p);
  const seen = new Set<object>();
  const queue: { value: unknown; path: string[] }[] = [{ value: response, path: [] }];
  let negative = false, malformed = false, confirmed = false, followerSeen = false, followerMismatch = false;
  const checkId = (value: unknown, role: string, path: string[]): boolean => {
    if (!validId(value)) return false;
    // Check approved IDs against their own declared slot BEFORE accepting
    // role membership. A sibling's approved ID is not approval for this slot.
    for (const collection of binding.collections.filter(c => c.ordered && c.role === role)) {
      const offset = path.length - collection.member.length - 1;
      if (!endsWithPath(path.slice(0, offset), collection.path)) return false;
      const index = Number(path[offset]);
      if (!Number.isSafeInteger(index) || index < 0 || index >= collection.ids.length) return false;
      if (collection.ids[index] !== undefined && collection.ids[index] !== value) return false; // F021_APPROVED_SLOT
      if (collection.ids[index] === undefined && binding.approved.get(role)?.has(value)) return false;
    }
    if (binding.approved.get(role)?.has(value)) return true;
    const slot = schema.created.find(s => s.role === role && samePath(s.path, path));
    if (!slot || [...binding.approved.values()].some(ids => ids.has(value))) return false;
    if (slot.when === "new" && ((response as Record<string, unknown>).new !== true || binding.approved.has(role))) return false;
    if (slot.when === "always" && binding.approved.has(role)) return false;
    if (slot.when === "missing_request_id") {
      const index = path.find(p => /^\d+$/u.test(p));
      if (index === undefined) return false;
      const stage = valuesAt(binding.body, ["stages", index])[0];
      if (!stage || typeof stage !== "object" || Object.hasOwn(stage, "id")) return false;
    }
    // Aliases for one created record must agree; array-created children are
    // distinct roles by index and may each receive their own new provider ID.
    const scope = `${role}:${path.filter(p => /^\d+$/u.test(p)).join(".")}`;
    if (newIds.has(scope) && newIds.get(scope) !== value) return false;
    if ([...newIds].some(([other, id]) => other !== scope && other.startsWith(`${role}:`) && id === value)) return false;
    newIds.set(scope, value);
    return true;
  };
  while (queue.length) {
    const { value, path } = queue.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (seen.has(value)) { malformed = true; continue; }
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) queue.push({ value: value[i], path: [...path, String(i)] }); // F02_ARRAY_RECURSION
      continue;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) malformed = true;
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (confirmation.kind === "tag_post_state" && key === confirmation.field) {
        const matches = !!expectedTags && validTagSet(child) && child.length === expectedTags.length && child.every(tag => expectedTags.includes(tag));
        if (!matches) tagsMismatch = true;
        else if (path.length === 0) tagsConfirmed = true;
      }
      for (const collection of binding.collections) {
        // Follower aliases retain the existing exact-set/action validation.
        if (collection.role === "followerId") continue;
        if (!endsWithPath(childPath, collection.path)) continue;
        collectionSeen.add(collection);
        if (!Array.isArray(child)) { mismatched.add(key); continue; }
        const ids = child.map(item => valuesAt(item, collection.member)[0]);
        if (ids.length !== collection.ids.length || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length
          || (!collection.ordered && ids.some(id => !collection.ids.includes(id)))) mismatched.add(key);
        if (collection.ordered) child.forEach((item, index) => {
          const expected = collection.items[index];
          if (item && typeof item === "object" && Object.hasOwn(item, "position") && expected && typeof expected === "object"
            && (item as Record<string, unknown>).position !== (expected as Record<string, unknown>).position) mismatched.add(key);
        });
      }
      if (["success", "succeeded", "succeded", "ok"].includes(key) || (key === "deleted" && frozen.method === "DELETE")) {
        if (typeof child !== "boolean") malformed = true;
        if (child === false) negative = true;
        if (child === true && path.length === 0) confirmed = true;
      }
      if ((["error", "errors"].includes(key) && child !== undefined && child !== null && child !== false && child !== "" && !(Array.isArray(child) && child.length === 0))
        || (key === "errorCount" && typeof child === "number" && child > 0)
        || (["statusCode", "status"].includes(key) && typeof child === "number" && child >= 400)
        || (key === "status" && typeof child === "string" && /^(?:failed|failure|error|denied|not_applied)$/iu.test(child))) negative = true;
      // The provider's root user object is a declared resource container. Its
      // identities are checked during traversal; it is not a scalar user alias.
      const userContainer = key === 'user' && path.length === 0 && frozen.operation.startsWith('users.')
        && child !== null && typeof child === 'object' && !Array.isArray(child);
      if (!userContainer && (isReturnedIdentityKey(key) || Object.hasOwn(schema.identities, key))) {
        if (!Object.hasOwn(schema.identities, key)) unknown.add(key);
        else if (["followers", "followersAdded", "followersRemoved", "followerIds"].includes(key)) {
          followerSeen = true;
          const action = frozen.operation.endsWith(".remove") ? "remove" : frozen.operation.endsWith(".add") ? "add"
            : (binding.body as Record<string, unknown>)?.followersActionType;
          if ((key === "followersAdded" && action === "remove") || (key === "followersRemoved" && action === "add")) followerMismatch = true;
          const ids = Array.isArray(child) ? child.map(item => {
            if (validId(item)) return item;
            if (!item || typeof item !== "object") return undefined;
            const aliases = ["id", "userId", "user_id", "followerId", "follower_id"].filter(k => Object.hasOwn(item, k)).map(k => (item as Record<string, unknown>)[k]);
            return aliases.length && aliases.every(id => validId(id) && id === aliases[0]) ? aliases[0] as string : undefined;
          }) : [];
          const expected = binding.followers;
          if (!Array.isArray(child) || !expected || ids.some(id => !id || !expected.has(id)) || new Set(ids).size !== ids.length || ids.length !== expected.size) followerMismatch = true;
        } else {
          const role = returnedIdentityRole(key, path, schema.primary);
          const values = Array.isArray(child) ? child : [child];
          if (values.length === 0 || values.some((id, index) => !checkId(id, role, Array.isArray(child) ? [...childPath, String(index)] : childPath))) mismatched.add(key);
          else if (role === schema.primary && (path.length === 0 || (path.length === 1 && returnedIdentityRole("id", path, "") === schema.primary))) confirmed = true;
        }
      }
      if (child !== null && typeof child === "object") queue.push({ value: child, path: childPath });
    }
  }
  if (malformed) return conflict("malformed_response");
  if (unknown.size) return conflict("unknown_identity", [...unknown]);
  if (mismatched.size) return conflict("identity_mismatch", [...mismatched]);
  if (followerMismatch) return conflict("follower_set");
  if (negative) return { status: "not_applied", reason: "negative_confirmation" };
  if (binding.followers && !followerSeen) return conflict("follower_set");
  if (binding.collections.some(c => c.role !== "followerId" && !collectionSeen.has(c))) return conflict("identity_mismatch");
  if (confirmation.kind === "tag_post_state" && (!tagsConfirmed || tagsMismatch)) return conflict("unconfirmed");
  if (!confirmed && heldOperationHooks.get(frozen)?.confirmsResponse?.(response, frozen)) confirmed = true;
  if (!tagsConfirmed && !confirmed && !(followerSeen && frozen.operation.includes(".followers."))) return conflict("unconfirmed");
  return { status: "applied" };
}
