# 0007: Where the live app runs (pilot and first clients)

- Status: **Proposed**, for the owner to decide
- Date: 2026-10-04
- Context: blueprint section 4. Real shop data must not go on Vercel Hobby,
  whose terms forbid commercial use. The owner asked for something cheaper
  than Vercel Pro (about $20/month).

## What the app needs from a host

- **Node.js with native modules.** Password hashing (`@node-rs/argon2`) and
  photo resizing (`sharp`) are compiled code. "Edge" hosts that run only
  JavaScript (Cloudflare Workers, Vercel Edge) cannot run them without
  replacing those parts.
- **Near the database.** Neon's only Asian region is Singapore
  (`aws-ap-southeast-1`), so the app should run in Singapore too.
- **Always on:** no "sleeping" free tier. A till must not wait a minute for
  the first bill of the morning.
- **Business use allowed** by the plan's terms.
- About 512 MB to 1 GB of memory.

## Options (prices checked 2026-10-04; they change, so confirm before paying)

| Host | Plan | Business use | Singapore | Monthly (app only) | Notes |
| --- | --- | --- | --- | --- | --- |
| **Fly.io** | pay as you go | yes | yes (`sin`) | about **$4.70** (512 MB) or **$8.50** (1 GB) | no free tier; credit card; deploys a container |
| Render | Starter instance | yes | yes | **$7** (512 MB) + workspace fee if a paid workspace is needed | free tier sleeps after 15 min (not for tills) |
| Railway | Pro (Hobby is non-commercial) | Pro only | yes | **$20** + usage over $20 | same as Vercel Pro |
| Vercel | Pro | yes | yes | **$20** per seat | the original recommendation; simplest |
| Hetzner Cloud (own server) | CPX22 | yes | yes | about **€26**, after 2026 price rises | we would run the server ourselves (updates, security): not for now |

Database (all options): Neon Launch, pay as you go, no minimum. It is
about $2-5/month for a small shop, because it sleeps when idle. Storage is
$0.35/GB-month.

## Recommendation

**Fly.io in Singapore, 1 GB machine: about $8.50/month, plus Neon Launch
(about $2-5), so roughly $11-14/month in all.** This is about half of
Vercel Pro.

- It runs the app unchanged in a standard container (`Dockerfile`, Phase 12
  step 2). The same container runs on Render, so the choice can be changed
  later.
- Backups, uptime checks and nightly maintenance run from GitHub Actions
  (Phase 11), not from the host, so they work with any host.
- Trade-offs:
  - Fly.io has no free tier and needs a credit card.
  - Deploys run a command (`fly deploy`) or a GitHub workflow, instead of
    Vercel's automatic previews.
  - Support is community-based on this plan.

**Second choice:** Render Starter ($7, 512 MB). It is simpler, but 512 MB
is tight for image resizing and the app together.

## Not chosen

- **Cloudflare Workers ($5):** cannot run the native password hashing and
  photo resizing without rewriting them.
- **Free tiers that sleep:** a till's first request of the day would wait.

## Sources

- [Fly.io pricing](https://docs.fly.io/about/pricing)
- [Render pricing explained](https://livemy.app/blog/render-pricing),
  [Render Starter $7](https://www.srvrlss.io/provider/render/)
- [Railway plans](https://docs.railway.com/reference/pricing/plans),
  [Railway: commercial use needs Pro](https://station.railway.com/questions/commercial-usage-using-hobby-plan-7fd8cf69),
  [Railway regions](https://docs.railway.com/deployments/regions)
- [Hetzner Singapore 2026 prices](https://bex.co/blog/2026/07/10/hetzner-singapore-region-apac-self-hosting)
- [Neon regions and pricing](https://www.srvrlss.io/provider/neon/)
- [Vercel fair use (Hobby non-commercial)](https://vercel.com/docs/limits/fair-use-guidelines)
