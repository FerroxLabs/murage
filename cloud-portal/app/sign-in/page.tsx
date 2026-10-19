import { safeNext } from "@/lib/session";
import { sendCode } from "./actions";

const ERRORS: Record<string, string> = {
  email: "Enter a valid email address.",
  slow: "Too many tries. Wait a few minutes and try again.",
  send: "We could not send the code. Try again.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const next = safeNext(q.next);
  return (
    <section className="card narrow">
      <h1>Sign in or create your account</h1>
      <p>We email you an 8 digit code. No password.</p>
      {q.error && <p role="alert" className="error">{ERRORS[q.error] ?? ERRORS.send}</p>}
      <form action={sendCode}>
        <input type="hidden" name="next" value={next} />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <button type="submit">Email me a code</button>
      </form>
    </section>
  );
}
