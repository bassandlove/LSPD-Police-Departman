import {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits
} from 'discord.js';
import { getGuildConfig } from './guildConfig.js';
import { getTicketData, saveTicketData, deleteTicketData, getOpenTicketCountForUser } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { createEmbed, errorEmbed } from '../utils/embeds.js';
import { logTicketEvent } from '../utils/ticketLogging.js';
import { BotConfig } from '../config/bot.js';
import { ensureTypedServiceError } from '../utils/serviceErrorBoundary.js';

function getPriorityMap() {
  const priorities = BotConfig.tickets?.priorities || {
    none: { emoji: "⚪", color: "#95A5A6", label: "Nincs" },
    low: { emoji: "🟢", color: "#2ECC71", label: "Alacsony" },
    medium: { emoji: "🟡", color: "#F1C40F", label: "Közepes" },
    high: { emoji: "🔴", color: "#E74C3C", label: "Magas" },
    urgent: { emoji: "🚨", color: "#E91E63", label: "Sürgős" },
  };
  
  const map = {};
  for (const [key, config] of Object.entries(priorities)) {
    map[key] = {
      name: `${config.emoji} ${config.label.toUpperCase()}`,
      color: config.color,
      emoji: config.emoji,
      label: config.label,
    };
  }
  return map;
}

const PRIORITY_MAP = getPriorityMap();
const TICKET_DELETE_DELAY_MS = 3000;
const TICKET_DELETE_DELAY_SECONDS = Math.floor(TICKET_DELETE_DELAY_MS / 1000);
const TICKET_NUMBER_BASE = 100;
const TICKET_NUMBER_RANGE = 900;

export async function getUserTicketCount(guildId, userId) {
  try {
    return await getOpenTicketCountForUser(guildId, userId);
  } catch (error) {
    const typedError = ensureTypedServiceError(error, {
      service: 'ticketService',
      operation: 'getUserTicketCount',
      message: 'Ticket operation failed: getUserTicketCount',
      userMessage: 'Nem sikerült megszámolni a nyitott jegyeket.',
      context: { guildId, userId }
    });
    logger.error('Hiba a felhasználói jegyek számolásakor:', {
      guildId,
      userId,
      error: typedError.message,
      errorCode: typedError.context?.errorCode
    });
    return 0;
  }
}

