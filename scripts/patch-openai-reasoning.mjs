import { execSync } from "child_process";
/**
 * Post-install patch: Add OpenAI (GPT-6 / GPT-5.6 / GPT-5.x) reasoning support
 * to pi-ai's amazon-bedrock.js (bedrock-runtime Converse API).
 *
 * Two gaps in pi-ai's Bedrock provider for OpenAI models:
 *
 * 1. buildAdditionalModelRequestFields() only handles anthropic.claude models
 *    and returns undefined for everything else, so reasoning effort can never
 *    be sent for OpenAI models. OpenAI on Bedrock expects:
 *      additionalModelRequestFields: { reasoning: { effort: "none|low|medium|high|xhigh" } }
 *    (verified live against us.openai.gpt-6-sol via the Converse API).
 *
 * 2. The streaming reasoningContent handler only reads `.text` / `.signature`.
 *    OpenAI GPT-6 emits reasoningContent.redactedContent (base64), which was
 *    silently dropped. We accumulate it onto the thinking block so the
 *    reasoning block is preserved end-to-end.
 *
 * Idempotent: re-running detects the "OpenAI reasoning effort" marker and skips.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

const MARKER = "OpenAI reasoning effort"; // idempotency sentinel

// --- Patch 1: reasoning effort for OpenAI models -------------------------
// Anchor: the final `return undefined;` that closes buildAdditionalModelRequestFields,
// which immediately follows the closing `}` of the anthropic.claude branch.
const effortAnchor = `        return result;
    }
    return undefined;
}`;

const effortReplacement = `        return result;
    }
    // OpenAI reasoning effort (GPT-6 / GPT-5.6 / GPT-5.x on Bedrock Converse API).
    if (model.id.includes("openai.") || model.id.includes("openai/")) {
        const level = options.reasoning;
        const effort = level === "minimal" ? "low" : level;
        return { reasoning: { effort } };
    }
    return undefined;
}`;

// --- Patch 2: preserve OpenAI redactedContent reasoning ------------------
const redactedAnchor = `            if (delta.reasoningContent.signature) {
                thinkingBlock.thinkingSignature =
                    (thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
            }`;

const redactedReplacement = `            if (delta.reasoningContent.signature) {
                thinkingBlock.thinkingSignature =
                    (thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
            }
            // OpenAI GPT-6 emits redactedContent (base64) instead of text; keep it on the signature.
            if (delta.reasoningContent.redactedContent) {
                const red = typeof delta.reasoningContent.redactedContent === "string"
                    ? delta.reasoningContent.redactedContent
                    : Buffer.from(delta.reasoningContent.redactedContent).toString("base64");
                thinkingBlock.thinkingSignature =
                    (thinkingBlock.thinkingSignature || "") + red;
            }`;

function patchFile(filePath) {
  if (!existsSync(filePath)) {
    return false;
  }
  let content = readFileSync(filePath, "utf8");
  if (content.includes(MARKER)) {
    console.log(`[patch-openai-reasoning] Already patched: ${filePath}`);
    return false;
  }
  let changed = false;
  if (content.includes(effortAnchor)) {
    content = content.replace(effortAnchor, effortReplacement);
    changed = true;
  } else {
    console.log(`[patch-openai-reasoning] WARNING: effort anchor not found in ${filePath}`);
  }
  if (content.includes(redactedAnchor)) {
    content = content.replace(redactedAnchor, redactedReplacement);
    changed = true;
  } else {
    console.log(`[patch-openai-reasoning] WARNING: redacted anchor not found in ${filePath}`);
  }
  if (changed) {
    writeFileSync(filePath, content);
    console.log(`[patch-openai-reasoning] Patched: ${filePath}`);
    return true;
  }
  return false;
}

const bedrockFiles = execSync(
  "find node_modules/.pnpm -path '*pi-ai*/dist/providers/amazon-bedrock.js' 2>/dev/null || true",
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

if (bedrockFiles.length === 0) {
  console.log("[patch-openai-reasoning] pi-ai amazon-bedrock.js not found, skipping");
  process.exit(0);
}

let patched = 0;
for (const file of bedrockFiles) {
  if (patchFile(file)) {
    patched++;
  }
}

if (patched === 0) {
  console.log("[patch-openai-reasoning] All files already patched or no matching code found");
} else {
  console.log(`[patch-openai-reasoning] Successfully patched ${patched} file(s)`);
}
