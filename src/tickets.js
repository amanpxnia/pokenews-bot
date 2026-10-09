// Support tickets, replacing MEE6's: an "Open ticket" button in #support creates a private
// "<number>-<username>" channel for the member and staff, with Claim / Close / Reopen / Delete buttons.
// Deleting a ticket posts a transcript to the staff log channel first.
const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits: P,
} = require('discord.js');

const FILE = path.join(__dirname, '..', 'data', 'tickets.json');
const SUPPORT_CHANNEL = process.env.TICKET_PANEL_CHANNEL || 'support';
const CATEGORY = process.env.TICKET_CATEGORY || 'Help';
const STAFF_ROLES = (process.env.TICKET_STAFF_ROLES || 'Support,Moderators').split(',').map((r) => r.trim());
const LOG_CHANNEL = process.env.TICKET_LOG_CHANNEL || 'moderator-only';

const MEMBER_ACCESS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { next: null, open: {} }; // open: { channelId: { owner, number } }
  }
};
const save = (st) => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(st, null, 2));
};

const button = (id, label, style, emoji) =>
  new ButtonBuilder().setCustomId(`ticket:${id}`).setLabel(label).setStyle(style).setEmoji(emoji);
const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);

const staffRoles = (guild) => STAFF_ROLES.map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
const isStaff = (member) =>
  member.permissions.has(P.Administrator) ||
  member.permissions.has(P.ManageChannels) ||
  member.roles.cache.some((r) => STAFF_ROLES.includes(r.name));

/** Post the "Open ticket" panel in #support, unless the bot already has one there. */
async function ensurePanel(guild, log) {
  const channel = guild.channels.cache.find((c) => c.name === SUPPORT_CHANNEL && c.isTextBased());
  if (!channel) return log(`  ! tickets: #${SUPPORT_CHANNEL} not found`);
  const recent = await channel.messages.fetch({ limit: 25 });
  const existing = recent.find(
    (m) => m.author.id === guild.client.user.id && m.components?.[0]?.components?.[0]?.customId === 'ticket:open'
  );
  if (existing) return;
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#D6F03E')
        .setTitle('🛟 Card Outpost Support')
        .setDescription(
          "Need help with an order, shipping, a withdrawal or your account?\n\nClick **Open ticket** below and we'll create a private channel for you and our support team."
        ),
    ],
    components: [row(button('open', 'Open ticket', ButtonStyle.Primary, '📩'))],
  });
  log(`Tickets: posted the "Open ticket" panel in #${channel.name}.`);
}

/** Next ticket number, continuing from MEE6's numbering ("95-username" → 96). */
function nextNumber(guild, st) {
  const fromChannels = Math.max(0, ...guild.channels.cache.map((c) => Number((c.name.match(/^(\d+)-/) || [])[1]) || 0));
  const n = Math.max(st.next || 0, fromChannels + 1);
  st.next = n + 1;
  return n;
}

async function open(interaction) {
  const { guild, user } = interaction;
  const st = load();
  const existing = Object.entries(st.open).find(([id, t]) => t.owner === user.id && guild.channels.cache.has(id));
  if (existing) {
    return interaction.reply({ content: `You already have an open ticket: <#${existing[0]}>`, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const number = nextNumber(guild, st);
  const category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY);
  const channel = await guild.channels.create({
    name: `${number}-${user.username}`.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 90),
    type: ChannelType.GuildText,
    parent: category?.id,
    topic: `Ticket #${number} - Created by: ${user}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
      { id: user.id, allow: MEMBER_ACCESS },
      { id: guild.client.user.id, allow: [...MEMBER_ACCESS, P.ManageChannels] },
      ...staffRoles(guild).map((r) => ({ id: r.id, allow: MEMBER_ACCESS })),
    ],
    reason: `Ticket #${number} opened by ${user.tag}`,
  });
  st.open[channel.id] = { owner: user.id, number };
  save(st);
  const welcome = await channel.send({
    content: `${user} Your ticket has been created.\n\nPlease describe your issue and add any details that could help (order ID, card name, screenshots). Our support team will be with you shortly.`,
    components: [
      row(
        button('claim', 'Claim', ButtonStyle.Success, '🙋'),
        button('close', 'Close', ButtonStyle.Secondary, '🔒'),
        button('delete', 'Delete', ButtonStyle.Danger, '🗑️')
      ),
    ],
    allowedMentions: { users: [user.id] },
  });
  await welcome.pin().catch(() => {});
  await interaction.editReply(`Your ticket is open: ${channel}`);
}

async function claim(interaction) {
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can claim tickets.', flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: `${interaction.user} claimed the ticket.`, allowedMentions: { parse: [] } });
}

async function setOwnerCanSend(interaction, canSend) {
  const t = load().open[interaction.channelId];
  if (t) await interaction.channel.permissionOverwrites.edit(t.owner, { SendMessages: canSend });
}

async function close(interaction) {
  await setOwnerCanSend(interaction, false);
  await interaction.reply({
    content: `${interaction.user} closed the ticket.`,
    components: [row(button('reopen', 'Reopen', ButtonStyle.Success, '🔓'), button('delete', 'Delete', ButtonStyle.Danger, '🗑️'))],
    allowedMentions: { parse: [] },
  });
}

async function reopen(interaction) {
  await setOwnerCanSend(interaction, true);
  await interaction.reply({ content: `${interaction.user} reopened the ticket.`, allowedMentions: { parse: [] } });
}

async function remove(interaction, log) {
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can delete tickets.', flags: MessageFlags.Ephemeral });
  await interaction.reply('🗑️ Deleting this ticket in 5 seconds…');
  const channel = interaction.channel;
  // transcript for the staff log channel
  try {
    const msgs = [...(await channel.messages.fetch({ limit: 100 })).values()].reverse();
    const text = msgs.map((m) => `[${m.createdAt.toISOString().slice(0, 16).replace('T', ' ')}] ${m.author.tag}: ${m.content}${m.attachments.size ? ' ' + [...m.attachments.values()].map((a) => a.url).join(' ') : ''}`).join('\n');
    const logChannel = channel.guild.channels.cache.find((c) => c.name === LOG_CHANNEL && c.isTextBased());
    await logChannel?.send({
      content: `📄 Transcript of **#${channel.name}** (deleted by ${interaction.user.tag})`,
      files: [new AttachmentBuilder(Buffer.from(text || '(empty)'), { name: `${channel.name}.txt` })],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    log(`  ! ticket transcript failed: ${err.message}`);
  }
  const st = load();
  delete st.open[channel.id];
  save(st);
  setTimeout(() => channel.delete(`Ticket deleted by ${interaction.user.tag}`).catch(() => {}), 5000);
}

/** Handle a ticket button click. Returns true if it was ours. */
async function handle(interaction, log) {
  if (!interaction.isButton() || !interaction.customId.startsWith('ticket:')) return false;
  const action = interaction.customId.slice('ticket:'.length);
  const handlers = { open, claim, close, reopen, delete: (i) => remove(i, log) };
  try {
    await handlers[action]?.(interaction);
  } catch (err) {
    log(`  ! ticket ${action} failed: ${err.message}`);
    const reply = { content: 'Something went wrong, please try again or ping a moderator.', flags: MessageFlags.Ephemeral };
    await (interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
  }
  return true;
}

module.exports = { ensurePanel, handle };