export async function createTicket(guild, member, categoryId, reason = 'Nem lett megadva indok', priority = 'none') {
  try {
    const config = await getGuildConfig(guild.client, guild.id);
    const ticketConfig = config.tickets || {};
    
    const maxTicketsPerUser = config.maxTicketsPerUser || 3;
    const currentTicketCount = await getUserTicketCount(guild.id, member.id);
    
    if (currentTicketCount >= maxTicketsPerUser) {
      return {
        success: false,
        error: `Elérted a maximálisan nyitható jegyek számát (${maxTicketsPerUser}). Kérlek, zárd be a meglévő jegyeidet, mielőtt újat nyitnál.`
      };
    }
    
    let category = categoryId ? 
      guild.channels.cache.get(categoryId) :
      guild.channels.cache.find(c => 
        c.type === ChannelType.GuildCategory && 
        c.name.toLowerCase().includes('tickets')
      );
    
    if (!category && !categoryId) {
      category = await guild.channels.create({
        name: 'Jegyek',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
        ],
      });
    }
    
    const ticketNumber = await getNextTicketNumber(guild.id);
    
    let channelName = `jegy-${ticketNumber}`;
    
    if (priority !== 'none') {
      const priorityInfo = PRIORITY_MAP[priority];
      if (priorityInfo) {
        channelName = `${priorityInfo.emoji} ${channelName}`;
      }
    }
    
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        ...(ticketConfig.supportRoles?.map(roleId => ({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        })) || []),
      ],
    });
    
    const ticketData = {
      id: channel.id,
      userId: member.id,
      guildId: guild.id,
      createdAt: new Date().toISOString(),
      status: 'open',
      claimedBy: null,
      priority: priority || 'none',
      reason: reason,
    };
    
    await saveTicketData(guild.id, channel.id, ticketData);
    
    const priorityInfo = PRIORITY_MAP[priority] || PRIORITY_MAP.none;
    
    const embed = createEmbed({
      title: `Jegy #${ticketNumber}`,
      description: `${member.toString()}, köszönjük, hogy nyitottál egy jegyet!\n\n**Indok:** ${reason}\n**Prioritás:** ${priorityInfo.emoji} ${priorityInfo.label}`,
      color: priorityInfo.color,
      fields: [
        { name: 'Státusz', value: '🟢 Nyitva', inline: true },
        { name: 'Feldolgozza', value: 'Nincs kiosztva', inline: true },
        { name: 'Létrehozva', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
      ],
    });
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_close')
        .setLabel('Jegy Zárása')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒'),
      new ButtonBuilder()
        .setCustomId('ticket_claim')
        .setLabel('Feldolgozás')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🙋'),
      new ButtonBuilder()
        .setCustomId('ticket_transcript')
        .setLabel('Átirat')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📜')
    );
    
    if (ticketConfig.enablePriority) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_priority:low')
          .setLabel('Alacsony')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔵'),
        new ButtonBuilder()
          .setCustomId('ticket_priority:high')
          .setLabel('Magas')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔴')
      );
    }
    
    const messageContent = `${member.toString()}${ticketConfig.supportRoles?.length ? ' ' + ticketConfig.supportRoles.map(r => `<@&${r}>`).join(' ') : ''}`;
    
    await channel.send({ 
      content: messageContent,
      embeds: [embed],
      components: [row] 
    });
    
    await logTicketEvent({
      client: guild.client,
      guildId: guild.id,
      event: {
        type: 'open',
        ticketId: channel.id,
        ticketNumber: ticketNumber,
        userId: member.id,
        executorId: member.id,
        reason: reason,
        priority: priority || 'none',
        metadata: {
          channelId: channel.id,
          categoryName: category?.name || 'Default'
        }
      }
    });
    
    return { success: true, channel, ticketData };
    
  } catch (error) {
    const typedError = ensureTypedServiceError(error, {
      service: 'ticketService',
      operation: 'createTicket',
      message: 'Ticket operation failed: createTicket',
      userMessage: 'Nem sikerült létrehozni a jegyet. Kérlek, próbáld újra később.',
      context: { guildId: guild?.id, userId: member?.id }
    });
    logger.error('Hiba a jegy létrehozásakor:', {
      guildId: guild?.id,
      userId: member?.id,
      error: typedError.message,
      errorCode: typedError.context?.errorCode
    });
    return { 
      success: false, 
      error: typedError.userMessage || typedError.message,
      errorCode: typedError.context?.errorCode
    };
  }
}

