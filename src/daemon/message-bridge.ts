import { createTwoFilesPatch } from "diff";
import type { DiffContent } from "./acp-client.js";

const DISCORD_MAX_LENGTH = 2000;
const MAX_DIFF_LINES = 150;

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
  tools: Map<string, { title: string; status: ToolStatus; rawInput?: Record<string, unknown> }>,
): string {
  const lines: string[] = [];
  for (const [, tool] of tools) {
    const detail = extractToolDetail(tool.rawInput) ?? extractDetailFromTitle(tool.title);
    const suffix = detail ? ` · \`${detail}\`` : "";
    lines.push(`${STATUS_ICONS[tool.status]} ${tool.title}${suffix}`);
  }
  return lines.join("\n");
}

const MAX_DETAIL_LENGTH = 80;

// Only display values from known-safe fields to avoid leaking secrets
const SAFE_FIELDS = ["command", "file_path", "pattern", "query", "path", "url", "description"];

// Substrings that mark a field as sensitive — matches "secret_key", "api_key", "access_token", etc.
const BLOCKED_SUBSTRINGS = ["token", "secret", "password", "key", "content", "new_string", "old_string", "credential", "auth"];

function isBlockedField(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_SUBSTRINGS.some((sub) => lower.includes(sub));
}

function extractToolDetail(rawInput?: Record<string, unknown>): string | null {
  if (!rawInput) return null;

  // Try known safe fields first
  for (const field of SAFE_FIELDS) {
    if (typeof rawInput[field] === "string" && rawInput[field]) {
      return truncate(sanitizeDetail(rawInput[field] as string), MAX_DETAIL_LENGTH);
    }
  }

  // Fallback: pick the first short string value from non-blocked fields
  for (const [fieldName, value] of Object.entries(rawInput)) {
    if (isBlockedField(fieldName)) continue;
    if (SAFE_FIELDS.includes(fieldName)) continue; // already checked
    if (typeof value === "string" && value.length > 0 && value.length < 100) {
      return truncate(sanitizeDetail(value), MAX_DETAIL_LENGTH);
    }
  }

  return null;
}

/**
 * Extract useful detail from the tool title when rawInput is unavailable.
 * Titles often look like "Read /path/to/file" or "Bash: ls -la" —
 * we extract the part after the first space or colon.
 */
function extractDetailFromTitle(title: string): string | null {
  if (!title) return null;

  // Pattern: "ToolName /path/or/arg" or "ToolName: something"
  const colonMatch = title.match(/^[^:]+:\s*(.+)/);
  if (colonMatch) {
    return truncate(sanitizeDetail(colonMatch[1].trim()), MAX_DETAIL_LENGTH);
  }

  // Pattern: "ToolName /some/path" — extract if second part looks like a path or command
  const spaceIdx = title.indexOf(" ");
  if (spaceIdx > 0 && spaceIdx < title.length - 1) {
    const rest = title.slice(spaceIdx + 1).trim();
    // Only extract if it looks like a path, URL, or meaningful argument
    if (rest.startsWith("/") || rest.startsWith("./") || rest.startsWith("http") || rest.includes(".")) {
      return truncate(sanitizeDetail(rest), MAX_DETAIL_LENGTH);
    }
  }

  return null;
}

function sanitizeDetail(text: string): string {
  return text.replace(/`/g, "'");
}

function truncate(text: string, max: number): string {
  // Use first line only for multiline values
  const firstLine = text.split("\n")[0];
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1) + "\u2026";
}

export function formatDiff(diffs: DiffContent[], maxLines = MAX_DIFF_LINES): string[] {
  if (diffs.length === 0) return [];

  const parts: string[] = [];

  for (const d of diffs) {
    const fileName = d.path.split("/").pop() ?? d.path;
    const oldText = d.oldText ?? "";
    const patch = createTwoFilesPatch(
      d.oldText == null ? "/dev/null" : d.path,
      d.path,
      oldText,
      d.newText,
      undefined,
      undefined,
      { context: 3 },
    );

    // Remove the first two header lines (Index: and ===) if present, keep ---/+++ and hunks
    const patchLines = patch.split("\n");
    // Find the first --- line to start from
    const startIdx = patchLines.findIndex((l) => l.startsWith("---"));
    const diffLines = startIdx >= 0 ? patchLines.slice(startIdx) : patchLines;

    let truncated = false;
    let displayLines = diffLines;
    if (diffLines.length > maxLines) {
      displayLines = diffLines.slice(0, maxLines);
      truncated = true;
    }

    let block = `**${fileName}**\n\`\`\`diff\n${displayLines.join("\n")}\n\`\`\``;
    if (truncated) {
      block += `\n*... ${diffLines.length - maxLines} more lines*`;
    }

    parts.push(block);
  }

  // Join all diff blocks and split for Discord's message limit
  const fullMessage = parts.join("\n\n");
  return splitMessage(fullMessage);
}
