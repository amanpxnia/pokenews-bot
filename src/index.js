require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Events, PermissionFlagsBits } = require('discord.js');
const { loadFeeds, fetchFeed, truncate } = require('./feeds');
const state = require('./state');
const chase = require('./chase');
const { isRelevant } = require('./relevance');
const { parseHours, currentSlot } = require('./schedule');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
// One news story per slot (local hours). Default: 8 a day, every 3 hours, between the grail slots.
const NEWS_TIMES = parseHours(process.env.NEWS_TIMES, '1,4,7,10,13,16,19,22');
const MAX_AGE_HOURS = 48; // don't post stories older than this
const CHASE_CHANNEL = (process.env.CHASE_CHANNEL ?? 'legendary-pulls').replace(/^#/, ''); // empty = off
// One grail reveal per slot (local hours). Default: 8 a day, every 3 hours.
const GRAIL_TIMES = parseHours(process.env.GRAIL_TIMES, '0,3,6,9,12,15,18,21');
const FEED_GAP_MS = 3000; // pause between feeds so Reddit doesn't rate-limit us
const TICK_MS = 5 * 60e3; // how often to check whether a slot has started
const RECENT_TITLES = 300; // remember this many posted headlines to skip the same story from another source

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeTitle = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Meme post: caption as the title, the picture, credit to the subreddit and poster. No links. */
function buildMemeMessage(feed, item) {
  const poster = item.author ? ` · ${item.author.replace(/^\/?u\//, 'u/')}` : '';
  const embed = new EmbedBuilder()
    .setColor(feed.color || '#FF4500')
    .setTitle(truncate(item.title, 256))
    .setImage(item.image)
    .setFooter({ text: `${feed.name}${poster}` });
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

/** News-channel style post: each story in its own card (headline, summary, source, picture). No links. */
function buildMessage(feed, item) {
  if (feed.type === 'memes') return buildMemeMessage(feed, item);
  const source = item.publisher || feed.name;
  const embed = new EmbedBuilder()
    .setColor(feed.color || '#FFCB05')
    .setTitle(truncate(`🚨 BREAKING: ${item.title}`, 256))
    .setFooter({ text: source });
  if (item.summary) embed.setDescription(item.summary);
  if (item.image) embed.setImage(item.image);
  if (item.date && !isNaN(item.date)) embed.setTimestamp(item.date);
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

const isFresh = (item, now) => !item.date || now - item.date.getTime() < MAX_AGE_HOURS * 3600e3;

/**
 * Pick the one story to post: the newest item, across all news feeds, that is fresh, relevant
 * (Pokémon / One Piece / baseball / basketball cards), not posted before, and not the same
 * headline as a recent post from another source. Exported so it can be tested without Discord.
 */
function pickNews(fetched, st, now = Date.now()) {
  const recentTitles = new Set(st.__news?.titles || []);
  const candidates = [];
  for (const { feed, items } of fetched) {
    for (const item of items) {
      if (!isFresh(item, now) || state.isSeen(st, feed.url, item.id)) continue;
      if (recentTitles.has(normalizeTitle(item.title)) || !isRelevant(item, feed)) continue;
      candidates.push({ feed, item });
    }
  }
  candidates.sort((a, b) => (b.item.date?.getTime() || 0) - (a.item.date?.getTime() || 0));
  return { pick: candidates[0] || null, candidates: candidates.length };
}

/** Which channel a feed posts to: its "channel" (name or ID) if set, otherwise the main news channel. */
async function channelFor(feed, defaultChannel) {
  if (!feed.channel) return defaultChannel;
  const guild = defaultChannel.guild;
  const ch =
    guild.channels.cache.get(feed.channel) ||
    guild.channels.cache.find((c) => c.name === feed.channel.replace(/^#/, '') && c.isTextBased());
  if (!ch) throw new Error(`channel "${feed.channel}" not found in ${guild.name}`);
  const perms = ch.permissionsFor(guild.members.me);
  if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw new Error(`bot needs View Channel, Send Messages and Embed Links in #${ch.name}`);
  }
  return ch;
}

/** Post the newest unposted picture meme from a meme feed (at most one). */
async function postMeme(feed, items, st, defaultChannel) {
  const meme = items.find(
    // full-size image posts only (skips videos/galleries, which only have a preview thumbnail)
    (i) => /^https:\/\/i\.redd\.it\//.test(i.image || '') && isFresh(i, Date.now()) && !state.isSeen(st, feed.url, i.id)
  );
  const firstRun = !state.hasFeed(st, feed.url);
  state.markSeen(st, feed.url, firstRun ? items.map((i) => i.id) : meme ? [meme.id] : []);
  if (!meme) return;
  const target = await channelFor(feed, defaultChannel);
  await target.send(buildMessage(feed, meme));
  log(`  meme posted to #${target.name}: ${meme.title}`);
}

/** At each news slot: fetch every feed, post one news story (and one meme). */
async function newsTick(channel) {
  const slot = currentSlot(NEWS_TIMES);
  const st = state.load();
  if (!slot || st.__news?.lastSlot === slot) return;
  // claim the slot first, so a failing feed doesn't make us retry (and hammer Reddit) every few minutes
  st.__news = { ...(st.__news || {}), lastSlot: slot };
  state.save(st);

  const fetched = [];
  for (const [i, feed] of loadFeeds().entries()) {
    if (i > 0) await sleep(FEED_GAP_MS);
    try {
      const items = await fetchFeed(feed);
      if (feed.type === 'memes') await postMeme(feed, items, st, channel);
      else fetched.push({ feed, items });
    } catch (err) {
      log(`  ! ${feed.name} failed: ${err.message}`);
    }
  }

  const { pick, candidates } = pickNews(fetched, st);
  if (!pick) {
    log(`News slot ${slot}: no new Pokémon / One Piece / baseball / basketball card story found.`);
  } else {
    await channel.send(buildMessage(pick.feed, pick.item));
    state.markSeen(st, pick.feed.url, [pick.item.id]);
    st.__news.titles = [...(st.__news.titles || []), normalizeTitle(pick.item.title)].slice(-RECENT_TITLES);
    log(`News slot ${slot}: posted "${pick.item.title}" (${pick.feed.name}; ${candidates} relevant candidates)`);
  }
  state.save(st);
}

/** At each grail slot: post one grail reveal. */
async function grailTick(defaultChannel) {
  if (!CHASE_CHANNEL || !GRAIL_TIMES.length || !chase.isDue(GRAIL_TIMES)) return;
  const target = await channelFor({ channel: CHASE_CHANNEL }, defaultChannel);
  const grail = await chase.postChase((message) => target.send(message), GRAIL_TIMES);
  log(`Grail posted to #${target.name}: ${grail.card.name} ($${grail.card.price}, ${grail.category})`);
}

let busy = false;
async function tick(channel) {
  if (busy) return;
  busy = true;
  try {
    await grailTick(channel).catch((e) => log('  ! grail failed:', e.message));
    await newsTick(channel).catch((e) => log('  ! news failed:', e.message));
  } finally {
    busy = false;
  }
}

async function main() {
  if (!TOKEN || !CHANNEL_ID) {
    console.error('Missing DISCORD_TOKEN or CHANNEL_ID. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  // Never auto-retry a request: if an upload is slow, a retry can post the same message twice
  // (Discord already got the first one). Give slow uploads more time instead.
  const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { timeout: 60e3, retries: 0 } });

  client.once(Events.ClientReady, async (c) => {
    log(`Logged in as ${c.user.tag}`);
    let channel;
    try {
      channel = await c.channels.fetch(CHANNEL_ID);
    } catch {
      console.error(`Couldn't find channel ${CHANNEL_ID}. Check the ID and that the bot is in that server.`);
      process.exit(1);
    }
    if (!channel || !channel.isTextBased()) {
      console.error(`Channel ${CHANNEL_ID} isn't a text channel.`);
      process.exit(1);
    }
    const perms = channel.permissionsFor?.(c.user);
    const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (perms && !perms.has(needed)) {
      console.error(`Bot needs View Channel, Send Messages and Embed Links in #${channel.name}.`);
      process.exit(1);
    }

    const at = (hours) => hours.map((h) => `${h}:00`).join(', ');
    log(`News → #${channel.name}, 1 story at ${at(NEWS_TIMES)}.`);
    if (CHASE_CHANNEL) log(`Grail reveals → #${CHASE_CHANNEL}, 1 at ${at(GRAIL_TIMES)}.`);
    await tick(channel);
    setInterval(() => tick(channel), TICK_MS);
  });

  process.on('SIGINT', () => {
    log('Shutting down.');
    client.destroy();
    process.exit(0);
  });

  await client.login(TOKEN);
}

if (require.main === module) main();

module.exports = { pickNews, newsTick, buildMessage, channelFor };
