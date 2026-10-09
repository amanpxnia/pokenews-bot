// Member counter, replacing MEE6's: keeps a channel named "Total Members: 1.47K" up to date.
const NAME = /^Total Members:/i;
const EVERY_MS = 15 * 60e3; // Discord only allows 2 channel renames per 10 minutes

const format = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2).replace(/\.?0+$/, '')}K` : String(n));

async function update(guild, log) {
  const channel = guild.channels.cache.find((c) => NAME.test(c.name));
  if (!channel) return;
  const { approximate_member_count: count } = await guild.client.rest.get(`/guilds/${guild.id}`, {
    query: new URLSearchParams({ with_counts: 'true' }),
  });
  const name = `Total Members: ${format(count)}`;
  if (channel.name !== name) {
    await channel.setName(name, 'Member counter');
    log(`Member counter: ${name}`);
  }
}

function start(guild, log) {
  const run = () => update(guild, log).catch((e) => log('  ! member counter failed:', e.message));
  run();
  setInterval(run, EVERY_MS);
}

module.exports = { start, format };
