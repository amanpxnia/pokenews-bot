// Grail posts: a few times a day, post a high-value graded card from the Card Outpost showroom
// with a "GRAIL PULLED" graphic. The mix of games follows MIX below (50% Pokémon, 20% One Piece,
// 30% baseball/basketball), and every card is worth at least MIN_PRICE.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const FEED = 'https://www.cardoutpost.com/api/cards/showroom-feed';
const STATE_FILE = path.join(__dirname, '..', 'data', 'chase.json');
const CATEGORY_FILE = path.join(__dirname, '..', 'data', 'card-categories.json');
const RENDER_SCRIPT = path.join(__dirname, '..', 'scripts', 'render_card.py');
const LABEL_SRC = path.join(__dirname, '..', 'scripts', 'read_label.swift');
const LABEL_BIN = path.join(__dirname, '..', 'bin', 'read_label');
const run = promisify(execFile);

const MIN_PRICE = Number(process.env.GRAIL_MIN_PRICE) || 1500;
const RECENT_LIMIT = 100; // don't repeat a card within this many posts
const MAX_TRIES = 30; // unknown cards to check (download + read label) per category before falling back

// Every 10 posts: 5 Pokémon, 2 One Piece, 3 sports, spread out so one game doesn't run back to back
const MIX = ['pokemon', 'sports', 'pokemon', 'onepiece', 'pokemon', 'sports', 'pokemon', 'onepiece', 'sports', 'pokemon'];
const LABELS = { pokemon: 'Pokémon', onepiece: 'One Piece', sports: 'Baseball/Basketball' };

// The showroom returns at most 120 cards per request, the priciest under `belowPrice`,
// so step down through these to collect everything from the top end to MIN_PRICE.
const PRICE_STEPS = [1000000, 20000, 10000, 7500, 5000, 3500, 2500];

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

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CardOutpostBot/1.0)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Status code ${res.status}`);
  return res.json();
}

/** Every graded showroom card worth at least MIN_PRICE, deduplicated. */
async function fetchPool() {
  const byId = new Map();
  for (const below of PRICE_STEPS) {
    const { cards = [] } = await getJson(`${FEED}?belowPrice=${below}&limit=120`);
    for (const c of cards) {
      if (c.price >= MIN_PRICE && c.gradeDisplay && c.imageUrl && c.name) byId.set(c.id, c);
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

/** Text on the PSA slab label, read with macOS's built-in text recognition. */
async function readLabel(photoPath) {
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

const yearOf = (label) => (label.match(/^\s*((?:19|20)\d{2})\b/m) || [])[1] || null;

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
        cache[card.id] = { category: categorize(label), year: yearOf(label) };
      }
      if (cache[card.id].category === wanted) return { card, year: cache[card.id].year, photo };
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

// Same layout as the hand-made #pulls-of-the-day posts: big heading lines, @everyone, and the graphic attached.
function buildMessage({ card, year }, graphic) {
  const ext = (card.imageUrl.match(/\.(jpe?g|png|webp)(?:\?|$)/i) || [, 'jpg'])[1];
  return {
    content: [
      '# 🏆  GRAIL OF THE DAY',
      `# ${[year, prettyName(card.name), `PSA ${card.gradeDisplay}`].filter(Boolean).join(' ')}`,
      `# ${money(card.price)}`,
      '@everyone',
    ].join('\n\n'),
    files: [
      graphic
        ? { attachment: graphic, name: 'grail-pulled.jpg' }
        : { attachment: card.imageUrl, name: `grail-pulled.${ext}` },
    ],
    allowedMentions: { parse: ['everyone'] },
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

const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

/** The most recent posting slot that has started today (e.g. "2026-10-07@13"), or null before the first one. */
function currentSlot(hours) {
  const now = new Date().getHours();
  const started = hours.filter((h) => h <= now);
  return started.length ? `${today()}@${Math.max(...started)}` : null;
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

module.exports = { postChase, prepareGrail, isDue, categorize, prettyName, MIX, MIN_PRICE };
