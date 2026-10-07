import type { Bot } from "@/state/store";
import { HeldLine, soundsIncomplete } from "./call-turns";

export interface SpokenGroupMessage {
  text: string;
  addressed: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whose voice a spoken acknowledgement would use in the room: the member
 * already writing, else the one member the (routed) line is addressed to.
 * Never a guess: "@everyone", no address, or several members means no cue.
 */
export function cueMemberFor(routedText: string, members: Bot[], busyBotId?: string | null): Bot | undefined {
  const busy = busyBotId ? members.find((member) => member.id === busyBotId) : undefined;
  if (busy) return busy;
  if (/(?:^|\s)@everyone\b/i.test(routedText)) return undefined;
  const named = members.filter((member) =>
    new RegExp("(?:^|\\s)@" + escapeRegExp(member.name) + "(?=\\s|[,.!?:;]|$)", "i").test(routedText),
  );
  return named.length === 1 ? named[0] : undefined;
}

/** Turn a natural spoken address into the room's existing mention syntax.
 * Apple dictation commonly returns “Atlas, …” rather than “@Atlas …”. */
export function routeSpokenGroupMessage(text: string, members: Bot[]): SpokenGroupMessage {
  const trimmed = text.trim();
  if (!trimmed) return { text: "", addressed: false };

  if (/(?:^|\s)@everyone\b/i.test(trimmed)) return { text: trimmed, addressed: true };
  const explicitlyMentioned = members.some((member) => {
    const tag = new RegExp("(?:^|\\s)@" + escapeRegExp(member.name) + "(?=\\s|[,.!?:;]|$)", "i");
    return tag.test(trimmed);
  });
  if (explicitlyMentioned) return { text: trimmed, addressed: true };

  const everyone = trimmed.match(/^(?:hey\s+)?(?:everyone|everybody|all)(?:[\s,:-]+(.*))?$/i);
  if (everyone) {
    const rest = everyone[1]?.trim();
    return { text: rest ? "@everyone " + rest : "@everyone", addressed: true };
  }

  // "Moss and Sable, ..." is the typed "@Moss and @Sable ...": several names.
  const names = [...members].sort((a, b) => b.name.length - a.name.length).map((m) => escapeRegExp(m.name)).join("|");
  if (names) {
    const joiner = "(?:\\s*,\\s*and\\s+|\\s+and\\s+|\\s*,\\s*)";
    const several = trimmed.match(
      new RegExp("^(?:hey\\s+)?((?:" + names + ")(?:" + joiner + "(?:" + names + "))+)(?:[\\s,:-]+(.*))?$", "i"),
    );
    if (several) {
      const tagged = several[1].replace(new RegExp("(?:" + names + ")", "gi"), (n) => "@" + n);
      const rest = several[2]?.trim();
      return { text: rest ? tagged + " " + rest : tagged, addressed: true };
    }
  }

  const candidates = [...members].sort((a, b) => b.name.length - a.name.length);
  for (const member of candidates) {
    const addressed = trimmed.match(
      new RegExp("^(?:hey\\s+)?" + escapeRegExp(member.name) + "(?:[\\s,:-]+(.*))?$", "i"),
    );
    if (!addressed) continue;
    const rest = addressed[1]?.trim();
    return { text: rest ? "@" + member.name + " " + rest : "@" + member.name, addressed: true };
  }

  return { text: trimmed, addressed: false };
}

/**
 * The owner's line on a room call. A final that stops mid-clause waits
 * CONTINUATION_WAIT_MS, counted from that final, for the rest; only speech
 * that begins AFTER the final (a partial of the next phrase) stretches the
 * wait, up to the HeldLine cap. The final itself, and the partials that led
 * up to it, never count as "more is coming".
 */
export class OwnerLine {
  private lastSpeechAt = 0;
  private readonly held: HeldLine;

  constructor(send: (text: string) => void) {
    this.held = new HeldLine(send, (since) => this.lastSpeechAt > since, soundsIncomplete);
  }

  /** A partial transcript: the owner is speaking now. */
  partial(text: string): void {
    if (text.trim()) this.lastSpeechAt = Date.now();
  }

  /** A final line. The text to send now (joined to any held half), or null
   *  while it waits; a held line is sent by `send` when the wait is over. */
  final(said: string): string | null {
    return this.held.take(said, Date.now());
  }

  drop(): void {
    this.held.drop();
  }
}
