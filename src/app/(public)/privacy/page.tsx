import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Privacy Policy" };

// DRAFT (Phase 11) for a lawyer to review; written with India's Digital
// Personal Data Protection Act, 2023 in mind. The facts it states are
// listed in docs/privacy-data-map.md.
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>Last updated: [date]. [Company legal name] (&quot;we&quot;) runs this billing service. Contact: [email], Grievance Officer: [name, email].</p>
      <h2>1. Two kinds of personal data</h2>
      <ul>
        <li><b>Your account:</b> name, email address, password (stored only as a secure hash), optional two-step login, the businesses you belong to and your role, and login records (time, IP address, browser).</li>
        <li><b>Data a business enters about its customers and staff:</b> names, phone numbers, addresses, GSTINs, bills, payments, IMEI numbers. For this data the business decides what is entered and why; we process it on the business&apos;s behalf.</li>
      </ul>
      <h2>2. Why we use it</h2>
      <ul>
        <li>To run the service: log you in, keep each business&apos;s data separate, save bills, stock and reports.</li>
        <li>To keep it secure: rate limits, a security log, alerts about password and two-step login changes, error reports with personal details removed.</li>
        <li>We do not sell personal data, show advertising, or use it to train AI.</li>
      </ul>
      <h2>3. Who else handles it (on our instructions)</h2>
      <ul>
        <li>[Hosting provider] (application), Neon (database, [region]), Cloudflare R2 (encrypted backups and photos), Resend (sending emails), Sentry (error reports, without personal details), Have I Been Pwned (only the first 5 characters of a password&apos;s hash, to refuse leaked passwords).</li>
        <li>Authorities, only when the law requires it.</li>
      </ul>
      <h2>4. How long we keep it</h2>
      <ul>
        <li>Business data: while the business uses the service; deleted [30] days after the owner asks; encrypted backups expire within [12 months].</li>
        <li>Login sessions: end after 30 minutes without use, at most 12 hours. Technical records against repeated requests: 90 days.</li>
        <li>Audit and security logs: [for as long as the business exists / period to be set].</li>
      </ul>
      <h2>5. Security</h2>
      <p>Encrypted connections (HTTPS), each business&apos;s data separated in the database itself, passwords hashed with Argon2id, optional two-step login, encrypted nightly backups, and regular security reviews.</p>
      <h2>6. Your rights</h2>
      <p>You can see and correct your account details, download a business&apos;s data (owner), ask for deletion, and withdraw consent. Customers of a business should contact that business first; we will help it answer. Write to [email]; we answer within [30] days. You may also complain to the Data Protection Board of India.</p>
      <h2>7. Data on tills</h2>
      <p>A registered till keeps a copy of item prices, recent bills and unsent bills on that computer so it can work without internet. Logging out removes everything except unsent bills; revoking a till removes everything.</p>
      <h2>8. Changes</h2>
      <p>We will announce important changes [30] days in advance.</p>
    </LegalPage>
  );
}
