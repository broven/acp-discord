const DISCORD_MAX_LENGTH = 2000;

export function splitMessage(text: string, maxLength = DISCORD_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeFence = "";

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find split point: prefer newline before maxLength
    let splitAt = maxLength;
    const lastNewline = remaining.lastIndexOf("\n", maxLength);
    if (lastNewline > maxLength * 0.5) {
      splitAt = lastNewline + 1;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Handle code blocks: count fences in this chunk
    const fenceMatches = chunk.match(/```\w*/g) || [];
    for (const fence of fenceMatches) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = fence;
      } else {
        inCodeBlock = false;
        codeFence = "";
      }
    }

    // If we're inside a code block at the split, close and reopen
    if (inCodeBlock) {
      chunk += "\n```";
      remaining = codeFence + "\n" + remaining;
      inCodeBlock = false;
      codeFence = "";
    }

    chunks.push(chunk);
  }

  return chunks;
}

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

const STATUS_ICONS: Record<ToolStatus, string> = {
  pending: "\u23F3",     // ⏳
  in_progress: "\uD83D\uDD04", // 🔄
  completed: "\u2705",   // ✅
  failed: "\u274C",      // ❌
};

export function formatToolSummary(
  tools: Map<string, { title: string; status: ToolStatus }>,
): string {
  const lines: string[] = [];
  for (const [, tool] of tools) {
    lines.push(`${STATUS_ICONS[tool.status]} ${tool.title}`);
  }
  return lines.join("\n");
}
