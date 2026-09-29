# Open Chambers

iPhone app that tells you when your representative or senators vote, with a one-line official summary of the bill. Companion to [The Floor](https://johnhubert.llc/floor/) (the web app) and reads the same nightly data.

Bundle id `com.johnhubert.openchambers` · Copyright © 2026 John Hubert LLC. Operations and troubleshooting: see `ADMIN.md`.

```
openchambers/
  app/        Capacitor iPhone shell — www-src/index.html is the whole app
  worker/     Alerts service on Cloudflare Workers (+ D1). Polls the House and Senate, sends APNs pushes
  .github/    ios-bootstrap workflow (generates app/ios once on a macOS runner)
```

## How it fits together

1. `floor` repo's nightly Action publishes `members.json`, `votes/*.json`, `zip.json` to https://johnhubert.llc/floor/data/. The app reads those directly.
2. The Worker runs every 10 minutes while Congress is usually in session. It notices new roll calls, looks up who follows each member, fetches the CRS summary from Congress.gov, and sends a push through APNs. Quiet-hours pushes are queued and sent at 8 AM Eastern.
3. The app registers its APNs token with `POST https://api.johnhubert.llc/v1/subscribe` along with the list of followed members and the alert mode. That is the only data the server keeps: token, follows, mode, quiet flag. No ZIP, no name, no account.

## Runbook — do these once, in order

### A. Cloudflare (alerts server) — about 20 minutes

```sh
cd worker
npm install
npx wrangler login
npx wrangler d1 create openchambers            # copy the database_id into wrangler.toml
npx wrangler d1 execute openchambers --remote --file schema.sql
```

Secrets (each prompts for the value):

```sh
npx wrangler secret put APNS_KEY        # paste the full contents of the .p8 file from step B2, including BEGIN/END lines
npx wrangler secret put APNS_KEY_ID     # 10-character Key ID shown next to the key
npx wrangler secret put APNS_TEAM_ID    # Team ID (Membership page in developer.apple.com)
npx wrangler secret put CONGRESS_API_KEY  # free key from https://api.congress.gov/sign-up/
```

Deploy and check:

```sh
npx wrangler deploy
curl https://api.johnhubert.llc/v1/health
```

`wrangler.toml` claims `api.johnhubert.llc` as a custom domain; because johnhubert.llc is already on Cloudflare, Wrangler creates the DNS record for you. `APNS_HOST` stays on the production host: Xcode Cloud archives are App Store-signed, so TestFlight builds use production APNs too.

### B. Apple — about 30 minutes, all in a browser

1. **Identifier.** Certificates, Identifiers & Profiles → Identifiers → + → App IDs → App. Bundle ID (explicit) `com.johnhubert.openchambers`, description "Open Chambers". Under Capabilities tick **Push Notifications**. Register.
2. **APNs key.** Keys → + → name "Open Chambers APNs", tick **Apple Push Notifications service (APNs)**. Download the `.p8` once (Apple won't offer it again), note the Key ID. This is the `APNS_KEY` / `APNS_KEY_ID` above. Store the .p8 somewhere safe and off the repo.
3. **App record.** App Store Connect → Apps → + → iOS, name **Open Chambers**, primary language English, bundle ID from step 1, SKU `openchambers`.
4. **Push the repo to GitHub** and run the **ios-bootstrap** workflow from the Actions tab (done). It generates `app/ios/` and commits it back.
5. **Signing.** Xcode Cloud needs Xcode for its first setup, so builds run on GitHub Actions instead (`.github/workflows/ios-release.yaml`). That needs three things, created once:
   - *Distribution certificate.* On the iMac open **Keychain Access** → menu Keychain Access → Certificate Assistant → **Request a Certificate From a Certificate Authority**. Email: support@johnhubert.llc, Common Name: John Hubert LLC, "Saved to disk". Then at developer.apple.com → Certificates → + → **Apple Distribution** → upload that `.certSigningRequest` → download the `.cer` → double-click it (imports into Keychain). In Keychain Access → My Certificates, find "Apple Distribution: John Hubert, LLC", expand it to confirm a private key is underneath, right-click → **Export** → format `.p12`, pick a password. (If the certificate shows "not trusted", install the Apple WWDR G3 intermediate from apple.com/certificateauthority and reopen Keychain Access.)
   - *Provisioning profile.* developer.apple.com → Profiles → + → **App Store Connect** (under Distribution) → App ID `com.johnhubert.openchambers` → certificate: the one above → name exactly `Open Chambers` → Generate → Download the `.mobileprovision`.
   - *App Store Connect API key.* appstoreconnect.apple.com → Users and Access → **Integrations** → App Store Connect API → Team Keys → + → name "GitHub upload", access **App Manager** → Generate → Download the `.p8` (once). Note the **Key ID** on that row and the **Issuer ID** at the top of the page.
6. **GitHub secrets.** In Terminal, base64 the three files (each command copies to the clipboard): `base64 -i ~/Downloads/cert.p12 | pbcopy`, `base64 -i ~/Downloads/Open_Chambers.mobileprovision | pbcopy`, `base64 -i ~/Downloads/AuthKey_XXXXXXXXXX.p8 | pbcopy`. Then repo → Settings → Secrets and variables → Actions → New repository secret, six times: `IOS_P12_BASE64`, `IOS_P12_PASSWORD`, `IOS_PROFILE_BASE64`, `ASC_KEY_BASE64`, `ASC_KEY_ID`, `ASC_ISSUER_ID`.
7. **Build.** Actions → **ios-release** → Run workflow (about 10–15 minutes). After that it runs on every push that touches `app/`. Each run uploads a build numbered by the run number; Apple processes it and it appears under the app's **TestFlight** tab.
8. **TestFlight.** TestFlight tab → Internal Testing → + group → add yourself → the build shows up; install the TestFlight app on your iPhone, install Open Chambers, enter your ZIP, follow someone, allow notifications. Then send yourself a test push: get your device token from the Worker (`npx wrangler d1 execute openchambers --remote --command "select token from subscriptions"`) and `curl -X POST https://api.johnhubert.llc/v1/test-push -H 'content-type: application/json' -d '{"key":"<CONGRESS_API_KEY>","token":"<token>"}'`.

### C. App Store listing

| Field | Value |
|---|---|
| Category | News (secondary: Reference) |
| Age rating | Everything "None" → 4+. Do **not** opt into the Kids Category (that adds restrictions we don't need; the app is designed for adults and is kid-safe anyway). |
| Price | Free |
| Privacy — data collected | **Identifiers → Device ID** (the push token): used for App Functionality, *not* linked to the user, *not* used for tracking. Nothing else. |
| Privacy policy URL | https://johnhubert.llc/privacy.html (add the Open Chambers section below) |
| Support URL | https://johnhubert.llc |
| Encryption | `ITSAppUsesNonExemptEncryption` is set to false in Info.plist (HTTPS only) so the export-compliance question is skipped. |
| Sign-in | None, so no Sign in with Apple obligation. |
| Content rights | All data is U.S. government public record (House Clerk, Senate, CRS) plus the public-domain unitedstates project and Voteview (CC0). |

Subtitle (30 chars): `Know how your reps vote`
Promo text: `Enter your ZIP. Follow your representative and senators. Get a notification, with a plain-English official summary, every time they vote.`
Keywords: `congress,vote,representative,senator,bill,roll call,house,senate,civic,government`

Screenshots: 6.9" (iPhone 16 Pro Max) and 6.5" sets are required. Take them in the simulator via Xcode Cloud's TestFlight build on any iPhone, or use the mockup artifact frames at 1320×2868.

Review notes to paste: "Open Chambers shows public congressional roll-call votes. No account is needed. To test alerts: enter ZIP 10001, turn on the switch next to any member, allow notifications. Alerts arrive when that member casts a recorded vote; between sessions of Congress there may be none, so the Today tab also lists their recent votes."

### D. Privacy policy addition (paste into privacy.html)

> **Open Chambers (iPhone).** Open Chambers does not ask for your name, email, or location. The ZIP code you enter is stored only on your device and is used to look up your congressional district from a bundled table. If you turn on alerts, the app sends an anonymous Apple push-notification token and the list of members you follow to our alerts service (hosted on Cloudflare). That is the only information the service stores; it is deleted when you unfollow everyone or delete the app (Apple reports the token as unregistered and we remove it). The app contains no analytics, no advertising, and no third-party SDKs other than Apple's push-notification framework. Bill summaries are fetched from Congress.gov through our service so that no third party sees your device token. Questions: support@johnhubert.llc.

## Developing

- Web preview: `cd app && python3 -m http.server 8080` then open http://localhost:8080/www-src/ — everything works except push (the Settings tab shows "Not available on the web").
- Change the UI: edit `app/www-src/index.html`, commit, push. Xcode Cloud rebuilds and ships to TestFlight.
- Worker changes: `cd worker && npx wrangler deploy`. `npx wrangler tail` streams logs; `POST /v1/test-push` sends a test notification.
- Worker tests: `node --test worker/test/*.test.mjs`.

## Not in v1 (on purpose)

Text-message alerts (needs a carrier gateway and per-message cost), Android, accounts, sharing. All can be added without changing the data model.
