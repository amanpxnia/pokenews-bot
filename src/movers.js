// Top Movers: once a day, rank showroom cards by how much their sale prices moved, over two windows:
//   30 days: median sale in the 30 days up to the newest sale vs. the 60 days before
//    7 days: median sale in the 7 days up to the newest sale vs. the 30 days before
// and post the top risers and the biggest drop of each, one post and one graphic per card.
// Windows end at the newest sale in Card Outpost's data (not today), because its sales history is
// published with a delay of a week or more. Format inspired by tcgberg.com/top-movers; the data is Card Outpost's own sales history,
// read from each card's page on cardoutpost.com.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { currentSlot } = require('./schedule');
const { prettyName, GAME_TAGS } = require('./chase');

const run = promisify(execFile);
const FEED = 'https://www.cardoutpost.com/api/cards/showroom-feed';
const STATE_FILE = path.join(__dirname, '..', 'data', 'movers.json');
const RENDER = path.join(__dirname, '..', 'scripts', 'render_card.py'); // same graphic style as grail reveals
const UA = 'Mozilla/5.0 (compatible; CardOutpostBot/1.0)';
const DAY = 86400e3;

const MIN_PRICE = Number(process.env.MOVERS_MIN_PRICE) || 1000;
const MAX_PRICE = Number(process.env.MOVERS_MAX_PRICE) || 10000;
const MIN_SALES = 2; // need at least this many sales in each window, so one odd sale can't fake a move
const PAGE_GAP_MS = 1200; // be gentle: one card page every 1.2 s
const TOP = Math.max(1, Number(process.env.MOVERS_TOP) || 1); // risers per window (plus the biggest drop)

const WINDOWS = {
  d30: { days: 30, baseline: 60, label: '30 DAYS', note: '30 days vs. the 60 days before' },
  d7: { days: 7, baseline: 30, label: '7 DAYS', note: '7 days vs. the 30 days before' },
};
const SALES_CACHE = path.join(__dirname, '..', 'data', 'movers-sales.json');
const CACHE_MAX_AGE_MS = 6 * 3600e3; // reuse card page data for up to 6 hours

const POST_GAP_MS = 4000; // pause between the posts so they don't land all at once

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

/** Sales/set/year for every pool card, from card pages (reusing a recent cache to spare the site). */
async function collectDetails(pool, log) {
  let cache = {};
  try {
    const saved = JSON.parse(fs.readFileSync(SALES_CACHE, 'utf8'));
    if (Date.now() - saved.at < CACHE_MAX_AGE_MS) cache = saved.cards;
  } catch {}
  const details = {};
  for (const card of pool) {
    if (cache[card.id]) {
      details[card.id] = cache[card.id];
      continue;
    }
    try {
      details[card.id] = await cardDetails(card.id);
    } catch (err) {
      log(`  ! movers: skipped ${card.name}: ${err.message}`);
    }
    await sleep(PAGE_GAP_MS);
  }
  fs.mkdirSync(path.dirname(SALES_CACHE), { recursive: true });
  fs.writeFileSync(SALES_CACHE, JSON.stringify({ at: Date.now(), cards: { ...cache, ...details } }));
  return details;
}

/** Rank every card by its move in each window. Returns { checked, through, windows: { d30: {...}, d7: {...} } }. */
async function computeMovers(log = () => {}) {
  const pool = await fetchPool();
  const details = await collectDetails(pool, log);
  // windows end at the newest sale in the data (it lags behind today)
  const end = Math.max(0, ...Object.values(details).flatMap((d) => d.sales.map((s) => s.time)));
  const rows = { d30: [], d7: [] };
  for (const card of pool) {
    const d = details[card.id];
    if (!d) continue;
    for (const [key, w] of Object.entries(WINDOWS)) {
      const recent = d.sales.filter((s) => s.time > end - w.days * DAY && s.time <= end).map((s) => s.price);
      const before = d.sales
        .filter((s) => s.time > end - (w.days + w.baseline) * DAY && s.time <= end - w.days * DAY)
        .map((s) => s.price);
      if (recent.length >= MIN_SALES && before.length >= MIN_SALES) {
        const from = median(before);
        const to = median(recent);
        rows[key].push({ card, set: d.set, year: d.year, game: gameOf(d.set), from, to, change: (to - from) / from, window: key, through: end });
      }
    }
  }
  // pick the 30-day movers first; the 7-day posts skip any card already featured, so no card is posted twice
  const windows = {};
  const featured = new Set();
  for (const key of ['d30', 'd7']) {
    const list = rows[key].filter((r) => !featured.has(r.card.id)).sort((a, b) => b.change - a.change);
    windows[key] = { gainers: list.filter((r) => r.change > 0).slice(0, TOP), decliners: list.filter((r) => r.change < 0).slice(-1), usable: rows[key].length };
    for (const r of [...windows[key].gainers, ...windows[key].decliners]) featured.add(r.card.id);
  }
  return { checked: pool.length, through: end, windows };
}

