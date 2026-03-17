import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    !!message &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

/**
 * Strip all `type: "thinking"` content blocks from assistant messages,
 * EXCEPT for the latest assistant message.
 *
 * Claude API requires that thinking/redacted_thinking blocks in the latest
 * assistant message be preserved exactly as returned. Modifying them causes:
 * "thinking or redacted_thinking blocks in the latest assistant message cannot be modified"
 *
 * If an assistant message becomes empty after stripping, it is replaced with
 * a synthetic `{ type: "text", text: "" }` block to preserve turn structure
 * (some providers require strict user/assistant alternation).
 *
 * Returns the original array reference when nothing was changed (callers can
 * use reference equality to skip downstream work).
 */
export function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  // Find index of the last assistant message - we must NOT modify this one
  // because Claude API requires thinking blocks in the latest assistant turn
  // to be preserved exactly.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistantMessageWithContent(messages[i])) {
      lastAssistantIdx = i;
      break;
    }
  }

  let touched = false;
  const out: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // Never strip thinking blocks from the latest assistant message
    if (i === lastAssistantIdx) {
      out.push(msg);
      continue;
    }
    if (!isAssistantMessageWithContent(msg)) {
      out.push(msg);
      continue;
    }
    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of msg.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") {
        touched = true;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }
    if (!changed) {
      out.push(msg);
      continue;
    }
    // Preserve the assistant turn even if all blocks were thinking-only.
    const content =
      nextContent.length > 0 ? nextContent : [{ type: "text", text: "" } as AssistantContentBlock];
    out.push({ ...msg, content });
  }
  return touched ? out : messages;
}
