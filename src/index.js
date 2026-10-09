require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Events, PermissionFlagsBits } = require('discord.js');
const { loadFeeds, fetchFeed, truncate } = require('./feeds');
const state = require('./state');
const chase = require('./chase');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const POLL_MINUTES = Math.max(2, Number(process.env.POLL_MINUTES) || 10);
const FIRST_RUN_POSTS = Math.max(0, Number(process.env.FIRST_RUN_POSTS_PER_FEED ?? 1));
const MAX_POSTS_PER_FEED = Math.max(1, Number(process.env.MAX_POSTS_PER_FEED) || 5);
const MAX_AGE_HOURS = 72; // ignore anything older than this, even if unseen
const REACTIONS = (process.env.REACTIONS ?? '⚡,🔥,💧,🌿,✨')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)
  .slice(0, 5);
const CHASE_CHANNEL = (process.env.CHASE_CHANNEL ?? 'legendary-pulls').replace(/^#/, ''); // empty = off
// Local hours to post a chase card, e.g. "9,13,17,21"
const CHASE_TIMES = (process.env.CHASE_TIMES ?? '9,13,17,21')
  .split(',')
  .map((h) => Number(h.trim()))
  .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
const FEED_GAP_MS = 3000; // pause between feeds so Reddit doesn't rate-limit us

const log = (...args) => console.log(new Date().toISOString(), ...args);

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

async function sendWithReactions(channel, message) {
  const sent = await channel.send(message);
  for (const emoji of REACTIONS) {
    try {
      await sent.react(emoji);
    } catch (err) {
      log(`  ! couldn't add reaction ${emoji}:`, err.message);
    }
  }
  return sent;
}

/**
 * Decide which items from a feed to post, update state, and post them.
 * Exported so it can be tested without Discord.
 */
async function processFeed(feed, items, st, post, opts = {}) {
  const now = opts.now || Date.now();
  const firstRunPosts = opts.firstRunPosts ?? FIRST_RUN_POSTS;
  const maxPerFeed = feed.maxPerPoll || opts.maxPerFeed || MAX_POSTS_PER_FEED;

  const postedTitles = opts.postedTitles; // shared across feeds within one check, to skip duplicates
  const fresh = items.filter(
    (i) =>
      // memes must be a full-size image post (skips videos/galleries, which only have a preview thumbnail)
      (feed.type !== 'memes' || /^https:\/\/i\.redd\.it\//.test(i.image || '')) &&
      (!i.date || now - i.date.getTime() < MAX_AGE_HOURS * 3600e3) &&
      !(postedTitles && postedTitles.has(normalizeTitle(i.title)))
  );
  let toPost;

  if (!state.hasFeed(st, feed.url)) {
    // First time we've seen this feed: post only the newest few, remember the rest.
    toPost = fresh.slice(0, firstRunPosts);
  } else {
    toPost = fresh.filter((i) => !state.isSeen(st, feed.url, i.id)).slice(0, maxPerFeed);
  }

  // Mark everything currently in the feed as seen so backlog never spills over later.
  state.markSeen(st, feed.url, items.map((i) => i.id));

  // Post oldest first so the channel reads chronologically.
  let posted = 0;
  for (const item of toPost.reverse()) {
    try {
      await post(buildMessage(feed, item));
      if (postedTitles) postedTitles.add(normalizeTitle(item.title));
      posted++;
    } catch (err) {
      log(`  ! failed to post "${item.title}":`, err.message);
    }
  }
  return posted;
}

let polling = false;
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

async function poll(channel) {
  if (polling) return log('Previous check still running, skipping this tick.');
  polling = true;
  try {
    const feeds = loadFeeds(); // re-read each time, so edits to feeds.json apply without restart
    const st = state.load();
    let total = 0;
    const postedTitles = new Set();
    for (const [i, feed] of feeds.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, FEED_GAP_MS));
      try {
        const target = await channelFor(feed, channel);
        const items = await fetchFeed(feed);
        const n = await processFeed(feed, items, st, (message) => sendWithReactions(target, message), {
          postedTitles,
        });
        total += n;
        if (n) log(`  ${feed.name}: posted ${n} to #${target.name}`);
      } catch (err) {
        log(`  ! ${feed.name} failed: ${err.message}`);
      }
      state.save(st); // save after every feed so a crash mid-run doesn't cause re-posts
    }
    log(`Check done — ${total} new item(s) posted from ${feeds.length} feed(s).`);
  } finally {
    polling = false;
  }
}

/** Post a chase card if a posting slot has started. Checked every few minutes. */
async function chaseTick(defaultChannel) {
  if (!CHASE_CHANNEL || !CHASE_TIMES.length || !chase.isDue(CHASE_TIMES)) return;
  const target = await channelFor({ channel: CHASE_CHANNEL }, defaultChannel);
  const grail = await chase.postChase((message) => target.send(message), CHASE_TIMES); // no reactions, like the hand-made pull posts
  log(`Grail posted to #${target.name}: ${grail.card.name} ($${grail.card.price}, ${grail.category})`);
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
    if (REACTIONS.length && perms && !perms.has([PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory])) {
      log(`Warning: bot needs Add Reactions and Read Message History in #${channel.name} to react to posts.`);
    }

    log(`Posting to #${channel.name} every ${POLL_MINUTES} min.`);
    await poll(channel);
    setInterval(() => poll(channel).catch((e) => log('Poll error:', e)), POLL_MINUTES * 60e3);

    if (CHASE_CHANNEL) {
      log(`Chase cards → #${CHASE_CHANNEL} daily at ${CHASE_TIMES.map((h) => h + ':00').join(', ')}.`);
      const tick = () => chaseTick(channel).catch((e) => log('  ! chase card failed:', e.message));
      tick();
      setInterval(tick, 5 * 60e3);
    }
  });

  process.on('SIGINT', () => {
    log('Shutting down.');
    client.destroy();
    process.exit(0);
  });

  await client.login(TOKEN);
}

if (require.main === module) main();

module.exports = { processFeed, buildMessage, sendWithReactions, channelFor };
