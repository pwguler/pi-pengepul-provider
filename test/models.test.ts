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
  catalogIdForms,
  fetchPengepulModels,
  loadPengepulModels,
  modelsFromApiResponse,
  modelsFromCache,
  toProviderModelConfigs,
  type BuiltinModelLookup,
  type BuiltinModelMeta,
  type PengepulModel,
} from "../extensions/models.ts";

const API_BODY = {
  object: "list",
  data: [
    { id: "claude-sonnet-4-6", object: "model", created: 1, owned_by: "anthropic" },
    { id: "claude-opus-5", object: "model", created: 2, owned_by: "anthropic" },
    { id: "gpt-5.4", object: "model", created: 3, owned_by: "codex" },
  ],
};

describe("catalogIdForms", () => {
  test("drops the routing namespace so the catalog id is reachable", () => {
    // The relay's id carries the namespace it was routed through in front of
    // the catalog's own id, which for aggregated vendors is itself
    // multi-segment. Tried in order, these shapes recover the real entry and
    // its thinkingLevelMap instead of falling back to a family heuristic.
    expect(catalogIdForms("commandcode/deepseek/deepseek-v4-pro")).toEqual([
      "commandcode/deepseek/deepseek-v4-pro",
      "deepseek-v4-pro",
      "deepseek/deepseek-v4-pro",
    ]);
    expect(catalogIdForms("openrouter/openai/gpt-6-astra")).toEqual([
      "openrouter/openai/gpt-6-astra",
      "gpt-6-astra",
      "openai/gpt-6-astra",
    ]);
  });

  test("a bare id yields only itself", () => {
    expect(catalogIdForms("claude-sonnet-4-6")).toEqual(["claude-sonnet-4-6"]);
    expect(catalogIdForms("openai/gpt-5.4")).toEqual(["openai/gpt-5.4", "gpt-5.4"]);
  });
});

