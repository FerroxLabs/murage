import { redirect } from "next/navigation";
import { twoFactorStatus } from "@/lib/cp";
import { requireToken, safeNext } from "@/lib/session";
import { TwoFactor } from "./two-factor";

export default async function Security({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const next = safeNext(q.next, "/security");
  const token = await requireToken("/security");
  const status = await twoFactorStatus(token).catch(() => null);
  if (!status) redirect("/sign-in?next=/security");
  return (
    <section className="card narrow">
      <h1>Security</h1>
      <p>You need a second step before you buy. Use a passkey, a phone, or a security key.</p>
      <TwoFactor enrolled={status.enrolled} verified={status.verified} factors={status.factors} next={next} />
    </section>
  );
}
