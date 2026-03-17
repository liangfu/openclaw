import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { dropThinkingBlocks, isAssistantMessageWithContent } from "./thinking.js";

describe("isAssistantMessageWithContent", () => {
  it("accepts assistant messages with array content and rejects others", () => {
    const assistant = castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    const user = castAgentMessage({ role: "user", content: "hi" });
    const malformed = castAgentMessage({ role: "assistant", content: "not-array" });

    expect(isAssistantMessageWithContent(assistant)).toBe(true);
    expect(isAssistantMessageWithContent(user)).toBe(false);
    expect(isAssistantMessageWithContent(malformed)).toBe(false);
  });
});

describe("dropThinkingBlocks", () => {
  it("returns the original reference when no thinking blocks are present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "world" }] }),
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("drops thinking blocks from historical assistant messages while preserving non-thinking content", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "historical" },
        ],
      }),
      castAgentMessage({ role: "user", content: "follow-up" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "latest" }],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const historical = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(result).not.toBe(messages);
    expect(historical.content).toEqual([{ type: "text", text: "historical" }]);
  });

  it("keeps assistant turn structure when all content blocks were thinking", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal-only" }],
      }),
      castAgentMessage({ role: "user", content: "next" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "latest" }],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const historical = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(historical.content).toEqual([{ type: "text", text: "" }]);
  });

  it("preserves thinking blocks in the latest assistant message (Claude API requirement)", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "my reasoning" },
          { type: "text", text: "my response" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    // Should return original reference since the only assistant message is the latest
    expect(result).toBe(messages);
  });

  it("drops thinking from historical but preserves in latest assistant message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning" },
          { type: "text", text: "old response" },
        ],
      }),
      castAgentMessage({ role: "user", content: "follow-up question" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "new reasoning - must be preserved" },
          { type: "text", text: "new response" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).not.toBe(messages);

    // Historical assistant message should have thinking stripped
    const historical = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(historical.content).toEqual([{ type: "text", text: "old response" }]);

    // Latest assistant message should be preserved exactly
    const latest = result[2] as Extract<AgentMessage, { role: "assistant" }>;
    expect(latest.content).toEqual([
      { type: "thinking", thinking: "new reasoning - must be preserved" },
      { type: "text", text: "new response" },
    ]);
  });

  it("preserves thinking in the last assistant message even when user message follows", () => {
    // When user sends a new message, the previous assistant message is still
    // the "latest assistant message" and its thinking blocks must be preserved
    // because Claude may continue from that context.
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "text", text: "response" },
        ],
      }),
      castAgentMessage({ role: "user", content: "new question" }),
    ];

    const result = dropThinkingBlocks(messages);
    // Should return original - the only assistant message is the latest
    expect(result).toBe(messages);
  });

  it("strips thinking from earlier assistant when multiple exist before user message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning" },
          { type: "text", text: "old response" },
        ],
      }),
      castAgentMessage({ role: "user", content: "middle question" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "newer reasoning - preserve this" },
          { type: "text", text: "newer response" },
        ],
      }),
      castAgentMessage({ role: "user", content: "latest question" }),
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).not.toBe(messages);

    // First assistant message should have thinking stripped
    const first = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(first.content).toEqual([{ type: "text", text: "old response" }]);

    // Second assistant message (the latest) should preserve thinking
    const second = result[2] as Extract<AgentMessage, { role: "assistant" }>;
    expect(second.content).toEqual([
      { type: "thinking", thinking: "newer reasoning - preserve this" },
      { type: "text", text: "newer response" },
    ]);
  });
});