describe("modelsFromApiResponse", () => {
  test("leaves out the batch routes OpenRouter refuses on this wire", () => {
    // The relay lists them, and OpenRouter refuses them with 404 "This model is
    // only available through the Batch API" - confirmed on 10 of the relay's 77
    // batch ids across anthropic, openai, qwen, deepseek and z-ai. A picker
    // entry that can only fail is worse than no entry.
    //
    // The `:free` variants stay, and not merely because they answer 200: sent
    // a tools payload, nex-agi/nex-n2.5-pro:free and meituan/LongCat-2.0:free
    // both returned a real get_time call. The one that failed did so with 429
    // from the free tier, which is a rate limit rather than a model that
    // cannot be used.
    const body = {
      object: "list",
      data: [
        { id: "openrouter/anthropic/claude-opus-5:batch", object: "model", owned_by: "openrouter" },
        { id: "openrouter/openai/gpt-5.4", object: "model", owned_by: "openrouter" },
        { id: "openrouter/google/gemma-4-31b-it:free", object: "model", owned_by: "openrouter" },
      ],
    };

    const models = modelsFromApiResponse(body);
    expect(models.map((m) => m.id)).toEqual([
      "openrouter/openai/gpt-5.4",
      "openrouter/google/gemma-4-31b-it:free",
    ]);
  });

  test("a catalog of nothing but batch routes stays empty rather than usable", () => {
    const body = {
      object: "list",
      data: [{ id: "openrouter/openai/gpt-5.4:batch", object: "model", owned_by: "openrouter" }],
    };
    expect(() => modelsFromApiResponse(body)).toThrow();
  });

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

  test("relay's reasoning flag wins over the catalog fallback", () => {
    // The relay tri-state `reasoning` is first-party truth for whether the
    // upstream accepts reasoning params. deepseek-v4.1-flash matches no pi
    // catalog and no family heuristic, so without this flag the model
    // registered as non-reasoning and pi hid the thinking picker entirely.
    const body = {
      object: "list",
      data: [
        {
          id: "commandcode/deepseek/deepseek-v4.1-flash",
          object: "model",
          owned_by: "commandcode",
          reasoning: true,
        },
      ],
    };
    const models = modelsFromApiResponse(body, () => undefined);
    expect(models[0]?.reasoning).toBe(true);
  });

  test("relay silence keeps the catalog's reasoning and inherited map strings", () => {
    // The 18 relay entries without a `reasoning` key are catalog fallback,
    // not refutations: nothing is promoted and nothing is demoted. The map
    // survives intact except off/minimal, nulled because the relay enforces
    // its effort enum at the request layer no matter where reasoning came
    // from.
    const body = {
      object: "list",
      data: [
        { id: "commandcode/deepseek/deepseek-v4-pro", object: "model", owned_by: "commandcode" },
      ],
    };
    const lookup: BuiltinModelLookup = (id) =>
      id.slice(id.lastIndexOf("/") + 1) === "deepseek-v4-pro"
        ? {
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            input: ["text"],
            cost: { input: 0.27, output: 1.1, cacheRead: 0.027, cacheWrite: 0 },
            thinkingLevelMap: { low: null, medium: null, high: "high", max: "max" },
          }
        : undefined;

    const models = modelsFromApiResponse(body, lookup);
    expect(models[0]?.reasoning).toBe(true);
    // Overlay, never replace: inherited strings and nulls survive.
    expect(models[0]?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      max: "max",
    });
  });

  test("a non-boolean relay reasoning value does not promote", () => {
    // The relay's rollout sends the flag as a boolean or omits it; anything
    // else is garbage and must fall back to the catalog, not throw.
    const body = {
      object: "list",
      data: [
        {
          id: "commandcode/deepseek/deepseek-v4.1-flash",
          object: "model",
          owned_by: "commandcode",
          reasoning: "true",
        },
      ],
    };
    const models = modelsFromApiResponse(body, () => undefined);
    expect(models[0]?.reasoning).toBe(false);
    expect(models[0]?.thinkingLevelMap).toBeUndefined();
  });

  test("relay-reasoning openai-completions models hide off and minimal", () => {
    // The relay's reasoning_effort enum is low|medium|high|xhigh|max: it 400s
    // on `minimal`, and its thinking toggle never actually disables thinking,
    // so neither level may reach the Chat Completions wire. Overlaying nulls
    // (not replacing) keeps inherited strings and inherited nulls intact; an
    // id no catalog carries gets the vendor scale instead of pi's default.
    const body = {
      object: "list",
      data: [
        {
          id: "commandcode/deepseek/deepseek-v4.1-flash",
          object: "model",
          owned_by: "commandcode",
          reasoning: true,
        },
      ],
    };

    const bare = modelsFromApiResponse(body, () => undefined);
    expect(bare[0]?.thinkingLevelMap).toEqual({ off: null, minimal: null, max: "max" });

    const lookup: BuiltinModelLookup = (id) =>
      id.slice(id.lastIndexOf("/") + 1) === "deepseek-v4.1-flash"
        ? {
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            input: ["text"],
            cost: { input: 0.27, output: 1.1, cacheRead: 0.027, cacheWrite: 0 },
            thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
          }
        : undefined;
    const inherited = modelsFromApiResponse(body, lookup);
    expect(inherited[0]?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      max: "max",
    });
  });

  test("an id no catalog carries reaches the top of the relay's scale", () => {
    // pi hides xhigh and max unless a model's map names them, so a relay-only
    // id dropped to low/medium/high and could never send the top of the scale.
    // The relay validates one vocabulary for every upstream family it serves,
    // so the fallback is per namespace, not per model. Only `max` is named:
    // DeepSeek folds xhigh into high and pi's deepseek catalog hides xhigh
    // outright, so naming it would offer a level that does nothing.
    const body = {
      object: "list",
      data: [
        {
          id: "commandcode/deepseek/deepseek-v4.1-flash",
          object: "model",
          owned_by: "commandcode",
          reasoning: true,
        },
        {
          id: "commandcode/Qwen/Qwen3.7-Flash",
          object: "model",
          owned_by: "commandcode",
          reasoning: true,
        },
      ],
    };

    const models = modelsFromApiResponse(body, () => undefined);
    for (const model of models) {
      // low/medium/high stay absent, so pi keeps its default mapping for them.
      expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, max: "max" });
    }
  });

  test("the namespace match is case-insensitive like the dialect's", () => {
    const body = {
      object: "list",
      data: [
        { id: "CommandCode/deepseek/deepseek-v4.9-flash", object: "model", owned_by: "CommandCode", reasoning: true },
      ],
    };
    const models = modelsFromApiResponse(body, () => undefined);
    expect(models[0]?.thinkingLevelMap?.max).toBe("max");
  });

  test("the fallback stays off known ids, other namespaces, and non-reasoning models", () => {
    // An id pi's catalog does carry keeps that catalog's answer even when the
    // answer is "provider default": a hit with no map must not grow one. The
    // openrouter namespace keeps pi's default for the same reason, and the
    // relay does not validate its enum there, so its map carries `off` alone -
    // see the minimal test below for why commandcode differs.
    const body = {
      object: "list",
      data: [
        { id: "commandcode/deepseek/deepseek-v4-flash", object: "model", owned_by: "commandcode", reasoning: true },
        { id: "openrouter/google/gemini-3.8-flash", object: "model", owned_by: "openrouter", reasoning: true },
        { id: "commandcode/Qwen/Qwen3.8-Max", object: "model", owned_by: "commandcode", reasoning: false },
      ],
    };
    const lookup: BuiltinModelLookup = (id) =>
      id.endsWith("/deepseek-v4-flash")
        ? {
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            input: ["text"],
            cost: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
          }
        : undefined;

    const models = modelsFromApiResponse(body, lookup);
    expect(models[0]?.thinkingLevelMap).toEqual({ off: null, minimal: null });
    expect(models[1]?.thinkingLevelMap).toEqual({ off: null });
    expect(models[2]?.thinkingLevelMap).toBeUndefined();
  });

  test("minimal is hidden only where the relay refuses it", () => {
    // Measured on the running relay: `commandcode/` answers 400 Invalid option:
    // expected one of "low"|"medium"|"high"|"xhigh"|"max" for minimal, while
    // `openrouter/` validates nothing and answers 200. Hiding it on openrouter
    // costs 166 of the 227 models there that reason a level the relay takes.
    //
    // `off` is not symmetric and stays hidden everywhere: `none` is refused by
    // gemini-3.8-flash and accepted by deepseek, so neither answer generalises.
    const body = {
      object: "list",
      data: [
        { id: "openrouter/google/gemini-3.8-flash", object: "model", owned_by: "openrouter", reasoning: true },
        { id: "openrouter/z-ai/glm-5.3-flash", object: "model", owned_by: "openrouter", reasoning: true },
        { id: "commandcode/deepseek/deepseek-v4.9-flash", object: "model", owned_by: "commandcode", reasoning: true },
      ],
    };
    const lookup: BuiltinModelLookup = (id) =>
      id === "openrouter/z-ai/glm-5.3-flash"
        ? {
            reasoning: true,
            contextWindow: 131_072,
            maxTokens: 32_768,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            // A foreign spelling of a level this namespace takes: case-folded,
            // not culled like the values the enum does not know.
            thinkingLevelMap: { minimal: "MINIMAL", off: "none" },
          }
        : undefined;

    const models = modelsFromApiResponse(body, lookup);
    expect(models[0]?.thinkingLevelMap).toEqual({ off: null });
    expect(models[1]?.thinkingLevelMap).toEqual({ off: null, minimal: "minimal" });
    expect(models[2]?.thinkingLevelMap).toEqual({ off: null, minimal: null, max: "max" });
  });

  test("relay reasoning does not overlay the anthropic adaptive path", () => {
    // The Messages dialect folds `minimal` into `low` and nulls `off` via
    // forceAdaptiveThinking; the overlay is openai-completions only.
    const body = {
      object: "list",
      data: [
        {
          id: "anthropic/claude-brand-new-9",
          object: "model",
          owned_by: "anthropic",
          reasoning: true,
        },
      ],
    };
    const models = modelsFromApiResponse(body, () => undefined);
    expect(models[0]?.dialect).toBe("anthropic-messages");
    expect(models[0]?.thinkingLevelMap).toBeUndefined();
  });

  test("a relay entry tagged anthropic reasons even when no name or catalog says so", () => {
    // The promotion is the relay's own claim about a model pi's catalog does
    // not know yet, and it has to be the reason reasoning comes out true here:
    // the name matches no reasoning family, the catalog is empty, and the
    // relay sends no reasoning flag. Without the tag the same entry is not
    // reasoning and gets no level map, which is the control beside it.
    const entry = { id: "commandcode/some-new-claude-alias", object: "model" };
    const tagged = modelsFromApiResponse(
      { object: "list", data: [{ ...entry, owned_by: "anthropic" }] },
      () => undefined,
    );
    expect(tagged[0]?.reasoning).toBe(true);
    expect(tagged[0]?.thinkingLevelMap?.max).toBe("max");

    const untagged = modelsFromApiResponse({ object: "list", data: [entry] }, () => undefined);
    expect(untagged[0]?.reasoning).toBe(false);
    expect(untagged[0]?.thinkingLevelMap).toBeUndefined();
  });

  test("a catalog map offering the relay's rejected levels is overlaid", () => {
    // Foreign catalogs were written for other upstreams: openrouter's
    // muse-spark maps minimal:"minimal" and opencode-go's hy4-preview maps
    // off:"none". The relay 400s on both efforts, so the overlay must null
    // them even when it did not assert reasoning itself.
    const body = {
      object: "list",
      data: [
        { id: "commandcode/tencent/hy4-preview", object: "model", owned_by: "commandcode" },
      ],
    };
    const lookup: BuiltinModelLookup = (id) =>
      id.slice(id.lastIndexOf("/") + 1) === "hy4-preview"
        ? {
            reasoning: true,
            contextWindow: 262_144,
            maxTokens: 65_536,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
          }
        : undefined;

    const models = modelsFromApiResponse(body, lookup);
    expect(models[0]?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  test("inherited level strings are normalized to the relay's enum", () => {
    // pi's openrouter catalog spells Google efforts in caps and Qwen's as
    // "default". The relay takes only lowercase low|medium|high|xhigh|max,
    // so a foreign value is case-folded when it matches and hidden when it
    // matches under no casing.
    const body = {
      object: "list",
      data: [
        {
          id: "openrouter/google/gemini-3.1-pro-preview",
          object: "model",
          owned_by: "openrouter",
          reasoning: true,
        },
        { id: "openrouter/qwen/qwen3.6-27b", object: "model", owned_by: "openrouter", reasoning: true },
      ],
    };
    const lookup: BuiltinModelLookup = (id): BuiltinModelMeta | undefined =>
      id === "openrouter/google/gemini-3.1-pro-preview"
        ? {
            reasoning: true,
            contextWindow: 1_048_576,
            maxTokens: 65_536,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            thinkingLevelMap: { low: "LOW", high: "HIGH" },
          }
        : {
            reasoning: true,
            contextWindow: 262_144,
            maxTokens: 65_536,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            thinkingLevelMap: { high: "default" },
          };

    const models = modelsFromApiResponse(body, lookup);
    expect(models[0]?.thinkingLevelMap).toEqual({ off: null, low: "low", high: "high" });
    // "default" is not a relay effort under any casing: keep the level hidden.
    expect(models[1]?.thinkingLevelMap).toEqual({ off: null, high: null });
  });

  test("family heuristics see through every relay routing prefix", () => {
    // The relay prefixes ids with its upstream namespace, and a surviving
    // route qualifier rides along. The family has to be read from the final
    // segment, and the OpenAI branch stays on the reasoning families: gpt-4o
    // is not one, however it is spelled.
    const body = {
      object: "list",
      data: [
        { id: "openrouter/openai/gpt-5-image-mini", object: "model", owned_by: "openrouter" },
        { id: "openrouter/openai/gpt-oss-120b:free", object: "model", owned_by: "openrouter" },
        { id: "openrouter/openai/gpt-4o", object: "model", owned_by: "openrouter" },
        { id: "openrouter/openai/gpt-3.5-turbo", object: "model", owned_by: "openrouter" },
      ],
    };
    const models = modelsFromApiResponse(body, () => undefined);
    expect(models[0]?.reasoning).toBe(true);
    expect(models[1]?.reasoning).toBe(true);
    expect(models[2]?.reasoning).toBe(false);
    expect(models[3]?.reasoning).toBe(false);
  });

  test("name-based reasoning families resolve without a catalog entry", () => {
    const body = {
      object: "list",
      data: [
        {
          id: "openrouter/deepseek/deepseek-r1-distill-llama-70b",
          object: "model",
          owned_by: "openrouter",
        },
        { id: "openrouter/perplexity/sonar-reasoning-pro", object: "model", owned_by: "openrouter" },
        { id: "openrouter/tencent/hy-mt2-7b", object: "model", owned_by: "openrouter" },
      ],
    };
    const models = modelsFromApiResponse(body, () => undefined);
    expect(models[0]?.reasoning).toBe(true);
    expect(models[1]?.reasoning).toBe(true);
    expect(models[2]?.reasoning).toBe(false);
    // Relay metadata still wins over the heuristic's placeholder numbers.
    expect(models[0]?.contextWindow).toBe(200_000);
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

  test("Anthropic models declare long cache retention; OpenAI models do not", () => {
    // The 1h cache TTL is an Anthropic Messages feature. An
    // openai-completions model carrying the flag would emit a ttl the
    // Chat Completions wire has nowhere to put.
    const models = modelsFromApiResponse(API_BODY);
    const configs = toProviderModelConfigs(models, "http://127.0.0.1:8317");
    const claude = configs.find((c) => c.id === "claude-sonnet-4-6");
    const gpt = configs.find((c) => c.id === "gpt-5.4");

    expect(claude?.compat?.supportsLongCacheRetention).toBe(true);
    expect(gpt?.compat?.supportsLongCacheRetention).toBeUndefined();
    // The flag rides alongside the existing one rather than replacing it.
    expect(claude?.compat?.forceAdaptiveThinking).toBe(true);
  });

  test("every model sends the relay's session affinity header", () => {
    // The relay's conversation_key resolves `x-claude-code-session-id`, then
    // `x-session-id`, then the body's `prompt_cache_key`, then a hash of the
    // cacheable prefix, on both routes. pi emits one of those headers only for
    // the `openrouter` affinity format, and only when the send flag is set.
    // Both auto-detected defaults are wrong here: openai-completions picks
    // `openai` (session_id + x-client-request-id + x-session-affinity) and
    // anthropic-messages picks nothing at all. The pin puts the conversation
    // on the relay's first rule rather than its third, on both dialects.
    // `test/affinity-wire.test.ts` measures what each dialect actually emits.
    const models = modelsFromApiResponse(API_BODY);
    const configs = toProviderModelConfigs(models, "http://127.0.0.1:8317");
    const claude = configs.find((c) => c.id === "claude-sonnet-4-6");
    const gpt = configs.find((c) => c.id === "gpt-5.4");

    expect(gpt?.compat?.sendSessionAffinityHeaders).toBe(true);
    expect(gpt?.compat?.sessionAffinityFormat).toBe("openrouter");
    expect(claude?.compat?.sendSessionAffinityHeaders).toBe(true);
    expect(claude?.compat?.sessionAffinityFormat).toBe("openrouter");
  });

  test("picker label strips the relay prefix; the id stays exact", () => {
    // The fixture needs a prefixed id: every id in API_BODY is bare, so this
    // test passed for a year with the prefix-stripping removed entirely.
    const models = modelsFromApiResponse({
      object: "list",
      data: [{ id: "openrouter/openai/gpt-5.4", object: "model", owned_by: "openrouter" }],
    });
    const configs = toProviderModelConfigs(models, "http://127.0.0.1:8317");
    expect(configs[0]?.name).toBe("openai/gpt-5.4 (pengepul)");
    expect(configs[0]?.id).toBe("openrouter/openai/gpt-5.4");
  });
});

describe("modelsFromCache", () => {
  test("rejects an envelope written before the compat shape changed", () => {
    // v3 entries predate supportsLongCacheRetention. Replaying one would
    // register Claude models without the flag and silently disable the 1h
    // cache until the next successful fetch.
    const models = modelsFromApiResponse(API_BODY);
    expect(() =>
      modelsFromCache({ version: 3, models: models.map((m) => ({ ...m })) }),
    ).toThrow();
  });

  test("rejects an envelope written before the relay reasoning flag was read", () => {
    // v4 entries predate reading the relay's tri-state `reasoning` flag.
    // Replaying one would keep registering relay-reasoning models as
    // non-reasoning (no thinking picker) until the next successful fetch.
    const models = modelsFromApiResponse(API_BODY);
    expect(() =>
      modelsFromCache({ version: 4, models: models.map((m) => ({ ...m })) }),
    ).toThrow();
  });

  test("rejects an envelope written before the relay-uniform level overlay", () => {
    // v5 entries predate nulling off/minimal on every openai-completions
    // reasoning model. Replaying one would keep offering catalog levels the
    // relay rejects (minimal, off:"none") until the next successful fetch.
    const models = modelsFromApiResponse(API_BODY);
    expect(() =>
      modelsFromCache({ version: 5, models: models.map((m) => ({ ...m })) }),
    ).toThrow();
  });

  test("round-trips through the cache envelope", () => {
    const models = modelsFromApiResponse(API_BODY);
    const cached = modelsFromCache({
      version: 6,
      models: models.map((m) => ({ ...m })),
    });
    expect(cached).toHaveLength(3);
    expect(cached[0]?.dialect).toBe("anthropic-messages");
    expect(cached[0]?.input).toEqual(["text"]);
  });

  test("a cache holding nothing but batch routes is rejected as invalid", () => {
    // Filtering before the guard matters here. With the guard first, this cache
    // parses to an empty list, and loadPengepulModels reports source "cache"
    // with "Using the cached catalog" while handing pi zero models - a warning
    // that contradicts itself. Throwing routes it to the accurate "no valid
    // cached catalog" message instead.
    const models = modelsFromApiResponse(API_BODY);
    const batch = {
      ...models[2]!,
      id: "openrouter/openai/gpt-5.4:batch",
      name: "gpt-5.4:batch (pengepul)",
    };
    expect(() => modelsFromCache({ version: 6, models: [batch] })).toThrow();
  });

  test("a cache written before the batch routes were dropped sheds them too", () => {
    // The cache covers a briefly absent relay, so it must not be the path that
    // resurrects a route the live catalog now leaves out. This is the one
    // shape the version guard cannot catch: v6 is still current, it simply
    // predates the filter.
    const models = modelsFromApiResponse(API_BODY);
    const cached = modelsFromCache({
      version: 6,
      models: [...models.map((m) => ({ ...m })), { ...models[2]!, id: "openrouter/openai/gpt-5.4:batch" }],
    });
    expect(cached.map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-5",
      "gpt-5.4",
    ]);
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
    dir = mkdtempSync(join(tmpdir(), "pi-pengepul-"));
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
      JSON.stringify({ version: 6, models: [cached] }, null, 2) + "\n",
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
