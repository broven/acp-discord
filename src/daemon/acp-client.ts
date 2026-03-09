import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

export interface AcpEventHandlers {
  onToolCall(channelId: string, toolCallId: string, title: string, kind: string, status: string): void;
  onToolCallUpdate(channelId: string, toolCallId: string, status: string): void;
  onAgentMessageChunk(channelId: string, text: string): void;
  onPermissionRequest(
    channelId: string,
    requestorId: string,
    toolCall: { toolCallId: string; title: string; kind: string },
    options: Array<{ optionId: string; name: string; kind: string }>,
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
          handlers.onToolCall(
            channelId,
            update.toolCallId,
            update.title ?? "Unknown",
            update.kind ?? "other",
            update.status ?? "pending",
          );
          break;
        }
        case "tool_call_update": {
          handlers.onToolCallUpdate(
            channelId,
            update.toolCallId,
            update.status ?? "in_progress",
          );
          break;
        }
      }
    },
  };
}
