# Front Desk Concierge — standalone app

A staff chat tool grounded only in a saved knowledge base, plus an `/admin` page for managers
to add, edit, and delete answers (with optional flyer attachments). This is a standalone
rebuild of the Claude-artifact version, meant to run at its own public URL.

**Nothing here costs money until you deploy it with real credentials.** You can read this
whole README, and even run the app locally in demo mode (see below), without creating an
Anthropic API key or touching your Fly.io billing.

## What it needs to run for real

| Thing | Where to get it | Cost |
|---|---|---|
| Anthropic API key | console.anthropic.com → API Keys | Pay-as-you-go, billed separately from any claude.ai subscription. A single Q&A exchange costs a small fraction of a cent with Claude Sonnet. |
| Fly.io app + volume | You already have a Fly.io account | Fly's smallest always-on machine + a small volume is typically a few dollars/month. Check Fly's current pricing before deploying. |
| A GitHub repo | You already have a GitHub account | Free for a private repo. |

You control both accounts and both bills — I never create accounts or spend on your behalf.

## Try it locally first, for free (demo mode)

If you don't set `ANTHROPIC_API_KEY`, the app runs in **demo mode**: every page works —
the staff passcode gate, the chat UI, flyer attachments, the `/admin` editor — except the
chat endpoint returns a canned placeholder instead of a real Claude answer. This is a safe
way to click through everything before spending anything.

The app has zero npm dependencies (it only uses Node's built-ins), so there's nothing to
install — just run it:

```
cd front-desk-concierge
cp .env.example .env
# edit .env: set STAFF_PASSCODE, ADMIN_PASSWORD, and SESSION_SECRET
# (leave ANTHROPIC_API_KEY blank to stay in demo mode)
npm start
```

Then open `http://localhost:8080` in your browser.

## Going live

### 1. Get an Anthropic API key (only when you're ready)

Go to console.anthropic.com, create an API key, and add a payment method. Keep the key
secret — never commit it to GitHub or paste it into a public place.

### 2. Push this folder to a GitHub repo

```
cd front-desk-concierge
git init
git add .
git commit -m "Front Desk Concierge"
gh repo create ysaz-front-desk-concierge --private --source=. --push
```

(Or create the repo on github.com first and `git remote add origin <url>` + `git push`.)

### 3. Create the Fly.io app and volume

Edit `fly.toml` first — change `app = "CHANGE-ME-front-desk-concierge"` to something unique,
e.g. `ysaz-front-desk-concierge`.

```
fly auth login          # if you're not already logged in
fly apps create ysaz-front-desk-concierge
fly volumes create fdc_data --region phx --size 1
```

(`--size 1` is 1 GB — plenty for the knowledge base JSON and a handful of flyer PDFs. `phx`
is Phoenix; pick a different region code if you'd rather.)

### 4. Set your secrets (these never go in the code or GitHub)

```
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  STAFF_PASSCODE="whatever you want front desk staff to type" \
  ADMIN_PASSWORD="a stronger password for you and Anthony" \
  SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
```

### 5. Deploy

```
fly deploy
```

Fly will print your app's URL (something like `https://ysaz-front-desk-concierge.fly.dev`).
That's the link to give staff — bookmark it, or set it as the homepage on a front-desk
computer's browser. `/admin` on that same domain is the manager page.

### 6. (Optional) Auto-deploy on every push

A ready-made GitHub Actions workflow is already in `.github/workflows/deploy.yml`. To turn
it on:

```
fly tokens create deploy -x 999999h   # generates a long-lived deploy token
```

Copy the printed token, then in your GitHub repo go to **Settings → Secrets and variables →
Actions → New repository secret**, name it `FLY_API_TOKEN`, and paste it in. From then on,
every `git push` to `main` redeploys automatically.

## What staff will see

- **Front desk / leadership staff**: visit the URL, type the shared passcode once (it's
  remembered in their browser for 30 days), then ask questions in plain language. A "Staff
  Directory" button and a link into `/admin` (view only, until they enter the admin password)
  sit in the sidebar.
- **Managers (you + Anthony)**: visit `/admin`, enter the admin password, then add, edit, or
  delete knowledge base entries and attach flyer PDFs/images — the same editor as the old
  Claude-artifact version.

## Changing the passcode or admin password later

```
fly secrets set STAFF_PASSCODE="new passcode"
fly secrets set ADMIN_PASSWORD="new password"
```

Each takes effect on the next request — no redeploy needed. Anyone already logged in stays
logged in (cookies are valid 30 days) until they clear cookies or you rotate `SESSION_SECRET`,
which invalidates every existing login.

## Notes on the current design

- The knowledge base is stored as a single JSON file (plus an `uploads/` folder for flyers)
  on the Fly volume — simple and easy to back up (`fly ssh sftp get /data/kb.json`), but it
  means **only one Fly machine should ever run this app** (already set in `fly.toml` via
  `min_machines_running = 1` and no autoscaling). If you outgrow this later, swap the JSON
  file for a real database (e.g. Fly Postgres) — everything else stays the same.
- Both the staff passcode and the admin password are single shared secrets, not per-person
  logins — that was the simpler option you chose. If you'd rather have individual logins per
  manager (so you know who changed what), that's a bigger change I can help with later.
- The app was seeded with the same 31 knowledge base entries from the Claude-artifact
  version, including the Facility Use Agreement flyer.
