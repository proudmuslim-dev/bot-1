import {
  Util,
  Role,
  Guild,
  Webhook,
  Collection,
  Structures,
  Permissions,
  StageChannel,
  VoiceChannel,
  MessageEmbed,
  WebhookClient,
  CategoryChannel,
  MessageAttachment,
  FetchOwnerOptions,
  MessageEmbedOptions,
  PermissionOverwriteOption,
} from "discord.js";
import {
  ActionLogType,
  MemberLogType,
  ModLogType,
} from "@fire/lib/util/constants";
import { ButtonStyle, ButtonType } from "../interfaces/interactions";
import { GuildTagManager } from "@fire/lib/util/guildtagmanager";
import { ReactionRoleData } from "@fire/lib/interfaces/rero";
import TicketName from "@fire/src/commands/Tickets/name";
import { PermRolesData } from "../interfaces/permroles";
import { GuildSettings } from "@fire/lib/util/settings";
import { getIDMatch } from "@fire/lib/util/converters";
import { GuildLogManager } from "../util/logmanager";
import { MessageIterator } from "../util/iterators";
import { FakeChannel } from "./slashCommandMessage";
import { ButtonMessage } from "./buttonMessage";
import { FireTextChannel } from "./textchannel";
import Semaphore from "semaphore-async-await";
import { APIGuild } from "discord-api-types";
import { FireMember } from "./guildmember";
import { FireMessage } from "./message";
import { Fire } from "@fire/lib/Fire";
import { v4 as uuidv4 } from "uuid";
import { FireUser } from "./user";
import { nanoid } from "nanoid";

type Primitive = string | boolean | number | null;

const parseUntil = (time?: string) => {
  if (!time) return 0;
  if (time.includes(".")) {
    // legacy py time
    return parseInt((parseFloat(time) * 1000).toString().split(".")[0]);
  } else return parseInt(time);
};

export class FireGuild extends Guild {
  quoteHooks: Collection<string, Webhook | WebhookClient>;
  reactionRoles: Collection<string, ReactionRoleData[]>;
  starboardReactions: Collection<string, number>;
  starboardMessages: Collection<string, string>;
  persistedRoles: Collection<string, string[]>;
  ticketLock?: { lock: Semaphore; limit: any };
  permRoles: Collection<string, PermRolesData>;
  inviteRoles: Collection<string, string>;
  vcRoles: Collection<string, string>;
  invites: Collection<string, number>;
  mutes: Collection<string, number>;
  tempBans: Collection<string, number>;
  fetchingMemberUpdates: boolean;
  muteCheckTask: NodeJS.Timeout;
  declare me: FireMember | null;
  banCheckTask: NodeJS.Timeout;
  fetchingRoleUpdates: boolean;
  settings: GuildSettings;
  logger: GuildLogManager;
  tags: GuildTagManager;
  declare client: Fire;

  constructor(client: Fire, data: object) {
    super(client, data);

    this.settings = new GuildSettings(client, this);
    this.logger = new GuildLogManager(client, this);
    this.tags = new GuildTagManager(client, this);
    this.starboardReactions = new Collection();
    this.starboardMessages = new Collection();
    this.persistedRoles = new Collection();
    this.reactionRoles = new Collection();
    this.inviteRoles = new Collection();
    this.fetchingMemberUpdates = false;
    this.quoteHooks = new Collection();
    this.permRoles = new Collection();
    this.fetchingRoleUpdates = false;
    this.vcRoles = new Collection();
    this.invites = new Collection();
    this.loadStarboardReactions();
    this.loadStarboardMessages();
    this.loadMutes();
    this.loadBans();
  }

  get language() {
    return this.client.getLanguage(
      this.settings.get<string>("utils.language", "en-US")
    );
  }

  get premium() {
    return this.client.util?.premium.has(this.id);
  }

  get muteRole() {
    const id = this.settings.get<string>(
      "mod.mutedrole",
      this.roles.cache.find((role) => role.name == "Muted")?.id
    );
    if (!id) return null;
    return this.roles.cache.get(id);
  }

  get logIgnored() {
    return this.settings.get<string[]>("utils.logignore", []);
  }

  get regions() {
    let regions = this.channels.cache
      .filter((channel) => channel.type == "voice" || channel.type == "stage")
      .map((channel: VoiceChannel | StageChannel) => channel.rtcRegion);
    regions = regions.filter(
      // remove duplicates
      (region, index) => regions.indexOf(region) === index
    );
    if (regions.includes(null))
      regions.splice(0, 0, regions.splice(regions.indexOf(null), 1)[0]);
    return regions;
  }

  _patch(data: APIGuild) {
    delete data.members;
    delete data.presences;

    // @ts-ignore
    super._patch(data);
  }

  fetchOwner(options?: FetchOwnerOptions) {
    return super.fetchOwner(options) as Promise<FireMember>;
  }

