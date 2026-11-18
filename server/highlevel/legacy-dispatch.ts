// PROVISIONAL INTERFACE: legacy dispatcher moved intact from tools.ts while C2 installs family dispatch.
// Old readers continue working during the parallel merge; no new family imports or edits this file.
import type { HighLevelToolName } from "../../shared/highlevel.ts";
import { HighLevelError, type ContactFields, type HighLevelCrm } from "./client.ts";
import { changeProblem, changedFields, type HighLevelWriteRecord } from "./tools.ts";

/** Runs one checked, authorized CRM call. The write record is set only when a change succeeded. HighLevelError and
 * HighLevelStopped pass through so the caller can record the outcome. */
export async function runHighLevelTool(crm: HighLevelCrm, name: HighLevelToolName, args: Record<string, unknown>): Promise<{ value: unknown; write?: HighLevelWriteRecord }> {
  const { connectionId: _connection, ...a } = args as Record<string, any>;
  const problem = changeProblem(name, a);
  if (problem) throw new HighLevelError(problem, { status: 400 });
  switch (name) {
    case "HIGHLEVEL_SEARCH_CONTACTS": return { value: await crm.searchContacts(a) };
    case "HIGHLEVEL_GET_CONTACT": return { value: await crm.getContact(a.contactId) };
    case "HIGHLEVEL_CREATE_CONTACT": {
      const contact = await crm.createContact(a as ContactFields);
      return { value: contact, write: { tool: name, kind: "contact", recordId: contact.id, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_UPDATE_CONTACT": {
      const { contactId, ...fields } = a;
      const contact = await crm.updateContact(contactId, fields as ContactFields);
      return { value: contact, write: { tool: name, kind: "contact", recordId: contactId, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_ADD_TAGS": return { value: await crm.addTags(a.contactId, a.tags), write: { tool: name, kind: "tags", recordId: a.contactId, fields: ["tags"] } };
    case "HIGHLEVEL_REMOVE_TAGS": return { value: await crm.removeTags(a.contactId, a.tags), write: { tool: name, kind: "tags", recordId: a.contactId, fields: ["tags"] } };
    case "HIGHLEVEL_LIST_NOTES": return { value: await crm.listNotes(a.contactId) };
    case "HIGHLEVEL_ADD_NOTE": {
      const out = await crm.addNote(a.contactId, a.body);
      return { value: out, write: { tool: name, kind: "note", recordId: out.note.id, fields: ["body"] } };
    }
    case "HIGHLEVEL_LIST_TASKS": return { value: await crm.listTasks(a.contactId) };
    case "HIGHLEVEL_ADD_TASK": {
      const { contactId, ...task } = a;
      const out = await crm.addTask(contactId, task as { title: string; dueDate: string; body?: string; assignedTo?: string });
      return { value: out, write: { tool: name, kind: "task", recordId: out.task.id, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_LIST_PIPELINES": return { value: await crm.listPipelines() };
    case "HIGHLEVEL_SEARCH_OPPORTUNITIES": return { value: await crm.searchOpportunities({ ...a, status: a.status === "all" ? undefined : a.status }) };
    case "HIGHLEVEL_GET_OPPORTUNITY": return { value: await crm.getOpportunity(a.opportunityId) };
    case "HIGHLEVEL_CREATE_OPPORTUNITY": {
      const out = await crm.createOpportunity(a as { pipelineId: string; stageId?: string; contactId: string; name: string; value?: number; status?: string });
      return { value: out, write: { tool: name, kind: "opportunity", recordId: out.id, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_UPDATE_OPPORTUNITY": {
      const { opportunityId, ...fields } = a;
      const out = await crm.updateOpportunity(opportunityId, fields);
      return { value: out, write: { tool: name, kind: "opportunity", recordId: opportunityId, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_SEARCH_CONVERSATIONS": return { value: await crm.searchConversations(a) };
    case "HIGHLEVEL_READ_CONVERSATION": return { value: await crm.readConversation(a.conversationId, a) };
    case "HIGHLEVEL_LIST_CALENDARS": return { value: await crm.listCalendars() };
    case "HIGHLEVEL_LIST_EVENTS": return { value: await crm.listEvents(a as { startTime: string; endTime: string; calendarId?: string; userId?: string }) };
    case "HIGHLEVEL_GET_LOCATION": return { value: await crm.getLocation() };
  }
}
