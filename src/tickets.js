// Support tickets, replacing MEE6's. The panel in #support has a topic menu; picking a topic opens a
// short form (order ID + what's wrong), then the bot creates a private "<number>-<topic>-<username>"
// channel for the member and staff with Claim / Close / Reopen / Delete buttons. Deleting a ticket
// posts a transcript to the staff log channel first.
//
// Nothing is kept on disk: a ticket's owner is read from its channel topic, so redeploys can't
// lose track of open tickets.
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits: P,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { findChannel } = require('./names');

// Channel/category IDs (names also work), so renames don't break tickets
const SUPPORT_CHANNEL = process.env.TICKET_PANEL_CHANNEL || '1501139190325186631'; // 『🎫』support-ticket
const CATEGORY = process.env.TICKET_CATEGORY || '1501139157299236864'; // HELP ═══
const STAFF_ROLES = (process.env.TICKET_STAFF_ROLES || 'Support,Moderators').split(',').map((r) => r.trim());
const LOG_CHANNEL = process.env.TICKET_LOG_CHANNEL || '1498984165360533528'; // 『🛡️』moderator-only

const TOPICS = {
  order: { label: 'Order / Shipping', emoji: '📦', description: 'Shipping requests, tracking, damaged or missing cards' },
  payments: { label: 'Withdrawals & Payments', emoji: '💸', description: 'Deposits, withdrawals, buyback, refunds' },
  account: { label: 'Account & Verification', emoji: '🔐', description: 'Login, ID verification, username, profile' },
  partnership: {
    label: 'Partnership / B2B',
    emoji: '🤝',
    description: 'Business inquiries, collabs, sponsorships, creators',
    refLabel: 'Company / brand & website', // form labels max 45 chars
    detailsLabel: 'What would you like to work on together?',
  },
  other: { label: 'Other', emoji: '💬', description: 'Anything else' },
};

const MEMBER_ACCESS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];

const button = (id, label, style, emoji) =>
  new ButtonBuilder().setCustomId(`ticket:${id}`).setLabel(label).setStyle(style).setEmoji(emoji);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

const staffRoles = (guild) => STAFF_ROLES.map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
const isStaff = (member) =>
  member.permissions.has(P.Administrator) ||
  member.permissions.has(P.ManageChannels) ||
  member.roles.cache.some((r) => STAFF_ROLES.includes(r.name));

// A ticket channel's topic looks like "Ticket #96 · Order / Shipping · Opened by <@123>"
const ownerOf = (channel) => (channel.topic?.match(/Opened by <@!?(\d+)>/) || [])[1] || null;
const openTicketOf = (guild, userId) =>
  guild.channels.cache.find((c) => c.type === ChannelType.GuildText && ownerOf(c) === userId);

const panelMessage = () => ({
  embeds: [
    new EmbedBuilder()
      .setColor('#D6F03E')
      .setTitle('🛟 Card Outpost Support')
      .setDescription(
        'Need help? Pick a topic below, fill in a few details, and we\'ll open a private channel for you and our support team.\n\n' +
          Object.values(TOPICS).map((t) => `${t.emoji} **${t.label}**: ${t.description}`).join('\n')
      ),
  ],
  components: [
    row(
      new StringSelectMenuBuilder()
        .setCustomId('ticket:topic')
        .setPlaceholder('📩 Open a ticket: choose a topic')
        .addOptions(Object.entries(TOPICS).map(([value, t]) => ({ value, label: t.label, emoji: t.emoji, description: t.description })))
    ),
  ],
});