  async initMuteRole() {
    if (this.muteRole) return this.muteRole;
    const role = await this.roles
      .create({
        position: this.me.roles.highest.rawPosition - 2, // -1 seems to fail a lot more than -2 so just do -2 to be safe
        mentionable: false,
        color: "#24242c",
        permissions: [],
        name: "Muted",
        hoist: false,
        reason: this.language.get("MUTE_ROLE_CREATE_REASON") as string,
      })
      .catch((e) => {
        this.client.console.warn(
          `[Guilds] Failed to create mute role in ${this.name} due to\n${e.stack}`
        );
      });
    if (!role) return false;
    this.settings.set<string>("mod.mutedrole", role.id);
    for (const [, channel] of this.channels.cache) {
      await channel
        .updateOverwrite(
          role,
          {
            SEND_MESSAGES: false,
            ADD_REACTIONS: false,
            SPEAK: false,
          },
          {
            reason: this.language.get("MUTE_ROLE_CREATE_REASON") as string,
            type: 0,
          }
        )
        .catch(() => {});
    }
    return role;
  }

  async changeMuteRole(role: Role) {
    const changed = await role
      .edit({
        position: this.me.roles.highest.rawPosition - 2,
        permissions: [],
      })
      .catch(() => {});
    if (!changed) return false;
    this.settings.set<string>("mod.mutedrole", role.id);
    for (const [, channel] of this.channels.cache) {
      await channel
        .updateOverwrite(
          role,
          {
            SEND_MESSAGES: false,
            ADD_REACTIONS: false,
            SPEAK: false,
          },
          {
            reason: this.language.get("MUTE_ROLE_CREATE_REASON") as string,
            type: 0,
          }
        )
        .catch(() => {});
    }
    return changed;
  }

  async syncMuteRolePermissions() {
    const role = this.muteRole;
    if (!role) return;
    for (const [, channel] of this.channels.cache) {
      const denied = channel.permissionOverwrites.get(role.id)?.deny;
      if (
        !denied ||
        !denied.has(Permissions.FLAGS.SEND_MESSAGES) ||
        !denied.has(Permissions.FLAGS.ADD_REACTIONS) ||
        !denied.has(Permissions.FLAGS.SPEAK)
      )
        await channel
          .updateOverwrite(
            role,
            {
              SEND_MESSAGES: false,
              ADD_REACTIONS: false,
              SPEAK: false,
            },
            {
              reason: this.language.get("MUTE_ROLE_CREATE_REASON") as string,
              type: 0,
            }
          )
          .catch(() => {});
    }
  }

  private async loadMutes() {
    this.mutes = new Collection();
    const mutes = await this.client.db
      .query("SELECT * FROM mutes WHERE gid=$1;", [this.id])
      .catch(() => {});
    if (!mutes)
      return this.client.console.error(
        `[Guild] Failed to load mutes for ${this.name} (${this.id})`
      );
    for await (const mute of mutes) {
      this.mutes.set(
        mute.get("uid") as string,
        parseUntil(mute.get("until") as string)
      );
    }
    if (this.muteCheckTask) clearInterval(this.muteCheckTask);
    this.muteCheckTask = setInterval(this.checkMutes.bind(this), 60000);
  }

  private async loadBans() {
    this.tempBans = new Collection();
    const bans = await this.client.db
      .query("SELECT * FROM bans WHERE gid=$1;", [this.id])
      .catch(() => {});
    if (!bans)
      return this.client.console.error(
        `[Guild] Failed to load bans for ${this.name} (${this.id})`
      );
    for await (const ban of bans) {
      this.tempBans.set(
        ban.get("uid") as string,
        parseUntil(ban.get("until") as string)
      );
    }
    if (this.banCheckTask) clearInterval(this.banCheckTask);
    this.banCheckTask = setInterval(this.checkBans.bind(this), 90000);
  }

  private async checkMutes() {
    if (!this.client.user || !this.available) return; // likely not ready yet or guild is unavailable
    const me =
      this.me instanceof FireMember
        ? this.me
        : ((await this.members
            .fetch(this.client.user.id)
            .catch(() => {})) as FireMember);
    if (!me) return; // could mean discord issues so return
    const now = +new Date();
    for (const [id] of this.mutes.filter(
      // likely never gonna be equal but if somehow it is then you're welcome
      (time) => !!time && now >= time
    )) {
      const member = (await this.members
        .fetch(id)
        .catch(() => {})) as FireMember;
      if (member) {
        const unmuted = await member.unmute(
          this.language.get("UNMUTE_AUTOMATIC") as string,
          this.me as FireMember
        );
        this.mutes.delete(id); // ensures id is removed from cache even if above fails to do so
        if (typeof unmuted == "string") {
          this.client.console.warn(
            `[Guild] Failed to remove mute for ${member} (${id}) in ${this.name} (${this.id}) due to ${unmuted}`
          );
          await this.modLog(
            this.language.get(
              "UNMUTE_AUTO_FAIL",
              `${member} (${id})`,
              this.language.get(`UNMUTE_FAILED_${unmuted.toUpperCase()}`)
            ),
            "unmute"
          );
        } else continue;
      } else {
        this.mutes.delete(id);
        const dbremove = await this.client.db
          .query("DELETE FROM mutes WHERE gid=$1 AND uid=$2;", [this.id, id])
          .catch(() => {});
        const embed = new MessageEmbed()
          .setColor("#2ECC71")
          .setTimestamp(now)
          .setAuthor(
            this.language.get("UNMUTE_LOG_AUTHOR", id),
            this.iconURL({ size: 2048, format: "png", dynamic: true })
          )
          .addField(this.language.get("MODERATOR"), me.toString())
          .setFooter(id.toString());
        if (!dbremove)
          embed.addField(
            this.language.get("ERROR"),
            this.language.get("UNMUTE_FAILED_DB_REMOVE")
          );
        await this.modLog(embed, "unmute").catch(() => {});
      }
    }
  }

