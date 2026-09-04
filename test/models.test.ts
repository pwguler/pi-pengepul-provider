import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A minimal fetch stand-in. The real `fetch` type requires more (e.g. `preconnect`),
// so we build a partial implementation and cast once at the boundary.
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
  return impl as unknown as typeof fetch;
}

import {
  bareId,
  fetchPengepulModels,
  loadPengepulModels,
  modelsFromApiResponse,
  modelsFromCache,
  toProviderModelConfigs,
  type BuiltinModelLookup,
  type PengepulModel,
} from "../src/models.ts";

const API_BODY = {
  object: "list",
  data: [
    { id: "claude-sonnet-4-6", object: "model", created: 1, owned_by: "anthropic" },
    { id: "claude-opus-5", object: "model", created: 2, owned_by: "anthropic" },
    { id: "gpt-5.4", object: "model", created: 3, owned_by: "codex" },
  ],
};

describe("modelsFromApiResponse", () => {
  test("parses a valid list and splits dialect by id", () => {
    const models = modelsFromApiResponse(API_BODY);
    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({ id: "claude-sonnet-4-6", dialect: "anthropic-messages" });
    expect(models[2]).toMatchObject({ id: "gpt-5.4", dialect: "openai-completions" });
  });

  test("throws on a malformed body", () => {
    expect(() => modelsFromApiResponse({})).toThrow();
    expect(() => modelsFromApiResponse({ object: "list", data: [] })).toThrow();
  });

  test("reasoning defaults true for claude and gpt families", () => {
    const models = modelsFromApiResponse(API_BODY);
    expect(models.every((m) => m.reasoning === true)).toBe(true);
  });

  test("REGRESSION: prefixed ids inherit pi's builtin catalog metadata", () => {
    // The relay advertises `anthropic/claude-opus-5`; the first cut looked that
    // prefixed id up in a bare-keyed table, missed, and registered every model
    // as 200K/64K text-only. pi's catalog says 1M/128K with images.
    const body = {
      object: "list",
      data: [{ id: "anthropic/claude-opus-5", object: "model", owned_by: "anthropic" }],
    };
    const lookup: BuiltinModelLookup = (id) =>
      bareId(id) === "claude-opus-5"
        ? {
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            input: ["text", "image"],
            cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          }
        : undefined;

    const models = modelsFromApiResponse(body, lookup);
    expect(models[0]).toMatchObject({
      id: "anthropic/claude-opus-5",
      dialect: "anthropic-messages",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    });
  });

  test("pengepul's own metadata wins over pi's catalog", () => {
    // pengepul >= 0.6.0 advertises the numbers this relay actually serves.
    // For claude-opus-5 the relay says 200K/64K at $15 while pi's catalog
    // says 1M/128K at $5; the relay is first-party and wins.
    const body = {
      object: "list",
      data: [
        {
          id: "anthropic/claude-opus-5",
          object: "model",
          owned_by: "anthropic",
          context_window: 200_000,
          max_output_tokens: 64_000,
          input_modalities: ["text", "image"],
          pricing: {
            input_per_million: 15,
            output_per_million: 75,
            cache_read_per_million: 1.5,
            cache_write_per_million: 18.75,
          },
        },
      ],
    };
    const lookup: BuiltinModelLookup = () => ({
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ["text"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    });

    const models = modelsFromApiResponse(body, lookup);
    expect(models[0]).toMatchObject({
      contextWindow: 200_000,
      maxTokens: 64_000,
      input: ["text", "image"],
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    });
  });

  test("partial relay metadata merges over the catalog per field", () => {
    // The 0.6.0 rollout is partial: an entry may carry a window and nothing
    // else. The window comes from the relay, pricing from the catalog.
    const body = {
      object: "list",
      data: [
        {
          id: "anthropic/claude-sonnet-5",
          object: "model",
          owned_by: "anthropic",
          context_window: 1_000_000,
          max_output_tokens: 64_000,
        },
      ],
    };
    const lookup: BuiltinModelLookup = () => ({
      reasoning: true,
      contextWindow: 500_000,
      maxTokens: 128_000,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });

    const models = modelsFromApiResponse(body, lookup);
    expect(models[0]).toMatchObject({
      contextWindow: 1_000_000, // relay
      maxTokens: 64_000, // relay
      input: ["text", "image"], // catalog
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, // catalog
    });
  });

  test("REGRESSION: commandcode ids inherit reasoning from another catalog", () => {
    // pi searched only the `openai` catalog for openai-completions ids, so
    // `commandcode/deepseek/deepseek-v4-pro` missed (it lives under `deepseek`),
    // fell to the non-reasoning heuristic, and pi never sent reasoning params.
    const body = {
      object: "list",
      data: [{ id: "commandcode/deepseek/deepseek-v4-pro", object: "model", owned_by: "commandcode" }],
    };
    const lookup: BuiltinModelLookup = (id) =>
      id.slice(id.lastIndexOf("/") + 1) === "deepseek-v4-pro"
        ? {
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            input: ["text"],
            cost: { input: 0.27, output: 1.1, cacheRead: 0.027, cacheWrite: 0 },
            thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
          }
        : undefined;

    const models = modelsFromApiResponse(body, lookup);
    expect(models[0]).toMatchObject({
      id: "commandcode/deepseek/deepseek-v4-pro",
      dialect: "openai-completions",
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
    });
  });

  test("unknown ids fall back to family heuristics via the bare id", () => {
    const body = {
      object: "list",
      data: [{ id: "anthropic/claude-brand-new-9", object: "model", owned_by: "anthropic" }],
    };
    const models = modelsFromApiResponse(body, () => undefined); // pi does not know it
    expect(models[0]?.reasoning).toBe(true); // claude- family heuristic + owned_by
    expect(models[0]?.input).toEqual(["text"]);
  });
});

describe("toProviderModelConfigs", () => {
  test("assigns per-model base URL matching its dialect", () => {
    const models = modelsFromApiResponse(API_BODY);
    const configs = toProviderModelConfigs(models, "http://127.0.0.1:8317");
    const claude = configs.find((c) => c.id === "claude-sonnet-4-6");
    const gpt = configs.find((c) => c.id === "gpt-5.4");

    expect(claude?.api).toBe("anthropic-messages");
    expect(claude?.baseUrl).toBe("http://127.0.0.1:8317");

    expect(gpt?.api).toBe("openai-completions");
    expect(gpt?.baseUrl).toBe("http://127.0.0.1:8317/v1");
  });

  test("reasoning Claude models force adaptive thinking; OpenAI models do not", () => {
    const models = modelsFromApiResponse(API_BODY);
    const configs = toProviderModelConfigs(models, "http://127.0.0.1:8317");
    const claude = configs.find((c) => c.id === "claude-sonnet-4-6");
    const gpt = configs.find((c) => c.id === "gpt-5.4");

    expect(claude?.compat?.forceAdaptiveThinking).toBe(true);
    // "off" marked unsupported so pi omits the thinking param entirely —
    // the upstream rejects thinking:{type:"disabled"}.
    expect(claude?.thinkingLevelMap?.off).toBe(null);
    expect(gpt?.compat?.forceAdaptiveThinking).toBeUndefined();
  });

  test("picker label strips the relay prefix; the id stays exact", () => {
    const models = modelsFromApiResponse(API_BODY);
    const configs = toProviderModelConfigs(models, "http://127.0.0.1:8317");
    const prefixed = configs.find((c) => c.id === "claude-sonnet-4-6");
    expect(prefixed?.name).toBe("claude-sonnet-4-6 (pengepul)");
  });
});

describe("modelsFromCache", () => {
  test("round-trips through the cache envelope", () => {
    const models = modelsFromApiResponse(API_BODY);
    const cached = modelsFromCache({
      version: 3,
      models: models.map((m) => ({ ...m })),
    });
    expect(cached).toHaveLength(3);
    expect(cached[0]?.dialect).toBe("anthropic-messages");
    expect(cached[0]?.input).toEqual(["text"]);
  });

  test("throws on a wrong cache version (stale v1 windows are rejected)", () => {
    expect(() => modelsFromCache({ version: 2, models: [] })).toThrow();
  });
});

describe("fetchPengepulModels", () => {
  test("sends x-api-key and returns parsed models", async () => {
    let sentHeaders: Record<string, string> | undefined;
    const fetchImpl = mockFetch(async (url, init) => {
      sentHeaders = init?.headers as Record<string, string>;
      return { ok: true, status: 200, json: async () => API_BODY };
    });

    const models = await fetchPengepulModels({
      url: "http://127.0.0.1:8317/v1/models",
      apiKey: "sk-local-abc",
      fetchImpl,
    });
    expect(models).toHaveLength(3);
    expect(sentHeaders?.["x-api-key"]).toBe("sk-local-abc");
  });

  test("surfaces a missing API key as a clear error", async () => {
    const fetchImpl = mockFetch(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    }));
    await expect(
      fetchPengepulModels({ url: "http://x/v1/models", fetchImpl }),
    ).rejects.toThrow(/API key/i);
  });
});

