// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW (1.0.4): the words a bot is told about asking the owner. One source for the
// agents server's tool descriptions and the rule line every engine's turn
// carries, so a tool engine and a text-only engine read the same instruction.
// Q4 (207, 208): the widget tools and their follow-up wording (adapted from
// OpenMausBot's show_widget description and WIDGET_PROMPT, PR #2820 and #2902).
// Model-facing: plain words, no emoji, no dashes used as punctuation.

/** The agents server's `ask_user` description. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the owner one to four questions on a card in this conversation. Each question can offer options to pick (multiSelect: true lets them pick several) and room for their own words. "
  + "Use it whenever you need a decision, a preference or missing information: do not guess what the owner would want to decide. "
  + "Never ask for a key or a password here; use request_credential. "
  + "After calling it, end your turn: the answer arrives as the owner's next message.";

/** The fence a bot with no tools writes instead of calling ask_user (QW Q2). */
export const QUESTION_FENCE = "murage-question";

/** The rule line of every engine's turn. */
export const ASK_RULE_LINE =
  `To ask the owner something, call ask_user on the agents server. With no tools, write the same input as JSON in a \`\`\`${QUESTION_FENCE} fenced block instead. `
  + "Then end your turn: the answer arrives as the owner's next message.";

/** The fence a bot with no tools writes instead of calling show_widget (QW Q2, Q4). */
export const WIDGET_FENCE = "murage-widget";

/** 208: when a bot reaches for a widget, and how an edit starts. One string, in the show_widget description and in the rule
 * line of every engine's turn. */
export const WIDGET_FOLLOW_UP =
  "Whenever you need something the owner could pick instead of type, such as a date, a time, days of the week, a length, whether to go ahead with a change, or one of a few options, show a widget form, in follow-up questions too, without being asked. "
  + "When the owner wants to change something that already exists, such as a routine, a reminder or a booking, show it as a form prefilled with how it is set now (each field's defaultValue), say in the caption that this is how it is set now, and give it a confirm button.";

/** The agents server's `show_widget` description. */
export const SHOW_WIDGET_TOOL_DESCRIPTION =
  `Show an interactive widget in this conversation: a form, a pick-one list, a confirmation or a short status. ${WIDGET_FOLLOW_UP} `
  + "\"Help me book a call\" gets a Card with a DatePicker, a TimePicker, a Select for the length and a Textarea for a note. Data and comparisons go in a markdown table in your message instead. "
  + "`widget` is one JSON tree. The root is {type: \"Card\" or \"ListView\", title?, caption?, children: [...], confirm?: {label, action}, cancel?: {label, action}}. "
  + "Nodes: Row, Col, Box, Spacer, Divider, Text, Title, Caption, Markdown, Badge{label, color}, Icon{name}, Image{src}, Progress{value 0 to 1}, Chart{data, series: [{type, dataKey}], xAxis}, Button{label, onClickAction}, Form{onSubmitAction, children}. "
  + "Fields, each with a name and a short label: Select or RadioGroup{options: [{label, value}]}, DatePicker{min?, max?} (YYYY-MM-DD), TimePicker{min?, max?, step?} (HH:MM, 24 hour), DayPicker (days of the week, sent as \"mon,wed,fri\"), Checkbox, Input, Textarea. "
  + "A ListView holds ListViewItem{children}; to have the owner choose one row, give the ListView a name and each row a value, and confirm sends the pick. Select, RadioGroup and such a list also let the owner answer in their own words; set allowOther: false only when nothing but an option will do. "
  + "An action is {type, payload?}; {type: \"open_url\", payload: {url}} shows a link the owner may open. An Image src is a data: image or an /api/attachments/ address; other addresses are dropped. Labels are plain words, no emoji. "
  + "The first press settles the widget and arrives as the owner's next message, so end your turn after a widget that asks something. Never ask for a key or a password here; use request_credential. Not available in rooms.";

/** The agents server's `update_widget` description. */
export const UPDATE_WIDGET_TOOL_DESCRIPTION =
  "Replace a widget you showed earlier in this conversation, in place: a progress bar moving, a status changing. `widgetId` is the id show_widget returned. A widget the owner already answered cannot be updated; show a new one.";

/** The widget half of the rule line. */
export const WIDGET_RULE_LINE =
  `${WIDGET_FOLLOW_UP} Call show_widget on the agents server; with no tools, write the same widget as JSON in a \`\`\`${WIDGET_FENCE} fenced block instead.`;

/** The rule line every engine's turn carries (renderMurageTurn), word for word the same on every engine. */
export const TURN_ASK_RULES = `${ASK_RULE_LINE} ${WIDGET_RULE_LINE}`;
