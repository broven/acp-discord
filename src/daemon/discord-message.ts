import { MessageType, type Message } from "discord.js";

export function shouldHandleDiscordMessage(message: Pick<Message, "system" | "type">): boolean {
  if (message.system) return false;
  return message.type === MessageType.Default || message.type === MessageType.Reply;
}
