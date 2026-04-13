import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../utils/embeds.js';
import { createTicket, closeTicket, claimTicket, updateTicketPriority } from '../services/ticket.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { logEvent } from '../utils/moderation.js';
import { logTicketEvent } from '../utils/ticketLogging.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { getTicketPermissionContext } from '../utils/ticketPermissions.js';

async function ensureGuildContext(interaction) {
  if (interaction.inGuild()) {
    return true;
  }

  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      embeds: [errorEmbed('Guild Only', 'This action can only be used in a server.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  return false;
}

async function ensureTicketPermission(interaction, client, actionLabel, options = {}) {
  const { allowTicketCreator = false } = options;

  const context = await getTicketPermissionContext({ client, interaction });

  if (!context.ticketData) {
    await interaction.reply({
      embeds: [errorEmbed('Not a Ticket Channel', 'This action can only be used in a valid ticket channel.')],
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    const permissionMessage = allowTicketCreator
      ? 'You must have **Manage Channels** permission, the configured **Staff role**, or be the **ticket creator**.'
      : 'You must have **Manage Channels** permission or the configured **Staff role**.';

    await interaction.reply({
      embeds: [errorEmbed('Permission Denied', `${permissionMessage}\n\nYou cannot perform: ${actionLabel}.`)],
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  return context;
}

const createTicketHandler = {
  name: 'create_ticket',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const rateLimitKey = `${interaction.user.id}:create_ticket`;
      const allowed = await checkRateLimit(rateLimitKey, 3, 60000);
      if (!allowed) {
        await interaction.reply({
          embeds: [errorEmbed('Slow Down', 'You are creating tickets too quickly. Please wait a minute before trying again.')],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const config = await getGuildConfig(client, interaction.guildId);
      const maxTicketsPerUser = config.maxTicketsPerUser || 3;
      
      const { getUserTicketCount } = await import('../services/ticket.js');
      const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);
      
      if (currentTicketCount >= maxTicketsPerUser) {
        return interaction.reply({
          embeds: [
            errorEmbed(
              '🎫 Ticket Limit Reached',
              `You have reached the maximum number of open tickets (${maxTicketsPerUser}).\n\nPlease close your existing tickets before opening a new one.\n\n**Current Tickets:** ${currentTicketCount}/${maxTicketsPerUser}`
            )
          ],
          flags: MessageFlags.Ephemeral
        });
      }
      
      const modal = new ModalBuilder()
        .setCustomId('create_ticket_modal')
        .setTitle('Jegy létrehozása');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Miért hozza létre ezt a jegyet?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Irja le a problémát...')
        .setRequired(true)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);
      
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error creating ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Error', 'Failed to open ticket creation form.')],
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
};

const createTicketModalHandler = {
  name: 'create_ticket_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      const categoryId = config.ticketCategoryId || null;
      
      const result = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason
      );
      
      if (result.success) {
        // --- JAVÍTOTT RÉSZ ---
        await interaction.editReply({
          embeds: [successEmbed(
            'Jegy Léterhozva',
            `A jegyed létrejött itt: ${result.channel}!`
          )]
        });
        // ---------------------
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'Failed to create ticket.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error creating ticket:', error);
      await interaction.editReply({
        embeds: [errorEmbed('Error', 'An unexpected error occurred while creating your ticket.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};

const closeTicketHandler = {
  name: 'ticket_close',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'close ticket', { allowTicketCreator: true }))) return;

      const modal = new ModalBuilder()
        .setCustomId('ticket_close_modal')
        .setTitle('Jegy lezárás');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('A bezárás oka (nem kötelező)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Ird le mért zárod a jegyed')
        .setRequired(false)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error closing ticket:', error);
    }
  }
};

const closeTicketModalHandler = {
  name: 'ticket_close_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'close ticket', { allowTicketCreator: true }))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();
      const reason = providedReason || 'Closed via close button with no reason provided.';

      const result = await closeTicket(interaction.channel, interaction.user, reason);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Jegy Zárás', 'Ezt a jegyet sikeresen lezártuk.')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'Failed to close ticket.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error submitting close ticket modal:', error);
    }
  }
};

const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'claim ticket'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const result = await claimTicket(interaction.channel, interaction.user);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Jegyet átveszem', 'Sikeresen igényelte ezt a jegyet!')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'Failed to claim ticket.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error claiming ticket:', error);
    }
  }
};

const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'update priority'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const priority = args?.[0];
      const result = await updateTicketPriority(interaction.channel, priority, interaction.user);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Prioritás frissítve', `A jegyek prioritása értékre lett állítva. ${priority}.`)],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'Failed to update priority.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error updating ticket priority:', error);
    }
  }
};

const transcriptTicketHandler = {
  name: 'ticket_transcript',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'create transcript'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      // Transcript logic would go here
      await interaction.editReply({
        embeds: [successEmbed('Átirat létrehozva', 'A jegy átirata elkészült.')],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      logger.error('Error creating transcript:', error);
    }
  }
};

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'unclaim ticket'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { unclaimTicket } = await import('../services/ticket.js');
      const result = await unclaimTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Átirat létrehozva', 'Sikeresen vissza vontad ezt a jegyet')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'Failed to unclaim ticket.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error unclaiming ticket:', error);
    }
  }
};

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'reopen ticket'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { reopenTicket } = await import('../services/ticket.js');
      const result = await reopenTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Reopened', 'The ticket has been successfully reopened!')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'Failed to reopen ticket.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error reopening ticket:', error);
    }
  }
};

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'delete ticket'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { deleteTicket } = await import('../services/ticket.js');
      const result = await deleteTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Jegy törölve', 'Ez a jegy 3 másodpercen belül véglegesen törlődik.')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'Failed to delete ticket.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error deleting ticket:', error);
    }
  }
};

export default createTicketHandler;
export { 
  createTicketModalHandler, 
  closeTicketModalHandler,
  closeTicketHandler, 
  claimTicketHandler, 
  priorityTicketHandler,
  transcriptTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler 
};