export async function closeTicket(channel, closer, reason = 'Nem lett megadva indok') {
  try {
    const ticketData = await getTicketData(channel.guild.id, channel.id);
    if (!ticketData) {
      return { success: false, error: 'Ez nem egy jegy csatorna' };
    }
    
    const config = await getGuildConfig(channel.client, channel.guild.id);
    const dmOnClose = config.dmOnClose !== false;
    const closedCategoryId = config.ticketClosedCategoryId || null;
    let movedToClosedCategory = false;
    
    ticketData.status = 'closed';
    ticketData.closedBy = closer.id;
    ticketData.closedAt = new Date().toISOString();
    ticketData.closeReason = reason;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    if (closedCategoryId && channel.parentId !== closedCategoryId) {
      const closedCategory = channel.guild.channels.cache.get(closedCategoryId)
        || await channel.guild.channels.fetch(closedCategoryId).catch(() => null);

      if (closedCategory?.type === ChannelType.GuildCategory) {
        try {
          await channel.setParent(closedCategoryId, { lockPermissions: false });
          movedToClosedCategory = true;
        } catch (moveError) {
            logger.warn(`Nem sikerült áthelyezni a(z) ${channel.id} jegyet a(z) ${closedCategoryId} lezárt kategóriába: ${moveError.message}`);
        }
      } else {
        logger.warn(`A beállított lezárt kategória érvénytelen a(z) ${channel.guild.id} szerveren: ${closedCategoryId}`);
      }
    }
    
    if (dmOnClose) {
      try {
        const ticketCreator = await channel.client.users.fetch(ticketData.userId).catch(() => null);
        if (ticketCreator) {
          const dmEmbed = createEmbed({
            title: '🎫 A jegyed be lett zárva',
            description: `A(z) **${channel.name}** nevű jegyed be lett zárva.\n\n**Indok:** ${reason}\n**Bezárta:** ${closer.tag}\n**Ekkor:** <t:${Math.floor(Date.now() / 1000)}:F>\n\nKöszönjük, hogy igénybe vetted a támogatást! Ha további kérdésed van, nyugodtan nyiss egy új jegyet.`,
            color: '#e74c3c',
            footer: { text: `Jegy ID: ${ticketData.id}` }
          });
          
          await ticketCreator.send({ embeds: [dmEmbed] });
        }
      } catch (dmError) {
          logger.warn(`Nem sikerült privát üzenetet küldeni a jegy létrehozójának (${ticketData.userId}): ${dmError.message}`);
      }
    }
    
    try {
      const user = await channel.guild.members.fetch(ticketData.userId).catch(() => null);
      const targetUser = user?.user || await channel.client.users.fetch(ticketData.userId).catch(() => null);
      
      if (targetUser) {
        const overwrite = channel.permissionOverwrites.cache.get(ticketData.userId);
        if (overwrite) {
          await overwrite.edit({
            ViewChannel: false,
            SendMessages: false,
          });
        } else {
          await channel.permissionOverwrites.create(targetUser, {
            ViewChannel: false,
            SendMessages: false,
          });
        }
      }
    } catch (permError) {
        logger.warn(`Nem sikerült frissíteni a felhasználói jogokat a bezárt jegyhez: ${permError.message}`);
    }
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Jegy #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const statusField = embed.fields?.find(f => f.name === 'Státusz');
      
      if (statusField) {
        statusField.value = '🔴 Zárva';
      }
      
      const updatedEmbed = createEmbed({
        title: embed.title || 'Jegy',
        description: embed.description || 'Jegy megbeszélés',
        color: '#e74c3c',
        fields: embed.fields || [],
        footer: embed.footer
      });
      
      await ticketMessage.edit({ 
        embeds: [updatedEmbed],
        components: []
      });
    }
    
    const closeEmbed = createEmbed({
      title: 'Jegy Bezárva',
      description: `Ezt a jegyet bezárta: ${closer}.\n**Indok:** ${reason}${dmOnClose ? '\n\n📩 Egy privát üzenet (DM) el lett küldve a jegy létrehozójának.' : ''}`,
      color: '#e74c3c',
      footer: { text: `Jegy ID: ${ticketData.id}` }
    });
    
    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_reopen')
        .setLabel('Jegy Újranyitása')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔓'),
      new ButtonBuilder()
        .setCustomId('ticket_delete')
        .setLabel('Jegy Törlése')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️')
    );
    
    await channel.send({ embeds: [closeEmbed], components: [controlRow] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'close',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: closer.id,
        reason: reason,
        metadata: {
          dmSent: dmOnClose,
          closedAt: ticketData.closedAt,
          movedToClosedCategory
        }
      }
    });
    
    return { success: true, ticketData };
    
  } catch (error) {
    const typedError = ensureTypedServiceError(error, {
      service: 'ticketService',
      operation: 'closeTicket',
      message: 'Ticket operation failed: closeTicket',
      userMessage: 'Nem sikerült bezárni a jegyet. Kérlek, próbáld újra később.',
      context: { guildId: channel?.guild?.id, channelId: channel?.id, closerId: closer?.id }
    });
    logger.error('Hiba a jegy bezárásakor:', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      userId: closer?.id,
      error: typedError.message,
      errorCode: typedError.context?.errorCode
    });
    return { 
      success: false, 
      error: typedError.userMessage || typedError.message,
      errorCode: typedError.context?.errorCode
    };
  }
}

