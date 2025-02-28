import { SlashCommandMessage } from "@fire/lib/extensions/slashCommandMessage";
import { CommandInteraction, Interaction } from "discord.js";
import { FireGuild } from "@fire/lib/extensions/guild";
import { constants } from "@fire/lib/util/constants";
import { FireUser } from "@fire/lib/extensions/user";
import { Listener } from "@fire/lib/util/listener";
import { Scope } from "@sentry/node";

const { emojis } = constants;

export default class InteractionListener extends Listener {
  constructor() {
    super("interaction", {
      emitter: "client",
      event: "interaction",
    });
  }

  async exec(interaction: Interaction) {
    if (this.blacklistCheck(interaction)) return;
    if (!interaction.isCommand()) return;
    else await this.handleApplicationCommand(interaction);
  }

  async handleApplicationCommand(command: CommandInteraction) {
    try {
      // should be cached if in guild or fetch if dm channel
      await this.client.channels.fetch(command.channelID).catch(() => {});
      const message = new SlashCommandMessage(this.client, command);
      await message.channel.ack((message.flags & 64) != 0);
      if (!message.command) {
        this.client.console.warn(
          `[Commands] Got slash command request for unknown command, /${command.commandName}`
        );
        return await message.error("UNKNOWN_COMMAND");
      } else if (!message.guild && message.command.channel == "guild")
        return await message.error(
          "SLASH_COMMAND_BOT_REQUIRED",
          this.client.config.inviteLink
        );
      await message.generateContent();
      // @ts-ignore
      await this.client.commandHandler.handle(message);
      // if (message.sent != "message")
      //   await message.sourceMessage?.delete().catch(() => {});
    } catch (error) {
      const guild = this.client.guilds.cache.get(command.guildID);
      if (!guild)
        await this.error(command, error).catch(() => {
          command.reply(`${emojis.error} Something went wrong...`);
        });
      if (typeof this.client.sentry != "undefined") {
        const sentry = this.client.sentry;
        sentry.setExtras({
          slashCommand: JSON.stringify(command),
          member: command.member
            ? `${command.member.user.username}#${command.member.user.discriminator}`
            : `${command.user.username}#${command.user.discriminator}`,
          channel_id: command.channelID,
          guild_id: command.guildID,
          env: process.env.NODE_ENV,
        });
        sentry.captureException(error);
        sentry.configureScope((scope: Scope) => {
          scope.setUser(null);
          scope.setExtras(null);
        });
      }
    }
  }

  async error(interaction: CommandInteraction, error: Error) {
    return interaction.reply(
      `${emojis.error} An error occured while trying to handle this interaction that may be caused by being in DMs or the bot not being present...

    If this is a slash command, try inviting the bot to a server (<${this.client.config.inviteLink}>) if you haven't already and try again.
    
    Error Message: ${error.message}`,
      { ephemeral: true }
    );
  }

  blacklistCheck(interaction: Interaction) {
    const guild = interaction.guild as FireGuild;
    const user = interaction.user as FireUser;

    return this.client.util.isBlacklisted(
      user,
      guild,
      interaction.isCommand() ? interaction.commandName : null
    );
  }
}