  private async checkBans() {
    if (!this.client.user || !this.available) return; // likely not ready yet or guild is unavailable
    const me =
      this.me instanceof FireMember
        ? this.me
        : ((await this.members
            .fetch(this.client.user.id)
            .catch(() => {})) as FireMember);
    if (!me) return; // could mean discord issues so return
    const now = +new Date();
    for (const [id] of this.tempBans.filter(
      // likely never gonna be equal but if somehow it is then you're welcome
      (time) => !!time && now >= time
    )) {
      const user = (await this.client.users
        .fetch(id)
        .catch(() => {})) as FireUser; // todo check error code
      if (!user) continue;
      await this.unban(
        user,
        this.language.get("UNMUTE_AUTOMATIC") as string,
        this.me as FireMember
      );
    }
  }

  async loadStarboardMessages() {
    this.starboardMessages = new Collection();
    const messages = await this.client.db
      .query("SELECT * FROM starboard WHERE gid=$1;", [this.id])
      .catch(() => {});
    if (!messages)
      return this.client.console.error(
        `[Guild] Failed to load starboard messages for ${this.name} (${this.id})`
      );
    for await (const message of messages)
      this.starboardMessages.set(
        message.get("original") as string,
        message.get("board") as string
      );
  }

  async loadStarboardReactions() {
    this.starboardReactions = new Collection();
    const reactions = await this.client.db
      .query("SELECT * FROM starboard_reactions WHERE gid=$1;", [this.id])
      .catch(() => {});
    if (!reactions)
      return this.client.console.error(
        `[Guild] Failed to load starboard reactions for ${this.name} (${this.id})`
      );
    for await (const reaction of reactions)
      this.starboardReactions.set(
        reaction.get("mid") as string,
        reaction.get("reactions") as number
      );
  }

  async loadInviteRoles() {
    this.inviteRoles = new Collection();
    if (!this.premium || !this.available) return;
    const invroles = await this.client.db
      .query("SELECT * FROM invrole WHERE gid=$1;", [this.id])
      .catch(() => {});
    if (!invroles)
      return this.client.console.error(
        `[Guild] Failed to load invite roles for ${this.name} (${this.id})`
      );
    for await (const invrole of invroles)
      this.inviteRoles.set(
        invrole.get("inv") as string,
        invrole.get("rid") as string
      );
  }

  async loadPersistedRoles() {
    this.persistedRoles = new Collection();
    if (!this.premium || !this.available) return;
    const persisted = await this.client.db
      .query("SELECT * FROM rolepersists WHERE gid=$1;", [this.id])
      .catch(() => {});
    if (!persisted)
      return this.client.console.error(
        `[Guild] Failed to load persisted roles for ${this.name} (${this.id})`
      );
    for await (const role of persisted)
      this.persistedRoles.set(
        role.get("uid") as string,
        role.get("roles") as string[]
      );
  }

  async loadVcRoles() {
    this.vcRoles = new Collection();
    if (!this.premium || !this.available) return;
    const voiceroles = await this.client.db
      .query("SELECT * FROM vcroles WHERE gid=$1;", [this.id])
      .catch(() => {});
    if (!voiceroles)
      return this.client.console.error(
        `[Guild] Failed to load voice roles for ${this.name} (${this.id})`
      );
    for await (const vcrole of voiceroles) {
      this.vcRoles.set(
        vcrole.get("cid") as string,
        vcrole.get("rid") as string
      );
      const channel = this.channels.cache.get(vcrole.get("cid") as string) as
        | VoiceChannel
        | StageChannel;
      if (!channel) continue;
      const role = this.roles.cache.get(vcrole.get("rid") as string);
      if (!role) continue;
      const members = await this.members
        .fetch({
          user: this.voiceStates.cache.map((state) => state.id),
        })
        .catch(() => {});
      if (!members) return;
      for (const [, state] of this.voiceStates.cache.filter(
        (state) =>
          state.channelID == channel.id &&
          !members.get(state.id)?.roles.cache.has(role.id) &&
          !members.get(state.id)?.user.bot
      ))
        await members
          .get(state.id)
          ?.roles.add(role, this.language.get("VCROLE_ADD_REASON") as string)
          .catch(() => {});
    }
  }

