import {
  GuildExperimentConfig,
  UserExperimentConfig,
} from "@fire/lib/interfaces/aether";
import { getAllCommands, getCommands } from "@fire/lib/util/commandutil";
import { FireMember } from "@fire/lib/extensions/guildmember";
import { MessageUtil } from "@fire/lib/ws/util/MessageUtil";
import { getCommitHash } from "@fire/lib/util/gitUtils";
import { EventType } from "@fire/lib/ws/util/constants";
import { Event } from "@fire/lib/ws/event/Event";
import GuildCheckEvent from "./GuildCheckEvent";
import { Message } from "@fire/lib/ws/Message";
import { Manager } from "@fire/lib/Manager";

export default class RestartEvent extends Event {
  constructor(manager: Manager) {
    super(manager, EventType.RESTART_CLIENT);
  }

  async run(data: {
    guildExperiments: GuildExperimentConfig[];
    userExperiments: UserExperimentConfig[];
    shardCount: number;
    shards: number[];
    session: string;
    id: number;
  }) {
    this.manager.client.console.log(
      "[Aether] Received restart event, checking whether sharding options have changed..."
    );
    if (data.id != this.manager.id)
      return this.manager.kill("cluster_id_mismatch");
    const currentOptions = this.manager.client.options;
    if (
      currentOptions.shardCount != data.shardCount &&
      !(currentOptions.shards as number[]).every((shard) =>
        data.shards.includes(shard)
      )
    )
      this.manager.kill("resharding");
    for (const [id, guild] of this.manager.client.guilds.cache)
      this.manager.ws.send(
        MessageUtil.encode(
          new Message(EventType.GUILD_CREATE, {
            id,
            member: GuildCheckEvent.getMemberJSON(guild.me as FireMember),
          })
        )
      );
    this.manager.session = data.session;
    if (data.guildExperiments)
      this.manager.state.loadedGuildExperiments = data.guildExperiments;
    if (data.userExperiments)
      this.manager.state.loadedUserExperiments = data.userExperiments;
    this.manager.client.manager.ws?.send(
      MessageUtil.encode(
        new Message(EventType.READY_CLIENT, {
          avatar: this.manager.client.user.displayAvatarURL({
            size: 4096,
          }),
          allCommands: getAllCommands(this.manager.client),
          commands: getCommands(this.manager.client),
          name: this.manager.client.user.username,
          id: this.manager.client.manager.id,
          env: process.env.NODE_ENV,
          commit: getCommitHash(),
          uuid: process.env.pm_id,
        })
      )
    );
    return;
  }
}
