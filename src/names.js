// Channel names may be decorated, e.g. "『🏆』pulls-of-the-day" or a category "HELP ═══════".
// Compare names without that decoration (and without case) so the bot keeps finding its channels.
const plain = (name) =>
  String(name)
    .replace(/^『[^』]*』\s*/, '')
    .replace(/\s*[═━─]+\s*$/, '')
    .replace(/^#/, '')
    .trim()
    .toLowerCase();

const sameName = (a, b) => plain(a) === plain(b);

/**
 * Find a channel by ID (preferred: survives renames) or by name, e.g. "1499117752277794966" or "gacha-wins".
 * `type` optionally restricts to a channel type (e.g. 4 for categories).
 */
function findChannel(guild, ref, type) {
  if (!ref) return undefined;
  const byId = guild.channels.cache.get(String(ref));
  if (byId) return byId;
  return guild.channels.cache.find((c) => sameName(c.name, ref) && (type === undefined ? c.type !== 4 : c.type === type));
}

module.exports = { plain, sameName, findChannel };