  async loadReactionRoles() {
    this.reactionRoles = new Collection();
    if (!this.premium || !this.available) return;
    const reactRoles = await this.client.db
      .query("SELECT * FROM reactrole WHERE gid=$1;", [this.id])
      .catch(() => {});
    if (!reactRoles)
      return this.client.console.error(
        `[Guild] Failed to load reaction roles for ${this.name} (${this.id})`
      );
    for await (const rero of reactRoles) {
      const mid = rero.get("mid") as string;
      if (!this.reactionRoles.has(mid)) this.reactionRoles.set(mid, []);
      this.reactionRoles.get(mid).push({
        role: rero.get("rid") as string,
        emoji: rero.get("eid") as string,
      });
    }
  }

  async loadPermRoles() {
    this.permRoles = new Collection();
    if (!this.available) return;
    const permRoles = await this.client.db
      .query("SELECT * FROM permroles WHERE gid=$1;", [this.id])
      .catch(() => {});
    if (!permRoles)
      return this.client.console.error(
        `[Guild] Failed to load permission roles for ${this.name} (${this.id})`
      );
    for await (const role of permRoles) {
      this.permRoles.set(role.get("rid") as string, {
        allow: BigInt(role.get("allow") as string),
        deny: BigInt(role.get("deny") as string),
      });
    }
    for (const [id, perms] of this.permRoles) {
      for (const [, channel] of this.channels.cache.filter(
        (channel) =>
          channel.permissionsFor(this.me).has(Permissions.FLAGS.MANAGE_ROLES) &&
          (channel.permissionOverwrites.get(id)?.allow.bitfield !=
            perms.allow ||
            channel.permissionOverwrites.get(id)?.deny.bitfield != perms.deny)
      ))
        channel
          .overwritePermissions(
            [
              ...channel.permissionOverwrites.array().filter(
                // ensure the overwrites below are used instead
                (overwrite) => overwrite.id != id
              ),
              {
                allow: perms.allow,
                deny: perms.deny,
                id: id,
                type: "role",
              },
            ],
            this.language.get("PERMROLES_REASON") as string
          )
          .catch(() => {});
    }
  }

  async loadInvites() {
    this.invites = new Collection();
    if (!this.premium || !this.available) return;
    const invites = await this.fetchInvites().catch(() => {});
    if (!invites) return this.invites;
    for (const [code, invite] of invites) this.invites.set(code, invite.uses);
    if (this.features.includes("VANITY_URL")) {
      const vanity = await this.fetchVanityData().catch(() => {});
      if (vanity) this.invites.set(vanity.code, vanity.uses);
    }
    return this.invites;
  }

  isPublic() {
    if (!this.available) return false;
    return (
      this.settings.get<boolean>("utils.public", false) ||
      (this.features && this.features.includes("DISCOVERABLE"))
    );
  }

  getDiscoverableData() {
    let splash = "https://i.imgur.com/jWRMBRd.png";
    if (!this.available)
      return {
        name: "",
        id: this.id,
        icon: "https://cdn.discordapp.com/embed/avatars/0.png",
        splash,
        vanity: `https://discover.inv.wtf/${this.id}`,
        members: 0,
      };
    if (this.splash)
      splash = this.splashURL({
        size: 2048,
        format: "png",
      }).replace("size=2048", "size=320");
    else if (this.discoverySplash)
      splash = this.discoverySplashURL({
        size: 2048,
        format: "png",
      }).replace("size=2048", "size=320");
    const icon =
      this.iconURL({
        format: "png",
        size: 128,
        dynamic: true,
      }) || "https://cdn.discordapp.com/embed/avatars/0.png";
    return {
      name: this.name,
      id: this.id,
      icon,
      splash,
      vanity: `https://discover.inv.wtf/${this.id}`,
      members: this.memberCount,
    };
  }

  getMember(name: string): FireMember | null {
    const username = name.split("#")[0];
    const member = this.members.cache.find(
      (member) =>
        member.toString().toLowerCase() == name.toLowerCase() ||
        member.displayName?.toLowerCase() == username.toLowerCase() ||
        member.user.username?.toLowerCase() == username.toLowerCase()
    );

    return member ? (member as FireMember) : null;
  }

  async fetchMember(name: string): Promise<FireMember | null> {
    const member = this.getMember(name);

    if (member) return member;
    const fetchedMembers = await this.members.fetch({
      user: this.members.cache.size ? [...this.members.cache.array()] : [],
      query: name,
      limit: 1,
    });

    return fetchedMembers.first() as FireMember | null;
  }

  async actionLog(
    log: string | MessageEmbed | MessageEmbedOptions,
    type: ActionLogType
  ) {
    const channel = this.channels.cache.get(
      this.settings.get<string>("log.action")
    );
    if (!channel || channel.type != "text") return;

    if (!this.me.permissionsIn(channel).has(Permissions.FLAGS.MANAGE_WEBHOOKS))
      return await (channel as FireTextChannel).send(log).catch(() => {});
    else return await this.logger.handleAction(log, type);
  }

  async modLog(
    log: string | MessageEmbed | MessageEmbedOptions,
    type: ModLogType
  ) {
    const channel = this.channels.cache.get(
      this.settings.get<string>("log.moderation")
    );
    if (!channel || channel.type != "text") return;

    if (!this.me.permissionsIn(channel).has(Permissions.FLAGS.MANAGE_WEBHOOKS))
      return await (channel as FireTextChannel).send(log).catch(() => {});
    else return await this.logger.handleModeration(log, type);
  }

