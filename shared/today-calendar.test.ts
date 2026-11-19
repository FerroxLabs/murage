// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import * as c from "./today-calendar";
import fixture from "../server/testing/fixtures/today-calendar/contract-v1.json";
import accounts from "../server/testing/fixtures/today-calendar/accounts-same-label.json";
import pages from "../server/testing/fixtures/today-calendar/default-changed.json";
import normalization from "../server/testing/fixtures/today-calendar/events-normalization.json";
import pagination from "../server/testing/fixtures/today-calendar/pagination-errors.json";
import preferences from "../server/testing/fixtures/today-calendar/preferences-v1.json";

const absent = (value: object, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
describe("Today C0 contracts", () => {
  it("strict-api-validation", () => {
    expect(c.settingsMutationSchema.safeParse(fixture.mutation).success).toBe(true);
    for (const bad of [
      {...fixture.mutation, extra: true}, absent(fixture.mutation, "mutationId"),
      {...fixture.mutation, enabled: "yes"}, {...fixture.mutation, syncZone: "Not/AZone"},
      {...fixture.mutation, morningTime: "24:00"}, {...fixture.mutation, expectedGeneration: -1},
      {...fixture.mutation, expectedGeneration: Number.MAX_SAFE_INTEGER + 1},
      {...fixture.mutation, selection: [{...fixture.mutation.selection[0], accountId: ""}]},
      {...fixture.mutation, selection: [{...fixture.mutation.selection[0], accountId: "界".repeat(342)}]},
      {...fixture.mutation, selection: [...fixture.mutation.selection, ...fixture.mutation.selection]},
      {...fixture.mutation, selection: accounts.tooManyCalendars.map(s => ({accountId:s.accountId,calendarId:s.calendarId,discoveryId:"d"}))},
    ]) expect(c.settingsMutationSchema.safeParse(bad).success, JSON.stringify(bad).slice(0,160)).toBe(false);
    expect(c.matchesStamp(fixture.stamp, {...fixture.stamp, ownerEpoch:"old"})).toBe(false);
    expect(c.matchesStamp(fixture.stamp, {...fixture.stamp, generation:0})).toBe(false);
    expect(c.matchesStamp(fixture.stamp, {...fixture.stamp, snapshotRevision:1})).toBe(false);
    expect(c.matchesStamp(fixture.stamp, fixture.stamp)).toBe(true);
    for (const valid of preferences.valid) expect(c.preferencesSchema.safeParse(valid).success).toBe(true);
    for (const bad of preferences.invalid) expect(c.preferencesSchema.safeParse(bad.value).success, bad.name).toBe(false);
    expect(c.ownerInvalidationSchema.safeParse({...fixture.stamp,reason:"published",rows:[]}).success).toBe(false);
  });
  it("complete-state-transitions", () => {
    const transitions: Record<string,string[]> = {
      queued:["claimed","cancelled","expired"], claimed:["running","cancelled","expired","interrupted"],
      running:["succeeded","retry_wait","failed","cancelled","expired","interrupted"],
      retry_wait:["claimed","cancelled","expired"], interrupted:["retry_wait","failed","expired","cancelled"],
      succeeded:[],failed:[],cancelled:[],expired:[],
    };
    for (const from of Object.keys(transitions)) for (const to of Object.keys(transitions)) expect(c.canTransitionRun(from,to), `${from} -> ${to}`).toBe(transitions[from].includes(to));
    expect(c.canTransitionRun("unknown","running")).toBe(false);
    expect(c.canTransitionRun("queued","unknown")).toBe(false);
  });
  it("broker-version-refusal", () => {
    expect(c.brokerRequestSchema.safeParse(fixture.request).success).toBe(true);
    expect(c.brokerResponseSchema.safeParse(fixture.response).success).toBe(true);
    for (const schema of [c.brokerRequestSchema,c.brokerResponseSchema]) {
      const value = schema === c.brokerRequestSchema ? fixture.request : fixture.response;
      expect(schema.safeParse({...value,contract:"murage.today-calendar/2"}).success).toBe(false);
      expect(schema.safeParse({...value,providerVersion:"google-calendar-v3/2"}).success).toBe(false);
      expect(schema.safeParse({...value,url:"https://example.invalid"}).success).toBe(false);
    }
  });
  it("exact-account-routing", () => {
    expect(c.matchesBrokerResponse(fixture.request,fixture.response,"principal-A")).toBe(true);
    for (const bad of [pages.foreignResponse,{...fixture.response,accountId:"account-B"},{...fixture.response,requestId:"22222222-2222-4222-8222-222222222222"},{...fixture.response,ownerBinding:"principal-B"}]) expect(c.matchesBrokerResponse(fixture.request,bad,"principal-A")).toBe(false);
  });
  it("same-label-default-change", () => {
    expect(accounts.accounts[0].label).toBe(accounts.accounts[1].label);
    expect(accounts.accounts[0].accountId).not.toBe(accounts.accounts[1].accountId);
    expect(pages.pages.map(p=>p.sessionDefault)).toEqual(["account-A","account-B"]);
    for (const page of pages.pages) {
      expect(c.matchesBrokerResponse(page.request,page.response,"principal-A")).toBe(true);
      expect(c.matchesBrokerResponse(page.request,{...page.response,accountId:"account-B"},"principal-A")).toBe(false);
    }
    expect(pages.pages[0].response.nextPageToken).toBe(pages.pages[1].request.pageToken);
    expect(pages.pages[1].response.nextPageToken).toBeNull();
  });
  it("selection-union-strict", () => {
    const selection = fixture.mutation.selection[0];
    for (const discoveryId of [null,"fresh"]) expect(c.settingsMutationSchema.safeParse({...fixture.mutation,selection:[{...selection,discoveryId}]}).success).toBe(true);
    for (const bad of [absent(selection,"discoveryId"),{...selection,discoveryId:""},{...selection,discoveryId:"x".repeat(201)},{...selection,discoveryId:1}]) expect(c.settingsMutationSchema.safeParse({...fixture.mutation,selection:[bad]}).success).toBe(false);
  });
  it("capabilities-stepup-enum", () => {
    for (const stepUp of ["none","native","web-device-key","web-passkey"]) expect(c.capabilitiesSchema.safeParse({...fixture.capabilities,stepUp}).success).toBe(true);
    for (const bad of [absent(fixture.capabilities,"stepUp"),{...fixture.capabilities,stepUp:"browser"},{...fixture.capabilities,requiresStepUp:["execute"]},{...fixture.capabilities,canRead:1},{...fixture.capabilities,extra:true}]) expect(c.capabilitiesSchema.safeParse(bad).success).toBe(false);
  });
});

describe("Today frozen unions and boundary fixtures", () => {
  const common = {contract:fixture.request.contract,providerVersion:fixture.request.providerVersion,requestId:fixture.request.requestId};
  const selection = accounts.selection;
  const settings = {version:1,enabled:true,generation:1,ownerBinding:fixture.ownerBinding,selection,morningTime:"06:00",syncZone:"America/New_York",showTitles:true,showAllDay:true,consentedAt:100,lastMutationId:fixture.mutation.mutationId};
  const owner = {...absent(absent(settings,"ownerBinding"),"consentedAt"),hasConsent:true};
  const coverage = {start:Date.parse(fixture.request.timeMin),end:Date.parse(fixture.request.timeMax),date:"2026-11-10",zone:"America/New_York"};
  const when = {kind:"timed",start:coverage.start+100,end:coverage.start+200};
  const row = {id:"opaque-hmac-row",calendarLabel:"Calendar",sourceZone:"America/New_York",privacy:"default",tentative:false,title:"SYNTHETIC_TITLE_CANARY",when};
  const snapshot = {...fixture.stamp,status:"ready",error:null,checkedAt:coverage.start+50,coverage,expiresAt:coverage.end,nextCheckAt:null,activeRun:null,rows:[row],complete:true};
  const settingsResponse = {...fixture.stamp,settings:owner,connections:accounts.accounts,connectionStatus:"known",capabilities:fixture.capabilities,status:"ready",error:null,nextCheckAt:null};
  it("all broker operations and typed failures are strict", () => {
    for (const operation of ["accounts","calendars"] as const) {
      const request = { ...common,operation,provider:"googlecalendar",pageToken:null,...(operation === "calendars" ? {accountId:"account-A",pageSize:100} : {}) };
      const response = {...common,ok:true,operation,ownerBinding:"principal-A",accountId:operation === "accounts" ? null : "account-A",items:operation === "accounts" ? accounts.accounts : [{calendarId:"calendar-A",label:"Calendar",timeZone:"UTC",primary:true,access:"reader"}],nextPageToken:null};
      expect(c.brokerRequestSchema.safeParse(request).success).toBe(true);
      expect(c.brokerResponseSchema.safeParse(response).success).toBe(true);
      expect(c.matchesBrokerResponse(request,response,"principal-A")).toBe(true);
      expect(c.brokerRequestSchema.safeParse({...request,ownerBinding:"principal-A"}).success).toBe(false);
      expect(c.brokerResponseSchema.safeParse({...response,sessionId:"default"}).success).toBe(false);
    }
    for (const code of c.BROKER_ERROR_CODES) {
      const response = {...common,ok:false,error:{code,retryAfterMs:null}};
      expect(c.brokerResponseSchema.safeParse(response).success).toBe(true);
      expect(c.matchesBrokerResponse(fixture.request,response,"principal-A")).toBe(true);
      expect(c.brokerResponseSchema.safeParse({...response,error:{...response.error,message:"SYNTHETIC_CREDENTIAL_CANARY"}}).success).toBe(false);
    }
    for (const patch of [{singleEvents:false},{showDeleted:true},{pageSize:101},{pageToken:"x".repeat(4097)},{timeMax:fixture.request.timeMin},{timeMax:"2026-11-13T05:00:00Z"},{timeMin:"2026-11-10T05:00:00+01:00"}]) expect(c.brokerRequestSchema.safeParse({...fixture.request,...patch}).success).toBe(false);
  });
  it("primitive boundaries preserve identity and reject malformed dates", () => {
    expect(c.idSchema.parse(" Account-A ")).toBe(" Account-A ");
    expect(c.idSchema.safeParse("界".repeat(341)).success).toBe(true);
    expect(c.idSchema.safeParse("界".repeat(342)).success).toBe(false);
    expect(c.idSchema.safeParse("\ud800").success).toBe(false);
    for (const good of ["2024-02-29","2000-02-29","2026-11-10"]) expect(c.civilDateSchema.safeParse(good).success).toBe(true);
    for (const bad of ["2026-02-29","1900-02-29","2026-02-30","2026-13-01","2026-01-00","2026-1-1"]) expect(c.civilDateSchema.safeParse(bad).success).toBe(false);
    for (const good of ["2026-11-10T12:00:00Z","2026-11-10T12:00:00+14:00","2026-11-10T12:00:00.123-05:00"]) expect(c.dateTimeSchema.safeParse(good).success).toBe(true);
    for (const bad of ["2026-02-30T12:00:00Z","2026-11-10T24:00:00Z","2026-11-10T12:00:00","2026-11-10T12:00:00+25:00"]) expect(c.dateTimeSchema.safeParse(bad).success).toBe(false);
    expect(c.dateValueSchema.safeParse({date:"2026-11-10",dateTime:"2026-11-10T12:00:00Z"}).success).toBe(false);
    expect(c.zoneSchema.safeParse("+01:00").success).toBe(false);
    expect(c.instantSchema.safeParse(Infinity).success).toBe(false);
    expect(c.counterSchema.safeParse(0.5).success).toBe(false);
    expect(c.labelSchema.safeParse("Calendar\u202e").success).toBe(false);
    expect(c.sanitizeTodayText("\u0000\u202e",120,"Calendar")).toBe("Calendar");
    expect(c.sanitizeTodayText("😀".repeat(121),120,"Calendar")).toBe("😀".repeat(120));
  });
  it("preferences are a bounded inactive projection in both languages", () => {
    for (const valid of preferences.valid) expect(c.parseInactivePreferences(JSON.stringify(valid))).toEqual(valid);
    for (const bad of preferences.invalid) expect(()=>c.parseInactivePreferences(JSON.stringify(bad.value)),bad.name).toThrow();
    expect(()=>c.parseInactivePreferences(" ".repeat(65536)+JSON.stringify(preferences.valid[0]))).toThrow();
    expect(()=>c.parseInactivePreferences(new Uint8Array([0xff,0xfe]))).toThrow();
    expect(c.TODAY_CALENDAR_PREFERENCES_PATH).toBe("today-calendar-preferences.json");
    expect(c.preferencesSchema.safeParse({...preferences.valid[0],selection:[{...selection[0],calendarId:"A\u0000B"},{...selection[0],calendarId:"A",accountId:"account-A\u0000B"}]}).success).toBe(true);
    const huge = {...preferences.valid[0],selection:Array.from({length:20},(_,i)=>({...selection[0],accountId:"\u0000".repeat(1020)+i,calendarId:"\u0000".repeat(1024)}))};
    expect(c.preferencesSchema.safeParse(huge).success).toBe(false);
  });
  it("settings and all HTTP request unions reject consent and principal forgery", () => {
    expect(c.settingsV1Schema.safeParse(settings).success).toBe(true);
    expect(c.settingsV1Schema.safeParse({...settings,enabled:false,consentedAt:null}).success).toBe(true);
    for (const patch of [{ownerBinding:null},{consentedAt:null},{selection:[]},{version:2}]) expect(c.settingsV1Schema.safeParse({...settings,...patch}).success).toBe(false);
    expect(c.settingsV1Schema.safeParse({...settings,enabled:false}).success).toBe(false);
    expect(c.ownerSettingsSchema.safeParse(owner).success).toBe(true);
    expect(c.ownerSettingsSchema.safeParse({...owner,ownerBinding:fixture.ownerBinding}).success).toBe(false);
    expect(c.ownerSettingsSchema.safeParse({...owner,hasConsent:false}).success).toBe(false);
    const expected = {expectedEpoch:"epoch-A",expectedGeneration:1};
    const requests = [
      [c.discoveryAccountsRequestSchema,{...expected,requestId:common.requestId,metadataConsent:true}],
      [c.discoveryCalendarsRequestSchema,{...expected,requestId:common.requestId,metadataConsent:true,accountId:"account-A"}],
      [c.refreshRequestSchema,{...expected,requestId:common.requestId}],
      [c.stopRequestSchema,{...expected,mutationId:common.requestId}],
    ] as const;
    for (const [schema,request] of requests) {
      expect(schema.safeParse(request).success).toBe(true);
      expect(schema.safeParse({...request,providerToken:"SYNTHETIC_CREDENTIAL_CANARY"}).success).toBe(false);
      expect(schema.safeParse(absent(request,"expectedEpoch")).success).toBe(false);
    }
    expect(c.discoveryAccountsRequestSchema.safeParse({...requests[0][1],metadataConsent:false}).success).toBe(false);
    expect(c.settingsResponseSchema.safeParse(settingsResponse).success).toBe(true);
    expect(c.settingsResponseSchema.safeParse({...settingsResponse,generation:2}).success).toBe(false);
    expect(c.mutationResponseSchema.safeParse({...settingsResponse,mutationId:common.requestId}).success).toBe(true);
    expect(c.mutationResponseSchema.safeParse({...settingsResponse,mutationId:"22222222-2222-4222-8222-222222222222"}).success).toBe(false);
  });
  it("discovery and refresh are complete stamped metadata without meetings", () => {
    const commonResponse = {...fixture.stamp,complete:true,discoveryId:"d",expiresAt:1000};
    const accountResponse = {...commonResponse,accounts:accounts.accounts};
    const calendarResponse = {...commonResponse,accountId:"account-A",calendars:[{calendarId:"c",label:"Calendar",timeZone:"UTC",primary:true,access:"owner"}]};
    expect(c.discoveryAccountsResponseSchema.safeParse(accountResponse).success).toBe(true);
    expect(c.discoveryCalendarsResponseSchema.safeParse(calendarResponse).success).toBe(true);
    expect(c.discoveryAccountsResponseSchema.safeParse({...accountResponse,complete:false}).success).toBe(false);
    expect(c.discoveryCalendarsResponseSchema.safeParse({...calendarResponse,rows:[]}).success).toBe(false);
    const response = {...fixture.stamp,runId:common.requestId,coalesced:true,runStatus:"retry_wait",nextAttemptAt:200,manualNotBefore:300};
    expect(c.refreshResponseSchema.safeParse(response).success).toBe(true);
    expect(c.refreshResponseSchema.safeParse({...response,rows:[row]}).success).toBe(false);
  });
  it("scheduler and job unions retain strict bounded durable metadata", () => {
    const claim = {runId:common.requestId,leaseToken:"lease-A",leaseExpiresAt:1000,ownerBinding:fixture.ownerBinding,generation:1,authorityEpoch:"authority-A"};
    const scheduler = {automaticDateHighWater:null,automaticNotBefore:null,lastAutomaticZone:null,lastAutomaticClaimAt:null,manualNotBefore:0,metadataThrottle:[],executionClaim:null};
    expect(c.schedulerStateV1Schema.safeParse(scheduler).success).toBe(true);
    expect(c.schedulerStateV1Schema.safeParse({...scheduler,automaticDateHighWater:"2026-11-10",automaticNotBefore:1000,lastAutomaticZone:"UTC",lastAutomaticClaimAt:100,metadataThrottle:[{accountId:null,startedAt:100},{accountId:"account-A",startedAt:200}],executionClaim:claim}).success).toBe(true);
    expect(c.schedulerStateV1Schema.safeParse({...scheduler,rows:[row]}).success).toBe(false);
    expect(c.claimSchema.safeParse({...claim,leaseExpiresAt:Infinity}).success).toBe(false);
    expect(c.claimSchema.safeParse({...claim,generation:Number.MAX_SAFE_INTEGER+1}).success).toBe(false);
    const run = {runId:common.requestId,kind:"automatic",idempotencyKey:"automatic:2026-11-10",ownerBinding:fixture.ownerBinding,generation:1,syncDate:"2026-11-10",syncZone:"UTC",coverageStart:100,coverageEnd:200,scheduledAt:100,status:"queued",attemptsSpent:0,maxAttempts:3,nextRetryAt:null,startedAt:null,finishedAt:null,error:null};
    for (const status of c.RUN_STATUSES) expect(c.runV1Schema.safeParse({...run,status}).success).toBe(true);
    expect(c.runV1Schema.safeParse({...run,kind:"manual",maxAttempts:1}).success).toBe(true);
    for (const patch of [{attemptsSpent:4},{kind:"manual"},{coverageEnd:100},{status:"retry"},{error:"provider said secret"}]) expect(c.runV1Schema.safeParse({...run,...patch}).success).toBe(false);
  });
  it("meeting privacy, all-day ranges and complete snapshot unions fail closed", () => {
    expect(c.snapshotResponseSchema.safeParse(snapshot).success).toBe(true);
    expect(c.snapshotResponseSchema.safeParse({...snapshot,status:"refresh_failed",error:"timeout"}).success).toBe(true);
    for (const patch of [{complete:false},{coverage:null},{status:"off"},{expiresAt:coverage.end+1},{checkedAt:coverage.end}]) expect(c.snapshotResponseSchema.safeParse({...snapshot,...patch}).success).toBe(false);
    const empty = {...snapshot,status:"off",checkedAt:null,coverage:null,expiresAt:null,rows:[],complete:false};
    expect(c.snapshotResponseSchema.safeParse(empty).success).toBe(true);
    expect(c.snapshotResponseSchema.safeParse({...empty,rows:[row]}).success).toBe(false);
    for (const privacy of ["private","confidential","unknown"]) {
      expect(c.meetingRowSchema.safeParse({...row,privacy}).success).toBe(false);
      expect(c.meetingRowSchema.safeParse({...row,privacy,title:"Busy"}).success).toBe(true);
    }
    expect(c.meetingRowSchema.safeParse({...row,accountId:"account-A"}).success).toBe(false);
    expect(c.meetingRowSchema.safeParse({...row,title:"x".repeat(301)}).success).toBe(false);
    const allDay = {kind:"all_day",startDate:"2026-11-09",endDate:"2026-11-12",sourceZone:"America/New_York",overlapStart:coverage.start,overlapEnd:coverage.end};
    expect(c.meetingWhenSchema.safeParse(allDay).success).toBe(true);
    expect(c.meetingWhenSchema.safeParse({...allDay,endDate:allDay.startDate}).success).toBe(false);
    const normalized = {...absent(row,"id"),rowId:row.id,identity:["googlecalendar","account-A","calendar-A","event-1",{dateTime:"2026-11-10T10:00:00-05:00"}]};
    expect(c.normalizedEventSchema.safeParse(normalized).success).toBe(true);
    const publication = {...fixture.stamp,checkedAt:snapshot.checkedAt,coverage,expiresAt:coverage.end,complete:true,rows:[normalized]};
    expect(c.publishedSnapshotSchema.safeParse(absent(publication,"version")).success).toBe(true);
    expect(c.publishedSnapshotSchema.safeParse({...absent(publication,"version"),expiresAt:coverage.end+1}).success).toBe(false);
  });
  it("errors and invalidations never carry private values", () => {
    for (const reason of c.invalidationReasonSchema.options) expect(c.ownerInvalidationSchema.safeParse({...fixture.stamp,reason}).success).toBe(true);
    for (const extra of [{rows:[row]},{accountId:"account-A"},{title:row.title},{reason:"other"}]) expect(c.ownerInvalidationSchema.safeParse({...fixture.stamp,reason:"published",...extra}).success).toBe(false);
    for (const code of c.ERROR_CODES) expect(c.apiErrorSchema.safeParse({error:{code},...(code === "throttled" ? {retryAt:1000} : {})}).success).toBe(true);
    expect(c.stepUpRefusalSchema.parse({error:{code:"step_up_required"}})).toEqual({error:{code:"step_up_required"}});
    for (const bad of [{error:{code:"step_up_required",message:"confirm"}},{error:{code:"step_up_required"},retryAt:100},{error:"step-up required"}]) expect(c.stepUpRefusalSchema.safeParse(bad).success).toBe(false);
    expect(c.apiErrorSchema.safeParse({error:{code:"timeout"},rows:[]}).success).toBe(false);
  });
});

it("synthetic normalization and pagination recipes are reusable without live data", () => {
  for (const sample of normalization.cases) expect(c.brokerEventSchema.safeParse(sample.event).success,sample.name).toBe(true);
  expect(normalization.cases.find(x=>x.name === "moved-exception")!.event.originalStart).not.toBeNull();
  expect(normalization.duplicates.identical[0]).toEqual(normalization.duplicates.identical[1]);
  expect(normalization.duplicates.conflicting[0].updatedAt).toBe(normalization.duplicates.conflicting[1].updatedAt);
  expect(normalization.duplicates.conflicting[0].summary).not.toBe(normalization.duplicates.conflicting[1].summary);
  for (const recipe of pagination.recipes) {
    if ("chunks" in recipe) expect(recipe.chunkBytes! * recipe.chunks!).toBeGreaterThan(c.TODAY_CALENDAR_LIMITS.bodyBytes);
    if ("eventCount" in recipe) expect(recipe.eventCount).toBeGreaterThan(c.TODAY_CALENDAR_LIMITS.items);
    if ("pages" in recipe) expect(recipe.pages).toBeGreaterThan(c.TODAY_CALENDAR_LIMITS.pages);
    if ("requests" in recipe) expect(recipe.requests).toBeGreaterThan(c.TODAY_CALENDAR_LIMITS.requests);
  }
  expect(pagination.revocation.publish).toBe(false);
  expect(pagination.lostSave.resubmit).toBe(false);
  expect(pagination.lostSave.readbackLastMutationId).toBe(pagination.lostSave.mutationId);
});

it("preserves valid BOM identities and rejects BOM-prefixed preference JSON consistently", () => {
  const identity = "\ufeffaccount-A";
  expect(c.idSchema.safeParse(identity).success).toBe(true);
  expect(c.idSchema.parse(identity)).toBe(identity);
  const raw = "\ufeff" + JSON.stringify(preferences.valid[0]);
  expect(() => c.parseInactivePreferences(raw)).toThrow();
  expect(() => c.parseInactivePreferences(new TextEncoder().encode(raw))).toThrow();
});
