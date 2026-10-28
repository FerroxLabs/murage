// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every word the phone tools say to a bot or to the owner, in one place (plan S20, global constraint on copy). Shared so the web card
// reads the same strings the server does; server/phones/copy.ts re-exports it. No em dash, none of the banned words (copy.test.ts holds the line).
export const PHONE_COPY = {
  /** Turns without a phone authority: the bot is told how the phone can be used, and nothing about why this turn lacks it. */
  withheld: "I can use your phone only when you ask me directly, in our own chat.",
  /** A turn that came from a share or a one-tap ask on the phone: the bot is pointed at Ask again. */
  withheldVia: "I can use your phone only when you ask me directly in our chat. Tap Ask again to do that.",
  /** The owner tries to edit a line that came from the phone: Ask again is the one way to an owner turn. */
  editViaRefused: "Lines from your phone can't be edited. Use Ask again.",
  timeout: "Asked on your phone; it did not run. Open Murage on the phone and ask again.",
  declined: "Not allowed on the phone this time.",
  accessChanged: "The phone's access changed.",
  mayHaveRun: "May have run on the phone; read it back before repeating.",
  notOnScreen: "You'll get a request on your phone; open Murage there to allow it.",
  oldApp: "Update the Murage app on your phone",
  passcode: "Set a passcode on this phone, then pair again",
  cloud: "Coming to Murage Cloud",
  /** What the phone says back when a text or a call was handed to its own screen. */
  sheetResults: ["opened for you to send", "dialer opened"],
  /** Outcomes the owner or the bot sees that have no plan-given string. */
  turnEnded: "The turn ended before the phone ran it.",
  restarted: "Murage restarted before the phone ran it.",
  denied: "The phone did not allow it; nothing ran.",
  unsupported: "The phone does not support that; nothing ran.",
  /** What the model is told when a call is turned away: no reason is ever given. */
  refused: "That phone tool is not available in this conversation.",
  invalidArgs: "The arguments for that phone tool were not valid. Check them and try again.",
  /** The owner's phone card, per action: what the bot is doing (server/phones/rpc.ts). */
  say: {
    "calendar.read": "read your calendar",
    "calendar.free_time": "look for free time in your calendar",
    "calendar.add": "add an event to your calendar",
    "calendar.change": "change an event in your calendar",
    "reminders.read": "read your reminders",
    "reminders.add": "add a reminder",
    "reminders.complete": "mark a reminder done",
    "contacts.search": "search your contacts",
    "contacts.get": "look up a contact",
    "location.get": "get your location",
    "alarms.set": "set an alarm",
    "alarms.timer": "start a timer",
    "messages.compose": "start a text message for you to send",
    "calls.dial": "open the dialer with a number",
  },
  sayFallback: "use your phone",
  /** The thread's activity row, per action, past tense; the phone is named by kind (server/routes/phones.ts). */
  did: {
    "calendar.read": "Read your calendar",
    "calendar.free_time": "Looked for free time in your calendar",
    "calendar.add": "Added an event",
    "calendar.change": "Changed an event",
    "reminders.read": "Read your reminders",
    "reminders.add": "Added a reminder",
    "reminders.complete": "Marked a reminder done",
    "contacts.search": "Searched your contacts",
    "contacts.get": "Looked up a contact",
    "location.get": "Got your location",
    "alarms.set": "Set an alarm",
    "alarms.timer": "Started a timer",
    "messages.compose": "Started a text message",
    "calls.dial": "Opened the dialer",
  },
  activity: { iphone: "the iPhone", android: "the Android phone", other: "your phone", fallback: "Used your phone", on: " on " },
  /** "wants to use your ..." in a device-job push (server/mobile-push-detail.ts). */
  capabilityNoun: { calendar: "calendar", reminders: "reminders", contacts: "contacts", location: "location", alarms: "alarms", messages: "messages", calls: "phone calls" },
  /** The device-job push body is `<bot name>` + wants[0] + `<noun>` + wants[1]. */
  pushWants: [" wants to use your ", ". Open Murage to allow it."],
  /** Added to a turn's instructions when the turn holds the phone tools. */
  instructions: [
    "Reading your phone is quiet: the owner sees nothing for a read.",
    "Every change to the phone is shown to the owner on the phone before it happens.",
    "A text or a call only happens when the owner taps send or call on the phone; you only prepare it.",
    "Pass ids from earlier results when you change or complete something.",
    "When more than one phone is paired, name the phone you mean.",
    "Before you repeat a create, read it back first to see whether it already exists.",
  ],
} as const;


/** The Phone card in bot settings (plan S21). Same rules as PHONE_COPY; copy.test.ts checks both. */
export const PHONE_CARD_COPY = {
  title: "Phone",
  intro: "Choose what this bot may do on your paired phone. Everything starts off. You see every change on the phone before it happens.",
  engineUnsupported: "This bot's engine can't use phone tools.",
  noPhones: "No phone is paired yet. Pair one from Phone in the sidebar.",
  noRegistration: "Open Murage on the phone to finish setting it up.",
  reports: "Reports",
  reportsNothing: "nothing yet",
  loading: "Loading phone status…",
  saveFailed: "Could not save phone access. Try again.",
  off: "Off",
  capabilities: {
    calendar: "Calendar",
    reminders: "Reminders",
    contacts: "Contacts",
    location: "Location",
    alarms: "Alarms and timers",
    messages: "Texts",
    calls: "Calls",
  },
  values: {
    read: "Read",
    add: "Add events",
    change: "Read, add and change",
    approximate: "Approximate",
    precise: "Precise",
    set: "Set",
    compose: "Prepare for you to send",
    dial: "Open the dialer",
  },
  /** Activity rows name the action and the phone; contents never appear. */
  activityNote: "Activity on the phone shows what was done, never what it contained.",
} as const;
