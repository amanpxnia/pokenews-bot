// Grail posts: a few times a day, post a high-value graded card from the Card Outpost showroom
// with a "GRAIL PULLED" graphic. The mix of games follows MIX below (50% Pokémon, 20% One Piece,
// 30% baseball/basketball), and every card is worth at least MIN_PRICE and under MAX_PRICE.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { currentSlot } = require('./schedule');

const FEED = 'https://www.cardoutpost.com/api/cards/showroom-feed';
const STATE_FILE = path.join(__dirname, '..', 'data', 'chase.json');
const CATEGORY_FILE = path.join(__dirname, '..', 'data', 'card-categories.json');
const RENDER_SCRIPT = path.join(__dirname, '..', 'scripts', 'render_card.py');
const LABEL_SRC = path.join(__dirname, '..', 'scripts', 'read_label.swift'); // macOS (Vision OCR)
const LABEL_BIN = path.join(__dirname, '..', 'bin', 'read_label');
const LABEL_PY = path.join(__dirname, '..', 'scripts', 'read_label.py'); // Linux/servers (Tesseract OCR)
const run = promisify(execFile);

const MIN_PRICE = Number(process.env.GRAIL_MIN_PRICE) || 1500;
// Under $10,000 by default, so every card posted also appears in the showroom's "God-Tier Pulls" list
const MAX_PRICE = Number(process.env.GRAIL_MAX_PRICE) || 10000;
const RECENT_LIMIT = 100; // don't repeat a card within this many posts
const MAX_TRIES = 30; // unknown cards to check (download + read label) per category before falling back

// Every 10 posts: 5 Pokémon, 2 One Piece, 3 sports, spread out so one game doesn't run back to back
const MIX = ['pokemon', 'sports', 'pokemon', 'onepiece', 'pokemon', 'sports', 'pokemon', 'onepiece', 'sports', 'pokemon'];
const LABELS = { pokemon: 'Pokémon', onepiece: 'One Piece', sports: 'Baseball/Basketball' };

// The showroom returns at most 120 cards per request, the priciest under `belowPrice`,
// so step down from MAX_PRICE through these to collect everything down to MIN_PRICE.
const PRICE_STEPS = [7500, 5000, 3500, 2500, 2000, 1750];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

const loadState = () => ({ lastSlot: null, mixIndex: 0, recent: [], ...readJson(STATE_FILE, {}) });

// cardoutpost.com's firewall blocks automated requests. SHOWROOM_BOT_KEY is a shared secret sent in the
// x-cardoutpost-bot header; a firewall rule on the site lets requests carrying it through.
const BOT_KEY = process.env.SHOWROOM_BOT_KEY;

async function getJson(url) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; CardOutpostBot/1.0)' };
  if (BOT_KEY) headers['x-cardoutpost-bot'] = BOT_KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (res.status === 403) {
    throw new Error(`cardoutpost.com blocked the request (403)${BOT_KEY ? '; check the firewall rule for x-cardoutpost-bot' : '; set SHOWROOM_BOT_KEY and allow it in the site firewall'}`);
  }
  if (!res.ok) throw new Error(`Status code ${res.status}`);
  return res.json();
}

/** Every graded showroom card worth at least MIN_PRICE and under MAX_PRICE, deduplicated. */
async function fetchPool() {
  const byId = new Map();
  for (const below of [MAX_PRICE, ...PRICE_STEPS.filter((p) => p < MAX_PRICE)]) {
    const { cards = [] } = await getJson(`${FEED}?belowPrice=${below}&limit=120`);
    for (const c of cards) {
      if (c.price >= MIN_PRICE && c.price < MAX_PRICE && c.gradeDisplay && c.imageUrl && c.name) byId.set(c.id, c);
    }
  }
  return [...byId.values()];
}