export async function claimTicket(channel, claimer) {
  try {
    const ticketData = await getTicketData(channel.guild.id, channel.id);
    if (!ticketData) {
      return { success: false, error: 'Ez nem egy jegy csatorna' };
    }
    
    if (ticketData.claimedBy) {
      return { 
        success: false, 
        error: `Ezt a jegyet már elvállalta: <@${ticketData.claimedBy}>` 
      };
    }
    
    ticketData.claimedBy = claimer.id;
    ticketData.claimedAt = new Date().toISOString();
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Jegy #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const claimedField = embed.fields?.find(f => f.name === 'Feldolgozza');
      
      if (claimedField) {
        claimedField.value = claimer.toString();
      }
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_close')
          .setLabel('Jegy Zárása')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔒'),
        new ButtonBuilder()
          .setCustomId('ticket_claim')
          .setLabel('Elvállalva')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🙋')
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('ticket_transcript')
          .setLabel('Átirat')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('📜')
      );
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const claimEmbed = createEmbed({
      title: 'Jegy Elvállalva',
      description: `🎉 ${claimer} elvállalta ezt a jegyet!`,
      color: '#2ecc71'
    });
    
    const unclaimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_unclaim')
        .setLabel('Elengedés')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔓')
    );

    const claimStatusMessage = messages.find(m =>
      m.embeds.length > 0 &&
      (m.embeds[0].title === 'Jegy Elvállalva' || m.embeds[0].title === 'Jegy Elengedve')
    );

    if (claimStatusMessage) {
      await claimStatusMessage.edit({ embeds: [claimEmbed], components: [unclaimRow] });
    } else {
      await channel.send({ embeds: [claimEmbed], components: [unclaimRow] });
    }
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'claim',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: claimer.id,
        metadata: {
          claimedAt: ticketData.claimedAt
        }
      }
    });
    
    return { success: true, ticketData };
    
  } catch (error) {
    const typedError = ensureTypedServiceError(error, {
      service: 'ticketService',
      operation: 'claimTicket',
      message: 'Ticket operation failed: claimTicket',
      userMessage: 'Nem sikerült elvállalni a jegyet. Kérlek, próbáld újra később.',
      context: { guildId: channel?.guild?.id, channelId: channel?.id, claimerId: claimer?.id }
    });
    logger.error('Hiba a jegy elvállalásakor:', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      userId: claimer?.id,
      error: typedError.message,
      errorCode: typedError.context?.errorCode
    });
    return { 
      success: false, 
      error: typedError.userMessage || typedError.message,
      errorCode: typedError.context?.errorCode
    };
  }
}

