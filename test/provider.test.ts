import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AuthContext,
  AuthResult,
  Model,
  Provider,
  ProviderAuthInteraction,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";

import {
  createPengepulProvider,
  type PengepulApiKeyCredential,
} from "../extensions/provider.ts";
import type { PengepulModelEntry } from "../extensions/models.ts";

const API_BODY = {
  object: "list",
  data: [
    { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
    { id: "gpt-5.4", object: "model", owned_by: "codex" },
  ],
};

// The real `fetch` type requires more than a partial implementation supplies.
const mockFetch = (impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) =>
  impl as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200): Partial<Response> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Unauthorized",
    json: async () => body,
  };
}

const authContext = (env: Record<string, string | undefined> = {}): AuthContext => ({
  env: async (name) => env[name],
  fileExists: async () => false,
});

const interaction = (answers: string[]): ProviderAuthInteraction => ({
  signal: new AbortController().signal,
  prompt: async () => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no answer left in the fake interaction");
    return answer;
  },
  notify: () => {},
});

interface Publication {
  persist?: { models: readonly Model<"anthropic-messages" | "openai-completions">[]; checkedAt?: number } | null;
  update?: () => void;
}

interface RefreshHarness {
  context: RefreshModelsContext;
  publications: Publication[];
  models: () => readonly Model<"anthropic-messages" | "openai-completions">[];
}

function refreshHarness(
  provider: Provider,
  input: {
    credential?: PengepulApiKeyCredential;
    stored?: readonly Model<"anthropic-messages" | "openai-completions">[];
    allowNetwork: boolean;
    signal?: AbortSignal;
  },
): RefreshHarness {
  const publications: Publication[] = [];
  const context: RefreshModelsContext = {
    ...(input.credential ? { credential: input.credential } : {}),
    ...(input.stored
      ? { stored: { models: input.stored as readonly Model<never>[] } }
      : {}),
    allowNetwork: input.allowNetwork,
    signal: input.signal ?? new AbortController().signal,
    publish: async (publication) => {
      publications.push(publication as Publication);
      publication.update?.();
      return true;
    },
  };
  return {
    context,
    publications,
    models: () => provider.getModels() as readonly Model<"anthropic-messages" | "openai-completions">[],
  };
}

