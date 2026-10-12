// gm reactions: every message in #gm gets one random reaction: :pokemon:, One Piece, baseball or basketball.
const { sameName } = require('./names');

const CHANNEL = process.env.GM_CHANNEL || '1501100932643950643'; // 『☀️』gm (ID; a name also works)
// :pokemon: is the server's custom emoji; the others are standard emojis (the server has no custom ones for them)
const REACTIONS = (process.env.GM_REACTIONS || '<:pokemon:1501141856535314554>,🏴‍☠️,⚾,🏀').split(',').map((r) => r.trim());

/** React to a message if it was posted in #gm (members only, not bots). */
async function onMessage(message, log) {
  if (message.author.bot || (message.channelId !== CHANNEL && !sameName(message.channel.name || '', CHANNEL))) return;
  const emoji = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
  await message.react(emoji).catch((e) => log(`  ! gm reaction failed: ${e.message}`));
}

module.exports = { onMessage, REACTIONS };
