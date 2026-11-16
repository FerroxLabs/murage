// SPDX-License-Identifier: AGPL-3.0-or-later
export const contactRecoveryCases = [
  ['create', { firstName: 'Reviewed' }, 'POST', '/contacts/'],
  ['update', { contactId: 'contact_1', firstName: 'Reviewed' }, 'PUT', '/contacts/contact_1'],
  ['upsert', { firstName: 'Reviewed' }, 'POST', '/contacts/upsert'],
  ['delete', { contactId: 'contact_1' }, 'DELETE', '/contacts/contact_1'],
  ['tags.add', { contactId: 'contact_1', tags: ['a'] }, 'POST', '/contacts/contact_1/tags'],
  ['tags.remove', { contactId: 'contact_1', tags: ['a'] }, 'DELETE', '/contacts/contact_1/tags'],
  ['tags.bulk', { contacts: ['contact_1', 'contact_2'], type: 'add', tags: ['a'] }, 'POST', '/contacts/bulk/tags/update/add'],
  ['notes.create', { contactId: 'contact_1', body: 'Reviewed', userId: 'u1' }, 'POST', '/contacts/contact_1/notes'],
  ['notes.update', { contactId: 'contact_1', noteId: 'note_1', body: 'Reviewed' }, 'PUT', '/contacts/contact_1/notes/note_1'],
  ['notes.delete', { contactId: 'contact_1', noteId: 'note_1' }, 'DELETE', '/contacts/contact_1/notes/note_1'],
  ['tasks.create', { contactId: 'contact_1', title: 'Reviewed', dueDate: '2026-11-20T10:00:00Z' }, 'POST', '/contacts/contact_1/tasks'],
  ['tasks.update', { contactId: 'contact_1', taskId: 'task_1', title: 'Reviewed' }, 'PUT', '/contacts/contact_1/tasks/task_1'],
  ['tasks.complete', { contactId: 'contact_1', taskId: 'task_1', completed: true }, 'PUT', '/contacts/contact_1/tasks/task_1/completed'],
  ['tasks.delete', { contactId: 'contact_1', taskId: 'task_1' }, 'DELETE', '/contacts/contact_1/tasks/task_1'],
  ['followers.add', { contactId: 'contact_1', followers: ['u1'] }, 'POST', '/contacts/contact_1/followers'],
  ['followers.remove', { contactId: 'contact_1', followers: ['u1'] }, 'DELETE', '/contacts/contact_1/followers'],
] as const;
