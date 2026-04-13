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
      embeds: [errorEmbed('Csak szerveren', 'Ez a művelet csak szerveren belül használható.')],
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
      embeds: [errorEmbed('Nem ticket csatorna', 'Ez a művelet csak érvényes ticket csatornában használható.')],
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    const permissionMessage = allowTicketCreator
      ? 'Rendelkezned kell a **Csatornák kezelése** jogosultsággal, a beállított **Staff ranggal**, vagy te kell légy a **ticket nyitója**.'
      : 'Rendelkezned kell a **Csatornák kezelése** jogosultsággal vagy a beállított **Staff ranggal**.';

    await interaction.reply({
      embeds: [errorEmbed('Hozzáférés megtagadva', `${permissionMessage}\n\nNem tudod a következőt elvégezni: ${actionLabel}.`)],
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
          embeds: [errorEmbed('Lassítás', 'Túl gyorsan hozol létre ticketeket. Kérlek várj egy percet és próbáld újra.')],
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
              '🎫 Ticket limit elérve',
              `Elérted a maximális nyitott ticketek számát (${maxTicketsPerUser}).\n\nKérlek zárd le a meglévő jegyeidet, mielőtt újat nyitnál.\n\n**Jelenlegi jegyek:** ${currentTicketCount}/${maxTicketsPerUser}`
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
        .setPlaceholder('Írja le a problémát...')
        .setRequired(true)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);
      
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error creating ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Hiba', 'Nem sikerült megnyitni a jegy létrehozása ablakot.')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.followUp({
          embeds: [errorEmbed('Hiba', 'Nem sikerült megnyitni a jegy létrehozása ablakot.')],
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
        await interaction.editReply({
          embeds: [successEmbed(
            'Jegy létrehozva',
            `A jegyed sikeresen létrejött itt: ${result.channel}!`
          )]
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Hiba', result.error || 'Nem sikerült létrehozni a jegyet.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error creating ticket:', error);
      await interaction.editReply({
        embeds: [errorEmbed('Hiba', 'Váratlan hiba történt a jegy létrehozása közben.')],
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

      if (!(await ensureTicketPermission(interaction, client, 'jegy lezárása', { allowTicketCreator: true }))) return;

      const modal = new ModalBuilder()
        .setCustomId('ticket_close_modal')
        .setTitle('Jegy lezárása');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Lezárás indoka (opcionális)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Írd le, miért zárod le ezt a jegyet...')
        .setRequired(false)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error closing ticket:', error);

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Hiba', 'Nem sikerült megnyitni a lezáró ablakot.')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.followUp({
          embeds: [errorEmbed('Hiba', 'Nem sikerült megnyitni a lezáró ablakot.')],
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
};

const closeTicketModalHandler = {
  name: 'ticket_close_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      if (!(await ensureTicketPermission(interaction, client, 'jegy lezárása', { allowTicketCreator: true }))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();
      const reason = providedReason || 'Lezárva a lezárás gombbal, külön indoklás nélkül.';

      const result = await closeTicket(interaction.channel, interaction.user, reason);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Jegy lezárva', 'Ez a jegy sikeresen lezárásra került.')],
          flags: MessageFlags.Ephemeral
        });

        await logEvent({
          client,
          guildId: interaction.guildId,
          event: {
            action: 'Ticket Lezárva',
            target: interaction.channel.toString(),
            executor: interaction.user.toString(),
            reason
          }
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Hiba', result.error || 'Nem sikerült lezárni a jegyet.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error submitting close ticket modal:', error);
      await interaction.editReply({
        embeds: [errorEmbed('Hiba', 'Hiba történt a jegy lezárása közben.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};

const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      if (!(await ensureTicketPermission(interaction, client, 'jegy átvétele'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const result = await claimTicket(interaction.channel, interaction.user);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Jegy átvéve', 'Sikeresen magadhoz rendelted ezt a jegyet!')],
          flags: MessageFlags.Ephemeral
        });
        
        await logEvent({
          client,
          guildId: interaction.guildId,
          event: {
            action: 'Ticket Átvéve',
            target: interaction.channel.toString(),
            executor: interaction.user.toString()
          }
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Hiba', result.error || 'Nem sikerült átvenni a jegyet.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error claiming ticket:', error);
      await interaction.editReply({
        embeds: [errorEmbed('Hiba', 'Hiba történt a jegy átvétele közben.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};

const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      if (!(await ensureTicketPermission(interaction, client, 'prioritás módosítása'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const priority = args?.[0];
      if (!priority) {
        await interaction.editReply({
          embeds: [errorEmbed('Érvénytelen prioritás', 'Prioritás megadása kötelező.')],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const result = await updateTicketPriority(interaction.channel, priority, interaction.user);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Prioritás frissítve', `A jegy prioritása mostantól: ${priority}.`)],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Hiba', result.error || 'Nem sikerült frissíteni a prioritást.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error updating ticket priority:', error);
      await interaction.editReply({
        embeds: [errorEmbed('Hiba', 'Hiba történt a prioritás frissítése közben.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};

const transcriptTicketHandler = {
  name: 'ticket_transcript',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      if (!(await ensureTicketPermission(interaction, client, 'mentés készítése'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      
      if (!messages || messages.size === 0) {
        await interaction.editReply({
          embeds: [errorEmbed('Nincsenek üzenetek', 'Nem találhatók üzenetek ebben a csatornában.')],
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      
      const messagesArray = Array.from(messages.values());
      const userMessages = messagesArray.filter(m => m.author && m.author.tag && m.type === 0);
      const sortedMessages = userMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      
      if (!sortedMessages || sortedMessages.length === 0) {
        await interaction.editReply({
          embeds: [errorEmbed('Nincsenek felhasználói üzenetek', 'Nem találhatók menthető üzenetek.')],
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      
      let htmlTranscript = `<!DOCTYPE html><html><head><title>Ticket Mentés - ${interaction.channel.name}</title></head><body><h1>🎫 Ticket Mentés</h1><p>Csatorna: ${interaction.channel.name}</p></body></html>`;
      
      const transcriptEmbed = createEmbed({
        title: `📜 Ticket Mentés - ${interaction.channel.name}`,
        description: `**Csatorna:** ${interaction.channel.name}\n**Készült:** <t:${Math.floor(Date.now() / 1000)}:F>\n**Üzenetek száma:** ${sortedMessages.length}\n\nA teljes mentést fájlként csatoltuk.`,
        color: 0x3498db
      });
      
      const { Buffer } = await import('buffer');
      const buffer = Buffer.from(htmlTranscript, 'utf-8');
      
      try {
        await interaction.user.send({
          content: `📜 **Ticket Mentés** a következőhöz: \`${interaction.channel.name}\``,
          embeds: [transcriptEmbed],
          files: [{ attachment: buffer, name: `ticket-mentes-${interaction.channel.name}.html` }]
        });
        
        await interaction.editReply({
          embeds: [{
            title: '✅ Mentés elküldve',
            description: 'A mentést elküldtük privát üzenetben.',
            color: 4689679
          }],
          flags: MessageFlags.Ephemeral
        });
      } catch (dmError) {
        await interaction.editReply({
          embeds: [errorEmbed('Sikertelen DM', 'Nem tudtam elküldeni a mentést. Kérlek engedélyezd a privát üzeneteket.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error creating transcript:', error);
      await interaction.editReply({
        embeds: [errorEmbed('Hiba', 'Nem sikerült elkészíteni a mentést.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'jegy leadása'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { unclaimTicket } = await import('../services/ticket.js');
      const result = await unclaimTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Jegy leadva', 'Sikeresen leadtad ezt a jegyet.')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Hiba', result.error || 'Nem sikerült leadni a jegyet.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error unclaiming ticket:', error);
      await interaction.editReply({ embeds: [errorEmbed('Hiba', 'Hiba történt.')], flags: MessageFlags.Ephemeral });
    }
  }
};

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'jegy újranyitása'))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { reopenTicket } = await import('../services/ticket.js');
      const result = await reopenTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Jegy újranyitva', 'Sikeresen újranyitottad ezt a jegyet!')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('Hiba', result.error || 'Nem sikerült újranyitni a jegyet.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error reopening ticket:', error);
      await interaction.editReply({ embeds: [errorEmbed('Hiba', 'Hiba történt.')], flags: MessageFlags.Ephemeral });
    }
  }
};

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;
      if (!(await ensureTicketPermission(interaction, client, 'jegy törlése'))) return;

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
          embeds: [errorEmbed('Hiba', result.error || 'Nem sikerült törölni a jegyet.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      logger.error('Error deleting ticket:', error);
      await interaction.editReply({ embeds: [errorEmbed('Hiba', 'Hiba történt.')], flags: MessageFlags.Ephemeral });
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



