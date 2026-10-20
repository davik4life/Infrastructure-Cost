# Zyria Infrastructure Costs

A small, private app for recording what Zyria spends on infrastructure each month and year.
It runs on its own at **costs.zyria.ng** on Cloudflare (Workers + D1 database), completely
separate from the Zyria app on Vercel. It doesn't share code, database or login with Zyria.

## Who can get in

- **Cloudflare Access** sits in front of costs.zyria.ng. Before any page loads, Cloudflare asks
  for an email address and sends a one-time code to it. Only the email addresses you put in the
  Access policy can get in. Everyone else, bots included, stops at Cloudflare's sign-in screen.
- The Worker also checks the Access sign-in token on every request (signature, audience, issuer,
  expiry). If Access is ever switched off or misconfigured, the app refuses everything instead of
  opening up.
- The `*.workers.dev` and preview URLs are turned off, so costs.zyria.ng is the only way in.
- Every change is recorded with the email of the person who made it (the **Activity** tab).

## Keeping it out of search engines and AI crawlers

- Crawlers can't get past the Access sign-in, so there is nothing for them to read.
- Every response also carries `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`, the page
  has a matching robots meta tag, and `/robots.txt` disallows everything.
- costs.zyria.ng isn't linked from zyria.ng, the sitemap, or anywhere public.

## First-time setup (about 15 minutes)

You need Node.js 20+ on your Mac and access to the Cloudflare account that holds zyria.ng.
Run the commands in Terminal from this folder.

### 1. Install and sign in to Cloudflare

```bash
npm install
npx wrangler login
```

### 2. Create the database

```bash
npx wrangler d1 create zyria-costs
```

Copy the `database_id` it prints into `wrangler.jsonc`, replacing `REPLACE_WITH_DATABASE_ID`.

### 3. Put Cloudflare Access in front of costs.zyria.ng

1. Open the Cloudflare dashboard and go to **Zero Trust** (one.dash.cloudflare.com). If this is
   your first time there, pick a team name (for example `zyria`) and choose the **Free** plan
   (free for up to 50 people).
2. Go to **Access → Applications → Add an application → Self-hosted**.
   - Application name: `Zyria Costs`
   - Session duration: `24 hours`
   - Public hostname: subdomain `costs`, domain `zyria.ng`
3. Add a policy:
   - Policy name: `Zyria admins`, Action: **Allow**
   - Include → **Emails** → add each admin's email address
4. Login methods: leave **One-time PIN** on. You can add Google later if you prefer.
5. Save the application. On its overview page, copy the **Application Audience (AUD) Tag**.
6. Find your team domain under **Settings → Custom pages** (it looks like
   `zyria.cloudflareaccess.com`).

In `wrangler.jsonc`, replace `REPLACE_WITH_TEAM_DOMAIN` and `REPLACE_WITH_AUD_TAG` with these two
values. Neither is a secret.

### 4. Create the tables and deploy

```bash
npm run db:migrate
npm run deploy
```

Wrangler creates the `costs.zyria.ng` DNS record for you. Open https://costs.zyria.ng, enter your
email, type the code Cloudflare sends you, and you're in. The services Zyria uses today are already
filled in.

## Adding or removing an admin

Zero Trust → Access → Applications → Zyria Costs → Policies → Zyria admins → edit the email list.
No redeploy needed.

## Day to day

- **Record a month**: once a month, fill in the real bills from each provider's invoice. Free
  services are left blank, monthly plans are pre-filled, usage-billed ones need the invoice amount.
- **Yearly bills** (the domain): record them only in the month you pay.
- **Exchange rate**: each dollar bill keeps the ₦ per $1 rate you entered with it, ideally the
  rate your bank actually charged. Changing the default rate never changes past months.
- **Export CSV**: downloads the selected year for your accountant.
- Services with recorded bills can't be deleted. Mark them **Cancelled** so past totals stay right.

## Making changes

```bash
cp .dev.vars.example .dev.vars   # local sign-in bypass, this computer only
npm run db:migrate:local
npm run dev                       # http://localhost:8787
npm test                          # sign-in and money checks
npm run deploy
```

Schema changes go in a new file in `migrations/` (for example `0002_...sql`), then
`npm run db:migrate` before deploying.

## Backups

D1 keeps 30 days of point-in-time history on every plan:
`npx wrangler d1 time-travel restore zyria-costs --timestamp=<when>`.
For a copy you keep yourself: `npx wrangler d1 export zyria-costs --remote --output=costs-backup.sql`.

## Cost

Workers, D1 and Access are all free at this size (Access free for up to 50 users).
# Infrastructure-Cost
