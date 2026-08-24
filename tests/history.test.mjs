/* Game history and season totals.
 *
 * The interesting risks here are that a finished game becomes unreachable once
 * a new one starts, that season totals silently add up different currencies,
 * and that switching between games mixes their event logs. */

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
await new Promise(r => server.listen(8095, r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

const T = [];
const check = (n, c, x = '') => T.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + x}`);

const addPlayer = async (n) => {
  await page.click('#addBtn'); await page.fill('#pName', n); await page.click('#pSave'); await page.waitForTimeout(110);
};
const cashOut = async (i, v) => {
  await page.click(`.card:nth-child(${i}) .fin`); await page.waitForTimeout(140);
  await page.fill('#cAmt', String(v)); await page.click('#formCash button[type=submit]'); await page.waitForTimeout(140);
};
const openGames = async () => { await page.click('#gamesBtn'); await page.waitForTimeout(250); };
const gamesText = () => page.$eval('#gList', e => e.textContent.replace(/\s+/g, ' ').trim());
const seasonRows = () => page.$$eval('#gSeason div', ds => ds.map(d => d.textContent.replace(/\s+/g, ' ').trim()));
const newGame = async () => {
  await openGames(); await page.click('#gNew'); await page.waitForTimeout(200);
  await page.click('#kOk'); await page.waitForTimeout(350);
};
// finish the game currently on screen (all checks must pass first)
const endGame = async () => {
  await page.click('#finishBtn'); await page.waitForTimeout(350);
  await page.click('#fEnd'); await page.waitForTimeout(300);
};

await page.goto('http://localhost:8095/');
await page.evaluate(() => localStorage.clear());
await page.goto('http://localhost:8095/#g=hist1');
await page.waitForTimeout(300);

// ---- 1. an empty game is not listed --------------------------------------
await openGames();
check('an empty game is not listed yet', /Nothing yet/.test(await gamesText()), await gamesText());
await page.click('#dlgGames [data-close]'); await page.waitForTimeout(150);

// ---- 2. night one: Marta wins ------------------------------------------
await addPlayer('Nuno'); await addPlayer('Marta');       // €5 each, pot €10
await cashOut(1, 2); await cashOut(2, 8);                 // Nuno -3, Marta +3
await openGames();
check('the game in progress is listed as open', /open/.test(await gamesText()), await gamesText());
check('the current game is tagged now', /now/.test(await gamesText()), await gamesText());
check('no season totals until a game finishes', await page.isHidden('#gSeasonWrap'), 'season shown too early');
await page.click('#dlgGames [data-close]'); await page.waitForTimeout(150);
await endGame();

await openGames();
let txt = await gamesText();
check('a finished game drops the open tag', !/open/.test(txt), txt);
check('the listing shows players and pot', /2 players/.test(txt) && /€10/.test(txt), txt);
check('season totals appear once finished', await page.isVisible('#gSeasonWrap'), 'season still hidden');
let season = await seasonRows();
check('season: Marta +€3, Nuno -€3', /Marta.*\+€3/.test(season[0] || '') && /Nuno.*-€3/.test(season[1] || ''), JSON.stringify(season));

// ---- 3. night two, and the first game survives it ------------------------
await page.click('#dlgGames [data-close]'); await page.waitForTimeout(150);
await newGame();
await addPlayer('Nuno'); await addPlayer('Marta'); await addPlayer('Tiago');   // pot €15
await cashOut(1, 10); await cashOut(2, 5); await cashOut(3, 0);               // Nuno +5, Marta 0, Tiago -5
await endGame();

await openGames();
txt = await gamesText();
check('both games are listed', (txt.match(/players/g) || []).length === 2, txt);
check('the older game is still there', /2 players/.test(txt) && /3 players/.test(txt), txt);
season = await seasonRows();
check('season aggregates across both nights',
  /Nuno.*\+€2/.test(season.find(r => /Nuno/.test(r)) || '') &&
  /Marta.*\+€3/.test(season.find(r => /Marta/.test(r)) || '') &&
  /Tiago.*-€5/.test(season.find(r => /Tiago/.test(r)) || ''), JSON.stringify(season));
check('season note counts the finished games', /2 finished games/.test(await page.textContent('#gSeasonNote')), await page.textContent('#gSeasonNote'));

// season nets must cancel out, exactly as within one game
const sum = (await seasonRows()).reduce((a, r) => {
  const m = r.match(/([+-]?)€([\d.]+)/); return a + (m ? (m[1] === '-' ? -1 : 1) * Math.round(parseFloat(m[2]) * 100) : 0);
}, 0);
check('season nets sum to zero', sum === 0, String(sum));

// ---- 4. switching back to an old game -----------------------------------
const oldCode = await page.$$eval('#gList .gopen', b => b.map(x => x.dataset.code));
await page.click(`.gopen[data-code="${oldCode[1]}"]`);     // the older, second-listed game
await page.waitForTimeout(500);
check('switching loads the older game', (await page.textContent('#tPl')) === '2' && (await page.textContent('#tIn')) === '€10',
  `players=${await page.textContent('#tPl')} in=${await page.textContent('#tIn')}`);
check('the reopened game is still locked', await page.isDisabled('#addBtn'), 'accepts players again');

await openGames();
check('the game just opened is tagged now', /now/.test(await gamesText()), await gamesText());
await page.click('#dlgGames [data-close]'); await page.waitForTimeout(150);

// ---- 5. history survives a reload ---------------------------------------
await page.reload(); await page.waitForTimeout(400);
await openGames();
check('history survives a reload', (await gamesText()).match(/players/g).length === 2, await gamesText());

// ---- 6. a different currency is left out of the season ------------------
await page.click('#dlgGames [data-close]'); await page.waitForTimeout(150);
await newGame();
await page.click('#settingsBtn'); await page.waitForTimeout(200);
await page.fill('#sCur', '$'); await page.click('#sSave'); await page.waitForTimeout(250);
await addPlayer('Nuno'); await addPlayer('Zed');
await cashOut(1, 10); await cashOut(2, 0);
await endGame();
await openGames();
season = await seasonRows();
check('a dollar game does not join the euro season', !season.some(r => /Zed/.test(r)), JSON.stringify(season));
check('the excluded game is called out', /another currency/.test(await page.textContent('#gSeasonNote')), await page.textContent('#gSeasonNote'));

// ---- 7. removing a game --------------------------------------------------
const before = (await gamesText()).match(/players/g).length;
const delCode = await page.$$eval('#gList .gdel', b => b.map(x => x.dataset.del));
await page.click(`.gdel[data-del="${delCode[0]}"]`); await page.waitForTimeout(250);
await page.click('#kOk'); await page.waitForTimeout(350);
const after = (await gamesText()).match(/players/g).length;
check('removing a game drops it from the list', after === before - 1, `${before} -> ${after}`);
check('the current game has no delete button',
  await page.$$eval('#gList .gamerow.now .gdel', b => b.length) === 0, 'current game is deletable');

check('no runtime errors', errors.length === 0, errors.join(' | '));

console.log(T.join('\n'));
const failed = T.filter(t => t.startsWith('FAIL')).length;
console.log(`\n${T.length - failed}/${T.length} passed`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