export async function reopenTicket(channel, reopener) {
  try {
    const ticketData = await getTicketData(channel.guild.id, channel.id);
    if (!ticketData) {
      return { success: false, error: 'Ez nem egy jegy csatorna' };
    }
    
    if (ticketData.status !== 'closed') {
      return { 
        success: false, 
        error: 'Ez a jegy jelenleg nincs bezárva' 
      };
    }

    const config = await getGuildConfig(channel.client, channel.guild.id);
    const openCategoryId = config.ticketCategoryId || null;
    let movedToOpenCategory = false;
    let openCategoryMoveFailed = false;
    
    ticketData.status = 'open';
    ticketData.closedBy = null;
    ticketData.closedAt = null;
    ticketData.closeReason = null;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    if (openCategoryId && channel.parentId !== openCategoryId) {
      const openCategory = channel.guild.channels.cache.get(openCategoryId)
        || await channel.guild.channels.fetch(openCategoryId).catch(() => null);

      if (openCategory?.type === ChannelType.GuildCategory) {
        try {
          await channel.setParent(openCategoryId, { lockPermissions: false });
          movedToOpenCategory = true;
        } catch (moveError) {
          openCategoryMoveFailed = true;
          logger.warn(`Nem sikerült áthelyezni az újranyitott ${channel.id} jegyet a(z) ${openCategoryId} nyitott kategóriába: ${moveError.message}`);
        }
      } else {
        openCategoryMoveFailed = true;
        logger.warn(`A beállított nyitott jegy kategória érvénytelen a(z) ${channel.guild.id} szerveren: ${openCategoryId}`);
      }
    }
    
    try {
      const user = await channel.guild.members.fetch(ticketData.userId).catch(() => null);
      if (user) {
        await channel.permissionOverwrites.create(user, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true
        });
      }
    } catch (error) {
      logger.warn(`Nem sikerült visszaállítani a hozzáférést a(z) ${ticketData.userId} felhasználónak:`, error.message);
    }
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Jegy #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const statusField = embed.fields?.find(f => f.name === 'Státusz');
      
      if (statusField) {
        statusField.value = '🟢 Nyitva';
      }
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_close')
          .setLabel('Jegy Zárása')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔒'),
        new ButtonBuilder()
          .setCustomId('ticket_claim')
          .setLabel(ticketData.claimedBy ? 'Elvállalva' : 'Feldolgozás')
          .setStyle(ticketData.claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setEmoji('🙋')
          .setDisabled(!!ticketData.claimedBy),
        new ButtonBuilder()
          .setCustomId('ticket_transcript')
          .setLabel('Átirat')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('📜')
      );
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const reopenEmbed = createEmbed({
      title: 'Jegy Újranyitva',
      description: `🔓 ${reopener} újranyitotta ezt a jegyet!`,
      color: '#2ecc71'
    });

    const closeStatusMessage = messages.find(m =>
      m.embeds.length > 0 &&
      m.embeds[0].title === 'Jegy Bezárva' &&
      m.components.length > 0 &&
      m.components[0].components.some(c => c.customId === 'ticket_reopen')
    );

    if (closeStatusMessage) {
      await closeStatusMessage.edit({ embeds: [reopenEmbed], components: [] });
    } else {
      await channel.send({ embeds: [reopenEmbed] });
    }
    
    return {
      success: true,
      ticketData,
      movedToOpenCategory,
      openCategoryMoveFailed
    };
    
  } catch (error) {
    const typedError = ensureTypedServiceError(error, {
      service: 'ticketService',
      operation: 'reopenTicket',
      message: 'Ticket operation failed: reopenTicket',
      userMessage: 'Nem sikerült újranyitni a jegyet. Kérlek, próbáld újra később.',
      context: { guildId: channel?.guild?.id, channelId: channel?.id, reopenerId: reopener?.id }
    });
    logger.error('Hiba a jegy újranyitásakor:', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      userId: reopener?.id,
      error: typedError.message,
      errorCode: typedError.context?.errorCode
    });
    return { 
      success: false, 
      error: typedError.userMessage || typedError.message,
      errorCode: typedError.context?.errorCode
    };
  }
}

