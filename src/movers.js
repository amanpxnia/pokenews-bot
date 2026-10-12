// Top Movers: once a day, rank showroom cards by how much their sale prices moved over the last
// 30 days (median of sales in the last 30 days vs. the 60 days before), and post the top 5 with a
// graphic. Format inspired by tcgberg.com/top-movers; the data is Card Outpost's own sales history,
// read from each card's page on cardoutpost.com.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { currentSlot } = require('./schedule');
const { prettyName } = require('./chase');

const run = promisify(execFile);
const FEED = 'https://www.cardoutpost.com/api/cards/showroom-feed';
const STATE_FILE = path.join(__dirname, '..', 'data', 'movers.json');
const RENDER = path.join(__dirname, '..', 'scripts', 'render_movers.py');
const UA = 'Mozilla/5.0 (compatible; CardOutpostBot/1.0)';
const DAY = 86400e3;

const MIN_PRICE = Number(process.env.MOVERS_MIN_PRICE) || 1000;
const MAX_PRICE = Number(process.env.MOVERS_MAX_PRICE) || 10000;
const MIN_SALES = 2; // need at least this many sales in each window, so one odd sale can't fake a move
const PAGE_GAP_MS = 1200; // be gentle: one card page every 1.2 s
const TOP = 5;

const GAME_TAGS = { pokemon: '<:pokemon:1501141856535314554>', onepiece: '🏴‍☠️', baseball: '⚾', basketball: '🏀' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastSlot: null };
  }
};
const saveState = (st) => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
};

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url}: status ${res.status}`);
  return res;
}

/** Graded showroom cards between MIN_PRICE and MAX_PRICE. */
async function fetchPool() {
  const byId = new Map();
  for (const below of [MAX_PRICE, 7500, 5000, 3500, 2500, 1750, 1250].filter((p) => p <= MAX_PRICE)) {
    const { cards = [] } = await (await get(`${FEED}?belowPrice=${below}&limit=120`)).json();
    for (const c of cards) if (c.gradeDisplay && c.price >= MIN_PRICE && c.price < MAX_PRICE) byId.set(c.id, c);
  }
  return [...byId.values()];
}

/** Sales history, set and year from a card's page (the data is embedded in the page). */
async function cardDetails(id) {
  const html = (await (await get(`https://www.cardoutpost.com/cards/${id}`)).text()).replace(/\\"/g, '"');
  const salesJson = html.match(/\[\{"time":\d+,"price":[\d.]+,"volume":\d+\}(?:,\{"time":\d+,"price":[\d.]+,"volume":\d+\})*\]/);
  const attr = (label) =>
    (html.match(new RegExp(`"children":"${label}"\\}\\],\\["\\$","span",null,\\{[^{}]*"children":\\[\\["\\$","span",null,\\{"className":"min-w-0 truncate","children":"([^"]+)"`)) || [])[1] || null;
  const decode = (v) => (v ? JSON.parse(`"${v}"`) : v); // e.g. "D \u0026 P" → "D & P"
  return { sales: salesJson ? JSON.parse(salesJson[0]) : [], set: decode(attr('Set')), year: attr('Year') };
}

function gameOf(set = '') {
  if (/POK[EÉ]MON/i.test(set)) return 'pokemon';
  if (/ONE\s*PIECE/i.test(set)) return 'onepiece';
  if (/BASKETBALL|\bNBA\b|HOOPS|PRIZM|THRILL SEEKERS/i.test(set)) return 'basketball';
  return 'baseball';
}

/** Rank every card by its 30-day move. Returns { gainers, decliners, checked }. */
async function computeMovers(log = () => {}) {
  const pool = await fetchPool();
  const now = Date.now();
  const rows = [];
  for (const card of pool) {
    try {
      const { sales, set, year } = await cardDetails(card.id);
      const recent = sales.filter((s) => s.time >= now - 30 * DAY).map((s) => s.price);
      const before = sales.filter((s) => s.time >= now - 90 * DAY && s.time < now - 30 * DAY).map((s) => s.price);
      if (recent.length >= MIN_SALES && before.length >= MIN_SALES) {
        const from = median(before);
        const to = median(recent);
        rows.push({ card, set, year, game: gameOf(set), from, to, change: (to - from) / from, sales: recent.length + before.length });
      }
    } catch (err) {
      log(`  ! movers: skipped ${card.name}: ${err.message}`);
    }
    await sleep(PAGE_GAP_MS);
  }
  rows.sort((a, b) => b.change - a.change);
  return { gainers: rows.filter((r) => r.change > 0).slice(0, TOP), decliners: rows.filter((r) => r.change < 0).slice(-1), checked: pool.length, usable: rows.length };
}

const pct = (change) => `${change >= 0 ? '+' : '-'}${Math.round(Math.abs(change) * 100)}%`;
const link = (r) => `<https://www.cardoutpost.com/cards/${r.card.id}>`;
const title = (r) => [r.year, prettyName(r.card.name)].filter(Boolean).join(' ');

/** The Discord message: ranked list with links, plus the graphic. */
async function buildPost({ gainers, decliners }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movers-'));
  try {
    const movers = [];
    for (const [i, r] of gainers.entries()) {
      const photo = path.join(dir, `${i}.jpg`);
      fs.writeFileSync(photo, Buffer.from(await (await get(r.card.imageUrl)).arrayBuffer()));
      movers.push({ name: prettyName(r.card.name), year: r.year, grade: r.card.gradeDisplay, change: pct(r.change), from: money(r.from), to: money(r.to), imagePath: photo });
    }
    const out = path.join(dir, 'movers.jpg');
    await run('python3', [RENDER, JSON.stringify({ period: 'LAST 30 DAYS', movers }), out], { timeout: 120000 });
    const lines = [
      '## 📈 TOP MOVERS · LAST 30 DAYS',
      ...gainers.map(
        (r, i) => `> **${i + 1}. [${title(r)}](${link(r)})** · PSA ${r.card.gradeDisplay} ${GAME_TAGS[r.game] || ''}\n> ▲ **${pct(r.change)}** · ${money(r.from)} → ${money(r.to)}`
      ),
      ...(decliners.length
        ? ['', `📉 **Biggest drop:** [${title(decliners[0])}](${link(decliners[0])}) · PSA ${decliners[0].card.gradeDisplay} · ▼ **${pct(decliners[0].change)}** (${money(decliners[0].from)} → ${money(decliners[0].to)})`]
        : []),
      '',
      '-# Median Card Outpost sale price over the last 30 days vs. the 60 days before. Past prices, not a prediction or financial advice.',
    ];
    return { content: lines.join('\n'), files: [{ attachment: fs.readFileSync(out), name: 'top-movers.jpg' }], allowedMentions: { parse: [] } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Post today's movers if the daily slot has started and they haven't gone out yet. */
async function tick(channel, hours, log) {
  const slot = currentSlot(hours);
  const st = loadState();
  if (!slot || st.lastSlot === slot) return;
  st.lastSlot = slot; // claim first: this takes several minutes and shouldn't start twice
  saveState(st);
  const result = await computeMovers(log);
  if (result.gainers.length < 3) return log(`Top movers: only ${result.gainers.length} risers with enough sales; skipped today.`);
  await channel.send(await buildPost(result));
  log(`Top movers posted to #${channel.name} (${result.usable} of ${result.checked} cards had enough sales).`);
}

module.exports = { computeMovers, buildPost, tick, cardDetails, gameOf };
