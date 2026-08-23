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

## Verifying the result

Real money changes hands on the strength of the settle-up screen, so it proves its
own arithmetic rather than asking to be trusted. Ending a game runs a set of checks
and **will not close while a blocking one fails**.

Blocking — each has a fix offered in the screen itself:

| Check | Meaning |
|---|---|
| Every player counted | nobody is settled as if they walked away with nothing by accident |
| Chips match the pot | the chips counted are worth exactly what was bought in |
| Player nets sum to zero | every euro won is a euro lost by someone else |
| Transfers reconcile | each debtor pays exactly their deficit, each creditor receives exactly their surplus |
| All amounts are valid | no zero, negative, or nonsensical buy-in or chip count |

Advisory — reported but never blocking, because nothing in the app can resolve them:
orphaned events (a buy-in belonging to a player this device has not seen, which
means a sync is incomplete), players removed while still holding buy-ins, changes
not yet uploaded, and whether sync is live.

Below the checks, an **audit table** shows the arithmetic per player — buy-ins →
money in, chips → money out, net — with a totals row, so the whole book can be
checked by hand.

### When the chips genuinely do not match

Sometimes a chip really is lost and no recount will fix it. Rather than override the
check, record the difference: choose whether it is split across everyone or assigned
to one player. The amount is written into the game's history and shown as its own
line in the audit. The book then balances honestly instead of being forced shut.

### Why the numbers always add up

Money is held as an **integer number of cents**, never as a floating-point amount.
Chip values often do not divide into whole cents — three chips to a €20 buy-in makes
one chip worth €6.666… — so cash-outs are allocated by *largest remainder*: each
player is floored, then the leftover cents go to the largest fractions. The column
therefore sums to exactly the value of the chips on the table.

This matters. An earlier version rounded each player independently and told one
player they were owed €26.67 while instructing the table to hand them €26.66. The
test suite now runs several thousand randomised games and asserts that the *rendered*
figures reconcile, not merely the numbers behind them.

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

The site is live at **https://nmcaodias.github.io/PokerSantaCruz/**.

GitHub Pages serves the `gh-pages` branch, and `.github/workflows/deploy.yml`
mirrors `main` onto it on every push. Nothing needs configuring in repo settings.

Pages was switched on by pushing a branch named `gh-pages`, which GitHub
auto-detects on a public repository. That path was taken because the
artifact-based deploy (`actions/deploy-pages`) requires the Pages source to be
set to "GitHub Actions" by hand, and a workflow token is not permitted to set it
(`Resource not accessible by integration`).

Treat `gh-pages` as generated output: never commit to it directly, since each
deploy force-updates it to match `main`.

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
the settlement split, the verification checks blocking and unblocking the end of a
game, rename/remove, settings, and reload persistence.

`tests/sync.test.mjs` runs **two independent browser contexts against a mock
Realtime Database** and checks they converge — history on join, live updates both
ways, simultaneous buy-ins on both devices, an offline edit that reaches the other
device once the network returns, and that both devices derive *identical* figures
from the same log (rounding ties break on player id precisely so two phones never
disagree).

`tests/verify.test.mjs` is the reconciliation suite: the €26.67/€26.66 regression,
**6000 randomised games** (4000 correctly counted, 2000 deliberately miscounted and
closed with an adjustment) asserting that every rendered figure adds up exactly, and
coverage of each individual check.