/** A provider wired to a temp dir, a fake env, and a mock fetch. */
function harness(options: {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  legacyCachePath?: string;
  configText?: string;
  onWarning?: (message: string) => void;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pengepul-provider-"));
  const legacyCachePath = options.legacyCachePath ?? join(dir, "pengepul-models.json");
  const provider = createPengepulProvider({
    env: options.env ?? {},
    legacyCachePath,
    configText: options.configText,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onWarning ? { logWarning: options.onWarning } : {}),
  });
  return {
    provider,
    legacyCachePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("createPengepulProvider", () => {
  test("identifies itself as the pengepul provider with both streams wired", () => {
    const h = harness();
    try {
      expect(h.provider.id).toBe("pengepul");
      expect(h.provider.name).toBe("Pengepul");
      expect(typeof h.provider.stream).toBe("function");
      expect(typeof h.provider.streamSimple).toBe("function");
      expect(typeof h.provider.refreshModels).toBe("function");
      expect(h.provider.auth.apiKey).toBeDefined();
      expect(h.provider.auth.oauth).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("pengepul login", () => {
  test("asks for the key, then the relay URL, and stores both", async () => {
    const h = harness();
    try {
      const credential = await h.provider.auth.apiKey?.login?.(
        interaction(["sk-local-abc", "http://10.10.1.100:8317"]),
      );
      const expected: PengepulApiKeyCredential = {
        type: "api_key",
        key: "sk-local-abc",
        baseUrl: "http://10.10.1.100:8317",
      };
      expect(credential).toEqual(expected);
    } finally {
      h.cleanup();
    }
  });

  test("defaults a blank relay URL to loopback and strips a trailing /v1", async () => {
    // pi replaces the whole credential object on login, so the URL it writes
    // is the only thing standing between the user and a silently local relay.
    const h = harness();
    try {
      const blank = await h.provider.auth.apiKey?.login?.(interaction(["sk-local-abc", "  "]));
      const expectedBlank: PengepulApiKeyCredential = {
        type: "api_key",
        key: "sk-local-abc",
        baseUrl: "http://127.0.0.1:8317",
      };
      expect(blank).toEqual(expectedBlank);

      const withV1 = await h.provider.auth.apiKey?.login?.(
        interaction(["sk-local-abc", "http://relay.example.com/v1"]),
      );
      const expectedStripped: PengepulApiKeyCredential = {
        type: "api_key",
        key: "sk-local-abc",
        baseUrl: "http://relay.example.com",
      };
      expect(withV1).toEqual(expectedStripped);
    } finally {
      h.cleanup();
    }
  });
});

describe("pengepul auth resolution", () => {
  test("resolves the stored key without ever returning a baseUrl", async () => {
    // pi applies a resolved baseUrl to every model, which would collapse the
    // two dialect base URLs onto one. The per-model baseUrl is the only place
    // the wire split can live.
    const h = harness();
    try {
      const stored: PengepulApiKeyCredential = {
        type: "api_key",
        key: "sk-local-abc",
        baseUrl: "http://10.10.1.100:8317",
      };
      const resolved = (await h.provider.auth.apiKey?.resolve({
        ctx: authContext(),
        credential: stored,
        signal: new AbortController().signal,
      })) as AuthResult | undefined;

      expect(resolved?.auth.apiKey).toBe("sk-local-abc");
      expect(resolved?.auth.baseUrl).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("falls back to the environment, then to pengepul's own config", async () => {
    const fromEnv = harness({ env: { PENGEPUL_API_KEY: "sk-env" } });
    try {
      const resolved = await fromEnv.provider.auth.apiKey?.resolve({
        ctx: authContext(),
        signal: new AbortController().signal,
      });
      expect(resolved?.auth.apiKey).toBe("sk-env");
    } finally {
      fromEnv.cleanup();
    }

    const fromConfig = harness({
      configText: "host: ''\nport: 8317\napi-keys:\n- sk-local-from-config\n",
    });
    try {
      const resolved = await fromConfig.provider.auth.apiKey?.resolve({
        ctx: authContext(),
        signal: new AbortController().signal,
      });
      expect(resolved?.auth.apiKey).toBe("sk-local-from-config");
    } finally {
      fromConfig.cleanup();
    }
  });

  test("reports unconfigured when no key exists anywhere", async () => {
    const h = harness();
    try {
      const resolved = await h.provider.auth.apiKey?.resolve({
        ctx: authContext(),
        signal: new AbortController().signal,
      });
      expect(resolved).toBeUndefined();

      const checked = await h.provider.auth.apiKey?.check?.({
        ctx: authContext(),
        signal: new AbortController().signal,
      });
      expect(checked).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("reports a stored credential and an ambient one differently", async () => {
    const h = harness({ env: { PENGEPUL_API_KEY: "sk-env" } });
    try {
      const stored = await h.provider.auth.apiKey?.check?.({
        ctx: authContext(),
        credential: { type: "api_key", key: "sk-local-abc" },
        signal: new AbortController().signal,
      });
      expect(stored).toEqual({ type: "api_key", source: "stored credential" });

      const ambient = await h.provider.auth.apiKey?.check?.({
        ctx: authContext(),
        signal: new AbortController().signal,
      });
      expect(ambient).toEqual({ type: "api_key", source: "PENGEPUL_API_KEY" });
    } finally {
      h.cleanup();
    }
  });
});

describe("refreshModels: catalog fetch", () => {
  test("fetches from the credential's relay base and sends the resolved key", async () => {
    const requested: Array<{ url: string; apiKey: string | undefined }> = [];
    const h = harness({
      fetchImpl: mockFetch(async (url, init) => {
        requested.push({ url, apiKey: new Headers(init?.headers).get("x-api-key") ?? undefined });
        return jsonResponse(API_BODY);
      }),
    });
    try {
      const refresh = refreshHarness(h.provider, {
        credential: { type: "api_key", key: "sk-local-abc", baseUrl: "http://10.10.1.100:8317" },
        allowNetwork: true,
      });
      await h.provider.refreshModels?.(refresh.context);

      expect(requested).toEqual([
        { url: "http://10.10.1.100:8317/v1/models", apiKey: "sk-local-abc" },
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("publishes models on the wire-correct base URL and persists them with a timestamp", async () => {
    const h = harness({ fetchImpl: mockFetch(async () => jsonResponse(API_BODY)) });
    try {
      const refresh = refreshHarness(h.provider, {
        credential: { type: "api_key", key: "sk-local-abc", baseUrl: "http://10.10.1.100:8317" },
        allowNetwork: true,
      });
      await h.provider.refreshModels?.(refresh.context);

      const published = refresh.models();
      expect(published.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "gpt-5.4"]);
      expect(published[0]?.baseUrl).toBe("http://10.10.1.100:8317");
      expect(published[1]?.baseUrl).toBe("http://10.10.1.100:8317/v1");

      const persisted = refresh.publications.at(-1)?.persist;
      expect(persisted?.models.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "gpt-5.4"]);
      expect(typeof persisted?.checkedAt).toBe("number");
    } finally {
      h.cleanup();
    }
  });

  test("the environment base wins over pengepul's config, and the credential wins over both", async () => {
    const requested: string[] = [];
    const h = harness({
      env: { PENGEPUL_BASE_URL: "http://env:8317", PENGEPUL_API_KEY: "sk-env" },
      configText: "host: 10.0.0.9\nport: 9000\napi-keys:\n- sk-local-config\n",
      fetchImpl: mockFetch(async (url) => {
        requested.push(url);
        return jsonResponse(API_BODY);
      }),
    });
    try {
      const fromEnv = refreshHarness(h.provider, { allowNetwork: true });
      await h.provider.refreshModels?.(fromEnv.context);

      const fromCredential = refreshHarness(h.provider, {
        credential: { type: "api_key", key: "sk-cred", baseUrl: "http://credential:8317" },
        allowNetwork: true,
      });
      await h.provider.refreshModels?.(fromCredential.context);

      expect(requested).toEqual([
        "http://env:8317/v1/models",
        "http://credential:8317/v1/models",
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("skips the network entirely without a key", async () => {
    let calls = 0;
    const warnings: string[] = [];
    const h = harness({
      fetchImpl: mockFetch(async () => {
        calls++;
        return jsonResponse(API_BODY);
      }),
      onWarning: (message) => warnings.push(message),
    });
    try {
      const refresh = refreshHarness(h.provider, { allowNetwork: true });
      await h.provider.refreshModels?.(refresh.context);
      expect(calls).toBe(0);
      expect(refresh.models()).toEqual([]);
      expect(warnings.join("\n")).toContain("No pengepul API key is configured");
    } finally {
      h.cleanup();
    }
  });
});

describe("refreshModels: stored catalog", () => {
  const storedModels = (base: string) =>
    [
      {
        id: "claude-sonnet-4-6",
        name: "claude-sonnet-4-6 (pengepul)",
        api: "anthropic-messages" as const,
        provider: "pengepul",
        baseUrl: base,
        reasoning: true,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      {
        id: "gpt-5.4",
        name: "gpt-5.4 (pengepul)",
        api: "openai-completions" as const,
        provider: "pengepul",
        baseUrl: `${base}/v1`,
        reasoning: true,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ] satisfies PengepulModelEntry[];

  test("re-points restored models at the relay base the credential names now", async () => {
    // The store replays whole models, baseUrl included, before any network
    // call. A relay that moved must not be reached at its old address.
    let calls = 0;
    const h = harness({
      fetchImpl: mockFetch(async () => {
        calls++;
        return jsonResponse(API_BODY);
      }),
    });
    try {
      const refresh = refreshHarness(h.provider, {
        credential: { type: "api_key", key: "sk-local-abc", baseUrl: "http://moved:8317" },
        stored: storedModels("http://127.0.0.1:8317"),
        allowNetwork: false,
      });
      await h.provider.refreshModels?.(refresh.context);

      expect(calls).toBe(0);
      expect(refresh.models()[0]?.baseUrl).toBe("http://moved:8317");
      expect(refresh.models()[1]?.baseUrl).toBe("http://moved:8317/v1");
    } finally {
      h.cleanup();
    }
  });

  test("restores from the store without persisting again", async () => {
    const h = harness({ fetchImpl: mockFetch(async () => jsonResponse(API_BODY)) });
    try {
      const refresh = refreshHarness(h.provider, {
        stored: storedModels("http://127.0.0.1:8317"),
        allowNetwork: false,
      });
      await h.provider.refreshModels?.(refresh.context);

      expect(refresh.models()).toHaveLength(2);
      expect(refresh.publications.every((publication) => publication.persist === undefined)).toBe(
        true,
      );
    } finally {
      h.cleanup();
    }
  });

  test("imports a legacy cache file once, when the store has nothing", async () => {
    const legacy = JSON.stringify({
      version: 6,
      models: [
        {
          id: "claude-sonnet-4-6",
          name: "claude-sonnet-4-6 (pengepul)",
          dialect: "anthropic-messages",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
      ],
    });
    const dir = mkdtempSync(join(tmpdir(), "pengepul-legacy-"));
    const legacyCachePath = join(dir, "pengepul-models.json");
    writeFileSync(legacyCachePath, legacy);
    const h = harness({
      legacyCachePath,
      fetchImpl: mockFetch(async () => jsonResponse(API_BODY)),
    });
    try {
      const offline = refreshHarness(h.provider, {
        credential: { type: "api_key", key: "sk-local-abc", baseUrl: "http://10.10.1.100:8317" },
        allowNetwork: false,
      });
      await h.provider.refreshModels?.(offline.context);

      expect(offline.models().map((model) => model.id)).toEqual(["claude-sonnet-4-6"]);
      expect(offline.models()[0]?.baseUrl).toBe("http://10.10.1.100:8317");
      // Read once, never written: the migration does not keep the old file alive.
      expect(readFileSync(legacyCachePath, "utf-8")).toBe(legacy);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      h.cleanup();
    }
  });

  test("ignores a legacy cache the store already covers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pengepul-legacy-"));
    const legacyCachePath = join(dir, "pengepul-models.json");
    writeFileSync(
      legacyCachePath,
      JSON.stringify({
        version: 6,
        models: [
          {
            id: "stale-model",
            name: "stale",
            dialect: "openai-completions",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          },
        ],
      }),
    );
    const h = harness({
      legacyCachePath,
      fetchImpl: mockFetch(async () => jsonResponse(API_BODY)),
    });
    try {
      const refresh = refreshHarness(h.provider, {
        stored: storedModels("http://127.0.0.1:8317"),
        allowNetwork: false,
      });
      await h.provider.refreshModels?.(refresh.context);
      expect(refresh.models().map((model) => model.id)).toEqual(["claude-sonnet-4-6", "gpt-5.4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      h.cleanup();
    }
  });
});

describe("refreshModels: failure handling", () => {
  test("a rejected key is a warning, and the stored catalog stays registered", async () => {
    const warnings: string[] = [];
    const h = harness({
      fetchImpl: mockFetch(async () => jsonResponse({ error: "unauthorized" }, 401)),
      onWarning: (message) => warnings.push(message),
    });
    try {
      const stored = [
        {
          id: "claude-sonnet-4-6",
          name: "claude-sonnet-4-6 (pengepul)",
          api: "anthropic-messages" as const,
          provider: "pengepul",
          baseUrl: "http://127.0.0.1:8317",
          reasoning: true,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
      ] satisfies PengepulModelEntry[];
      const refresh = refreshHarness(h.provider, {
        credential: { type: "api_key", key: "sk-wrong", baseUrl: "http://10.10.1.100:8317" },
        stored,
        allowNetwork: true,
      });
      await h.provider.refreshModels?.(refresh.context);

      expect(warnings.join("\n")).toContain("401");
      expect(refresh.models().map((model) => model.id)).toEqual(["claude-sonnet-4-6"]);
      expect(refresh.publications.some((publication) => publication.persist !== undefined)).toBe(
        false,
      );
    } finally {
      h.cleanup();
    }
  });

  test("a hung relay is cut off by the timeout instead of stalling the refresh", async () => {
    const warnings: string[] = [];
    const h = harness({
      env: { PENGEPUL_MODELS_TIMEOUT_MS: "40" },
      fetchImpl: mockFetch(
        (_url, init) =>
          new Promise<Partial<Response>>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
      onWarning: (message) => warnings.push(message),
    });
    try {
      const refresh = refreshHarness(h.provider, {
        credential: { type: "api_key", key: "sk-local-abc", baseUrl: "http://10.10.1.100:8317" },
        allowNetwork: true,
      });
      await h.provider.refreshModels?.(refresh.context);
      expect(warnings.join("\n")).toContain("timed out");
    } finally {
      h.cleanup();
    }
  });

  test("an aborted refresh stops quietly", async () => {
    const warnings: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error("shutting down"));
    const h = harness({
      fetchImpl: mockFetch(async () => jsonResponse(API_BODY)),
      onWarning: (message) => warnings.push(message),
    });
    try {
      const refresh = refreshHarness(h.provider, {
        credential: { type: "api_key", key: "sk-local-abc", baseUrl: "http://10.10.1.100:8317" },
        allowNetwork: true,
        signal: controller.signal,
      });
      await h.provider.refreshModels?.(refresh.context);
      expect(warnings).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
