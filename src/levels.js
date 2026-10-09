// Levels / XP, replacing MEE6's: 15–25 XP per message, at most once a minute per member, same level
// curve as MEE6, "GG @user, you just advanced to level N!" in the channel they chatted in.
// On first run, existing levels are imported from MEE6's public leaderboard so nobody loses progress.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'levels.json');
const COOLDOWN_MS = 60e3;
const SAVE_EVERY_MS = 30e3;

let data = null; // { users: { [id]: { xp, messages, name } }, importedFromMee6: bool }
let dirty = false;
const lastXpAt = new Map();

// MEE6's curve: going from level n to n+1 takes 5n² + 50n + 100 XP
const xpForNext = (level) => 5 * level * level + 50 * level + 100;
function levelFromXp(xp) {
  let level = 0;
  let left = xp;
  while (left >= xpForNext(level)) left -= xpForNext(level++);
  return { level, into: left, needed: xpForNext(level) };
}

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    data = { users: {}, importedFromMee6: false };
  }
  return data;
}

function save() {
  if (!dirty) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
  fs.renameSync(FILE + '.tmp', FILE);
  dirty = false;
}

/** Copy every member's XP from MEE6's public leaderboard (only done once). */
async function importFromMee6(guildId, log) {
  load();
  if (data.importedFromMee6) return;
  let imported = 0;
  for (let page = 0; page < 50; page++) {
    const res = await fetch(`https://mee6.xyz/api/plugins/levels/leaderboard/${guildId}?limit=1000&page=${page}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`MEE6 leaderboard: status ${res.status}`);
    const { players = [] } = await res.json();
    for (const p of players) {
      const mine = data.users[p.id] || { xp: 0, messages: 0 };
      // keep whichever is higher, in case members already earned XP here
      data.users[p.id] = { xp: Math.max(mine.xp, p.xp), messages: Math.max(mine.messages, p.message_count || 0), name: p.username };
      imported++;
    }
    if (players.length < 1000) break;
  }
  data.importedFromMee6 = true;
  dirty = true;
  save();
  log(`Levels: imported ${imported} members from MEE6.`);
}

/** Give XP for a message. Returns the new level if the member levelled up, else null. */
function onMessage(userId, name, now = Date.now()) {
  load();
  if (now - (lastXpAt.get(userId) || 0) < COOLDOWN_MS) return null;
  lastXpAt.set(userId, now);
  const user = (data.users[userId] ||= { xp: 0, messages: 0 });
  const before = levelFromXp(user.xp).level;
  user.xp += 15 + Math.floor(Math.random() * 11);
  user.messages++;
  user.name = name;
  dirty = true;
  const after = levelFromXp(user.xp).level;
  return after > before ? after : null;
}

/** Rank card text for one member. */
function rankOf(userId) {
  load();
  const user = data.users[userId];
  if (!user) return null;
  const position = Object.values(data.users).filter((u) => u.xp > user.xp).length + 1;
  return { ...levelFromXp(user.xp), xp: user.xp, messages: user.messages, position };
}

/** Top members by XP. */
function leaderboard(limit = 10) {
  load();
  return Object.entries(data.users)
    .sort((a, b) => b[1].xp - a[1].xp)
    .slice(0, limit)
    .map(([id, u], i) => ({ id, position: i + 1, name: u.name, xp: u.xp, ...levelFromXp(u.xp) }));
}

setInterval(save, SAVE_EVERY_MS).unref();
process.on('exit', save);

module.exports = { importFromMee6, onMessage, rankOf, leaderboard, levelFromXp, xpForNext, save };
