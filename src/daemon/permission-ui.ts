import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type TextChannel,
} from "discord.js";
import type { DiffContent } from "./acp-client.js";
import { formatDiff } from "./message-bridge.js";

const KIND_LABELS: Record<string, string> = {
  allow_once: "\u2705 Allow",
  allow_always: "\u2705 Always Allow",
  reject_once: "\u274C Reject",
  reject_always: "\u274C Never Allow",
};

const KIND_STYLES: Record<string, ButtonStyle> = {
  allow_once: ButtonStyle.Success,
  allow_always: ButtonStyle.Success,
  reject_once: ButtonStyle.Danger,
  reject_always: ButtonStyle.Danger,
};

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export async function sendPermissionRequest(
  channel: TextChannel,
  toolTitle: string,
  toolKind: string,
  options: PermissionOption[],
  requestorId: string,
  diffs: DiffContent[] = [],
  timeoutMs = 14 * 60 * 1000,
): Promise<{ outcome: "selected"; optionId: string; diffsSent?: boolean } | { outcome: "cancelled"; diffsSent?: boolean }> {
  if (options.length === 0) {
    return { outcome: "cancelled" };
  }

  // Send diffs before the permission embed so the user can review changes
  let diffsSent = false;
  if (diffs.length > 0) {
    try {
      const diffMessages = formatDiff(diffs);
      for (const msg of diffMessages) {
        await channel.send(msg);
      }
      diffsSent = true;
    } catch (err) {
      console.error("Failed to send permission diffs:", err);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle(`Permission: ${toolTitle}`)
    .setDescription(`Tool type: \`${toolKind}\``)
    .setTimestamp();

  const buttons = options.map((opt) =>
    new ButtonBuilder()
      .setCustomId(`perm_${opt.optionId}`)
      .setLabel(KIND_LABELS[opt.kind] ?? opt.name)
      .setStyle(KIND_STYLES[opt.kind] ?? ButtonStyle.Secondary),
  );

  // Discord allows max 5 buttons per ActionRow
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }

  const msg = await channel.send({ embeds: [embed], components: rows });

  return new Promise((resolve) => {
    const collector = msg.createMessageComponentCollector({
      filter: (i) => i.user.id === requestorId,
      time: timeoutMs,
    });

    collector.on("collect", async (interaction) => {
      const optionId = interaction.customId.replace("perm_", "");
      await interaction.update({ components: [] });
      collector.stop("selected");
      resolve({ outcome: "selected", optionId, diffsSent });
    });

    collector.on("end", (_collected, reason) => {
      if (reason === "time") {
        msg.edit({ components: [] }).catch(() => {});
        resolve({ outcome: "cancelled", diffsSent });
      }
    });
  });
}