/** Post the ticket panel in #support, or update the bot's existing one (e.g. when topics change). */
async function ensurePanel(guild, log) {
  const channel = findChannel(guild, SUPPORT_CHANNEL);
  if (!channel) return log(`  ! tickets: #${SUPPORT_CHANNEL} not found`);
  const recent = await channel.messages.fetch({ limit: 25 });
  const existing = recent.find(
    (m) => m.author.id === guild.client.user.id && m.components?.[0]?.components?.[0]?.customId === 'ticket:topic'
  );
  if (existing) {
    const current = existing.components[0].components[0].options.map((o) => o.value).join(',');
    if (current !== Object.keys(TOPICS).join(',')) {
      await existing.edit(panelMessage());
      log(`Tickets: updated the support panel in #${channel.name}.`);
    }
    return;
  }
  await channel.send(panelMessage());
  log(`Tickets: posted the support panel in #${channel.name}.`);
}

/** Topic picked → show the short form (after checking they don't already have a ticket open). */
async function chooseTopic(interaction) {
  const topic = interaction.values[0];
  const open = openTicketOf(interaction.guild, interaction.user.id);
  if (open) return interaction.reply(ephemeral(`You already have an open ticket: ${open}`));
  const modal = new ModalBuilder().setCustomId(`ticket:form:${topic}`).setTitle(`${TOPICS[topic].emoji} ${TOPICS[topic].label}`);
  modal.addComponents(
    row(
      new TextInputBuilder()
        .setCustomId('ref')
        .setLabel(TOPICS[topic].refLabel ? `${TOPICS[topic].refLabel} (optional)` : 'Order ID, card name or username (optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100)
    ),
    row(
      new TextInputBuilder()
        .setCustomId('details')
        .setLabel(TOPICS[topic].detailsLabel || "What's going on?")
        .setPlaceholder('Describe the issue. You can add screenshots in the ticket.')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(1500)
    )
  );
  await interaction.showModal(modal);
}

/** Next ticket number, continuing from the highest "<number>-…" channel (MEE6's included). */
const nextNumber = (guild) =>
  Math.max(0, ...guild.channels.cache.map((c) => Number((c.name.match(/^(\d+)-/) || [])[1]) || 0)) + 1;

/** Form submitted → create the ticket channel. */
async function submitForm(interaction) {
  const { guild, user } = interaction;
  const topicKey = interaction.customId.split(':')[2];
  const topic = TOPICS[topicKey] || TOPICS.other;
  const open = openTicketOf(guild, user.id);
  if (open) return interaction.reply(ephemeral(`You already have an open ticket: ${open}`));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const number = nextNumber(guild);
  const category = findChannel(guild, CATEGORY, ChannelType.GuildCategory);
  const channel = await guild.channels.create({
    name: `${number}-${topicKey}-${user.username}`.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 90),
    type: ChannelType.GuildText,
    parent: category?.id,
    topic: `Ticket #${number} · ${topic.label} · Opened by ${user}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
      { id: user.id, allow: MEMBER_ACCESS },
      { id: guild.client.user.id, allow: [...MEMBER_ACCESS, P.ManageChannels] },
      ...staffRoles(guild).map((r) => ({ id: r.id, allow: MEMBER_ACCESS })),
    ],
    reason: `Ticket #${number} (${topic.label}) opened by ${user.tag}`,
  });

  const ref = interaction.fields.getTextInputValue('ref').trim();
  const details = interaction.fields.getTextInputValue('details').trim();
  const summary = new EmbedBuilder()
    .setColor('#D6F03E')
    .setTitle(`${topic.emoji} Ticket #${number} · ${topic.label}`)
    .setDescription(details)
    .setFooter({ text: `Opened by ${user.tag}` })
    .setTimestamp();
  if (ref) summary.addFields({ name: topic.refLabel || 'Order ID / reference', value: ref });

  const staffMentions = staffRoles(guild).map((r) => `${r}`).join(' ');
  const welcome = await channel.send({
    content: `${user} thanks, your ticket is open. Our support team will reply here soon; feel free to add screenshots.${staffMentions ? `\n${staffMentions}` : ''}`,
    embeds: [summary],
    components: [
      row(
        button('claim', 'Claim', ButtonStyle.Success, '🙋'),
        button('close', 'Close', ButtonStyle.Secondary, '🔒'),
        button('delete', 'Delete', ButtonStyle.Danger, '🗑️')
      ),
    ],
    allowedMentions: { users: [user.id], roles: staffRoles(guild).map((r) => r.id) },
  });
  await welcome.pin().catch(() => {});
  await interaction.editReply(`Your ticket is open: ${channel}`);
}