export async function deleteTicket(channel, deleter) {
  try {
    const ticketData = await getTicketData(channel.guild.id, channel.id);
    if (!ticketData) {
      return { success: false, error: 'Ez nem egy jegy csatorna' };
    }
    
    const deleteEmbed = createEmbed({
      title: 'Jegy Törlése',
      description: `🗑️ Ez a jegy véglegesen törlésre kerül ${TICKET_DELETE_DELAY_SECONDS} másodpercen belül.`,
      color: '#e74c3c',
      footer: { text: `Jegy ID: ${ticketData.id}` }
    });
    
    await channel.send({ embeds: [deleteEmbed] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'delete',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: deleter.id,
        metadata: {
          deletedAt: new Date().toISOString()
        }
      }
    });
    
    setTimeout(async () => {
      try {
        await channel.delete('Jegy véglegesen törölve');
        logger.info(`Törölt jegy csatorna: ${channel.name} (${channel.id})`);
      } catch (deleteError) {
        logger.error(`Nem sikerült törölni a(z) ${channel.id} jegy csatornát:`, deleteError);
      }
    }, TICKET_DELETE_DELAY_MS);
    
    return { success: true, ticketData };
    
  } catch (error) {
    const typedError = ensureTypedServiceError(error, {
      service: 'ticketService',
      operation: 'deleteTicket',
      message: 'Ticket operation failed: deleteTicket',
      userMessage: 'Nem sikerült törölni a jegyet. Kérlek, próbáld újra később.',
      context: { guildId: channel?.guild?.id, channelId: channel?.id, deleterId: deleter?.id }
    });
    logger.error('Hiba a jegy törlésekor:', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      userId: deleter?.id,
      error: typedError.message,
      errorCode: typedError.context?.errorCode
    });
    return { 
      success: false, 
      error: typedError.userMessage || typedError.message,
      errorCode: typedError.context?.errorCode
    };
  }
}

export async function unclaimTicket(channel, unclaimer) {
  try {
    const ticketData = await getTicketData(channel.guild.id, channel.id);
    if (!ticketData) {
      return { success: false, error: 'Ez nem egy jegy csatorna' };
    }
    
    if (!ticketData.claimedBy) {
      return { 
        success: false, 
        error: 'Ez a jegy jelenleg nincs elvállalva' 
      };
    }
    
    if (ticketData.claimedBy !== unclaimer.id && !unclaimer.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return { 
        success: false, 
        error: 'Csak a saját jegyedet engedheted el, vagy "Csatornák kezelése" jog szükséges hozzá.' 
      };
    }
    
    const previousClaimer = ticketData.claimedBy;
    ticketData.claimedBy = null;
    ticketData.claimedAt = null;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Jegy #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const claimedField = embed.fields?.find(f => f.name === 'Feldolgozza');
      
      if (claimedField) {
        claimedField.value = 'Nincs kiosztva';
      }
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_close')
          .setLabel('Jegy Zárása')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔒'),
        new ButtonBuilder()
          .setCustomId('ticket_claim')
          .setLabel('Feldolgozás')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🙋'),
        new ButtonBuilder()
          .setCustomId('ticket_transcript')
          .setLabel('Átirat')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('📜')
      );
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const claimMessage = messages.find(m => 
      m.embeds.length > 0 && 
      (m.embeds[0].title === 'Jegy Elvállalva' || m.embeds[0].title === 'Jegy Elengedve')
    );
    
    if (claimMessage) {
      const unclaimEmbed = createEmbed({
        title: 'Jegy Elengedve',
        description: `🔓 ${unclaimer} elengedte ezt a jegyet!`,
        color: '#f39c12'
      });
      
      await claimMessage.edit({ 
        embeds: [unclaimEmbed],
        components: []
      });
    } else {
      const unclaimEmbed = createEmbed({
        title: 'Jegy Elengedve',
        description: `🔓 ${unclaimer} elengedte ezt a jegyet!`,
        color: '#f39c12'
      });
      
      await channel.send({ embeds: [unclaimEmbed] });
    }
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'unclaim',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: unclaimer.id,
        metadata: {
          previousClaimer: previousClaimer
        }
      }
    });
    
    return { success: true, ticketData };
    
  } catch (error) {
    const typedError = ensureTypedServiceError(error, {
      service: 'ticketService',
      operation: 'unclaimTicket',
      message: 'Ticket operation failed: unclaimTicket',
      userMessage: 'Nem sikerült elengedni a jegyet. Kérlek, próbáld újra később.',
      context: { guildId: channel?.guild?.id, channelId: channel?.id, unclaimerId: unclaimer?.id }
    });
    logger.error('Hiba a jegy elengedésekor:', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      userId: unclaimer?.id,
      error: typedError.message,
      errorCode: typedError.context?.errorCode
    });
    return { 
      success: false, 
      error: typedError.userMessage || typedError.message,
      errorCode: typedError.context?.errorCode
    };
  }
}

