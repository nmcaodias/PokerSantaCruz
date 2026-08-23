/* Reconciliation tests.
 *
 * The point of these is narrow and important: every figure the settle-up screen
 * shows must add up exactly, for any combination of buy-ins and chip ratios.
 * The regression case below shipped as a real bug — a player was shown as owed
 * €26.67 while the transfers paying them totalled €26.66. */

import { chromium } from './_playwright.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'text/plain' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(8096, r));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
await page.goto('http://localhost:8096/#g=verifytests');
await page.waitForTimeout(300);

const T = [];
const check = (n, c, x = '') => T.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + x}`);

/* Build an event log in the page and fold it. Returns the derived state plus
 * the settlement and the verification checks. */
const run = (spec) => page.evaluate((spec) => {
  const M = window.PSC_MATH;
  let n = 0;
  const ev = {};
  const put = (o) => { const id = 'e' + (++n).toString().padStart(4, '0'); ev[id] = Object.assign({ id, ts: 1000 + n, dev: 't' }, o); };

  put({ type: 'settings', value: { buyIn: spec.buyIn, chipsPerBuyIn: spec.chipsPerBuyIn, currency: '€', name: 'T' } });
  spec.players.forEach((p, i) => {
    const pid = 'p' + i;
    put({ type: 'player_add', playerId: pid, name: p.name });
    p.buyins.forEach(a => put({ type: 'buyin', playerId: pid, amount: a }));
    if (p.chips !== null && p.chips !== undefined) put({ type: 'cashout', playerId: pid, chips: p.chips });
  });
  if (spec.adjustment) put({ type: 'adjustment', value: spec.adjustment });
  if (spec.orphanBuyin) put({ type: 'buyin', playerId: 'ghost', amount: 20 });

  const st = M.load(ev);
  const settled = M.settle(st.rows);
  const checks = M.verify(st, settled);
  return {
    rows: st.rows.map(r => ({ name: r.name, inC: r.inC, outC: r.outC, netC: r.netC, done: r.done, shown: M.fmtCents(r.netC) })),
    totalInC: st.totalInC, totalOutC: st.totalOutC,
    transfers: settled.transfers.map(t => ({ from: t.from, to: t.to, amountC: t.amountC, shown: M.fmtCents(t.amountC) })),
    residualC: settled.residualC,
    checks: checks.map(c => ({ id: c.id, ok: c.ok, blocking: c.blocking, detail: c.detail })),
  };
}, spec);

const parseShown = (s) => Math.round(parseFloat(s.replace(/[^0-9.\-]/g, '')) * 100);

/* Assert that what is printed on screen reconciles — not merely the integers
 * behind it. This is the assertion the original bug would have failed. */
function reconciles(res) {
  const paid = {}, recv = {};
  for (const t of res.transfers) {
    paid[t.from] = (paid[t.from] || 0) + parseShown(t.shown);
    recv[t.to] = (recv[t.to] || 0) + parseShown(t.shown);
  }
  for (const r of res.rows) {
    const shownNet = parseShown(r.shown);
    const owed = shownNet < 0 ? -shownNet : 0;
    const due = shownNet > 0 ? shownNet : 0;
    if ((paid[r.name] || 0) !== owed) return `${r.name} shown net ${r.shown} but pays ${(paid[r.name] || 0) / 100}`;
    if ((recv[r.name] || 0) !== due) return `${r.name} shown net ${r.shown} but receives ${(recv[r.name] || 0) / 100}`;
  }
  return null;
}

// ---- 1. the exact shipped bug -------------------------------------------
{
  const res = await run({
    buyIn: 20, chipsPerBuyIn: 3,
    players: [
      { name: 'A', buyins: [20], chips: 1 },
      { name: 'B', buyins: [20], chips: 1 },
      { name: 'C', buyins: [20], chips: 7 },
    ],
  });
  const c = res.rows.find(r => r.name === 'C');
  const got = res.transfers.filter(t => t.to === 'C').reduce((s, t) => s + parseShown(t.shown), 0);
  check('regression: 3 chips per buy-in reconciles to the cent',
    parseShown(c.shown) === got, `net ${c.shown} vs received ${got / 100}`);
  check('regression: pot balances exactly', res.totalInC === res.totalOutC, `${res.totalInC} vs ${res.totalOutC}`);
  check('regression: no residual', res.residualC === 0, String(res.residualC));
}

// ---- 2. fuzz: thousands of random games, run in-page --------------------
{
  const res = await page.evaluate(({ iters, adjIters }) => {
    const M = window.PSC_MATH;
    let n = 0;
    const build = (spec) => {
      const ev = {}; n = 0;
      const put = (o) => { const id = 'e' + (++n).toString().padStart(5, '0'); ev[id] = Object.assign({ id, ts: 1000 + n, dev: 't' }, o); };
      put({ type: 'settings', value: { buyIn: spec.buyIn, chipsPerBuyIn: spec.chipsPerBuyIn, currency: '€', name: 'T' } });
      spec.players.forEach((p, i) => {
        put({ type: 'player_add', playerId: 'p' + i, name: 'P' + i });
        p.buyins.forEach(x => put({ type: 'buyin', playerId: 'p' + i, amount: x }));
        if (p.chips != null) put({ type: 'cashout', playerId: 'p' + i, chips: p.chips });
      });
      if (spec.adjust) put({ type: 'adjustment', value: spec.adjust });
      return ev;
    };
    const parse = (str) => Math.round(parseFloat(str.replace(/[^0-9.\-]/g, '')) * 100);
    const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
    const ratios = [1, 2, 3, 4, 5, 6, 7, 9, 10, 13, 20, 25, 30, 100];
    const buyIns = [5, 10, 20, 25, 50, 12.5];

    // Checks the RENDERED strings reconcile, not just the integers behind them.
    const bad = (st, settled) => {
      const paid = {}, recv = {};
      settled.transfers.forEach(t => {
        paid[t.from] = (paid[t.from] || 0) + parse(M.fmtCents(t.amountC));
        recv[t.to] = (recv[t.to] || 0) + parse(M.fmtCents(t.amountC));
      });
      let sum = 0;
      for (const r of st.rows) {
        sum += r.netC;
        const shown = parse(M.fmtCents(r.netC));
        if ((paid[r.name] || 0) !== (shown < 0 ? -shown : 0)) return r.name + ' pays wrong';
        if ((recv[r.name] || 0) !== (shown > 0 ? shown : 0)) return r.name + ' receives wrong';
      }
      if (sum !== 0) return 'nets sum to ' + sum;
      if (settled.residualC !== 0) return 'residual ' + settled.residualC;
      if (st.totalInC !== st.totalOutC) return 'pot ' + st.totalInC + ' vs ' + st.totalOutC;
      return null;
    };

    const mkGame = () => {
      const players = [], count = rnd(2, 7);
      const buyIn = buyIns[rnd(0, buyIns.length - 1)];
      const chipsPerBuyIn = ratios[rnd(0, ratios.length - 1)];
      let chipsOnTable = 0;
      for (let i = 0; i < count; i++) {
        const buyins = Array.from({ length: rnd(1, 4) }, () => buyIn);
        chipsOnTable += buyins.length * chipsPerBuyIn;
        players.push({ buyins, chips: 0 });
      }
      return { players, buyIn, chipsPerBuyIn, chipsOnTable };
    };
    const deal = (g, total) => {
      let left = total;
      for (let i = 0; i < g.players.length - 1; i++) { const t = rnd(0, left); g.players[i].chips = t; left -= t; }
      g.players[g.players.length - 1].chips = left;
    };

    let failure = null, ok = 0;
    // (a) correctly counted games must reconcile
    for (let k = 0; k < iters && !failure; k++) {
      const g = mkGame();
      deal(g, g.chipsOnTable);
      const st = M.load(build(g));
      const why = bad(st, M.settle(st.rows));
      if (why) failure = `counted: ${g.chipsPerBuyIn} chips/${g.buyIn} — ${why}`; else ok++;
    }
    // (b) miscounted games, closed with an adjustment, must also reconcile
    let adjOk = 0;
    for (let k = 0; k < adjIters && !failure; k++) {
      const g = mkGame();
      deal(g, Math.max(0, g.chipsOnTable + rnd(-9, 9)));   // deliberately off
      let st = M.load(build(g));
      const gap = st.totalOutC - st.totalInC;
      const mode = k % 2 ? 'split' : 'player';
      st = M.load(build(Object.assign({}, g, {
        adjust: { mode, playerId: mode === 'split' ? null : 'p0', amountC: -gap, reason: 'fuzz' }
      })));
      const why = bad(st, M.settle(st.rows));
      if (why) failure = `adjusted(${mode}) gap ${gap}: ${why}`; else adjOk++;
    }
    return { failure, ok, adjOk };
  }, { iters: 4000, adjIters: 2000 });

  check(`fuzz: ${res.ok} counted games reconcile exactly`, !res.failure || !/counted:/.test(res.failure), res.failure || '');
  check(`fuzz: ${res.adjOk} miscounted games close exactly once adjusted`, !res.failure, res.failure || '');
}

// ---- 3. checks fire correctly -------------------------------------------
const idOf = (res, id) => res.checks.find(c => c.id === id);
{
  const clean = await run({
    buyIn: 20, chipsPerBuyIn: 20,
    players: [{ name: 'A', buyins: [20], chips: 10 }, { name: 'B', buyins: [20], chips: 30 }],
  });
  check('clean game: all blocking checks pass',
    clean.checks.filter(c => c.blocking).every(c => c.ok),
    JSON.stringify(clean.checks.filter(c => c.blocking && !c.ok)));

  const uncounted = await run({
    buyIn: 20, chipsPerBuyIn: 20,
    players: [{ name: 'A', buyins: [20], chips: 20 }, { name: 'B', buyins: [20], chips: null }],
  });
  check('uncounted player fails the counted check', idOf(uncounted, 'counted').ok === false);
  check('uncounted check names the player', /B/.test(idOf(uncounted, 'counted').detail), idOf(uncounted, 'counted').detail);

  const short = await run({
    buyIn: 20, chipsPerBuyIn: 20,
    players: [{ name: 'A', buyins: [20], chips: 10 }, { name: 'B', buyins: [20], chips: 10 }],
  });
  check('miscount fails the pot check', idOf(short, 'pot').ok === false);
  check('miscount reports the amount under', /20 under/.test(idOf(short, 'pot').detail), idOf(short, 'pot').detail);

  const orphan = await run({
    buyIn: 20, chipsPerBuyIn: 20, orphanBuyin: true,
    players: [{ name: 'A', buyins: [20], chips: 20 }, { name: 'B', buyins: [20], chips: 20 }],
  });
  check('orphaned event is detected', idOf(orphan, 'orphans').ok === false, JSON.stringify(idOf(orphan, 'orphans')));
  check('orphaned event is advisory, not blocking', idOf(orphan, 'orphans').blocking === false);
}

// ---- 4. adjustments close the book exactly ------------------------------
{
  // 3 players, €60 pot, only €50 counted -> €10 short, does not divide evenly
  const base = {
    buyIn: 20, chipsPerBuyIn: 20,
    players: [
      { name: 'A', buyins: [20], chips: 20 },
      { name: 'B', buyins: [20], chips: 20 },
      { name: 'C', buyins: [20], chips: 10 },
    ],
  };
  const before = await run(base);
  check('setup: €10 short before adjusting', before.totalInC - before.totalOutC === 1000,
    String(before.totalInC - before.totalOutC));

  const split = await run({ ...base, adjustment: { mode: 'split', amountC: 1000, reason: 'lost chip' } });
  let sum = 0; split.rows.forEach(r => sum += r.netC);
  check('split adjustment brings nets to exactly zero', sum === 0, String(sum));
  check('split adjustment passes the pot check', idOf(split, 'pot').ok === true, idOf(split, 'pot').detail);
  check('split adjustment reconciles on screen', reconciles(split) === null, reconciles(split) || '');
  check('uneven split totals exactly the shortfall',
    split.rows.reduce((s, r) => s + r.netC, 0) === 0 && split.totalInC === split.totalOutC,
    `${split.totalInC} vs ${split.totalOutC}`);

  const one = await run({ ...base, adjustment: { mode: 'player', playerId: 'p0', amountC: 1000, reason: 'A miscounted' } });
  let sum2 = 0; one.rows.forEach(r => sum2 += r.netC);
  check('player adjustment brings nets to exactly zero', sum2 === 0, String(sum2));
  check('player adjustment reconciles on screen', reconciles(one) === null, reconciles(one) || '');
}

check('no runtime errors', errors.length === 0, errors.join(' | '));

console.log(T.join('\n'));
const failed = T.filter(t => t.startsWith('FAIL')).length;
console.log(`\n${T.length - failed}/${T.length} passed`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
