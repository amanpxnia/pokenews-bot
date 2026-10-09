// Remembers which items have already been posted, so restarts don't re-post.
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'seen.json');
const MAX_IDS_PER_FEED = 500;

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE); // atomic-ish write so a crash can't corrupt it
}

function hasFeed(state, feedUrl) {
  return Array.isArray(state[feedUrl]);
}

function isSeen(state, feedUrl, id) {
  return hasFeed(state, feedUrl) && state[feedUrl].includes(id);
}

function markSeen(state, feedUrl, ids) {
  const list = state[feedUrl] || [];
  for (const id of ids) if (!list.includes(id)) list.push(id);
  state[feedUrl] = list.slice(-MAX_IDS_PER_FEED);
}

module.exports = { load, save, hasFeed, isSeen, markSeen };
