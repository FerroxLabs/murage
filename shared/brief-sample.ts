// THE SAMPLE BRIEF: what tomorrow morning looks like, today.
//
// WHY THIS EXISTS AT ALL. The first run reaches a point where it has to ask
// for something, and asking before showing is the wrong order. Both
// cross-research models, independently, proposed the same fix: render a real
// brief from example data and show it BEFORE the ask. It is an offer and an
// invitation rather than a pitch, and it answers the "what does this thing
// actually do" question with the thing itself.
//
// AND IT COSTS NOTHING TO PRODUCE. No model call, no network, no key. That is
// what makes it the answer to having no free starter allowance: there is
// nothing here to abuse, because nothing is spent. A person on a brand new
// machine with no key at all still gets to see exactly what they would be
// getting.
//
// IT IS THE REAL TEMPLATE. Every section below is one the daily routine can
// actually fill, rendered by the same `renderBriefHtml` the real brief uses.
// A sample with invented sections would be a promise the product could not
// keep the next morning, which is worse than no sample.
//
// ON THE CONTENT. It is one invented day, chosen to demonstrate JUDGEMENT
// rather than volume: a decision that carries a recommendation, a detail
// somebody would otherwise have been caught out by, a lead time raised at the
// lead time rather than at the deadline, something handled without being
// asked, and a pattern noticed over weeks. Five short sections. It is
// deliberately not a busy day, because a wall of items would demonstrate the
// opposite of the point.
//
// The names are ordinary and invented. No brands, no real people, nothing
// that could read as a real message from a real person.

import type { BriefData } from "./brief.ts";

/**
 * The day the sample shows.
 *
 * A FIXED LABEL, not today's date, and this is a deliberate choice rather
 * than laziness. Dating it "today" would make it a forecast that is
 * demonstrably wrong the moment they read it, because none of these things
 * are on their actual calendar. "A Tuesday in March" reads as an example,
 * which is what it is, and an example nobody can mistake for their own day is
 * an example nobody feels lied to by.
 */
export const SAMPLE_BRIEF_DATE = "An example. A Tuesday in March.";

/**
 * A brief worth reading, with their name on it.
 *
 * The name is the only real thing in here and it does most of the work: it
 * is the difference between a screenshot of somebody else's product and a
 * page that was made for them thirty seconds ago.
 */
export function sampleBrief(ownerName: string): BriefData {
  return {
    ownerName: ownerName.trim(),
    dateLabel: SAMPLE_BRIEF_DATE,
    // One decision, with a recommendation, because a list of options is a
    // failure to do the job. The recommendation carries its reason, and the
    // reason is a fact the assistant went and found.
    needsYou: [
      {
        title: "Maya needs a time for tomorrow",
        detail: "She has asked for half an hour and offered ten, eleven or four.",
        recommend: "Eleven. Your earlier meeting finishes at ten thirty and four is the only clear stretch you have left that day.",
        by: "Answer by noon",
      },
    ],
    // The day, edited rather than transcribed, and the second entry is the
    // whole argument for the product: a detail buried in a message that would
    // otherwise have been found out about in a car park.
    today: [
      { when: "9:30", title: "Quarterly review with the team", detail: "The figures you asked for are attached to the invitation." },
      { when: "2:00", title: "Appointment at the clinic", detail: "They have written to say use the side entrance today, not the main doors." },
      { when: "Late", title: "Nothing after four", detail: "You kept Tuesday evenings clear, so I have left it that way." },
    ],
    // What moved. Only things that change what happens today.
    overnight: [
      { title: "Daniel has not sent Thursday's figures", detail: "They were due yesterday. Thursday's meeting cannot really happen without them." },
      { title: "The venue confirmed the room for the 14th", detail: "Nothing needed from you. I have put it in." },
    ],
    // How graduated trust becomes visible. One line each, no boasting, and
    // the word "approve" appears because that is the promise being kept.
    handled: [
      { title: "Replied to three people about times", detail: "All confirmations of things already in your calendar. Nothing new was promised." },
      { title: "Drafted your reply to Daniel", detail: "It is waiting for you to approve. I have not sent it." },
    ],
    // Last, and the most human section. A pattern over weeks, and a silence,
    // both of which are things only something watching every day would see.
    noticed: [
      { title: "This is the third time Thursday has moved", detail: "Each time it was waiting on the same figures. It may be worth settling that rather than moving it again." },
      { title: "You have not replied to your sister since the 2nd", detail: "She has written twice. Not my business, but you did ask me to keep an eye on the people who matter." },
    ],
  };
}
