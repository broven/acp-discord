import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type TextChannel,
} from "discord.js";

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
  timeoutMs = 14 * 60 * 1000,
): Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }> {
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

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  const msg = await channel.send({ embeds: [embed], components: [row] });

  return new Promise((resolve) => {
    const collector = msg.createMessageComponentCollector({ time: timeoutMs });

    collector.on("collect", async (interaction) => {
      const optionId = interaction.customId.replace("perm_", "");
      await interaction.update({ components: [] }); // disable buttons
      collector.stop("selected");
      resolve({ outcome: "selected", optionId });
    });

    collector.on("end", (_collected, reason) => {
      if (reason === "time") {
        msg.edit({ components: [] }).catch(() => {});
        resolve({ outcome: "cancelled" });
      }
    });
  });
}
