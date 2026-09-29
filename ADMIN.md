# Open Chambers — administrator's guide

How the system works, how to tell whether it is working, and what to do when it isn't. Companion to `README.md` (which is the one-time setup runbook).

## 1. The three parts

Open Chambers is three separate things that only talk to each other through public URLs.

**The website and its nightly pipeline** (repo `1084/floor`, live at https://johnhubert.llc/floor/). A GitHub Action runs `pipeline/build.mjs` once a day. It downloads the member list (unitedstates/congress-legislators), every House roll call of the year from `clerk.house.gov`, every Senate roll call of the session from `senate.gov`, the DW-NOMINATE scores from Voteview, and the ZIP-to-district table, and writes them as static JSON files under `docs/data/`. GitHub Pages serves those files. No keys, no server, nothing runs between builds. **This is where the app's voting records come from.**

**The alerts service** (repo `1084/open-chambers`, folder `worker/`, live at https://api.johnhubert.llc). A Cloudflare Worker with a small D1 database. On a schedule (below) it asks `clerk.house.gov` and `senate.gov` directly whether any roll call has happened since the last one it saw, and for each new vote it looks up who follows any member who voted and sends them a push notification through Apple (APNs). It stores only: push tokens, which members each token follows, alert preferences, which votes it has already handled, and a few bookkeeping values.

**The iPhone app** (same repo, folder `app/`). A single web page (`app/www-src/index.html`) wrapped by Capacitor. It reads the website's JSON directly for everything it displays, keeps the ZIP code and preferences on the phone, and talks to the alerts service for exactly two things: registering the push token with the list of followed members, and fetching a bill summary.

Data flow for one notification:

```
clerk.house.gov / senate.gov  ──(every 10 min)──▶  Worker poll()
                                                       │ new vote?
                                                       ▼
                                          D1: who follows a voter?  ──▶  Congress.gov (bill summary, cached)
                                                       │
                                                       ▼
                                          APNs (Apple)  ──▶  the phone
```

### The keys, and what each one is for

| Key | Lives in | Used for | NOT used for |
|---|---|---|---|
| Congress.gov API key (`CONGRESS_API_KEY`) | Cloudflare secret; also in your Terminal when you run admin commands | Fetching CRS bill summaries from api.congress.gov; and as the password for the admin endpoints (`/v1/status`, `/v1/poll`, `/v1/test-push`) | Votes. Roll-call data needs no key at all; it is fetched as XML from the House Clerk and the Senate. (The key is issued by api.data.gov, which is why the email came from data.gov.) |
| APNs key (`APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`) | Cloudflare secrets; the `.p8` file in your safe storage | Signing the requests the Worker sends to Apple to deliver notifications | Anything else |
| App Store Connect API key (`ASC_KEY_*` secrets) | GitHub repository secrets; the `.p8` in safe storage | Letting the GitHub build upload new builds to TestFlight | Anything at run time |
| Distribution certificate + provisioning profile (`IOS_P12_*`, `IOS_PROFILE_BASE64`) | GitHub repository secrets; `.p12` in safe storage | Code-signing the app during the GitHub build | Anything at run time |
| GitHub personal access token | macOS Keychain on the iMac | `git push` from Terminal | Anything else |

## 2. Schedules

| What | When | Where to see it |
|---|---|---|
| Website data refresh | Daily, scheduled 07:17 UTC (GitHub often runs it hours late, typically 13:00–16:00 UTC / 9 AM–noon ET) | github.com/1084/floor → Actions → "Refresh data" |
| Worker poll | Every 10 minutes, 13:00–23:59 UTC Mon–Fri and 00:00–03:59 UTC Tue–Sat (9 AM–midnight ET on weekdays), plus once every 2 hours around the clock | `/v1/health` → `lastRun` |
| Quiet hours (per user, if enabled) | Alerts held 10 PM–8 AM Eastern, sent at 8 AM | `/v1/status` → `counts.queued` |
| App build | On every push to `main` that touches `app/`, or manually | github.com/1084/open-chambers → Actions → "ios-release" |

A vote that happens today shows up in the **app's vote lists** only after tonight's website refresh. A **notification** for it, however, does not wait for the refresh: the Worker reads the House and Senate directly and should send within about 10 minutes of the vote being posted.

## 3. Is it working? Three checks, in order

**Check 1 — the Worker is alive and polling.** In a browser (no key needed):

    https://api.johnhubert.llc/v1/health

`lastRun` should be a timestamp from the last 10 minutes during session hours, followed by `house=<n> senate=<n> new=<n> sent=<n>`. The two numbers are the last roll-call numbers it has seen; they should match the newest numbers on clerk.house.gov and senate.gov. If `lastRun` is hours old during a weekday afternoon, the cron is not firing (see §5).

**Check 2 — the full picture.** In Terminal (the key is your Congress.gov key; the `read` line hides it while you type):

    read -s "KEY?Congress API key: "; echo
    curl -s "https://api.johnhubert.llc/v1/status?key=$KEY" | python3 -m json.tool

This shows: the bookkeeping `state` (high-water marks, `last_run`, `last_error` if a poll has ever crashed, `seeded`), row `counts`, the 10 most recent votes it handled, every subscription (first 8 characters of the token, mode, follow count, last update), whether each secret is present, and the configuration. **`last_error` is the first thing to read when something is wrong.**

**Check 3 — the website pipeline.** github.com/1084/floor → Actions. The latest "Refresh data" run should be green and from today. Its log ends with counts (members, house, senate, nominate). https://johnhubert.llc/floor/data/meta.json shows `builtAt` and the totals the app is currently reading.

## 4. "I didn't get a notification for today's vote" — the decision tree

Work down this list; the first "no" is the cause.

1. **Was it a recorded roll-call vote?** Voice votes and unanimous-consent agreements produce no roll call and no notification. Check clerk.house.gov/Votes or senate.gov → Votes → Roll Call Votes for today.
2. **Is your alert mode "Final passage" and was this a passage vote?** The default mode sends only votes whose question is passage, adoption, concurrence, a conference report, a veto override, or an amendment "as amended". Cloture motions, motions to proceed or table, nominations, procedural votes, and most amendments are **not** sent in that mode. Most Senate days consist entirely of cloture votes and nominations. Switch to "Every roll call" in the app's Settings if you want those. (`/v1/status` shows each subscription's `mode`.)
3. **Did the Worker poll after the vote?** `/v1/health` → `lastRun`. Votes after 4 AM UTC / before 9 AM ET on a weekday, or on weekends, are picked up by the 2-hourly heartbeat, so up to 2 hours late.
4. **Did the Worker see the vote?** `/v1/status` → `recentVotes` should list its id (`h-119-2-NNN` or `s-119-2-NNNNN`). If the high-water mark (`house_last_…` / `senate_last_…` in `state`) is *ahead* of the vote's number, the vote was skipped; if it is *behind* by a lot, the Worker is still catching up (see §5, "stale notifications").
5. **Do you follow someone who voted?** The vote page on the website lists every member's position. A member who was absent still counts ("did not vote").
6. **Was it quiet hours?** If your quiet toggle is on and the vote was between 10 PM and 8 AM ET, it is queued (`counts.queued`) and sent at 8 AM.
7. **Did Apple accept it?** `last_error` in `/v1/status`, or run `npx wrangler tail` in `worker/` and wait for the next poll; APNs rejections are logged as `apns <status> <reason>`. See the table in §6.
8. **Is the phone still registered?** `/v1/status` → `subscriptions` should show your token prefix. If the row is gone, Apple reported the token dead (app deleted/reinstalled) and the Worker removed it; opening the app re-registers, or toggle a follow switch off and on.

To test the whole delivery path at any time (Terminal, in `worker/`):

    TOKEN=$(npx wrangler d1 execute openchambers --remote --json --command "select token from subscriptions limit 1" | python3 -c "import json,sys;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d;print(d['results'][0]['token'])")
    curl -s -X POST https://api.johnhubert.llc/v1/test-push -H 'content-type: application/json' -d "{\"key\":\"$KEY\",\"token\":\"$TOKEN\"}"; echo

Expected: `{"ok":true,"status":200,"reason":""}` and a banner on the phone.

To force a poll right now instead of waiting for the cron:

    curl -s -X POST https://api.johnhubert.llc/v1/poll -H 'content-type: application/json' -d "{\"key\":\"$KEY\"}"; echo

## 5. Known failure modes and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `lastRun` hours old on a weekday | Worker cron not firing, or every poll crashing | `/v1/status` → `last_error`. If empty, check the Cloudflare dashboard → Workers → openchambers-api → Logs / Cron triggers. Redeploy: `cd worker && npx wrangler deploy`. |
| `last_error` mentions `senate.gov` or `clerk.house.gov` with status 403/503 | The source site is blocking or down | Wait; both sites have brief outages. If 403 persists for a day, the site is blocking Cloudflare's network: open an issue in the repo and we change the fetch (different User-Agent or proxy through the nightly pipeline). |
| `last_error` mentions `members.json` | The website is down or the data folder moved | Check https://johnhubert.llc/floor/data/members.json loads. The Worker caches members for 6 h and needs them to map Senate votes to people. |
| Stale notifications for votes from weeks ago | High-water marks started too low (a fresh database before the seeding logic existed) | Reset them and let the Worker reseed from the website: `npx wrangler d1 execute openchambers --remote --command "delete from state where key like 'house_last_%' or key like 'senate_last_%'"`, then force a poll. |
| `apns 403 InvalidProviderToken` | APNs key, key id, or team id wrong or revoked | Re-enter the three `APNS_*` secrets (`npx wrangler secret put …`). Check the key still exists at developer.apple.com → Keys. |
| `apns 400 BadDeviceToken` / `410 Unregistered` | Phone token dead (app deleted, or a development token hitting production) | Nothing to do; the Worker deletes the row. The app re-registers on next launch. |
| `apns 400 TopicDisallowed` / `DeviceTokenNotForTopic` | `APNS_TOPIC` in `wrangler.toml` doesn't match the bundle id | Must be `com.johnhubert.openchambers`. Fix, `npx wrangler deploy`. |
| App shows "Couldn't register" with an error line | Native push plumbing | The error text says what. `no valid aps-environment entitlement`: the profile was made before Push was enabled on the App ID; regenerate the profile and rebuild. |
| App shows "Off in iPhone Settings" | User denied notifications | iPhone Settings → Notifications → Open Chambers → Allow. |
| Vote lists in the app are days old | Nightly refresh failing | github.com/1084/floor → Actions → open the failed run → read the log. Usually a source site outage; re-run the workflow. |
| Nightly refresh green but a chamber's count didn't grow | The source changed its XML | Compare a current file from clerk.house.gov/evs/2026/rollNNN.xml (or the Senate equivalent) to what `pipeline/parsers.mjs` expects; the parser tests in `test/` show the shapes. |
| ios-release build fails at "Import signing certificate" | Certificate or profile expired (both are issued for one year) | Repeat README section B5 for the expired item and update the matching GitHub secret. |
| ios-release fails at "Export and upload" with an authentication error | App Store Connect API key revoked | Generate a new key (README B5, third item) and update the three `ASC_*` secrets. |
| Bill summary says "No CRS summary has been published" | Normal: CRS writes summaries days or weeks after introduction, and never for some resolutions and nominations | Nothing to do. |

## 6. Routine operations

**Changing the app.** Edit files under `app/www-src/` (the UI) or `worker/src/` (the service). Commit and push. An `app/` change builds and uploads a new TestFlight build automatically (about 5 minutes plus Apple's processing); a `worker/` change needs `cd worker && npx wrangler deploy`. Web-only changes to the app can be previewed first: `cd app && python3 -m http.server 8080` then open http://localhost:8080/www-src/ (push is unavailable in the browser; everything else works).

**Releasing to the App Store.** App Store Connect → the app → Distribution → the version → pick the build → Submit for Review. Increment the version (`MARKETING_VERSION` in `.github/workflows/ios-release.yaml`) for each store release; the build number is the GitHub run number and increments on its own.

**Looking at logs live.** `cd worker && npx wrangler tail` streams every request and poll as it happens. Leave it open across a 10-minute boundary to watch a poll.

**Looking at the database.** `npx wrangler d1 execute openchambers --remote --command "<SQL>"`. Tables: `subscriptions`, `follows`, `seen_votes`, `queued`, `state`. Useful queries: `select count(*) from subscriptions`; `select * from state`; `select vote_id, seen_at from seen_votes order by seen_at desc limit 20`.

**Removing a user's data on request.** They can do it themselves by unfollowing everyone or deleting the app. Manually, with the first characters of their token from `/v1/status`: `delete from follows where token like 'abcd1234%'; delete from subscriptions where token like 'abcd1234%';`.

**Rotating a secret.** Cloudflare: `npx wrangler secret put NAME` (overwrites). GitHub: repo → Settings → Secrets and variables → Actions → pencil icon. Neither needs a code change.

## 7. Calendar

| When | What |
|---|---|
| January 2027 (120th Congress) | In `worker/wrangler.toml` set `CONGRESS = "120"` and deploy; in `floor/pipeline/build.mjs` update the Congress number and the Voteview file name (`HS120_members.csv`, published by Voteview a few weeks into the new Congress). The high-water keys are per Congress and session, so they reseed automatically. |
| Each January (new session) | Nothing; session is computed from the year. |
| ~September 2027 | Apple Distribution certificate and provisioning profile expire (one year from creation). Repeat README B5 items 1–2 and update `IOS_P12_BASE64`, `IOS_P12_PASSWORD`, `IOS_PROFILE_BASE64`. The app already on phones keeps working; only new builds need it. |
| Annually | Apple Developer Program renewal (email from Apple). If it lapses, the app is removed from the store and push stops. |
| When Apple raises the minimum SDK | GitHub's `macos-latest` image tracks current Xcode; if a build fails with an SDK complaint, bump nothing and re-run, or pin the runner label in the workflow. |

## 8. Costs and limits

Everything currently runs on free tiers: GitHub Actions (2,000 macOS-weighted minutes/month is more than enough for a few builds a day), GitHub Pages, Cloudflare Workers (100,000 requests/day; the polls use about 300), D1 (5 GB), Congress.gov API (5,000 requests/hour; summaries are cached). APNs is free. Apple Developer Program is the one recurring cost.
