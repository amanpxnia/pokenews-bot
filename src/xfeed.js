// X (Twitter) feed, replacing MEE6's: posts each new tweet from the account to a channel.
// Uses X's public embed timeline (no API key needed). Retweets and replies are skipped.
const state = require('./state');

const HANDLE = process.env.X_HANDLE || 'cardoutpostX';
const CHANNEL = process.env.X_FEED_CHANNEL || 'x-feed';
const EVERY_MS = 30 * 60e3; // X rate-limits this endpoint after a few quick requests, so check gently
const KEY = `x:${HANDLE}`; // where seen tweet ids are kept in data/seen.json

async function fetchTweets() {
  const res = await fetch(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${HANDLE}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CardOutpostBot/1.0)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`X timeline: status ${res.status}`);
  const html = await res.text();
  const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!json) throw new Error('X timeline: unexpected page format');
  const entries = JSON.parse(json[1]).props?.pageProps?.timeline?.entries || [];
  return entries
    .map((e) => e.content?.tweet)
    .filter((t) => t && !t.retweeted_status && !t.in_reply_to_status_id_str && t.user?.screen_name === HANDLE)
    .map((t) => ({ id: t.id_str, url: `https://x.com/${HANDLE}/status/${t.id_str}`, date: new Date(t.created_at) }))
    .sort((a, b) => a.date - b.date); // oldest first, so the channel reads in order
}

async function check(guild, log) {
  const channel = guild.channels.cache.find((c) => c.name === CHANNEL && c.isTextBased());
  if (!channel) return log(`  ! X feed: #${CHANNEL} not found`);
  const tweets = await fetchTweets();
  const st = state.load();
  if (!state.hasFeed(st, KEY)) {
    // first run: remember what's already there instead of re-posting the whole timeline
    state.markSeen(st, KEY, tweets.map((t) => t.id));
    return state.save(st);
  }
  for (const t of tweets.filter((t) => !state.isSeen(st, KEY, t.id))) {
    // the bare link makes Discord show X's own preview (text, images, video)
    await channel.send({ content: `**@${HANDLE}** just posted on X\n${t.url}`, allowedMentions: { parse: [] } });
    state.markSeen(st, KEY, [t.id]);
    state.save(st);
    log(`X feed: posted ${t.url}`);
  }
}

function start(guild, log) {
  const run = () => check(guild, log).catch((e) => log('  ! X feed failed:', e.message));
  run();
  setInterval(run, EVERY_MS);
}

module.exports = { start, fetchTweets };
