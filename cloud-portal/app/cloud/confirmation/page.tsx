import Link from "next/link";
import { redirect } from "next/navigation";
import { cp, CPError } from "@/lib/cp";
import { requireToken } from "@/lib/session";

/** The contract confirmation we emailed, kept here too: full text of the terms, the renewal and cancel information, the withdrawal form. */
export default async function Confirmation() {
  const token = await requireToken("/cloud/confirmation");
  let data: { subject: string; text: string; sentAt: number };
  try {
    data = await cp<{ subject: string; text: string; sentAt: number }>("/v1/account/confirmation", { token });
  } catch (e) {
    if (e instanceof CPError && e.status === 404) redirect("/cloud");
    throw e;
  }
  return (
    <>
      <h1>Your order confirmation</h1>
      <p className="small">Sent {new Date(data.sentAt).toISOString().slice(0, 10)}. <Link href="/cloud">Back to My Cloud</Link></p>
      <pre data-testid="confirmation-text" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{data.text}</pre>
    </>
  );
}
