import {
  BedrockClient,
  ListFoundationModelsCommand,
  type ListFoundationModelsCommandOutput,
  ListInferenceProfilesCommand,
  type ListInferenceProfilesCommandOutput,
} from "@aws-sdk/client-bedrock";
import type { BedrockDiscoveryConfig, ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("bedrock-discovery");

const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const DEFAULT_CONTEXT_WINDOW = 32000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type BedrockModelSummary = NonNullable<ListFoundationModelsCommandOutput["modelSummaries"]>[number];

type BedrockInferenceProfileSummary = NonNullable<
  ListInferenceProfilesCommandOutput["inferenceProfileSummaries"]
>[number];

type BedrockDiscoveryCacheEntry = {
  expiresAt: number;
  value?: ModelDefinitionConfig[];
  inFlight?: Promise<ModelDefinitionConfig[]>;
};

const discoveryCache = new Map<string, BedrockDiscoveryCacheEntry>();
let hasLoggedBedrockError = false;

function normalizeProviderFilter(filter?: string[]): string[] {
  if (!filter || filter.length === 0) {
    return [];
  }
  const normalized = new Set(
    filter.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0),
  );
  return Array.from(normalized).toSorted();
}

function buildCacheKey(params: {
  region: string;
  providerFilter: string[];
  refreshIntervalSeconds: number;
  defaultContextWindow: number;
  defaultMaxTokens: number;
}): string {
  return JSON.stringify(params);
}

function includesTextModalities(modalities?: Array<string>): boolean {
  return (modalities ?? []).some((entry) => entry.toLowerCase() === "text");
}

function isActive(summary: BedrockModelSummary): boolean {
  const status = summary.modelLifecycle?.status;
  return typeof status === "string" ? status.toUpperCase() === "ACTIVE" : false;
}

function mapInputModalities(summary: BedrockModelSummary): Array<"text" | "image"> {
  const inputs = summary.inputModalities ?? [];
  const mapped = new Set<"text" | "image">();
  for (const modality of inputs) {
    const lower = modality.toLowerCase();
    if (lower === "text") {
      mapped.add("text");
    }
    if (lower === "image") {
      mapped.add("image");
    }
  }
  if (mapped.size === 0) {
    mapped.add("text");
  }
  return Array.from(mapped);
}

function inferReasoningSupport(summary: BedrockModelSummary): boolean {
  const haystack = `${summary.modelId ?? ""} ${summary.modelName ?? ""}`.toLowerCase();
  return haystack.includes("reasoning") || haystack.includes("thinking");
}

