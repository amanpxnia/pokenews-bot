// Run `npm run check-feeds` to see which feeds work and preview their latest headlines.
// Doesn't touch Discord or the seen-items state.
const { loadFeeds, fetchFeed } = require('./feeds');

(async () => {
  const feeds = loadFeeds();
  let ok = 0;
  for (const [n, feed] of feeds.entries()) {
    if (n > 0) await new Promise((r) => setTimeout(r, 3000)); // same spacing as the bot
    try {
      const items = await fetchFeed(feed);
      ok++;
      console.log(`✅ ${feed.name} — ${items.length} items`);
      for (const i of items.slice(0, 3)) {
        const when = i.date ? i.date.toISOString().slice(0, 16).replace('T', ' ') : '?';
        console.log(`   • [${when}] ${i.title}${i.image ? ' 🖼' : ''}`);
      }
    } catch (err) {
      console.log(`❌ ${feed.name} — ${err.message}\n   ${feed.url}`);
    }
  }
  console.log(`\n${ok}/${feeds.length} feeds working. Set "enabled": false in feeds.json for any you want to skip.`);
})();
