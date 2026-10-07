import { freshAuthCopy } from "@/lib/fresh-auth";

/** Stands where Allow would be, on a browser pairing, for a card that needs the computer or the app. */
export function ComputerOnlyNotice({ className }: { className?: string }) {
  return <p role="status" data-computer-only className={className}>{freshAuthCopy("computerOnly")}</p>;
}
