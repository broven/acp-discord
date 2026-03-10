import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

export interface DiffContent {
  path: string;
  oldText?: string | null;
  newText: string;
}

export interface AcpEventHandlers {
  onToolCall(channelId: string, toolCallId: string, title: string, kind: string, status: string, diffs: DiffContent[]): void;
  onToolCallUpdate(channelId: string, toolCallId: string, status: string, diffs: DiffContent[]): void;
  onAgentMessageChunk(channelId: string, text: string): void;
  onPermissionRequest(
    channelId: string,
    requestorId: string,
    toolCall: { toolCallId: string; title: string; kind: string },
    options: Array<{ optionId: string; name: string; kind: string }>,
    diffs: DiffContent[],
  ): Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }>;
  onPromptComplete(channelId: string, stopReason: string): void;
}

export function createAcpClient(
  channelId: string,
  handlers: AcpEventHandlers,
  getRequestorId: () => string,
): Client {
  return {
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const diffs = extractDiffs((params.toolCall as { content?: unknown }).content);
      const result = await handlers.onPermissionRequest(
        channelId,
        getRequestorId(),
        {
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? "Unknown",
          kind: params.toolCall.kind ?? "other",
        },
        params.options.map((o: { optionId: string; name: string; kind: string }) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
        diffs,
      );

      if (result.outcome === "selected") {
        return { outcome: { outcome: "selected", optionId: result.optionId } };
      }
      return { outcome: { outcome: "cancelled" } };
    },

    async sessionUpdate(params: SessionNotification): Promise<void> {
      const update = params.update;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          if (update.content.type === "text") {
            handlers.onAgentMessageChunk(channelId, update.content.text);
          }
          break;
        }
        case "tool_call": {
          const toolCallDiffs = extractDiffs(update.content);
          handlers.onToolCall(
            channelId,
            update.toolCallId,
            update.title ?? "Unknown",
            update.kind ?? "other",
            update.status ?? "pending",
            toolCallDiffs,
          );
          break;
        }
        case "tool_call_update": {
          const updateDiffs = extractDiffs(update.content);
          handlers.onToolCallUpdate(
            channelId,
            update.toolCallId,
            update.status ?? "in_progress",
            updateDiffs,
          );
          break;
        }
      }
    },
  };
}

function extractDiffs(content: unknown): DiffContent[] {
  if (!Array.isArray(content)) return [];
  const diffs: DiffContent[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && "type" in item && item.type === "diff") {
      const { path, oldText, newText } = item as Record<string, unknown>;
      if (typeof path !== "string" || typeof newText !== "string") continue;
      if (oldText !== undefined && oldText !== null && typeof oldText !== "string") continue;
      diffs.push({ path, oldText: (oldText as string | null) ?? null, newText });
    }
  }
  return diffs;
}
