import {
  BitFieldResolvable,
  PermissionString,
  GuildChannel,
  Permissions,
} from "discord.js";
import { SlashCommandMessage } from "@fire/lib/extensions/slashCommandMessage";
import { ButtonMessage } from "@fire/lib/extensions/buttonMessage";
import { FireMessage } from "@fire/lib/extensions/message";
import VanityURLs from "@fire/src/modules/vanityurls";
import { titleCase } from "@fire/lib/util/constants";
import { Language } from "@fire/lib/util/language";
import { Command } from "@fire/lib/util/command";
import {
  APIComponent,
  ButtonStyle,
  ButtonType,
} from "@fire/lib/interfaces/interactions";

const userMentionRegex = /<@!?(\d{15,21})>$/im;

export default class Help extends Command {
  constructor() {
    super("help", {
      description: (language: Language) =>
        language.get("HELP_COMMAND_DESCRIPTION"),
      clientPermissions: [
        Permissions.FLAGS.SEND_MESSAGES,
        Permissions.FLAGS.EMBED_LINKS,
      ],
      aliases: ["helpme", "commands", "h"],
      args: [
        {
          id: "command",
          type: "command",
          default: undefined,
          required: false,
        },
      ],
      enableSlashCommand: true,
      restrictTo: "all",
      ephemeral: true,
    });
  }

  async exec(message: FireMessage, args: { command: Command }) {
    if (typeof args.command == "undefined") return await this.sendHelp(message);
    else if (!args.command) return await message.error("HELP_NO_COMMAND");
    else return await this.sendUsage(message, args.command);
  }

  async sendHelp(message: FireMessage) {
    let fields: { name: string; value: string; inline: boolean }[] = [];
    for (const [name, category] of this.client.commandHandler.categories) {
      if (name == "Admin" && !message.author.isSuperuser()) continue;
      let commands: string[] = [];
      category
        .filter((command) => {
          if (command.ownerOnly && this.client.ownerID != message.author.id)
            return false;
          if (command.superuserOnly && !message.author.isSuperuser())
            return false;
          if (
            command.moderatorOnly &&
            !message.member?.isModerator(message.channel)
          )
            return false;
          if (
            command.guilds.length &&
            !command.guilds.includes(message.guild?.id)
          )
            return false;
          if (command.channel == "guild" && !message.guild) return false;
          if (
            (command.userPermissions as PermissionString[])?.length &&
            !message.guild
          )
            return false;
          if (
            (command.userPermissions as PermissionString[])?.length &&
            (message.channel as GuildChannel)
              .permissionsFor(message.author)
              .missing(
                command.userPermissions as BitFieldResolvable<
                  PermissionString,
                  bigint
                >
              ).length
          )
            return false;
          return true;
        })
        .forEach((command) =>
          commands.push(
            command.parent
              ? `\`${command.id.replace("-", " ")}\``
              : `\`${command.id}\``
          )
        );
      if (commands.length)
        fields.push({
          name: category.id,
          value: commands.join(", "),
          inline: false,
        });
    }
    fields.push({
      name: message.language.get("HELP_CREDITS_NAME") as string,
      value: message.language.get("HELP_CREDITS_VALUE") as string,
      inline: false,
    });
    let buttons: APIComponent[] = null;
    if (message.guild?.hasExperiment(1621199146, 1)) {
      let supportInvite = "https://inv.wtf/fire";
      const vanityurls = this.client.getModule("vanityurls") as VanityURLs;
      if (vanityurls) {
        const supportVanity = await vanityurls.getVanity("fire");
        if (typeof supportVanity == "object" && supportVanity?.invite)
          supportInvite = `https://discord.gg/${supportVanity.invite}`;
      }
      buttons = [
        {
          type: ButtonType.BUTTON,
          style: ButtonStyle.LINK,
          url: "https://inv.wtf/",
          label: "Website",
        },
        {
          type: ButtonType.BUTTON,
          style: ButtonStyle.LINK,
          // right now this opens in browser but
          // I have been told this may change
          url: supportInvite,
          label: "Support",
        },
        {
          url: "https://inv.wtf/terms",
          label: "Terms of Service",
          type: ButtonType.BUTTON,
          style: ButtonStyle.LINK,
        },
        {
          url: "https://inv.wtf/privacy",
          type: ButtonType.BUTTON,
          style: ButtonStyle.LINK,
          label: "Privacy Policy",
        },
        {
          url: "https://inv.wtf/premium",
          type: ButtonType.BUTTON,
          style: ButtonStyle.LINK,
          label: "Premium",
        },
      ];
    } else
      fields.push({
        name: message.language.get("HELP_LINKS_NAME") as string,
        value: message.language.get("HELP_LINKS_VALUE") as string,
        inline: false,
      });
    const embed = {
      color: message.member?.displayHexColor || "#ffffff",
      author: {
        icon_url: this.client.user.displayAvatarURL({
          size: 2048,
          format: "png",
        }),
      },
      fields,
      footer: {
        text: message.language.get(
          "HELP_FOOTER",
          message.util.parsed.prefix.replace(
            userMentionRegex,
            `@${this.client.user.username} `
          ) || "$",
          this.client.manager.id
        ) as string,
      },
      timestamp: new Date(),
    };
    return message instanceof SlashCommandMessage
      ? await message.channel.send(null, { embed, buttons })
      : await ButtonMessage.sendWithButtons(message.channel, null, {
          buttons,
          embed,
        });
  }

  async sendUsage(message: FireMessage, command: Command) {
    let permissions: string[] = [];
    for (const perm of (command.userPermissions || []) as Array<
      PermissionString | bigint
    >)
      permissions.push(this.client.util.cleanPermissionName(perm));
    let args: string[] = command.getArgumentsClean();
    const embed = {
      color: message.member?.displayHexColor || "#ffffff",
      title: titleCase(command.id),
      description: command.description(message.language),
      fields: [
        {
          name: "» Usage",
          value: `${message.util.parsed.prefix || "$"}${command.id} ${
            args?.join(" ").replace(/\] \[/gim, " ") || ""
          }`,
          inline: false,
        },
      ],
      timestamp: new Date(),
    };
    if (permissions.length)
      embed.fields.push({
        name: "» Permission" + (permissions.length > 1 ? "s" : ""),
        value: permissions.join(", "),
        inline: false,
      });
    await message.channel.send(null, { embed });
  }
}