  async memberLog(
    log: string | MessageEmbed | MessageEmbedOptions,
    type: MemberLogType
  ) {
    const channel = this.channels.cache.get(
      this.settings.get<string>("log.members")
    );
    if (!channel || channel.type != "text") return;

    if (!this.me.permissionsIn(channel).has(Permissions.FLAGS.MANAGE_WEBHOOKS))
      return await (channel as FireTextChannel).send(log).catch(() => {});
    else return await this.logger.handleMembers(log, type);
  }

  hasExperiment(id: number, bucket: number) {
    // if (this.client.config.dev) return true;
    const experiment = this.client.experiments.get(id);
    if (!experiment || experiment.kind != "guild") return false;
    if (!experiment.active) return true;
    return !!experiment.data.find(([i, b]) => i == this.id && b == bucket);
  }

  async giveExperiment(id: number, bucket: number) {
    const experiment = this.client.experiments.get(id);
    if (!experiment || experiment.kind != "guild")
      throw new Error("Experiment is not a guild experiment");
    if (!experiment.buckets.includes(bucket)) throw new Error("Invalid Bucket");
    experiment.data = experiment.data.filter(([i]) => i != this.id);
    experiment.data.push([this.id, bucket]);
    await this.client.db.query("UPDATE experiments SET data=$1 WHERE id=$2;", [
      experiment.data?.length ? experiment.data : null,
      BigInt(experiment.id),
    ]);
    this.client.experiments.set(experiment.id, experiment);
    this.client.refreshExperiments();
    return this.hasExperiment(id, bucket);
  }

  async removeExperiment(id: number, bucket: number) {
    const experiment = this.client.experiments.get(id);
    if (!experiment || experiment.kind != "guild")
      throw new Error("Experiment is not a guild experiment");
    const b = experiment.data.length;
    experiment.data = experiment.data.filter(
      ([i, b]) => i != this.id && b != bucket
    );
    if (b == experiment.data.length) return !this.hasExperiment(id, bucket);
    await this.client.db.query("UPDATE experiments SET data=$1 WHERE id=$2;", [
      experiment.data?.length ? experiment.data : null,
      BigInt(experiment.id),
    ]);
    this.client.experiments.set(experiment.id, experiment);
    this.client.refreshExperiments();
    return !this.hasExperiment(id, bucket);
  }

  get tickets() {
    const textChannels = this.channels.cache.filter(
      (channel) => channel.type == "text"
    );
    return this.settings
      .get<string[]>("tickets.channels", [])
      .map((id) => textChannels.get(id))
      .filter((channel) => !!channel) as FireTextChannel[];
  }