async function getNextTicketNumber(guildId) {
  const randomTicket = Math.floor(Math.random() * TICKET_NUMBER_RANGE) + TICKET_NUMBER_BASE;
  return randomTicket.toString();
}

export async function updateTicketPriority(channel, priority, updater) {
  try {
    const ticketData = await getTicketData(channel.guild.id, channel.id);
    if (!ticketData) {
      return { success: false, error: 'Ez nem egy jegy csatorna' };
    }
    
    const priorityInfo = PRIORITY_MAP[priority];
    if (!priorityInfo) {
      return { success: false, error: 'Érvénytelen prioritási szint' };
    }
    
    ticketData.priority = priority;
    ticketData.priorityUpdatedBy = updater.id;
    ticketData.priorityUpdatedAt = new Date().toISOString();
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const currentName = channel.name;
    const priorityEmojis = [...new Set(Object.values(PRIORITY_MAP).map((item) => item.emoji).filter(Boolean))];
    const escapedPriorityEmojis = priorityEmojis.map((emoji) => emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const cleanName = escapedPriorityEmojis.length > 0
      ? currentName.replace(new RegExp(`(?:${escapedPriorityEmojis.join('|')})`, 'g'), '').trim()
      : currentName.trim();
    const newName = priority === 'none' ? cleanName : `${priorityInfo.emoji} ${cleanName}`;

    if (newName && newName !== currentName) {
      try {
        await channel.setName(newName);
      } catch (nameError) {
        logger.warn(`Nem sikerült frissíteni a csatorna nevét a prioritáshoz: ${nameError.message}`);
      }
    }
    
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m => 
      m.embeds.length > 0 && 
      m.embeds[0].title?.startsWith('Jegy #')
    );
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      
      const updatedEmbed = createEmbed({
        title: embed.title || 'Jegy',
        description: embed.description?.split('\n**Prioritás:**')[0] + `\n**Prioritás:** ${priorityInfo.emoji} ${priorityInfo.label}`,
        color: priorityInfo.color,
        fields: embed.fields || [],
        footer: embed.footer
      });
      
      await ticketMessage.edit({ embeds: [updatedEmbed] });
    }
    
    const updateEmbed = createEmbed({
      title: 'Prioritás Frissítve',
      description: `📊 A jegy prioritását frissítette **${priorityInfo.emoji} ${priorityInfo.label}** szintre ${updater}`,
      color: priorityInfo.color
    });
    
    await channel.send({ embeds: [updateEmbed] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'priority',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: updater.id,
        priority: priority,
        metadata: {
          previousPriority: ticketData.priority,
          updatedAt: ticketData.priorityUpdatedAt
        }
      }
    });
    
    return { success: true, ticketData };
    
  } catch (error) {
    const typedError = ensureTypedServiceError(error, {
      service: 'ticketService',
      operation: 'updateTicketPriority',
      message: 'Ticket operation failed: updateTicketPriority',
      userMessage: 'Nem sikerült frissíteni a jegy prioritását. Kérlek, próbáld újra később.',
      context: { guildId: channel?.guild?.id, channelId: channel?.id, updaterId: updater?.id, priority }
    });
    logger.error('Hiba a jegy prioritásának frissítésekor:', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      userId: updater?.id,
      error: typedError.message,
      errorCode: typedError.context?.errorCode
    });
    return { 
      success: false, 
      error: typedError.userMessage || typedError.message,
      errorCode: typedError.context?.errorCode
    };
  }
}