function resolveDefaultContextWindow(config?: BedrockDiscoveryConfig): number {
  const value = Math.floor(config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
  return value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}

function resolveDefaultMaxTokens(config?: BedrockDiscoveryConfig): number {
  const value = Math.floor(config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS);
  return value > 0 ? value : DEFAULT_MAX_TOKENS;
}

function matchesProviderFilter(summary: BedrockModelSummary, filter: string[]): boolean {
  if (filter.length === 0) {
    return true;
  }
  const providerName =
    summary.providerName ??
    (typeof summary.modelId === "string" ? summary.modelId.split(".")[0] : undefined);
  const normalized = providerName?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return filter.includes(normalized);
}

function shouldIncludeSummary(summary: BedrockModelSummary, filter: string[]): boolean {
  if (!summary.modelId?.trim()) {
    return false;
  }
  if (!matchesProviderFilter(summary, filter)) {
    return false;
  }
  if (summary.responseStreamingSupported !== true) {
    return false;
  }
  if (!includesTextModalities(summary.outputModalities)) {
    return false;
  }
  if (!isActive(summary)) {
    return false;
  }
  return true;
}

function toModelDefinition(
  summary: BedrockModelSummary,
  defaults: { contextWindow: number; maxTokens: number },
): ModelDefinitionConfig {
  const id = summary.modelId?.trim() ?? "";
  return {
    id,
    name: summary.modelName?.trim() || id,
    reasoning: inferReasoningSupport(summary),
    input: mapInputModalities(summary),
    cost: DEFAULT_COST,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

export function resetBedrockDiscoveryCacheForTest(): void {
  discoveryCache.clear();
  hasLoggedBedrockError = false;
}

function profileProviderName(id: string): string | undefined {
  // Strip cross-region routing prefix (us. / eu. / apac. / global. ...) then take provider segment.
  const segments = id.split(".");
  if (segments.length >= 3) {
    return segments[1];
  }
  if (segments.length === 2) {
    return segments[0];
  }
  return undefined;
}

function matchesProfileProviderFilter(id: string, filter: string[]): boolean {
  if (filter.length === 0) {
    return true;
  }
  const provider = profileProviderName(id)?.trim().toLowerCase();
  return provider ? filter.includes(provider) : false;
}

function inferProfileReasoning(id: string, name: string): boolean {
  const haystack = `${id} ${name}`.toLowerCase();
  return (
    haystack.includes("reasoning") ||
    haystack.includes("thinking") ||
    haystack.includes("gpt-6") ||
    haystack.includes("gpt-5.6")
  );
}

function inferProfileInput(id: string, name: string): Array<"text" | "image"> {
  const haystack = `${id} ${name}`.toLowerCase();
  // OpenAI GPT-6 series on Bedrock accept text + image.
  if (haystack.includes("openai") && haystack.includes("gpt-6")) {
    return ["text", "image"];
  }
  return ["text"];
}

function shouldIncludeProfile(
  summary: BedrockInferenceProfileSummary,
  filter: string[],
): boolean {
  const id = summary.inferenceProfileId?.trim();
  if (!id) {
    return false;
  }
  if (typeof summary.status === "string" && summary.status.toUpperCase() !== "ACTIVE") {
    return false;
  }
  return matchesProfileProviderFilter(id, filter);
}

function profileToModelDefinition(
  summary: BedrockInferenceProfileSummary,
  defaults: { contextWindow: number; maxTokens: number },
): ModelDefinitionConfig {
  const id = summary.inferenceProfileId?.trim() ?? "";
  const name = summary.inferenceProfileName?.trim() || id;
  return {
    id,
    name,
    reasoning: inferProfileReasoning(id, name),
    input: inferProfileInput(id, name),
    cost: DEFAULT_COST,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

export async function discoverBedrockModels(params: {
  region: string;
  config?: BedrockDiscoveryConfig;
  now?: () => number;
  clientFactory?: (region: string) => BedrockClient;
}): Promise<ModelDefinitionConfig[]> {
  const refreshIntervalSeconds = Math.max(
    0,
    Math.floor(params.config?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS),
  );
  const providerFilter = normalizeProviderFilter(params.config?.providerFilter);
  const defaultContextWindow = resolveDefaultContextWindow(params.config);
  const defaultMaxTokens = resolveDefaultMaxTokens(params.config);
  const cacheKey = buildCacheKey({
    region: params.region,
    providerFilter,
    refreshIntervalSeconds,
    defaultContextWindow,
    defaultMaxTokens,
  });
  const now = params.now?.() ?? Date.now();

  if (refreshIntervalSeconds > 0) {
    const cached = discoveryCache.get(cacheKey);
    if (cached?.value && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached?.inFlight) {
      return cached.inFlight;
    }
  }

  const clientFactory = params.clientFactory ?? ((region: string) => new BedrockClient({ region }));
  const client = clientFactory(params.region);

  const discoveryPromise = (async () => {
    const byId = new Map<string, ModelDefinitionConfig>();

    // Foundation models (base IDs). Many newer models are INFERENCE_PROFILE-only and
    // are not directly invocable, but we keep the existing gating for backward compat.
    const foundationResponse = await client.send(new ListFoundationModelsCommand({}));
    for (const summary of foundationResponse.modelSummaries ?? []) {
      if (!shouldIncludeSummary(summary, providerFilter)) {
        continue;
      }
      const def = toModelDefinition(summary, {
        contextWindow: defaultContextWindow,
        maxTokens: defaultMaxTokens,
      });
      byId.set(def.id, def);
    }

    // Cross-region inference profiles (us.* / global.* etc). These are the invocable
    // IDs for INFERENCE_PROFILE-only models (e.g. OpenAI GPT-6 series). Prefer the
    // profile definition when an ID collides (it is the invocable one).
    try {
      let nextToken: string | undefined;
      do {
        const profileResponse: ListInferenceProfilesCommandOutput = await client.send(
          new ListInferenceProfilesCommand({
            typeEquals: "SYSTEM_DEFINED",
            ...(nextToken ? { nextToken } : {}),
          }),
        );
        for (const summary of profileResponse.inferenceProfileSummaries ?? []) {
          if (!shouldIncludeProfile(summary, providerFilter)) {
            continue;
          }
          const def = profileToModelDefinition(summary, {
            contextWindow: defaultContextWindow,
            maxTokens: defaultMaxTokens,
          });
          byId.set(def.id, def);
        }
        nextToken = profileResponse.nextToken;
      } while (nextToken);
    } catch (error) {
      if (!hasLoggedBedrockError) {
        hasLoggedBedrockError = true;
        log.warn(`Failed to list inference profiles: ${String(error)}`);
      }
    }

    return Array.from(byId.values()).toSorted((a, b) => a.name.localeCompare(b.name));
  })();

  if (refreshIntervalSeconds > 0) {
    discoveryCache.set(cacheKey, {
      expiresAt: now + refreshIntervalSeconds * 1000,
      inFlight: discoveryPromise,
    });
  }

  try {
    const value = await discoveryPromise;
    if (refreshIntervalSeconds > 0) {
      discoveryCache.set(cacheKey, {
        expiresAt: now + refreshIntervalSeconds * 1000,
        value,
      });
    }
    return value;
  } catch (error) {
    if (refreshIntervalSeconds > 0) {
      discoveryCache.delete(cacheKey);
    }
    if (!hasLoggedBedrockError) {
      hasLoggedBedrockError = true;
      log.warn(`Failed to list models: ${String(error)}`);
    }
    return [];
  }
}
