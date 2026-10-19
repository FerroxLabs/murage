import type { Metadata } from "next";
import Link from "next/link";
import { config } from "@/lib/config";
import { getToken } from "@/lib/session";
import { signOut } from "./actions";
import { ReferralTracking } from "./referral-tracking";
import "./globals.css";

export const metadata: Metadata = { title: "Murage Cloud", description: "Your Murage Cloud account." };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = Boolean(await getToken());
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/plans" className="brand">Murage Cloud</Link>
          <nav aria-label="Main">
            <Link href="/plans">Plans</Link>
            <Link href="/cloud">My Cloud</Link>
            <Link href="/security">Security</Link>
            {signedIn ? (
              <form action={signOut}><button type="submit" className="linklike">Sign out</button></form>
            ) : (
              <Link href="/sign-in">Sign in</Link>
            )}
          </nav>
        </header>
        <main>{children}</main>
        <footer className="foot">
          <p>Refunds follow our terms. Customers in the EU get 14 days. <a href={config.termsUrl}>Read the terms</a>.</p>
        </footer>
        <ReferralTracking />
      </body>
    </html>
  );
}
