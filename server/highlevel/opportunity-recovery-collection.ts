import { isReturnedIdentityKey } from "./operations/returned-identity-schemas.ts";
import { highlevelIdSchema } from "./operations/schemas/common.ts";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validId = (v: unknown): v is string => highlevelIdSchema.safeParse(v).success;

/** A location-scoped complete read may contain unrelated records. Validate
 * their declared identity positions before excluding them from the mutation
 * witness. They never supply approved values, receipt IDs or tool output. All
 * other response siblings still go through the shared whole-response gate. */
export function checkRecoveryCollection(records: unknown[], pipeline: boolean, locationId: string): "valid" | "invalid" | "negative" {
  let invalid = false, negative = false;
  const ids = new Set<string>();
  for (const record of records) {
    if (!object(record) || !validId(record.id) || ids.has(record.id)) return "invalid";
    ids.add(record.id);
    const allowed = new Map<string, unknown>();
    const aliases = (container: Record<string, unknown>, path: string, names: string[], required?: unknown) => {
      const values = names.filter(key => Object.hasOwn(container, key)).map(key => container[key]);
      const expected = required === undefined ? values[0] : required;
      if (values.some(v => v !== expected || (v !== null && !validId(v)))) invalid = true;
      for (const name of names) allowed.set(`${path}${name}`, expected);
    };
    aliases(record, "", pipeline ? ["id", "pipelineId", "pipeline_id"] : ["id", "opportunityId", "opportunity_id"], record.id);
    if (pipeline && record.stages !== undefined) {
      if (!Array.isArray(record.stages)) return "invalid";
      const stages = new Set<string>();
      for (const [i, stage] of record.stages.entries()) {
        if (!object(stage) || !validId(stage.id) || stages.has(stage.id)) return "invalid";
        stages.add(stage.id);
        aliases(stage, `stages.${i}.`, ["id", "pipelineStageId", "pipeline_stage_id"], stage.id);
        aliases(stage, `stages.${i}.`, ["pipelineId", "pipeline_id"], record.id);
      }
    }
    if (!pipeline) {
      for (const key of ["pipelineId", "pipelineStageId", "contactId", "assignedTo"]) aliases(record, "", [key, key.replace(/Id$/u, "_id")]);
      if (record.contact !== undefined && record.contact !== null) {
        if (!object(record.contact)) return "invalid";
        aliases(record.contact, "contact.", ["id", "contactId", "contact_id"], record.contactId ?? record.contact_id);
      }
      if (record.followers !== undefined) {
        if (!Array.isArray(record.followers)) return "invalid";
        allowed.set("followers", record.followers);
        const followers = new Set<string>();
        for (const [i, follower] of record.followers.entries()) {
          const id = object(follower) ? follower.id ?? follower.userId ?? follower.user_id ?? follower.followerId ?? follower.follower_id : follower;
          if (!validId(id) || followers.has(id)) return "invalid";
          followers.add(id);
          if (object(follower)) aliases(follower, `followers.${i}.`, ["id", "userId", "user_id", "followerId", "follower_id"], id);
        }
      }
    }
    const visit = (value: unknown, path: string) => {
      if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${path}${i}.`)); return; }
      if (!object(value)) return;
      for (const [key, child] of Object.entries(value)) {
        // Match the shared gate's negative and malformed confirmation rules.
        if (["success", "succeeded", "succeded", "ok", "deleted"].includes(key)) {
          if (typeof child !== "boolean") invalid = true;
          if (child === false) negative = true;
        }
        if ((["error", "errors"].includes(key) && child !== null && child !== false && child !== "" && !(Array.isArray(child) && !child.length))
          || (key === "errorCount" && typeof child === "number" && child > 0)
          || (["statusCode", "status"].includes(key) && typeof child === "number" && child >= 400)
          || (key === "status" && typeof child === "string" && /^(?:failed|failure|error|denied|not_applied)$/iu.test(child))) negative = true;
        if (key === "locationId" || key === "location_id") { if (child !== locationId) invalid = true; }
        else if (isReturnedIdentityKey(key) && (!allowed.has(`${path}${key}`) || allowed.get(`${path}${key}`) !== child)) invalid = true;
        visit(child, `${path}${key}.`);
      }
    };
    visit(record, "");
  }
  return invalid ? "invalid" : negative ? "negative" : "valid";
}
