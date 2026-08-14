import { execSync } from "child_process";
/**
 * Post-install patch: Make pi-ai's supportsAdaptiveThinking() recognize all
 * Claude 4.x models (not just 4.6) for bedrock compatibility.
 *
 * Both bedrock-runtime (Converse API) and bedrock-mantle require
 * thinking.type="adaptive" for Claude 4.7+ models, but pi-ai only sends it
 * for opus-4-6/sonnet-4-6.
 *
 * This patch updates both anthropic.js (for bedrock-mantle) and
 * amazon-bedrock.js (for bedrock-runtime Converse API).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

// Pattern for anthropic.js (includes comment)
const oldFnAnthropicWithComment = `function supportsAdaptiveThinking(modelId) {
    // Opus 4.6 and Sonnet 4.6 model IDs (with or without date suffix)
    return (modelId.includes("opus-4-6") ||
        modelId.includes("opus-4.6") ||
        modelId.includes("sonnet-4-6") ||
        modelId.includes("sonnet-4.6"));
}`;

// Pattern for amazon-bedrock.js (no comment)
const oldFnBedrockNoComment = `function supportsAdaptiveThinking(modelId) {
    return (modelId.includes("opus-4-6") ||
        modelId.includes("opus-4.6") ||
        modelId.includes("sonnet-4-6") ||
        modelId.includes("sonnet-4.6"));
}`;

const newFnWithComment = `function supportsAdaptiveThinking(modelId) {
    // All Claude 4.x models support adaptive thinking (required by bedrock-mantle and bedrock-runtime)
    return (modelId.includes("opus-4") ||
        modelId.includes("sonnet-4") ||
        modelId.includes("haiku-4"));
}`;

function patchFile(filePath, oldPatterns, newContent) {
  if (!existsSync(filePath)) {
    return false;
  }

  let content = readFileSync(filePath, "utf8");

  // Check if already patched
  if (content.includes("All Claude 4.x")) {
    console.log(`[patch-mantle-thinking] Already patched: ${filePath}`);
    return false;
  }

  // Try each old pattern
  for (const oldPattern of oldPatterns) {
    if (content.includes(oldPattern)) {
      content = content.replace(oldPattern, newContent);
      writeFileSync(filePath, content);
      console.log(`[patch-mantle-thinking] Patched: ${filePath}`);
      return true;
    }
  }

  console.log(`[patch-mantle-thinking] WARNING: unexpected content in ${filePath}`);
  return false;
}

// Find and patch anthropic.js files
const anthropicFiles = execSync(
  "find node_modules/.pnpm -path '*pi-ai*/dist/providers/anthropic.js' 2>/dev/null || true",
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

// Find and patch amazon-bedrock.js files
const bedrockFiles = execSync(
  "find node_modules/.pnpm -path '*pi-ai*/dist/providers/amazon-bedrock.js' 2>/dev/null || true",
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

if (anthropicFiles.length === 0 && bedrockFiles.length === 0) {
  console.log("[patch-mantle-thinking] pi-ai provider files not found, skipping");
  process.exit(0);
}

let patched = 0;

// Patch anthropic.js files
for (const file of anthropicFiles) {
  if (patchFile(file, [oldFnAnthropicWithComment, oldFnBedrockNoComment], newFnWithComment)) {
    patched++;
  }
}

// Patch amazon-bedrock.js files
for (const file of bedrockFiles) {
  if (patchFile(file, [oldFnBedrockNoComment, oldFnAnthropicWithComment], newFnWithComment)) {
    patched++;
  }
}

if (patched === 0) {
  console.log("[patch-mantle-thinking] All files already patched or no matching code found");
} else {
  console.log(`[patch-mantle-thinking] Successfully patched ${patched} file(s)`);
}
