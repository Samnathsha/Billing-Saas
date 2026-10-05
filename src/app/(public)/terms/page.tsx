import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Terms of Service" };

// DRAFT (Phase 11) for a lawyer to review before the first paying client.
export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <p>Last updated: [date]. These terms are between [company legal name], [registered address] (&quot;we&quot;), and the business that signs up (&quot;you&quot;).</p>
      <h2>1. The service</h2>
      <p>We provide online software for billing, GST invoices, stock, purchases, expenses and reports, used through a web browser, including tills that can bill without internet for a limited time.</p>
      <h2>2. Your account</h2>
      <ul>
        <li>The person who creates the business is its owner and is responsible for who they invite and what roles they give.</li>
        <li>Keep passwords secret; use two-step login for owners and admins. Tell us at once of any misuse.</li>
        <li>You must give true business and GST details.</li>
      </ul>
      <h2>3. Your data</h2>
      <ul>
        <li>The business data you enter (bills, customers, stock, staff) belongs to you. We use it only to provide the service, as described in the Privacy Policy.</li>
        <li>You can download all of it at any time (owner: Business settings).</li>
        <li>You are responsible for the correctness of your bills, tax rates and filings. The app follows the rules you set; check figures with your accountant.</li>
        <li>You must keep your own records for as long as tax law requires (GST: usually several years). Download your data before asking for deletion.</li>
      </ul>
      <h2>4. Offline tills</h2>
      <p>Bills made without internet are saved on that computer and count only once they reach the server. Keep tills online regularly; we are not responsible for bills lost because a till&apos;s browser data was cleared before it synced.</p>
      <h2>5. Plans and payment</h2>
      <p>[Pilot: free of charge. Later plans, prices, billing period, taxes, and what happens on non-payment: to be set.]</p>
      <h2>6. Acceptable use</h2>
      <p>No unlawful use, no attempts to reach other businesses&apos; data, to break security or to overload the service. We may suspend an account that does so, with notice where possible.</p>
      <h2>7. Availability and changes</h2>
      <p>We aim for the service to be available at all times but cannot guarantee it. We back up data nightly. We may change the service and these terms with [30] days&apos; notice for important changes.</p>
      <h2>8. Ending</h2>
      <p>You may stop at any time. The owner can ask for the business to be deleted: it is deleted [30] days later. Backups that still hold it expire within [12 months].</p>
      <h2>9. Liability</h2>
      <p>[Limitation of liability, exclusions, and the maximum amount: for the lawyer.]</p>
      <h2>10. Law and disputes</h2>
      <p>[Indian law; courts of [city]. Grievance contact: [name, email].]</p>
    </LegalPage>
  );
}
