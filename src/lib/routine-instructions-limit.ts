import { ROUTINE_INSTRUCTIONS_MAX, routineInstructionsLength, routineInstructionsTooLongMessage } from "../../shared/routine-instructions";

const count = new Intl.NumberFormat("en-US");

/** What the routine editor says under the instructions box.
 *
 * Nothing while the text is comfortably short; a running count once it is
 * close to the limit; and, over it, the plain refusal the server would give,
 * with Save disabled. Instructions are never shortened on save. */
export function routineInstructionsLimit(text: string): { over: boolean; line: string } | null {
  const length = routineInstructionsLength(text);
  if (length > ROUTINE_INSTRUCTIONS_MAX) return { over: true, line: routineInstructionsTooLongMessage(length) };
  if (length >= ROUTINE_INSTRUCTIONS_MAX * 0.9) return { over: false, line: `${count.format(length)} of ${count.format(ROUTINE_INSTRUCTIONS_MAX)} characters` };
  return null;
}
