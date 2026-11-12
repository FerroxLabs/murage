// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent expected plans for the reviewed F3/F4/F5/F6/F7 implementations.
// These are literal owner-route examples and scope/read expectations, never generated from the planner or manifest.
import type { ScopeVector } from './scope-policy.vectors.ts';
const p = (operation: string): [string, string, number] => [operation, 'prepare', 1];
const r = (operation: string): [string, string, number] => [operation, 'recovery', 1];
const check = (operation: string): [string, string, number] => [operation, 'recheck', 1];
const v = (operation: string, args: Record<string, unknown>, scopes: string[], reads: [string, string, number][], preparation: number): ScopeVector => ({operation,args,scopes,reads,preparation});
const cr=['calendars.readonly'], cw=['calendars.readonly','calendars.write'];
const er=['calendars/events.readonly'], ew=['calendars/events.readonly','calendars/events.write'];
const at='2026-11-12T09:00:00Z', until='2026-11-12T10:00:00Z';
const scope={altId:'loc1',altType:'location'};
const item={name:'Fixture item',currency:'USD',amount:1,qty:1};
const contact={id:'contact1',name:'Fixture buyer',email:'fixture@example.test',phoneNo:'+15550000001'};
const draft={...scope,status:'draft',name:'Fixture invoice',currency:'USD',businessDetails:{name:'Fixture seller'},items:[item],discount:{type:'fixed',value:0},contactDetails:contact,issueDate:'2026-11-11',dueDate:'2026-11-12',sentTo:{email:[contact.email],phoneNo:[contact.phoneNo]},liveMode:false};
const ir=['invoices.readonly'], iw=['invoices.readonly','invoices.write'];
export const INTEGRATED_SCOPE_VECTORS: readonly ScopeVector[] = [
  v('conversations.search',{locationId:'loc1'},['conversations.readonly'],[],0),
  v('conversations.get',{conversationId:'conversation1'},['conversations.readonly'],[],0),
  v('conversations.messages.list',{conversationId:'conversation1'},['conversations.readonly','conversations/message.readonly'],[p('conversations.get')],1),
  v('conversations.message.get',{messageId:'message1'},['conversations/message.readonly'],[],0),
  v('conversations.email.get',{emailMessageId:'email1'},['conversations/message.readonly'],[],0),
  v('conversations.create',{locationId:'loc1',contactId:'contact1'},['contacts.readonly','conversations.readonly','conversations.write'],[p('contacts.get'),['conversations.search','recovery',2]],1),
  v('conversations.update',{locationId:'loc1',conversationId:'conversation1',starred:true},['conversations.readonly','conversations.write'],[p('conversations.get'),r('conversations.get')],1),
  v('conversations.delete',{conversationId:'conversation1'},['conversations.readonly','conversations.write'],[p('conversations.get'),r('conversations.get')],1),
  // Each named transport has the same single-recipient ownership and dispatch
  // reconciliation contract. No conversation ID is supplied: the two-read
  // recipient lookup must remain in the plan, before any provider I/O.
  ...([
    ['sms','SMS'],['email','Email'],['whatsapp','WhatsApp'],
    ['facebook','FB'],['instagram','IG'],['gmb','GMB'],['livechat','Live_Chat'],
    ['scheduledSms','SMS'],['scheduledEmail','Email'],
  ] as const).map(([transport,type]) => v(`conversations.send.${transport}`,
    {type,contactId:'contact1',message:'Fixture message',status:'pending',...(transport.startsWith('scheduled')?{scheduledTimestamp:2_000_000_000}:{})},
    ['contacts.readonly','conversations.readonly','conversations/message.readonly','conversations/message.write'],
    [p('contacts.get'),['conversations.search','prepare',2],p('conversations.messages.list'),p('conversations.get'),['conversations.search','recovery',2],r('conversations.messages.list')],5)),
  v('conversations.schedule.cancel',{messageId:'message1'},['conversations.readonly','conversations/message.readonly','conversations/message.write'],[p('conversations.message.get'),p('conversations.get'),r('conversations.message.get')],2),
  v('conversations.schedule.cancelEmail',{emailMessageId:'email1'},['conversations.readonly','conversations/message.readonly','conversations/message.write'],[p('conversations.email.get'),p('conversations.get'),r('conversations.email.get')],2),
  v('conversations.attachment.upload',{conversationId:'conversation1',file:{workspaceFile:'letter.txt'}},['conversations.readonly','conversations/message.readonly','conversations/message.write'],[p('conversations.get'),p('conversations.messages.list'),r('conversations.messages.list')],2),
  v('calendars.list',{locationId:'loc1'},cr,[],0),
  v('calendars.get',{calendarId:'calendar1'},cr,[],0),
  v('calendars.freeSlots',{calendarId:'calendar1',startDate:1794474000000,endDate:1794477600000},cr,[],0),
  v('calendars.groups.list',{locationId:'loc1'},['calendars/groups.readonly'],[],0),
  v('calendars.resources.list',{locationId:'loc1',limit:10,skip:0,resourceType:'equipments'},['calendars/resources.readonly'],[],0),
  v('calendars.create',{locationId:'loc1',name:'Fixture calendar'},cw,[p('calendars.list'),r('calendars.list')],1),
  v('calendars.update',{calendarId:'calendar1',name:'Fixture calendar'},cw,[p('calendars.get'),r('calendars.get')],1),
  v('calendars.delete',{calendarId:'calendar1'},cw,[p('calendars.get'),r('calendars.get')],1),
  v('calendars.events.list',{locationId:'loc1',startTime:at,endTime:until},er,[],0),
  v('calendars.appointment.get',{eventId:'event1'},er,[],0),
  v('calendars.appointment.book',{calendarId:'calendar1',locationId:'loc1',contactId:'contact1',startTime:at,endTime:until},[...ew,...cr,'contacts.readonly'],[p('calendars.freeSlots'),p('contacts.get'),p('calendars.events.list'),r('calendars.events.list')],3),
  v('calendars.appointment.reschedule',{eventId:'event1',startTime:at,endTime:until},[...ew,...cr],[p('calendars.appointment.get'),p('calendars.freeSlots'),r('calendars.appointment.get')],2),
  v('calendars.appointment.cancel',{eventId:'event1',appointmentStatus:'cancelled'},ew,[p('calendars.appointment.get'),r('calendars.appointment.get')],1),
  v('calendars.event.delete',{eventId:'event1'},ew,[p('calendars.appointment.get'),r('calendars.appointment.get')],1),
  v('calendars.blockSlot.create',{calendarId:'calendar1',locationId:'loc1',startTime:at,endTime:until},ew,[p('calendars.events.list'),r('calendars.events.list')],1),
  v('calendars.blockSlot.update',{eventId:'event1',calendarId:'calendar1',locationId:'loc1',startTime:at,endTime:until},ew,[p('calendars.events.list'),r('calendars.events.list')],1),
  v('calendars.appointmentNotes.list',{appointmentId:'event1',limit:10,offset:0},er,[p('calendars.appointment.get')],1),
  v('calendars.appointmentNotes.create',{appointmentId:'event1',body:'Fixture note'},ew,[p('calendars.appointment.get'),p('calendars.appointmentNotes.list'),r('calendars.appointmentNotes.list')],2),
  v('calendars.appointmentNotes.update',{appointmentId:'event1',noteId:'note1',body:'Fixture note'},ew,[p('calendars.appointment.get'),p('calendars.appointmentNotes.list'),r('calendars.appointmentNotes.list')],2),
  v('calendars.appointmentNotes.delete',{appointmentId:'event1',noteId:'note1'},ew,[p('calendars.appointment.get'),p('calendars.appointmentNotes.list'),r('calendars.appointmentNotes.list')],2),
  v('automations.workflows.list',{locationId:'loc1'},['workflows.readonly'],[],0),
  v('automations.campaigns.list',{locationId:'loc1'},['campaigns.readonly'],[],0),
  v('automations.workflow.addContact',{contactId:'contact1',workflowId:'workflow1'},['contacts.readonly','contacts.write','workflows.readonly'],[p('contacts.get'),p('automations.workflows.list'),r('contacts.get')],2),
  v('automations.workflow.removeContact',{contactId:'contact1',workflowId:'workflow1'},['contacts.readonly','contacts.write','workflows.readonly'],[p('contacts.get'),p('automations.workflows.list'),r('contacts.get')],2),
  v('automations.campaign.addContact',{contactId:'contact1',campaignId:'campaign1'},['campaigns.readonly','contacts.readonly','contacts.write'],[p('contacts.get'),p('automations.campaigns.list'),r('contacts.get')],2),
  v('automations.campaign.removeContact',{contactId:'contact1',campaignId:'campaign1'},['campaigns.readonly','contacts.readonly','contacts.write'],[p('contacts.get'),p('automations.campaigns.list'),r('contacts.get')],2),
  v('automations.campaign.removeAll',{contactId:'contact1'},['contacts.readonly','contacts.write'],[p('contacts.get'),r('contacts.get')],1),
  v('location.get',{},['locations.readonly'],[],0),
  ...([
    ['customFields','locations/customFields','fieldId',{name:'Fixture field',dataType:'TEXT'},{name:'Fixture field'}],
    ['customValues','locations/customValues','valueId',{name:'Fixture value',value:'Fixture'},{name:'Fixture value',value:'Fixture'}],
    ['tags','locations/tags','tagId',{name:'Fixture tag'},{name:'Fixture tag'}],
  ] as const).flatMap(([family,permission,idField,create,update]) => [
    v(`location.${family}.list`,{},[`${permission}.readonly`],[],0),
    v(`location.${family}.get`,{[idField]:'record1'},[`${permission}.readonly`],[],0),
    v(`location.${family}.create`,create,[`${permission}.readonly`,`${permission}.write`],[p(`location.${family}.list`),r(`location.${family}.list`)],1),
    v(`location.${family}.update`,{[idField]:'record1',...update},[`${permission}.readonly`,`${permission}.write`],[p(`location.${family}.get`),r(`location.${family}.get`)],1),
    v(`location.${family}.delete`,{[idField]:'record1'},[`${permission}.readonly`,`${permission}.write`],[p(`location.${family}.get`),r(`location.${family}.get`)],1),
  ]),
  v('location.tasks.search',{},['locations/tasks.readonly'],[],0),
  v('location.templates.list',{originId:'origin1'},['locations/templates.readonly'],[],0),
  v('users.list',{locationId:'loc1'},['users.readonly'],[],0),
  v('users.get',{userId:'user1'},['users.readonly'],[],0),
  v('users.create',{companyId:'company1',email:'fixture@example.test',firstName:'Fixture',lastName:'User',type:'account',role:'user',locationIds:['loc1']},['users.readonly','users.write'],[p('users.list'),r('users.list')],1),
  v('users.update',{userId:'user1',firstName:'Fixture'},['users.readonly','users.write'],[p('users.get'),r('users.get')],1),
  v('users.delete',{userId:'user1'},['users.readonly','users.write'],[p('users.get'),r('users.get')],1),
  v('forms.list',{locationId:'loc1'},['forms.readonly'],[],0),
  v('forms.submissions',{locationId:'loc1',formId:'form1'},['forms.readonly'],[],0),
  v('forms.surveys.list',{locationId:'loc1'},['surveys.readonly'],[],0),
  v('forms.surveys.submissions',{locationId:'loc1',surveyId:'survey1'},['surveys.readonly'],[],0),
  v('payments.invoices.list',{...scope,limit:'20',offset:'0'},ir,[],0),
  v('payments.invoices.get',{...scope,invoiceId:'invoice1'},ir,[],0),
  v('payments.invoice.create',draft,[...iw,'contacts.readonly'],[p('contacts.get'),p('payments.invoices.list'),r('payments.invoices.list'),r('payments.invoices.get')],2),
  v('payments.invoice.update',{...scope,invoiceId:'invoice1',status:'draft',name:'Fixture invoice',currency:'USD',invoiceItems:[item],issueDate:'2026-11-11',dueDate:'2026-11-12'},iw,[p('payments.invoices.get'),check('payments.invoices.get'),r('payments.invoices.get')],2),
  v('payments.invoice.send',{...scope,invoiceId:'invoice1',userId:'user1',action:'email',liveMode:false},iw,[p('payments.invoices.get'),r('payments.invoices.get')],1),
  v('payments.invoice.void',{...scope,invoiceId:'invoice1'},iw,[p('payments.invoices.get'),r('payments.invoices.get')],1),
  v('payments.invoice.delete',{...scope,invoiceId:'invoice1'},iw,[p('payments.invoices.get'),r('payments.invoices.get')],1),
  v('payments.invoice.recordPayment',{...scope,invoiceId:'invoice1',mode:'cash',amount:1,notes:'Fixture payment',card:{brand:'',last4:''},cheque:{number:''}},iw,[p('payments.invoices.get'),r('payments.invoices.get')],1),
  v('payments.invoice.text2pay',{...scope,name:draft.name,currency:'USD',items:[item],contactDetails:contact,issueDate:draft.issueDate,dueDate:draft.dueDate,sentTo:draft.sentTo,liveMode:false,userId:'user1',action:'send'},[...iw,'contacts.readonly'],[p('contacts.get'),p('payments.invoices.list'),r('payments.invoices.list'),r('payments.invoices.get')],2),
  v('payments.orders.list',{altId:'loc1'},['payments/orders.readonly'],[],0),
  v('payments.orders.get',{altId:'loc1',orderId:'order1'},['payments/orders.readonly'],[],0),
  v('payments.transactions.list',scope,['payments/transactions.readonly'],[],0),
  v('payments.transactions.get',{...scope,transactionId:'transaction1'},['payments/transactions.readonly'],[],0),
  v('payments.subscriptions.list',scope,['payments/subscriptions.readonly'],[],0),
  v('payments.subscriptions.get',{...scope,subscriptionId:'subscription1'},['payments/subscriptions.readonly'],[],0),
  v('payments.products.list',{locationId:'loc1'},['products.readonly'],[],0),
  v('payments.products.get',{locationId:'loc1',productId:'product1'},['products.readonly'],[],0),
];
