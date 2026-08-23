import { chromium } from './_playwright.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'text/plain' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(8099, r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://localhost:8099/#g=testgame1');
await page.waitForTimeout(300);

const T = [];
const check = (name, cond, extra='') => { T.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + extra}`); };

// --- helpers -------------------------------------------------------------
const addPlayer = async (name) => {
  await page.click('#addBtn');
  await page.fill('#pName', name);
  await page.click('#pSave');
  await page.waitForTimeout(90);
};
const state = () => page.evaluate(() => {
  // reach into the page: re-derive via the rendered DOM
  return {
    totalIn: document.getElementById('tIn').textContent,
    totalOut: document.getElementById('tOut').textContent,
    players: document.getElementById('tPl').textContent,
    rows: [...document.querySelectorAll('.card')].map(c => ({
      name: c.querySelector('.who button').textContent,
      meta: c.querySelector('.meta').textContent,
      fin: c.querySelector('.fin').textContent,
      done: c.classList.contains('done'),
    })),
  };
});

// --- 1. add players ------------------------------------------------------
await addPlayer('Nuno');
await addPlayer('Marta');
await addPlayer('Tiago');
let s = await state();
check('three players added', s.players === '3', JSON.stringify(s));
check('each starts with one buy-in', s.rows.every(r => r.meta.includes('1 buy-in')), JSON.stringify(s.rows));
check('pot is 3x5 = 15', s.totalIn === '€15', s.totalIn);

// --- 2. quick buy-in via + ----------------------------------------------
await page.click('.card:nth-child(1) .plus');
await page.waitForTimeout(80);
s = await state();
check('+ adds a buy-in', s.rows[0].meta.includes('2 buy-ins'), s.rows[0].meta);
check('pot now 20', s.totalIn === '€20', s.totalIn);

// --- 3. undo via toast ---------------------------------------------------
check('undo toast is offered', await page.isVisible('#toastAct'), 'no toast action');
await page.click('#toastAct');
await page.waitForTimeout(80);
s = await state();
check('undo removes the buy-in', s.rows[0].meta.includes('1 buy-in') && s.totalIn === '€15', JSON.stringify(s.rows[0]) + s.totalIn);

// --- 4. custom buy-in via menu ------------------------------------------
await page.click('.card:nth-child(2) .who button');
await page.waitForTimeout(120);
await page.click('#mBuyin');
await page.waitForTimeout(120);
await page.click('#bChips .chip:nth-child(3)');           // 2x buy-in = 10
const chipVal = await page.inputValue('#bAmt');
check('quick-amount chip fills the field', chipVal === '10', chipVal);
await page.click('#formBuyin button[type=submit]');
await page.waitForTimeout(100);
s = await state();
check('custom buy-in recorded', s.rows[1].meta.includes('2 buy-ins') && s.rows[1].meta.includes('€15'), s.rows[1].meta);
check('pot now 25', s.totalIn === '€25', s.totalIn);

// --- 5. cash out ---------------------------------------------------------
const cashOut = async (idx, chips) => {
  await page.click(`.card:nth-child(${idx}) .fin`);
  await page.waitForTimeout(120);
  await page.fill('#cAmt', String(chips));
  await page.click('#formCash button[type=submit]');
  await page.waitForTimeout(100);
};
await cashOut(1, 2);     // Nuno:  in 5,  out 2  -> -3
await cashOut(2, 20);    // Marta: in 15, out 20 -> +5
await cashOut(3, 3);     // Tiago: in 5,  out 3  -> -2
s = await state();
check('cash-out marks the row done', s.rows.every(r => r.done), JSON.stringify(s.rows.map(r=>r.done)));
check('finish button shows the chip count', s.rows[1].fin === '20', s.rows[1].fin);
check('counted total = 25', s.totalOut === '€25', s.totalOut);
check('balanced total is flagged ok', await page.getAttribute('#tOut', 'class') === 'ok', await page.getAttribute('#tOut','class'));
check('net shown per player', s.rows[0].meta.includes('-€3') && s.rows[1].meta.includes('+€5'), JSON.stringify(s.rows.map(r=>r.meta)));

// --- 6. settlement -------------------------------------------------------
await page.click('#finishBtn');
await page.waitForTimeout(150);
const tx = await page.$$eval('#fTx li', ls => ls.map(l => l.textContent.replace(/\s+/g,' ').trim()));
const warn = await page.$eval('#fWarn', e => e.textContent.trim());
check('no warning when books balance', warn === '', warn);
check('two transfers settle three players', tx.length === 2, JSON.stringify(tx));
check('Nuno pays Marta 3', tx.some(t => t.includes('Nuno') && t.includes('Marta') && t.includes('€3')), JSON.stringify(tx));
check('Tiago pays Marta 2', tx.some(t => t.includes('Tiago') && t.includes('Marta') && t.includes('€2')), JSON.stringify(tx));

await page.screenshot({ path: 'tests/shot-settle.png' });
await page.click('#fEnd');
await page.waitForTimeout(120);
check('game locks after finishing', await page.isDisabled('#addBtn'), 'add still enabled');
check('+ disabled after finishing', await page.isDisabled('.card:nth-child(1) .plus'), '+ still enabled');

// --- 7. persistence across reload ---------------------------------------
await page.reload();
await page.waitForTimeout(300);
s = await state();
check('state survives a reload', s.players === '3' && s.totalIn === '€25', JSON.stringify(s));

// --- 8. mismatch warning -------------------------------------------------
await page.evaluate(() => localStorage.clear());
await page.goto('http://localhost:8099/#g=testgame2');
await page.waitForTimeout(250);
await addPlayer('A'); await addPlayer('B');
await cashOut(1, 1); await cashOut(2, 1);   // 10 in, 2 out
await page.click('#finishBtn');
await page.waitForTimeout(150);
const checksText = () => page.$eval('#fChecks', e => e.textContent.replace(/\s+/g,' ').trim());
let warn2 = await checksText();
check('under-count is flagged', /€8 under/.test(warn2), warn2);
check('End game is blocked while a check fails', await page.isDisabled('#fEnd'), 'End game still enabled');
check('the block reason is stated', /Resolve/.test(await page.textContent('#fBlock')), await page.textContent('#fBlock'));

// resolving the miscount should unblock it
await page.click('#dlgFinish [data-close]');
await page.waitForTimeout(120);
await cashOut(1, 5); await cashOut(2, 5);     // 10 in, 10 out
await page.click('#finishBtn');
await page.waitForTimeout(200);
check('correcting the counts clears the failure', !/under|over/.test(await checksText()), await checksText());
check('End game is enabled once checks pass', !(await page.isDisabled('#fEnd')), 'still disabled');

// the audit table must agree with the header totals
const audit = await page.$eval('#fAudit', e => e.textContent.replace(/\s+/g,' ').trim());
check('audit shows the totals and says balanced', /€10 in · €10 out/.test(audit) && /balanced/.test(audit), audit);
await page.click('#dlgFinish [data-close]');
await page.waitForTimeout(100);

// --- 9. uncounted players flagged ---------------------------------------
await page.evaluate(() => localStorage.clear());
await page.goto('http://localhost:8099/#g=testgame3');
await page.waitForTimeout(250);
await addPlayer('C'); await addPlayer('D');
await cashOut(1, 5);
await page.click('#finishBtn');
await page.waitForTimeout(150);
const warn3 = await page.$eval('#fChecks', e => e.textContent.replace(/\s+/g,' ').trim());
check('uncounted player is named', warn3.includes('Not counted yet') && warn3.includes('D'), warn3);
check('uncounted player blocks End game', await page.isDisabled('#fEnd'), 'End game still enabled');
await page.click('#dlgFinish [data-close]');

// --- 10. rename + remove -------------------------------------------------
await page.click('.card:nth-child(1) .who button');
await page.waitForTimeout(120);
await page.click('#mRename');
await page.waitForTimeout(120);
await page.fill('#pName', 'Charlie');
await page.click('#pSave');
await page.waitForTimeout(120);
s = await state();
check('rename works', s.rows[0].name === 'Charlie', JSON.stringify(s.rows));

await page.click('.card:nth-child(2) .who button');
await page.waitForTimeout(120);
await page.click('#mRemove');
await page.waitForTimeout(120);
await page.click('#kOk');
await page.waitForTimeout(120);
s = await state();
check('remove drops the player and their buy-ins', s.players === '1' && s.totalIn === '€5', JSON.stringify(s));

// --- 11. settings --------------------------------------------------------
await page.click('#settingsBtn');
await page.waitForTimeout(150);
await page.fill('#sName', 'Friday Game');
await page.fill('#sBuyin', '50');
await page.fill('#sCur', '$');
await page.fill('#sChips', '100');
await page.click('#sSave');
await page.waitForTimeout(150);
const title = await page.textContent('#gameName');
s = await state();
check('game renamed', title === 'Friday Game', title);
check('currency applied', s.totalIn === '$5', s.totalIn);
await page.click('.card:nth-child(1) .plus');
await page.waitForTimeout(100);
s = await state();
check('new buy-in amount applied', s.totalIn === '$55', s.totalIn);

// chip ratio: 100 chips per $50 buy-in -> 1 chip = $0.5
await cashOut(1, 100);
s = await state();
check('chip ratio converts chips to money', s.totalOut === '$50', s.totalOut);

// --- 12. merge semantics (simulated second device) ----------------------
const merged = await page.evaluate(() => {
  // Two devices each append an event with distinct ids; a union must keep both.
  const code = 'mergecheck';
  const mk = (id, type, extra) => Object.assign({ id, type, ts: Date.now(), dev: 'x' }, extra);
  const pid = 'p1';
  const a = {};
  a['e1'] = mk('e1', 'player_add', { playerId: pid, name: 'Zoe' });
  a['e2'] = mk('e2', 'buyin', { playerId: pid, amount: 20 });      // device A
  a['e3'] = mk('e3', 'buyin', { playerId: pid, amount: 20 });      // device B, same moment
  localStorage.setItem('psc.log.' + code, JSON.stringify({ events: a, pending: [] }));
  return true;
});
await page.goto('http://localhost:8099/#g=mergecheck');
await page.waitForTimeout(250);
s = await state();
check('concurrent buy-ins both survive the merge', s.rows[0].meta.includes('2 buy-ins'), JSON.stringify(s.rows));

// --- 12b. regression: buy-in ordered before the player that owns it ------
// Same timestamp with a lexically-smaller id (same-ms commits), and a
// buy-in stamped earlier than its player (a second device's clock is behind).
await page.evaluate(() => {
  const t = Date.now();
  const mk = (id, ts, type, extra) => Object.assign({ id, type, ts, dev: 'x' }, extra);
  const ev = {};
  ev['aaa'] = mk('aaa', t, 'buyin', { playerId: 'p9', amount: 20 });        // sorts first, same ms
  ev['zzz'] = mk('zzz', t, 'player_add', { playerId: 'p9', name: 'Skew' });
  ev['bbb'] = mk('bbb', t - 60000, 'buyin', { playerId: 'p9', amount: 20 }); // clock behind
  localStorage.setItem('psc.log.skewcheck', JSON.stringify({ events: ev, pending: [] }));
});
await page.goto('http://localhost:8099/#g=skewcheck');
await page.waitForTimeout(250);
s = await state();
check('buy-ins ordered before their player still count', s.totalIn === '€40' && s.rows.length === 1, JSON.stringify(s));

// --- 13. no runtime errors ----------------------------------------------
check('no console/page errors', errors.length === 0, errors.join(' | '));

await page.screenshot({ path: 'tests/shot-main.png' });

console.log(T.join('\n'));
const failed = T.filter(t => t.startsWith('FAIL')).length;
console.log(`\n${T.length - failed}/${T.length} passed`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
