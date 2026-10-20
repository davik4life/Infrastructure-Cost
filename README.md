# Zyria Infrastructure Costs

A small, private app for recording what Zyria spends on infrastructure each month and year.
It runs on its own at **costs.zyria.ng** on Cloudflare (Workers + D1 database), completely
separate from the Zyria app on Vercel. It doesn't share code, database or login with Zyria.

## Who can get in

- **Cloudflare Access** sits in front of costs.zyria.ng. Before any page loads, Cloudflare asks
  for an email address and sends a one-time code to it. Only the email addresses listed in the
  "Zyria admins" policy can get in. Everyone else, bots included, stops at Cloudflare's sign-in
  screen. Anyone not on the list can still request a code, but Cloudflare never sends one.
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

If Wrangler offers to add it to your config, say **yes**, and answer **no** to "connect to the
remote resource for local dev" (local testing should use a throwaway copy, not your real records).
Then open `wrangler.jsonc` and check that `d1_databases` has **exactly one** entry, with
`"binding": "DB"` and the new `database_id`. If Wrangler added a second entry under another
binding name, move its `database_id` into the `DB` entry and delete the extra one. The app only
reads `DB`.

### 3. Put Cloudflare Access in front of costs.zyria.ng

**3a. Turn on email codes (One-time PIN).** New Zero Trust accounts only come with the
"Cloudflare" login, which makes every admin sign in with a Cloudflare account. Email codes are
simpler: each admin types their email address and gets a 6-digit code.

1. Open the Cloudflare dashboard and go to **Zero Trust** (one.dash.cloudflare.com). If this is
   your first time there, pick a team name (for example `zyria`) and choose the **Free** plan
   (free for up to 50 people).
2. Go to **Integrations → Identity providers → Add new identity provider → One-time PIN**, and save.

**3b. Create the application.**

1. Go to **Access → Applications → Add an application** and choose **Self-hosted**.
2. Destination: choose **Public DNS**, then subdomain `costs`, domain `zyria.ng`.
   (Not *Workers*, *Private destinations* or *Service auth*. The app checks the sign-in token that
   the Public DNS setup sends.)
3. Application name: `Zyria Costs`. Session duration: `24 hours`.
4. **Login methods:** tick **One-time PIN**. You can also leave **Cloudflare** ticked if you like
   signing in with your own Cloudflare account. Turn on **Instant Auth** only if One-time PIN is
   the only method ticked.

**3c. Add the policy.** This is what decides who gets in.

- Policy name: `Zyria admins`, Action: **Allow**
- Add one **Include** rule: selector **Emails**, value: each admin's email address.
- Don't add anything else. In particular:
  - Leave **Authentication Method** alone. It requires a particular kind of sign-in (such as a
    hardware key) and blocks email codes if set wrong.
  - Never use **Login Methods → One-time PIN** as the *only* Include rule. That lets in anyone
    with any email address.

**3d. Copy two values into `wrangler.jsonc`.**

- `ACCESS_TEAM_DOMAIN`: your **team domain**, from **Settings → Team name and domain** (or
  **Custom pages**). It always ends in `.cloudflareaccess.com`, like `zyria.cloudflareaccess.com`.
  It is *not* costs.zyria.ng, and has no `https://`.
- `ACCESS_AUD`: the application's **Application Audience (AUD) Tag**, from Access → Applications →
  Zyria Costs (overview or Basic information). It is 64 letters and numbers with no dashes. The
  shorter ID with dashes that appears in the page address is the application ID, not the AUD tag.

If either value is in the wrong format, the app says so on screen after you deploy, instead of
letting anyone in.

Neither is a secret. The file is fine to commit to a private GitHub repo.

### 4. Create the screenshot storage, the tables, and deploy

```bash
npx wrangler r2 bucket create zyria-costs-uploads
npm run db:migrate
npm run deploy
```

The bucket is private: it has no public URL, and screenshots are only served through the app after
sign-in. Don't attach a custom domain or turn on public access for it in the R2 dashboard.

Wrangler creates the `costs.zyria.ng` DNS record for you. Open https://costs.zyria.ng, enter your
email, type the code Cloudflare sends you, and you're in. The services Zyria uses today are already
filled in.

## Adding or removing an admin

Zero Trust → Access → Applications → Zyria Costs → Policies → Zyria admins → edit the email list.
No redeploy needed. Removing someone takes effect at their next sign-in, within 24 hours. To cut
them off at once, go to **Zero Trust → My team → Users**, open them, and choose **Revoke session**.

## Updating an existing install

When a new version adds a file to `migrations/`, run `npm run db:migrate` before `npm run deploy`.

**Upgrading to the priority, links and screenshots version** (migration `0002`), once:

```bash
npx wrangler r2 bucket create zyria-costs-uploads
npm run db:migrate
npm run deploy
```

Bills you recorded before this update are marked **Paid**, and every service gets a starting
priority (Critical: Vercel, Neon, Cloudflare DNS, the domain, Paystack. High: R2, Resend, Upstash,
Shipbubble. Medium: Sentry, GitHub, OpenAI. Low: this app). Change any of them in the app.

## Day to day

- **Record a month**: once a month, fill in the real bills from each provider's invoice. Free
  services are left blank, monthly plans are pre-filled, usage-billed ones need the invoice amount.
- **Yearly bills** (the domain): record them only in the month you pay.
- **Exchange rate**: each dollar bill keeps the ₦ per $1 rate you entered with it, ideally the
  rate your bank actually charged. Changing the default rate never changes past months.
- **Priority** (Critical, High, Medium, Low) is set on each service and copied to its bills, where
  you can change it per bill. The ledger and the services list sort by it, and the ledger can
  filter by it.
- **Paid or due**: record a bill as *Due* when it's come in but isn't paid yet. Due bills, from
  any year, appear in **Due to pay** at the top, most urgent first, with **Mark paid** (which also
  fills in today's date if "Paid on" is empty).
- **Payment link**: each service can hold its billing page, and each bill can hold its own link
  (an invoice, say). New bills start with the service's link. Links must start with `https://`.
- **Screenshots**: add plan pages, invoices or receipts to a service or a bill. Use "Add
  screenshots", or paste straight from the clipboard while the form is open. PNG, JPEG, WebP or
  GIF, up to 5 MB each and 10 per item. They upload when you save. Deleting a bill or service
  deletes its screenshots too.
- **Export CSV**: downloads the selected year for your accountant, with priority, status and links.
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
Screenshots live in R2, which time-travel doesn't cover. Deleting one in the app removes it for good.

## Cost

Workers, D1 and Access are all free at this size (Access free for up to 50 users). R2 storage is
free up to 10 GB a month, shared with the bucket Zyria already uses for product images. Thousands
of screenshots fit in well under 1 GB.
# Infrastructure-Cost