  async createTicket(
    author: FireMember,
    subject: string,
    category?: CategoryChannel
  ) {
    if (author?.guild?.id != this.id) return "author";
    if (this.client.util.isBlacklisted(author.id, this)) return "blacklisted";
    category =
      category ||
      (this.channels.cache
        .filter((channel) => channel.type == "category")
        .get(this.settings.get<string>("tickets.parent")) as CategoryChannel);
    if (!category) return "disabled";
    const limit = this.settings.get<number>("tickets.limit", 1);
    if (!this.ticketLock?.lock || this.ticketLock?.limit != limit)
      this.ticketLock = { lock: new Semaphore(limit), limit };
    const permits = this.ticketLock.lock.getPermits();
    if (!permits) return "lock";
    let locked = false;
    setTimeout(() => {
      if (locked) this.ticketLock.lock.release();
    }, 15000);
    await this.ticketLock.lock.acquire();
    locked = true;
    let channels = this.settings
      .get<string[]>("tickets.channels", [])
      .map((id) =>
        this.channels.cache
          .filter((channel) => channel.type == "text" && channel.id == id)
          .get(id)
      );
    if (
      channels.filter((channel: FireTextChannel) =>
        channel?.topic.includes(author.id)
      ).length >= limit
    ) {
      locked = false;
      this.ticketLock.lock.release();
      return "limit";
    }
    const words = (this.client.getCommand("ticket-name") as TicketName).words;
    let increment = this.settings.get<number>("tickets.increment", 0);
    const variables = {
      "{increment}": increment.toString(),
      "{name}": author.user.username,
      "{id}": author.id,
      "{word}": this.client.util.randomItem<string>(words),
      "{uuid}": uuidv4().slice(0, 4),
      "{crab}": "🦀", // CRAB IN DA CODE
    };
    let name = this.settings.get<string>("tickets.name", "ticket-{increment}");
    for (const [key, value] of Object.entries(variables)) {
      name = name.replace(key, value);
    }
    name = name.replace(/crab/gim, "🦀");
    this.settings.set<number>("tickets.increment", ++increment);
    const overwriteTheOverwrites = [
      author.id,
      this.me.id,
      this.roles.everyone.id,
    ];

    const ticket = ((await this.channels
      .create(name.slice(0, 50), {
        parent: category,
        permissionOverwrites: [
          ...category.permissionOverwrites
            .array()
            .filter(
              // ensure the overwrites below are used instead
              (overwrite) => !overwriteTheOverwrites.includes(overwrite.id)
            )
            .map((overwrite) => {
              // we can't set manage roles without admin so just remove it
              if (overwrite.allow.has(Permissions.FLAGS.MANAGE_ROLES))
                overwrite.allow.remove(Permissions.FLAGS.MANAGE_ROLES);
              if (overwrite.deny.has(Permissions.FLAGS.MANAGE_ROLES))
                overwrite.deny.remove(Permissions.FLAGS.MANAGE_ROLES);
              return overwrite;
            }),
          {
            allow: [
              Permissions.FLAGS.VIEW_CHANNEL,
              Permissions.FLAGS.SEND_MESSAGES,
            ],
            type: "member",
            id: author.id,
          },
          {
            allow: [
              Permissions.FLAGS.VIEW_CHANNEL,
              Permissions.FLAGS.SEND_MESSAGES,
              Permissions.FLAGS.MANAGE_CHANNELS,
            ],
            type: "member",
            id: this.me.id,
          },
          {
            id: this.roles.everyone.id,
            deny: [Permissions.FLAGS.VIEW_CHANNEL],
            type: "role",
          },
        ],
        topic: this.language.get(
          "TICKET_CHANNEL_TOPIC",
          author.toString(),
          author.id,
          subject
        ) as string,
        reason: this.language.get(
          "TICKET_CHANNEL_TOPIC",
          author.toString(),
          author.id,
          subject
        ) as string,
      })
      .catch((e: Error) => e)) as unknown) as FireTextChannel;
    if (ticket instanceof Error) {
      locked = false;
      this.ticketLock.lock.release();
      return ticket;
    }
    const embed = new MessageEmbed()
      .setTitle(this.language.get("TICKET_OPENER_TILE", author.toString()))
      .setTimestamp()
      .setColor(author.displayHexColor || "#ffffff")
      .addField(this.language.get("SUBJECT"), subject);
    const description = this.settings.get<string>("tickets.description");
    if (description) embed.setDescription(description);
    const alertId = this.settings.get<string>("tickets.alert");
    const alert = this.roles.cache.get(alertId);
    let opener: FireMessage;
    if (alert && !author.isModerator()) {
      if (this.hasExperiment(1621199146, 1))
        ButtonMessage.sendWithButtons(ticket, alert.toString(), {
          allowedMentions: { roles: [alertId] },
          embed,
          buttons: [
            {
              type: ButtonType.BUTTON,
              style: ButtonStyle.DESTRUCTIVE,
              custom_id: `ticket_close_${ticket.id}`,
              label: this.language.get("TICKET_CLOSE_BUTTON_TEXT") as string,
              emoji: { id: "534174796938870792" },
            },
          ],
        }).catch(() => {});
      else
        opener = (await ticket
          .send(alert.toString(), {
            allowedMentions: { roles: [alertId] },
            embed,
          })
          .catch(() => {})) as FireMessage;
    } else {
      if (this.hasExperiment(1621199146, 1))
        ButtonMessage.sendWithButtons(ticket, embed, {
          buttons: [
            {
              type: 2,
              style: ButtonStyle.DESTRUCTIVE,
              custom_id: `ticket_close_${ticket.id}`,
              label: this.language.get("TICKET_CLOSE_BUTTON_TEXT") as string,
              emoji: { id: "534174796938870792" },
            },
          ],
        }).catch(() => {});
      else opener = (await ticket.send(embed).catch(() => {})) as FireMessage;
    }
    channels.push(ticket);
    this.settings.set<string[]>(
      "tickets.channels",
      channels.map((channel) => channel && channel.id)
    );
    this.client.emit("ticketCreate", author, ticket, opener);
    locked = false;
    this.ticketLock.lock.release();
    return ticket;
  }

