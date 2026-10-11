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

module.exports = { plain, sameName };