const pct = (change) => `${change >= 0 ? '+' : '-'}${Math.round(Math.abs(change) * 100)}%`;

/**
 * One post + graphic for a mover. `label` is e.g. "TOP MOVER #1" or "BIGGEST DROP"; r.window is d30 or d7.
 *   ## 📈 TOP MOVER #1 · LAST 30 DAYS
 *   > **2011 Lugia-Holo**
 *   > PSA 7 · :pokemon_headbang: Pokémon
 *   > ▲ **+468%** · $1,584 → $9,000
 *   🔗 View this card
 */
async function buildPost(r, label) {
  const w = WINDOWS[r.window || 'd30'];
  const up = r.change >= 0;
  const name = prettyName(r.card.name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mover-'));
  try {
    const photo = path.join(dir, 'photo.jpg');
    fs.writeFileSync(photo, Buffer.from(await (await get(r.card.imageUrl)).arrayBuffer()));
    const out = path.join(dir, 'mover.jpg');
    const graphic = {
      headline: label.replace(/\s*#\d+$/, ''), // graphic says "TOP MOVER"; the post text keeps the rank
      name,
      subline: r.year,
      grade: `PSA ${r.card.gradeDisplay}`,
      price: pct(r.change),
      priceColor: up ? 'up' : 'down',
      caption: `${money(r.from)} → ${money(r.to)} · ${w.days} days`,
      imagePath: photo,
    };
    await run('python3', [RENDER, JSON.stringify(graphic), out], { timeout: 120000 });
    const content = [
      `## ${up ? '📈' : '📉'} ${label} · ${w.label}`,
      `> **${[r.year, name].filter(Boolean).join(' ')}**`,
      `> PSA ${r.card.gradeDisplay}${GAME_TAGS[r.game] ? ` · ${GAME_TAGS[r.game]}` : ''}`,
      `> ${up ? '▲' : '▼'} **${pct(r.change)}** · ${money(r.from)} → ${money(r.to)}`,
      '',
      `🔗 [View this card](<https://www.cardoutpost.com/cards/${r.card.id}>)`,
      `-# Median Card Outpost sale price over ${w.note}, using sales through ${new Date(r.through).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. Past prices, not financial advice.`,
    ].join('\n');
    return { content, files: [{ attachment: fs.readFileSync(out), name: 'top-mover.jpg' }], allowedMentions: { parse: [] } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** All of today's posts: for each window (30 days, then 7 days) the top risers, then the biggest drop. */
async function buildPosts({ windows }) {
  const posts = [];
  for (const key of ['d30', 'd7']) {
    const { gainers, decliners } = windows[key];
    for (const [i, r] of gainers.entries()) posts.push(await buildPost(r, `TOP MOVER #${i + 1}`));
    if (decliners[0]) posts.push(await buildPost(decliners[0], 'BIGGEST DROP'));
  }
  return posts;
}

/** Post today's movers if the daily slot has started and they haven't gone out yet. */
async function tick(channel, hours, log) {
  const slot = currentSlot(hours);
  const st = loadState();
  if (!slot || st.lastSlot === slot) return;
  st.lastSlot = slot; // claim first: this takes several minutes and shouldn't start twice
  saveState(st);
  const result = await computeMovers(log);
  if (!result.windows.d30.gainers.length && !result.windows.d7.gainers.length) return log('Top movers: no cards with enough sales; skipped today.');
  const posts = await buildPosts(result);
  for (const [i, post] of posts.entries()) {
    if (i > 0) await sleep(POST_GAP_MS);
    await channel.send(post);
  }
  log(`Top movers: ${posts.length} posts in #${channel.name} (of ${result.checked} cards, ${result.windows.d30.usable} had enough sales for 30 days, ${result.windows.d7.usable} for 7 days).`);
}

module.exports = { computeMovers, buildPost, buildPosts, tick, cardDetails, gameOf };
