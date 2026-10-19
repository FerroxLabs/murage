import { safeNext } from "@/lib/session";
import { verifyCode } from "../actions";

export default async function Code({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const next = safeNext(q.next);
  return (
    <section className="card narrow">
      <h1>Enter your code</h1>
      <p>We sent an 8 digit code to {q.email ?? "your email"}. It works for 10 minutes.</p>
      {q.error && <p role="alert" className="error">That code did not work. Check it and try again.</p>}
      <form action={verifyCode}>
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="email" value={q.email ?? ""} />
        <label htmlFor="otp">Code</label>
        <input id="otp" name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{8,10}" required />
        <button type="submit">Continue</button>
      </form>
      <p><a href={`/sign-in?next=${encodeURIComponent(next)}`}>Use a different email</a></p>
    </section>
  );
}
