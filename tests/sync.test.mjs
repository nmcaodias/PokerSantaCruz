import { chromium } from './_playwright.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };

// ---- static host ---------------------------------------------------------
const site = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'text/plain' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => site.listen(8098, r));

// ---- mock Firebase Realtime Database -------------------------------------
// Implements the subset the app uses: GET .json, PATCH .json (shallow merge),
// and GET with Accept: text/event-stream (put on open, patch on change).
const DB = {};                 // code -> { eventId: event }
const streams = new Map();     // code -> Set(res)
let patchCount = 0;

const db = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PATCH,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  const m = req.url.match(/^\/games\/([^/]+)\/events\.json/);
  if (!m) { res.writeHead(404, cors); return res.end('{}'); }
  const code = decodeURIComponent(m[1]);
  DB[code] = DB[code] || {};

  if (req.method === 'GET') {
    if ((req.headers.accept || '').includes('text/event-stream')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: put\ndata: ${JSON.stringify({ path: '/', data: DB[code] })}\n\n`);
      if (!streams.has(code)) streams.set(code, new Set());
      streams.get(code).add(res);
      req.on('close', () => streams.get(code)?.delete(res));
      return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(DB[code]));
  }

  if (req.method === 'PATCH') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let obj = {};
      try { obj = JSON.parse(body || '{}'); } catch {}
      patchCount++;
      Object.assign(DB[code], obj);
      for (const s of streams.get(code) || [])
        s.write(`event: patch\ndata: ${JSON.stringify({ path: '/', data: obj })}\n\n`);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    });
    return;
  }
  res.writeHead(405, cors); res.end();
});
await new Promise(r => db.listen(8097, r));

// ---- drive two independent "devices" -------------------------------------
const T = [];
const check = (n, c, x='') => T.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  <-- ' + x}`);

const browser = await chromium.launch();
const errors = [];
const mkDevice = async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  pg.on('console', m => {
    // the offline test pulls the network on purpose; that failure is expected
    if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text()))
      errors.push('CONSOLE: ' + m.text());
  });
  pg._ctx = ctx;
  return pg;
};

const URL = 'http://localhost:8098/#g=nightone&db=' + encodeURIComponent('http://localhost:8097');
const A = await mkDevice();   // separate contexts = separate localStorage, like separate phones
const B = await mkDevice();

await A.goto(URL);
await A.waitForTimeout(600);
check('device A reports live sync', (await A.textContent('#syncTxt')) === 'Live', await A.textContent('#syncTxt'));

// A adds two players
const addPlayer = async (pg, name) => {
  await pg.click('#addBtn'); await pg.fill('#pName', name); await pg.click('#pSave'); await pg.waitForTimeout(150);
};
await addPlayer(A, 'Nuno');
await addPlayer(A, 'Marta');
await A.waitForTimeout(400);

// B joins the same game fresh and should receive the history
await B.goto(URL);
await B.waitForTimeout(700);
let bPlayers = await B.textContent('#tPl');
let bIn = await B.textContent('#tIn');
check('B receives the game history on join', bPlayers === '2' && bIn === '€40', `players=${bPlayers} in=${bIn}`);

// live push A -> B
await A.click('.card:nth-child(1) .plus');
await A.waitForTimeout(600);
bIn = await B.textContent('#tIn');
check('buy-in on A streams to B', bIn === '€60', bIn);

// live push B -> A
await addPlayer(B, 'Tiago');
await B.waitForTimeout(600);
let aPlayers = await A.textContent('#tPl');
let aIn = await A.textContent('#tIn');
check('player added on B streams to A', aPlayers === '3' && aIn === '€80', `players=${aPlayers} in=${aIn}`);

// simultaneous buy-ins on both devices must both survive (union, not overwrite)
await Promise.all([
  A.click('.card:nth-child(2) .plus'),
  B.click('.card:nth-child(2) .plus'),
]);
await A.waitForTimeout(900);
aIn = await A.textContent('#tIn');
bIn = await B.textContent('#tIn');
check('simultaneous buy-ins on both devices both count', aIn === '€120' && bIn === '€120', `A=${aIn} B=${bIn}`);

