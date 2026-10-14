import {
  type BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { beforeEach, describe, expect, it, vi } from "vitest";

const foundationMock = vi.fn();
const profilesMock = vi.fn();
const sendMock = vi.fn((command: unknown) => {
  if (command instanceof ListInferenceProfilesCommand) {
    return profilesMock(command);
  }
  if (command instanceof ListFoundationModelsCommand) {
    return foundationMock(command);
  }
  throw new Error(`Unexpected command: ${String(command)}`);
});
const clientFactory = () => ({ send: sendMock }) as unknown as BedrockClient;

const baseActiveAnthropicSummary = {
  modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
  modelName: "Claude 3.7 Sonnet",
  providerName: "anthropic",
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  responseStreamingSupported: true,
  modelLifecycle: { status: "ACTIVE" },
};

async function loadDiscovery() {
  const mod = await import("./bedrock-discovery.js");
  mod.resetBedrockDiscoveryCacheForTest();
  return mod;
}

function mockFoundationSummaries(summaries: unknown[]): void {
  foundationMock.mockResolvedValueOnce({ modelSummaries: summaries });
}

function mockInferenceProfiles(summaries: unknown[] = []): void {
  profilesMock.mockResolvedValueOnce({ inferenceProfileSummaries: summaries });
}

function mockSingleActiveSummary(overrides: Partial<typeof baseActiveAnthropicSummary> = {}): void {
  mockFoundationSummaries([{ ...baseActiveAnthropicSummary, ...overrides }]);
  mockInferenceProfiles([]);
}

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockClear();
    foundationMock.mockReset();
    profilesMock.mockReset();
    // Default: no inference profiles unless a test overrides.
    profilesMock.mockResolvedValue({ inferenceProfileSummaries: [] });
  });

  it("filters to active streaming text models and maps modalities", async () => {
    const { discoverBedrockModels } = await loadDiscovery();

    mockFoundationSummaries([
      {
        modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
        modelName: "Claude 3.7 Sonnet",
        providerName: "anthropic",
        inputModalities: ["TEXT", "IMAGE"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "ACTIVE" },
      },
      {
        modelId: "anthropic.claude-3-haiku-20240307-v1:0",
        modelName: "Claude 3 Haiku",
        providerName: "anthropic",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: false,
        modelLifecycle: { status: "ACTIVE" },
      },
      {
        modelId: "meta.llama3-8b-instruct-v1:0",
        modelName: "Llama 3 8B",
        providerName: "meta",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "INACTIVE" },
      },
      {
        modelId: "amazon.titan-embed-text-v1",
        modelName: "Titan Embed",
        providerName: "amazon",
        inputModalities: ["TEXT"],
        outputModalities: ["EMBEDDING"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "ACTIVE" },
      },
    ]);
    mockInferenceProfiles([]);

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
      name: "Claude 3.7 Sonnet",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 32000,
      maxTokens: 4096,
    });
  });

  it("discovers invocable inference profiles and maps GPT-6 reasoning/image support", async () => {
    const { discoverBedrockModels } = await loadDiscovery();

    mockFoundationSummaries([]);
    mockInferenceProfiles([
      {
        inferenceProfileId: "us.openai.gpt-6-sol",
        inferenceProfileName: "GPT-6 Sol",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
      },
      {
        inferenceProfileId: "global.openai.gpt-6-astra",
        inferenceProfileName: "GPT-6 Astra",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
      },
      {
        inferenceProfileId: "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        inferenceProfileName: "Claude 3.7 Sonnet (cross-region)",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
      },
    ]);

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    const gpt6Sol = models.find((m) => m.id === "us.openai.gpt-6-sol");
    expect(gpt6Sol).toMatchObject({
      id: "us.openai.gpt-6-sol",
      reasoning: true,
      input: ["text", "image"],
    });
    const astra = models.find((m) => m.id === "global.openai.gpt-6-astra");
    expect(astra).toMatchObject({ reasoning: true, input: ["text", "image"] });
    const claude = models.find((m) => m.id === "us.anthropic.claude-3-7-sonnet-20250219-v1:0");
    expect(claude).toMatchObject({ reasoning: false, input: ["text"] });
  });

  it("prefers inference profile id for INFERENCE_PROFILE-only models", async () => {
    const { discoverBedrockModels } = await loadDiscovery();

    mockFoundationSummaries([]);
    mockInferenceProfiles([
      {
        inferenceProfileId: "us.openai.gpt-6-sol",
        inferenceProfileName: "GPT-6 Sol",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
      },
    ]);

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models.map((m) => m.id)).toContain("us.openai.gpt-6-sol");
  });

  it("applies provider filter to profiles too", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    mockFoundationSummaries([{ ...baseActiveAnthropicSummary }]);
    mockInferenceProfiles([
      {
        inferenceProfileId: "us.openai.gpt-6-sol",
        inferenceProfileName: "GPT-6 Sol",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
      },
    ]);

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["anthropic"] },
      clientFactory,
    });
    expect(models.map((m) => m.id)).toEqual(["anthropic.claude-3-7-sonnet-20250219-v1:0"]);
  });

  it("applies provider filter", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    mockSingleActiveSummary();

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
      clientFactory,
    });
    expect(models).toHaveLength(0);
  });

  it("uses configured defaults for context and max tokens", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    mockSingleActiveSummary();

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { defaultContextWindow: 64000, defaultMaxTokens: 8192 },
      clientFactory,
    });
    expect(models[0]).toMatchObject({ contextWindow: 64000, maxTokens: 8192 });
  });

  it("caches results when refreshInterval is enabled", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    mockSingleActiveSummary();

    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(foundationMock).toHaveBeenCalledTimes(1);
  });

  it("skips cache when refreshInterval is 0", async () => {
    const { discoverBedrockModels } = await loadDiscovery();

    foundationMock
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] });

    await discoverBedrockModels({
      region: "us-east-1",
      config: { refreshInterval: 0 },
      clientFactory,
    });
    await discoverBedrockModels({
      region: "us-east-1",
      config: { refreshInterval: 0 },
      clientFactory,
    });
    expect(foundationMock).toHaveBeenCalledTimes(2);
  });
});

