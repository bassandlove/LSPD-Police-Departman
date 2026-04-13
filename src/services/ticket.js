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
    none: { emoji: "⚪", color: "#95A5A6", label: "None" },
    low: { emoji: "🟢", color: "#2ECC71", label: "Low" },
    medium: { emoji: "🟡", color: "#F1C40F", label: "Medium" },
    high: { emoji: "🔴", color: "#E74C3C", label: "High" },
    urgent: { emoji: "🚨", color: "#E91E63", label: "Urgent" },
  };
  
  const map = {};
  for (const [key, config] of Object.entries(priorities)) {
    map[key] = {
      name: `${config.emoji} ${config.label.toUpperCase()}`,
      color: config.color,
      emoji: config.emoji,
      label: config.label
    };
  }
  return map;
}

/**
 * Creates a new ticket channel for a user
 */
export async function createTicket(guild, member, categoryId, reason) {
  try {
    const config = await getGuildConfig(guild.client, guild.id);
    
    // Create channel
    const channelName = `ticket-${member.user.username}`;
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
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
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ],
        },
      ],
    });

    // --- MAGYARÍTOTT ÜDVÖZLŐ ÜZENET ---
    const welcomeEmbed = createEmbed({
      title: 'Jegy létrehozva',
      description: `Üdvözlünk a jegyednél, ${member}! Kérjük, várd meg, amíg a stáb válaszol.`,
      color: BotConfig.getColor?.('main') || 0x3498db,
      fields: [
        { name: 'Indok', value: reason || 'Nincs megadva', inline: false },
        { name: 'Állapot', value: 'Nyitva', inline: true }
      ],
      timestamp: true
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_close')
        .setLabel('Bezárás')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒'),
      new ButtonBuilder()
        .setCustomId('ticket_claim')
        .setLabel('Átveszem')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🙋‍♂️')
    );
    // ----------------------------------

    await channel.send({ content: `${member}`, embeds: [welcomeEmbed], components: [row] });

    // Save ticket data to database
    const ticketData = {
      id: channel.id,
      guildId: guild.id,
      userId: member.id,
      reason: reason,
      status: 'open',
      createdAt: new Date().toISOString()
    };
    
    await saveTicketData(ticketData);

    return { success: true, channel };
  } catch (error) {
    logger.error('Error in createTicket service:', error);
    return { success: false, error: 'Failed to create ticket channel.' };
  }
}

/**
 * Closes a ticket channel
 */
export async function closeTicket(channel, user, reason) {
  try {
    const ticketData = await getTicketData(channel.id);
    if (!ticketData) {
      return { success: false, error: 'Ticket data not found.' };
    }

    const closeEmbed = createEmbed({
      title: 'Jegy lezárva',
      description: `Ezt a jegyet lezárta: ${user}`,
      fields: [{ name: 'Indok', value: reason || 'Nincs megadva' }],
      color: 0xe74c3c
    });

    await channel.send({ embeds: [closeEmbed] });
    
    ticketData.status = 'closed';
    ticketData.closedAt = new Date().toISOString();
    ticketData.closedBy = user.id;
    ticketData.closeReason = reason;
    await saveTicketData(ticketData);

    return { success: true };
  } catch (error) {
    logger.error('Error closing ticket service:', error);
    return { success: false, error: 'Failed to close ticket.' };
  }
}

/**
 * Claims a ticket
 */
export async function claimTicket(channel, user) {
  try {
    const ticketData = await getTicketData(channel.id);
    if (!ticketData) return { success: false, error: 'Ticket not found.' };

    const claimEmbed = createEmbed({
      description: `Ezt a jegyet átvette: ${user}`,
      color: 0x2ecc71
    });

    await channel.send({ embeds: [claimEmbed] });
    
    ticketData.claimedBy = user.id;
    await saveTicketData(ticketData);

    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to claim ticket.' };
  }
}

/**
 * Updates ticket priority
 */
export async function updateTicketPriority(channel, priority, updater) {
  try {
    const ticketData = await getTicketData(channel.id);
    if (!ticketData) return { success: false, error: 'Ticket not found.' };

    const priorityMap = getPriorityMap();
    const priorityInfo = priorityMap[priority.toLowerCase()];

    ticketData.priority = priority.toLowerCase();
    ticketData.priorityUpdatedAt = new Date().toISOString();
    await saveTicketData(ticketData);

    const updateEmbed = createEmbed({
      title: 'Prioritás módosítva',
      description: `A jegy prioritása módosítva lett: **${priorityInfo.emoji} ${priorityInfo.label}**\nMódosította: ${updater}`,
      color: priorityInfo.color
    });
    
    await channel.send({ embeds: [updateEmbed] });
    return { success: true, ticketData };
  } catch (error) {
    logger.error('Error updating ticket priority:', error);
    return { success: false, error: 'Failed to update priority.' };
  }
}

/**
 * Gets the number of open tickets for a user
 */
export async function getUserTicketCount(guildId, userId) {
  return await getOpenTicketCountForUser(guildId, userId);
}

/**
 * Deletes a ticket channel
 */
export async function deleteTicket(channel, member) {
  try {
    // Csatorna törlése 3 másodperc után
    setTimeout(async () => {
      try {
        await channel.delete();
        await deleteTicketData(channel.id);
      } catch (e) {
        logger.error('Error deleting channel:', e);
      }
    }, 3000);

    return { success: true };
  } catch (error) {
    logger.error('Error in deleteTicket service:', error);
    return { success: false, error: 'Failed to delete ticket.' };
  }
}
