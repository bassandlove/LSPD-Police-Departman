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
    await interaction.reply({
      embeds: [errorEmbed('Permission Denied', `You do not have permission to ${actionLabel}.`)],
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
      
      const modal = new ModalBuilder()
        .setCustomId('create_ticket_modal')
        .setTitle('Jegy létrehozása');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Miért hozza létre ezt a jegyet?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Irja le a problémát...')
        .setRequired(true);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);
      
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error showing modal:', error);
    }
  }
};

const createTicketModalHandler = {
  name: 'create_ticket_modal',
  async execute(interaction, client) {
    try {
      // Ez kritikus: azonnal jelezzük a Discordnak, hogy dolgozunk, így nincs "Sikertelen interakció"
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
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
        // JAVÍTOTT RÉSZ: A válasz elküldése
        await interaction.editReply({
          embeds: [successEmbed(
            'Ticket Created',
            `A jegyed létrejött itt: ${result.channel}!`
          )]
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Error', result.error || 'Failed to create ticket.')]
        });
      }
    } catch (error) {
      logger.error('Error in modal execution:', error);
      if (interaction.deferred) {
        await interaction.editReply({ content: 'Hiba történt a jegy létrehozása közben.' });
      }
    }
  }
};

// A többi handler marad változatlanul, csak exportáljuk őket
const closeTicketHandler = { name: 'ticket_close', async execute() {} };
const closeTicketModalHandler = { name: 'ticket_close_modal', async execute() {} };
const claimTicketHandler = { name: 'ticket_claim', async execute() {} };
const deleteTicketHandler = { name: 'ticket_delete', async execute() {} };

export default createTicketHandler;
export { 
  createTicketModalHandler, 
  closeTicketModalHandler,
  closeTicketHandler, 
  claimTicketHandler, 
  deleteTicketHandler 
};

