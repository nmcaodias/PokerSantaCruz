# Poker Santa Cruz

A one-page tracker for a home poker game: who bought in, how many times, what they
walked away with, and who pays whom at the end. No build step, no framework, no
accounts — one HTML file served as a static site.

## Using it

- **Add player** puts someone at the table with their first buy-in.
- **+** on a row adds another buy-in at the standard amount. A toast offers *Undo*
  for a few seconds, so a mis-tap costs nothing.
- **Finish** on a row records the chips that player counted at the end. The row
  turns green and the button shows the count; tap it again to correct it.
- **Finish game** shows each player's net and the shortest list of payments that
  settles everyone up, then locks the game.
- Tapping a **player's name** opens rename, remove, a custom-amount buy-in, and
  undo of their last buy-in.

The header strip keeps the running totals: money in the pot, chips counted so far,
and how many players. Once every player is counted, *Counted* turns green when the
books balance and amber when they don't — a chip miscount is caught before anyone
gets paid.

Buy-in amount, currency, game name, and the chip-to-money ratio live in Settings.
Leave *chips per buy-in* equal to the buy-in to enter cash directly; set it to the
number of physical chips a buy-in buys to enter chip counts instead.

## Syncing across devices

The game state is an **append-only log of events** — "player added", "buy-in",
"cashed out". Each event has a unique id, so merging two devices is just a union
of their logs. Two people tapping **+** at the same moment produce two different
events and both count; there is no last-write-wins step where one overwrites the
other. Every device also keeps working with no signal at all, queuing its events
and flushing them on reconnect.

Live sync needs somewhere to put that log. The app talks to a **Firebase Realtime
Database** over its plain REST API — reads stream over `EventSource`, writes are a
single `PATCH` per event — so there is no SDK and nothing to build.

1. Create a free project at [console.firebase.google.com](https://console.firebase.google.com).
2. **Build → Realtime Database → Create Database.**
3. Under **Rules**, publish:

   ```json
   { "rules": { "games": { "$code": { ".read": true, ".write": true } } } }
   ```

4. Put the database URL into `config.js` so every visitor gets sync automatically:

   ```js
   window.PSC_CONFIG = { dbUrl: "https://your-project-default-rtdb.firebaseio.com" };
   ```

   Or paste it once per device under **Settings → Realtime Database URL**.

Then **Settings → Copy share link** and send it to the table. Anyone who opens it
joins the same game and sees it update live. The status pill in the header reads
*Live*, *Saving*, *Offline*, or *Local* when no database is configured.

Those rules let anyone who knows a game code read and write that game. Codes are
random and unguessable and nothing personal is stored, which is fine for a home
game — don't reuse the database for anything sensitive.

Without a database the app still works fully; it just stays on the one device.

## Deploying

**One-time setup:** open **Settings → Pages** and set **Source** to **GitHub
Actions**. A workflow's token is not permitted to create the Pages site itself, so
this step can't be automated — until it's done, `.github/workflows/deploy.yml`
fails at `configure-pages` with *"Get Pages site failed"*.

After that, every push to the default branch publishes the site. The workflow also
runs on `main`, `master`, and `claude/**` branches. To publish without waiting for
another push, re-run the latest run from the **Actions** tab.

The site lands at `https://<user>.github.io/<repo>/`.

## Running locally

```sh
npm start          # serves the folder at http://localhost:8080
```

Any static file server works — there is nothing to compile.

## Tests

```sh
npm install        # playwright
npm test
```

`tests/app.test.mjs` drives the real page in Chromium: buy-ins, undo, cash-outs,
the settlement split, the balance warnings, rename/remove, settings, and reload
persistence. `tests/sync.test.mjs` runs **two independent browser contexts against
a mock Realtime Database** and checks they converge — history on join, live
updates both ways, simultaneous buy-ins on both devices, and an offline edit that
reaches the other device once the network returns.