  async closeTicket(
    channel: FireTextChannel,
    author: FireMember,
    reason: string
  ) {
    if (channel instanceof FakeChannel)
      channel = channel.real as FireTextChannel;
    if (author instanceof FireUser)
      author = (await this.members.fetch(author).catch(() => {})) as FireMember;
    if (!author) return "forbidden";
    let channels = this.settings
      .get<string[]>("tickets.channels", [])
      .map((id) =>
        this.channels.cache
          .filter((channel) => channel.type == "text" && channel.id == id)
          .get(id)
      );
    if (!channels.includes(channel)) return "nonticket";
    if (
      !author.permissions.has(Permissions.FLAGS.MANAGE_CHANNELS) &&
      !channel.topic.includes(author.id)
    )
      return "forbidden";
    channels = channels.filter((c) => c && c.id != channel.id);
    if (channels.length)
      this.settings.set<string[]>(
        "tickets.channels",
        channels.map((c) => c.id)
      );
    else this.settings.delete("tickets.channels");
    let transcript: string[] = [];
    const iterator = new MessageIterator(channel, {
      oldestFirst: true,
    });
    for await (const message of iterator.iterate()) {
      transcript.push(
        `${message.author} (${
          message.author.id
        }) at ${message.createdAt.toLocaleString(
          this.language.id
        )}\n${this.getTranscriptContent(message)}`
      );
    }
    transcript.push(`${transcript.length} messages, closed by ${author}`);
    const buffer = Buffer.from(transcript.join("\n\n"), "ascii");
    const id = getIDMatch(channel.topic, true);
    let creator = author;
    if (id) {
      creator = (await this.members.fetch(id).catch(() => {})) as FireMember;
      if (creator)
        await creator
          .send(
            creator.language.get("TICKET_CLOSE_TRANSCRIPT", this.name, reason),
            {
              files: [
                new MessageAttachment(buffer, `${channel.name}-transcript.txt`),
              ],
            }
          )
          .catch(() => {});
      else creator = author;
    }
    const log =
      (this.channels.cache.get(
        this.settings.get<string>("tickets.transcript_logs")
      ) as FireTextChannel) ||
      (this.channels.cache.get(
        this.settings.get<string>("log.action")
      ) as FireTextChannel);
    const embed = new MessageEmbed()
      .setTitle(this.language.get("TICKET_CLOSER_TITLE", channel.name))
      .setTimestamp()
      .setColor(author.displayHexColor || "#ffffff")
      .addField(
        this.language.get("TICKET_CLOSER_CLOSED_BY"),
        `${author} (${author.id})`
      )
      .addField(this.language.get("REASON"), reason);
    await log
      ?.send(null, {
        embed,
        files:
          channel.parentID == "755796036198596688"
            ? []
            : [new MessageAttachment(buffer, `${channel.name}-transcript.txt`)],
      })
      .catch(() => {});
    this.client.emit("ticketClose", creator);
    return (await channel
      .delete(this.language.get("TICKET_CLOSE_REASON") as string)
      .catch((e: Error) => e)) as FireTextChannel | Error;
  }

  private getTranscriptContent(message: FireMessage) {
    let text = message.cleanContent ?? "";
    if (message.embeds.length)
      for (const embed of message.embeds) {
        if (embed.description) text += `\n${embed.description}`;
        if (embed.fields.length)
          for (const field of embed.fields)
            text += `\n${field.name} | ${field.value}`;
      }
    if (message.attachments.size)
      for (const [, attachment] of message.attachments)
        text += `\n${attachment.proxyURL}`;
    if (message.stickers.size)
      text += `\n${this.language.get(
        "TICKET_CLOSE_TRANSCRIPT_STICKER",
        message.stickers.map((sticker) => sticker.name).join(",")
      )}`;

    return text.trim() || "¯\\\\_(ツ)_/¯";
  }

  async createModLogEntry(
    user: FireUser | FireMember,
    moderator: FireMember,
    type: ModLogType,
    reason: string
  ) {
    const date = new Date().toLocaleString(this.language.id);
    const caseID = nanoid();
    const entryResult = await this.client.db
      .query(
        "INSERT INTO modlogs (gid, uid, modid, reason, date, type, caseid) VALUES ($1, $2, $3, $4, $5, $6, $7);",
        [this.id, user.id, moderator.id, reason, date, type, caseID]
      )
      .catch(() => {});
    if (!entryResult) return false;
    // amazing success detection
    else if (entryResult.status.startsWith("INSERT")) return caseID;
    return false;
  }

  async deleteModLogEntry(caseID: string) {
    const entryResult = await this.client.db
      .query("DELETE FROM modlogs WHERE gid=$1 AND caseid=$2;", [
        this.id,
        caseID,
      ])
      .catch(() => {});
    if (!entryResult) return false;
    else if (entryResult.status.startsWith("DELETE")) return true;
    return false;
  }

  async unban(
    user: FireUser,
    reason: string,
    moderator: FireMember,
    channel?: FireTextChannel
  ) {
    if (!reason || !moderator) return "args";
    if (!moderator.isModerator(channel)) return "forbidden";
    const ban = await this.bans.fetch(user).catch(() => {});
    if (!ban) return "no_ban";
    const logEntry = await this.createModLogEntry(
      user,
      moderator,
      "unban",
      reason
    ).catch(() => {});
    if (!logEntry) return "entry";
    const unbanned = await this.members
      .unban(user, `${moderator} | ${reason}`)
      .catch(() => {});
    if (!unbanned) {
      const deleted = await this.deleteModLogEntry(logEntry).catch(() => false);
      return deleted ? "unban" : "unban_and_entry";
    }
    if (this.tempBans.has(user.id)) {
      await this.client.db
        .query("DELETE FROM bans WHERE gid=$1 AND uid=$2;", [this.id, user.id])
        .catch(() => {});
      this.tempBans.delete(user.id);
    }
    const embed = new MessageEmbed()
      .setColor("#E74C3C")
      .setTimestamp()
      .setAuthor(
        this.language.get("UNBAN_LOG_AUTHOR", user.toString()),
        user.displayAvatarURL({ size: 2048, format: "png", dynamic: true })
      )
      .addField(this.language.get("MODERATOR"), moderator.toString())
      .addField(this.language.get("REASON"), reason)
      .setFooter(`${user.id} | ${moderator.id}`);
    await this.modLog(embed, "unban").catch(() => {});
    if (channel)
      return await channel
        .send(
          this.language.get(
            "UNBAN_SUCCESS",
            Util.escapeMarkdown(user.toString()),
            Util.escapeMarkdown(this.name)
          )
        )
        .catch(() => {});
  }