// "CHARIZARD-HOLO" -> "Charizard-Holo", keeps short tokens like "EX", "GX", "FA/" as-is
function prettyName(name) {
  return name
    .toLowerCase()
    .replace(/(^|[\s\-/(.&])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase())
    .replace(/\b(Ex|Gx|Vmax|Vstar|V|Fa|Psa|Tcg)\b/g, (w) => w.toUpperCase());
}

const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** Text on the PSA slab label: macOS's built-in text recognition on a Mac, Tesseract elsewhere (e.g. Railway). */
async function readLabel(photoPath) {
  if (process.platform !== 'darwin') {
    const { stdout } = await run('python3', [LABEL_PY, photoPath], { timeout: 60000 });
    return stdout;
  }
  if (!fs.existsSync(LABEL_BIN)) {
    fs.mkdirSync(path.dirname(LABEL_BIN), { recursive: true });
    await run('swiftc', ['-O', LABEL_SRC, '-o', LABEL_BIN], { timeout: 300000 });
  }
  const { stdout } = await run(LABEL_BIN, [photoPath], { timeout: 30000 });
  return stdout;
}

/** Which game a card is from, from its slab label ("2016 POKEMON XY", "1962 TOPPS", "2022 ONE PIECE ..."). */
function categorize(label) {
  const t = label.toUpperCase();
  if (/POK[EÉ]MON/.test(t)) return 'pokemon';
  if (/ONE\s*PIECE/.test(t)) return 'onepiece';
  if (/FOOTBALL|HOCKEY|SOCCER|\bNFL\b|\bNHL\b/.test(t)) return 'other';
  if (/TOPPS|BOWMAN|UPPER\s*DECK|PANINI|PRIZM|DONRUSS|FLEER|HOOPS|SKYBOX|STADIUM CLUB|\bLEAF\b|GOUDEY|\bSCORE\b|SELECT|OPTIC|MOSAIC|BASKETBALL|BASEBALL|\bNBA\b|\bMLB\b/.test(t)) {
    return 'sports';
  }
  return 'other';
}

/** For sports cards: basketball if the label says so, otherwise baseball (most vintage Topps is baseball). */
const sportOf = (label) => (/BASKETBALL|\bNBA\b|\bWNBA\b|HOOPS|PRIZM/i.test(label) ? 'basketball' : 'baseball');

// Game tag shown on a reveal, e.g. "⚡ Pokémon"
const GAME_TAGS = { pokemon: '⚡ Pokémon', onepiece: '🏴‍☠️ One Piece', baseball: '⚾ Baseball', basketball: '🏀 Basketball' };

// first "1999 POKEMON…" / "2018 TOPPS…" style year+word on the label (OCR may add stray characters before it)
const yearOf = (label) => (label.match(/\b((?:19|20)\d{2})\s+[A-Z]/) || [])[1] || null;

async function downloadPhoto(card, dir) {
  const res = await fetch(card.imageUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`card photo: status ${res.status}`);
  const file = path.join(dir, `${card.id}.jpg`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/**
 * Find a card of the `wanted` category. Labels already read are cached in data/card-categories.json
 * (by card id), so known cards are matched without reading them again. Returns { card, year, photo } or null.
 */
async function findCard(pool, wanted, recent, dir, cache) {
  const shuffled = pool.filter((c) => !recent.includes(c.id)).sort(() => Math.random() - 0.5);
  const candidates = [
    ...shuffled.filter((c) => cache[c.id]?.category === wanted), // known matches first
    ...shuffled.filter((c) => !cache[c.id]), // then cards we haven't read yet
  ];
  let checked = 0;
  for (const card of candidates) {
    const known = cache[card.id];
    if (!known && checked >= MAX_TRIES) break;
    try {
      const photo = await downloadPhoto(card, dir);
      if (!known) {
        checked++;
        const label = await readLabel(photo);
        const category = categorize(label);
        cache[card.id] = { category, year: yearOf(label), ...(category === 'sports' && { sport: sportOf(label) }) };
      }
      const info = cache[card.id];
      if (info.category === wanted) return { card, year: info.year, game: wanted === 'sports' ? info.sport || 'baseball' : wanted, photo };
    } catch (err) {
      console.error(`  ! skipped ${card.name}: ${err.message}`);
    }
  }
  return null;
}

/** Draw the post graphic (styled like the hand-made #pulls-of-the-day images). Returns a PNG Buffer or null. */
async function renderGraphic(photo, dir, { title, year, grade, price }) {
  try {
    const out = path.join(dir, 'graphic.jpg');
    const data = { headline: 'GRAIL PULLED', name: title, subline: year, grade, price, caption: 'Market Value', imagePath: photo };
    await run('python3', [RENDER_SCRIPT, JSON.stringify(data), out], { timeout: 60000 });
    return fs.readFileSync(out);
  } catch (err) {
    console.error('  ! graphic render failed, posting the plain photo instead:', err.message);
    return null;
  }
}

// Grail reveal text ("clean stat block"):
//   ## 🏆 GRAIL OF THE DAY
//   > **2003 Charizard-Holo**
//   > PSA 9 · ⚡ Pokémon
//   > Market value **$4,896**
//   🔗 View this card   (links to the card's page; angle brackets stop Discord adding a link preview)
// The "GRAIL PULLED" graphic is attached below it. No @everyone ping.
function buildMessage({ card, year, game }, graphic) {
  const ext = (card.imageUrl.match(/\.(jpe?g|png|webp)(?:\?|$)/i) || [, 'jpg'])[1];
  const title = [year, prettyName(card.name)].filter(Boolean).join(' ');
  return {
    content: [
      '## 🏆 GRAIL OF THE DAY',
      `> **${title}**`,
      `> PSA ${card.gradeDisplay}${GAME_TAGS[game] ? ` · ${GAME_TAGS[game]}` : ''}`,
      `> Market value **${money(card.price)}**`,
      '',
      `🔗 [View this card](<https://www.cardoutpost.com/cards/${card.id}>)`,
    ].join('\n'),
    files: [
      graphic
        ? { attachment: graphic, name: 'grail-pulled.jpg' }
        : { attachment: card.imageUrl, name: `grail-pulled.${ext}` },
    ],
    allowedMentions: { parse: [] },
  };
}

/**
 * Pick the next card in the mix and build its post. Nothing is saved until `commit(slot)`
 * is called after the post has been sent (except the label cache, which is always kept).
 */
async function prepareGrail() {
  const st = loadState();
  const cache = readJson(CATEGORY_FILE, {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grail-'));
  try {
    const pool = await fetchPool();
    const wanted = MIX[st.mixIndex % MIX.length];
    // the wanted game first; if none turns up, fall back to the others rather than skip the post
    const order = [wanted, ...Object.keys(LABELS).filter((k) => k !== wanted)];
    let pick = null;
    let category = null;
    for (category of order) {
      pick = await findCard(pool, category, st.recent, dir, cache);
      if (pick) break;
      console.error(`  ! no ${LABELS[category]} card worth ${money(MIN_PRICE)}+ found this time`);
    }
    writeJson(CATEGORY_FILE, cache);
    if (!pick) throw new Error(`no card worth ${money(MIN_PRICE)}+ found`);

    const graphic = await renderGraphic(pick.photo, dir, {
      title: prettyName(pick.card.name),
      year: pick.year,
      grade: `PSA ${pick.card.gradeDisplay}`,
      price: money(pick.card.price),
    });
    const commit = (slot) => {
      const now = loadState();
      now.recent = [...now.recent, pick.card.id].slice(-RECENT_LIMIT);
      now.mixIndex = (st.mixIndex + 1) % MIX.length;
      if (slot) now.lastSlot = slot;
      writeJson(STATE_FILE, now);
    };
    return { message: buildMessage(pick, graphic), card: pick.card, year: pick.year, category: LABELS[category], wanted: LABELS[wanted], commit };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** True if a slot has started and its post hasn't gone out yet (a missed earlier slot isn't made up). */
function isDue(hours) {
  const slot = currentSlot(hours);
  return slot !== null && loadState().lastSlot !== slot;
}

/** Post the next grail now. `send(message)` posts it. */
async function postChase(send, hours = []) {
  const grail = await prepareGrail();
  await send(grail.message);
  grail.commit(currentSlot(hours));
  return grail;
}

module.exports = { postChase, prepareGrail, fetchPool, isDue, categorize, prettyName, MIX, MIN_PRICE, MAX_PRICE };
