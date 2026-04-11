import { describe, expect, it } from "vitest";
import { MessageType } from "discord.js";
import { shouldHandleDiscordMessage } from "../discord-message.js";

describe("shouldHandleDiscordMessage", () => {
  it("accepts normal user messages", () => {
    expect(shouldHandleDiscordMessage({ system: false, type: MessageType.Default })).toBe(true);
    expect(shouldHandleDiscordMessage({ system: false, type: MessageType.Reply })).toBe(true);
  });

  it("ignores system and thread starter messages", () => {
    expect(shouldHandleDiscordMessage({ system: true, type: MessageType.Default })).toBe(false);
    expect(shouldHandleDiscordMessage({ system: false, type: MessageType.ThreadStarterMessage })).toBe(false);
  });
});
