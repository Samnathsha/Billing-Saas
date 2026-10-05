# Personal data map (Phase 11; OWASP ASVS 8.3.4)

What personal data the app holds, where, and for how long. The draft
Privacy Policy (`/privacy`) is written from this list. Keep the two in step.

| Data | Whose | Where | Kept | Who can see it |
| --- | --- | --- | --- | --- |
| Name, email | users (staff, owners) | `users` | while the account exists | the person; owners/admins of their businesses |
| Password | users | `accounts` (Argon2id hash only) | while the account exists | nobody (login service only) |
| Two-step login secret, backup codes | users | `two_factors` (encrypted) | until switched off | nobody (login service only) |
| Sessions: IP address, browser | users | `sessions` | 30 min idle / 12 h at most | the person ("Your devices") |
| Security log: email hash, IP, browser | users | `security_events` (append-only) | [period to be set, Q51] | operator only |
| Customer name, phone, address, GSTIN | the business's customers | `customers`, `invoices` (buyer copy) | while the business exists | that business's staff (by role) |
| Bills, payments, IMEIs, warranty | the business's customers | `invoices`, `invoice_items`, `serial_numbers`, … | while the business exists | that business's staff (by role) |
| Supplier name, phone, GSTIN | suppliers | `suppliers` | while the business exists | staff who buy |
| Audit log (who did what, before/after values) | staff | `audit_logs` (append-only) | while the business exists | Owner, Admin |
| Till copy: prices, recent bills, unsent bills | customers (bill lines) | the till's browser (IndexedDB) | until logout (unsent bills until sent); wiped on revoke | that till |
| Error reports | none (scrubbed) | Sentry | Sentry plan default | operator |
| Backups (everything above) | all | Cloudflare R2, age-encrypted | 30 daily, 12 monthly | operator with the offline key |
| Business export ZIP | all of one business | the owner's computer | the owner decides | the owner |

Not collected: card numbers, Aadhaar, location, contacts, advertising IDs.
No data is sold or used for advertising or AI training.

Open: how long the security log and audit log are kept (Q51), and the
lawyer's review of `/terms` and `/privacy` (Q52).