describe("loadPengepulModels", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pwgu-pengepul-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns a live source and writes the cache on success", async () => {
    const cachePath = join(dir, "pengepul-models.json");
    const fetchImpl = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => API_BODY,
    }));
    const result = await loadPengepulModels({
      url: "http://127.0.0.1:8317/v1/models",
      cachePath,
      relayBase: "http://127.0.0.1:8317",
      fetchImpl,
    });
    expect(result.source).toBe("live");
    expect(result.models).toHaveLength(3);
    expect(result.warning).toBeUndefined();
  });

  test("falls back to the cache to cover a briefly absent relay", async () => {
    const cachePath = join(dir, "pengepul-models.json");
    const cached: PengepulModel = {
      id: "claude-opus-5",
      name: "claude-opus-5 (pengepul)",
      dialect: "anthropic-messages",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1000000,
      maxTokens: 128000,
    };
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 3, models: [cached] }, null, 2) + "\n",
      { mode: 0o600 },
    );

    const failedFetch = mockFetch(async () => {
      throw new Error("connection refused");
    });
    const result = await loadPengepulModels({
      url: "http://127.0.0.1:8317/v1/models",
      cachePath,
      relayBase: "http://127.0.0.1:8317",
      fetchImpl: failedFetch,
    });

    expect(result.source).toBe("cache");
    expect(result.warning).toContain("cache");
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.id).toBe("claude-opus-5");
  });
});