async function claim(interaction) {
  if (!isStaff(interaction.member)) return interaction.reply(ephemeral('Only staff can claim tickets.'));
  await interaction.reply({ content: `🙋 ${interaction.user} claimed the ticket and will help you.`, allowedMentions: { parse: [] } });
}

async function setOwnerCanSend(channel, canSend) {
  const owner = ownerOf(channel);
  if (owner) await channel.permissionOverwrites.edit(owner, { SendMessages: canSend });
}

async function close(interaction) {
  const owner = ownerOf(interaction.channel);
  if (!isStaff(interaction.member) && interaction.user.id !== owner) return interaction.reply(ephemeral('Only staff or the ticket owner can close it.'));
  await setOwnerCanSend(interaction.channel, false);
  await interaction.reply({
    content: `🔒 ${interaction.user} closed the ticket.`,
    components: [row(button('reopen', 'Reopen', ButtonStyle.Success, '🔓'), button('delete', 'Delete', ButtonStyle.Danger, '🗑️'))],
    allowedMentions: { parse: [] },
  });
}

async function reopen(interaction) {
  if (!isStaff(interaction.member)) return interaction.reply(ephemeral('Only staff can reopen tickets.'));
  await setOwnerCanSend(interaction.channel, true);
  await interaction.reply({ content: `🔓 ${interaction.user} reopened the ticket.`, allowedMentions: { parse: [] } });
}

async function remove(interaction, log) {
  if (!isStaff(interaction.member)) return interaction.reply(ephemeral('Only staff can delete tickets.'));
  await interaction.reply('🗑️ Saving a transcript and deleting this ticket in 5 seconds…');
  const channel = interaction.channel;
  try {
    const msgs = [...(await channel.messages.fetch({ limit: 100 })).values()].reverse();
    const line = (m) =>
      `[${m.createdAt.toISOString().slice(0, 16).replace('T', ' ')}] ${m.author.tag}: ${m.content}` +
      (m.embeds[0]?.description ? ` | ${m.embeds[0].title || ''}: ${m.embeds[0].description}` : '') +
      (m.attachments.size ? ' ' + [...m.attachments.values()].map((a) => a.url).join(' ') : '');
    const logChannel = findChannel(channel.guild, LOG_CHANNEL);
    await logChannel?.send({
      content: `📄 Transcript of **#${channel.name}** (${channel.topic || ''}), deleted by ${interaction.user.tag}`,
      files: [new AttachmentBuilder(Buffer.from(msgs.map(line).join('\n') || '(empty)'), { name: `${channel.name}.txt` })],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    log(`  ! ticket transcript failed: ${err.message}`);
  }
  setTimeout(() => channel.delete(`Ticket deleted by ${interaction.user.tag}`).catch(() => {}), 5000);
}

/** Handle a ticket menu pick, form submit or button click. Returns true if it was ours. */
async function handle(interaction, log) {
  if (!interaction.customId?.startsWith('ticket:')) return false;
  const action = interaction.customId.split(':')[1];
  try {
    if (action === 'topic' && interaction.isStringSelectMenu()) await chooseTopic(interaction);
    else if (action === 'form' && interaction.isModalSubmit()) await submitForm(interaction);
    else if (interaction.isButton()) await { claim, close, reopen, delete: (i) => remove(i, log) }[action]?.(interaction);
  } catch (err) {
    log(`  ! ticket ${action} failed: ${err.message}`);
    const reply = ephemeral('Something went wrong, please try again or ping a moderator.');
    await (interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
  }
  return true;
}

module.exports = { ensurePanel, handle, ownerOf, nextNumber, TOPICS };