// settings propagate
await A.click('#settingsBtn'); await A.waitForTimeout(200);
await A.fill('#sName', 'Santa Cruz Night'); await A.click('#sSave');
await A.waitForTimeout(600);
check('settings propagate to B', (await B.textContent('#gameName')) === 'Santa Cruz Night', await B.textContent('#gameName'));

// offline queue: kill the DB, act, bring it back
const wasPatches = patchCount;
await B._ctx.setOffline(true);
await B.click('.card:nth-child(3) .plus');
await B.waitForTimeout(400);
const bStatus = await B.textContent('#syncTxt');
check('B shows offline while disconnected', bStatus === 'Offline' || bStatus === 'Saving' || bStatus === 'Syncing', bStatus);
const bInOffline = await B.textContent('#tIn');
check('offline edit applies locally right away', bInOffline === '€140', bInOffline);

await B._ctx.setOffline(false);
await B.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await B.waitForTimeout(1500);
aIn = await A.textContent('#tIn');
check('queued offline edit reaches A once back online', aIn === '€140', aIn);
check('offline edit produced a real upload', patchCount > wasPatches, `${wasPatches} -> ${patchCount}`);

// count everyone out (pot is €140: Nuno 40, Marta 60, Tiago 40)
const cashOut = async (pg, idx, chips) => {
  await pg.click(`.card:nth-child(${idx}) .fin`); await pg.waitForTimeout(150);
  await pg.fill('#cAmt', String(chips)); await pg.click('#formCash button[type=submit]');
  await pg.waitForTimeout(200);
};
await cashOut(A, 1, 50); await cashOut(A, 2, 40); await cashOut(A, 3, 50);
await A.waitForTimeout(800);

// Both devices must derive byte-identical figures from the same event log.
// The chip allocator breaks rounding ties on player id precisely so two phones
// never show different numbers for the same game.
await A.click('#finishBtn'); await A.waitForTimeout(400);
await B.click('#finishBtn'); await B.waitForTimeout(400);
const grab = pg => pg.evaluate(() => ({
  audit: document.getElementById('fAudit').textContent.replace(/\s+/g, ' ').trim(),
  tx: document.getElementById('fTx').textContent.replace(/\s+/g, ' ').trim(),
  checks: document.getElementById('fChecks').textContent.replace(/\s+/g, ' ').trim(),
}));
const va = await grab(A), vb = await grab(B);
check('both devices compute the same audit', va.audit === vb.audit, `A=${va.audit}\n     B=${vb.audit}`);
check('both devices compute the same payments', va.tx === vb.tx, `A=${va.tx}\n     B=${vb.tx}`);
check('both devices pass the same checks', va.checks === vb.checks, `A=${va.checks}\n     B=${vb.checks}`);
check('a fully counted game is not blocked', !(await A.isDisabled('#fEnd')), 'End game disabled: ' + va.checks);

await B.click('#dlgFinish [data-close]'); await B.waitForTimeout(150);
await A.click('#fEnd'); await A.waitForTimeout(800);
check('finishing on A locks B too', await B.isDisabled('#addBtn'), 'B still accepts players');

// reload B: server state survives, no duplicate events
await B.reload();
await B.waitForTimeout(800);
bIn = await B.textContent('#tIn');
bPlayers = await B.textContent('#tPl');
check('reload does not duplicate events', bIn === '€140' && bPlayers === '3', `in=${bIn} players=${bPlayers}`);

check('no runtime errors across both devices', errors.length === 0, errors.join(' | '));

console.log(T.join('\n'));
const failed = T.filter(t => t.startsWith('FAIL')).length;
console.log(`\n${T.length - failed}/${T.length} passed`);

await browser.close(); site.close(); db.close();
process.exit(failed ? 1 : 0);