  async block(
    blockee: FireMember | Role,
    reason: string,
    moderator: FireMember,
    channel: FireTextChannel
  ) {
    if (!reason || !moderator) return "args";
    if (!moderator.isModerator(channel)) return "forbidden";
    let logEntry: string | false | void;
    if (blockee instanceof FireMember) {
      logEntry = await this.createModLogEntry(
        blockee,
        moderator,
        "block",
        reason
      ).catch(() => {});
      if (!logEntry) return "entry";
    }
    const overwrite: PermissionOverwriteOption = {
      SEND_MESSAGES: false,
      ADD_REACTIONS: false,
    };
    const blocked = await channel
      .updateOverwrite(blockee, overwrite, {
        reason: `${moderator} | ${reason}`,
      })
      .catch(() => {});
    if (!blocked) {
      let deleted = true; // ensures "block" is used if logEntry doesn't exist
      if (logEntry)
        deleted = await this.deleteModLogEntry(logEntry).catch(() => false);
      return deleted ? "block" : "block_and_entry";
    }
    const embed = new MessageEmbed()
      .setColor(
        blockee instanceof FireMember
          ? blockee.displayHexColor
          : null || "#E74C3C"
      )
      .setTimestamp()
      .setAuthor(
        this.language.get(
          "BLOCK_LOG_AUTHOR",
          blockee instanceof FireMember ? blockee.toString() : blockee.name
        ),
        blockee instanceof FireMember
          ? blockee.displayAvatarURL({
              size: 2048,
              format: "png",
              dynamic: true,
            })
          : this.iconURL({ size: 2048, format: "png", dynamic: true }),
        "https://static.inv.wtf/blocked.gif" // hehe
      )
      .addField(this.language.get("MODERATOR"), moderator.toString())
      .addField(this.language.get("REASON"), reason)
      .setFooter(`${this.id} | ${moderator.id}`);
    await this.modLog(embed, "block").catch(() => {});
    return await channel
      .send(
        this.language.get(
          "BLOCK_SUCCESS",
          Util.escapeMarkdown(
            blockee instanceof FireMember ? blockee.toString() : blockee.name
          )
        )
      )
      .catch(() => {});
  }

  async unblock(
    unblockee: FireMember | Role,
    reason: string,
    moderator: FireMember,
    channel: FireTextChannel
  ) {
    if (!reason || !moderator) return "args";
    if (!moderator.isModerator(channel)) return "forbidden";
    let logEntry: string | false | void;
    if (unblockee instanceof FireMember) {
      logEntry = await this.createModLogEntry(
        unblockee,
        moderator,
        "unblock",
        reason
      ).catch(() => {});
      if (!logEntry) return "entry";
    }
    const overwrite: PermissionOverwriteOption = {
      SEND_MESSAGES: null,
      ADD_REACTIONS: null,
    };
    const unblocked = await channel
      .updateOverwrite(unblockee, overwrite, {
        reason: `${moderator} | ${reason}`,
      })
      .catch(() => {});
    if (
      channel.permissionOverwrites?.get(unblockee.id)?.allow.bitfield == 0n &&
      channel.permissionOverwrites?.get(unblockee.id)?.deny.bitfield == 0n &&
      unblockee.id != this.roles.everyone.id
    )
      await channel.permissionOverwrites
        .get(unblockee.id)
        .delete()
        .catch(() => {}); // this doesn't matter *too* much
    if (!unblocked) {
      let deleted = true; // ensures "unblock" is used if logEntry doesn't exist
      if (logEntry)
        deleted = await this.deleteModLogEntry(logEntry).catch(() => false);
      return deleted ? "unblock" : "unblock_and_entry";
    }
    const embed = new MessageEmbed()
      .setColor(
        unblockee instanceof FireMember
          ? unblockee.displayHexColor
          : null || "#2ECC71"
      )
      .setTimestamp()
      .setAuthor(
        this.language.get(
          "UNBLOCK_LOG_AUTHOR",
          unblockee instanceof FireMember
            ? unblockee.toString()
            : unblockee.name
        ),
        unblockee instanceof FireMember
          ? unblockee.displayAvatarURL({
              size: 2048,
              format: "png",
              dynamic: true,
            })
          : this.iconURL({ size: 2048, format: "png", dynamic: true })
      )
      .addField(this.language.get("MODERATOR"), moderator.toString())
      .addField(this.language.get("REASON"), reason)
      .setFooter(`${this.id} | ${moderator.id}`);
    await this.modLog(embed, "unblock").catch(() => {});
    return await channel
      .send(
        this.language.get(
          "UNBLOCK_SUCCESS",
          Util.escapeMarkdown(
            unblockee instanceof FireMember
              ? unblockee.toString()
              : unblockee.name
          )
        )
      )
      .catch(() => {});
  }
}

Structures.extend("Guild", () => FireGuild);
