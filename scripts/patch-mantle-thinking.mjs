/**
 * Post-install patch: Make pi-ai's supportsAdaptiveThinking() recognize all
 * Claude 4.x models (not just 4.6) for bedrock-mantle compatibility.
 *
 * bedrock-mantle requires thinking.type="adaptive" for all Claude models,
 * but pi-ai only sends it for opus-4-6/sonnet-4-6.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const files = execSync(
  "find node_modules/.pnpm -path '*pi-ai*/dist/providers/anthropic.js'",
  { encoding: "utf8" }
).trim().split("\n").filter(Boolean);

if (files.length === 0) {
  console.log("[patch-mantle-thinking] pi-ai anthropic provider not found, skipping");
  process.exit(0);
}

const oldFn = `function supportsAdaptiveThinking(modelId) {
    // Opus 4.6 and Sonnet 4.6 model IDs (with or without date suffix)
    return (modelId.includes("opus-4-6") ||
        modelId.includes("opus-4.6") ||
        modelId.includes("sonnet-4-6") ||
        modelId.includes("sonnet-4.6"));
}`;

const newFn = `function supportsAdaptiveThinking(modelId) {
    // All Claude 4.x models support adaptive thinking (required by bedrock-mantle)
    return (modelId.includes("opus-4") ||
        modelId.includes("sonnet-4") ||
        modelId.includes("haiku-4"));
}`;

let patched = 0;
for (const piAiFile of files) {
  if (!existsSync(piAiFile)) continue;
  let content = readFileSync(piAiFile, "utf8");
  if (content.includes(oldFn)) {
    content = content.replace(oldFn, newFn);
    writeFileSync(piAiFile, content);
    console.log(`[patch-mantle-thinking] Patched: ${piAiFile}`);
    patched++;
  } else if (content.includes("All Claude 4.x")) {
    console.log(`[patch-mantle-thinking] Already patched: ${piAiFile}`);
  } else {
    console.log(`[patch-mantle-thinking] WARNING: unexpected content in ${piAiFile}`);
  }
}
if (patched === 0) {
  console.log("[patch-mantle-thinking] All files already patched or no matching code found");
}
