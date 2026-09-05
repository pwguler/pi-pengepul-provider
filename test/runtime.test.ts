import { describe, expect, test } from "bun:test";

import {
  createPengepulRuntime,
  type PengepulRuntimeApi,
} from "../extensions/runtime.ts";
import type { PengepulModel, PengepulModelSource } from "../extensions/models.ts";

const MODEL: PengepulModel = {
  id: "claude-sonnet-4-6",
  name: "claude-sonnet-4-6 (pengepul)",
  dialect: "anthropic-messages",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 64000,
};

function fakeHost() {
  const registered: Array<{ name: string; config: unknown }> = [];
  const warnings: string[] = [];
  const pi: PengepulRuntimeApi = {
    registerProvider: (name, config) => registered.push({ name, config }),
  };
  return { registered, warnings, pi };
}

describe("PengepulRuntime", () => {
  test("registers from the cache immediately when a valid cache exists", async () => {
    const host = fakeHost();
    // A never-resolving live refresh so the cache-first path is what registers,
    // and the background refresh does not disturb the assertion.
    const runtime = createPengepulRuntime(host.pi, {
      loadCachedModels: async () => [MODEL],
      loadModels: () => new Promise<PengepulModelSource>(() => {}),
      createProviderConfig: (models) => ({ models, name: "Pengepul" }),
    });

    await runtime.initialize();

    expect(host.registered).toHaveLength(1);
    expect(host.registered[0]?.name).toBe("pengepul");
    runtime.dispose();
  });

  test("registers nothing usable and reports a warning when discovery returns empty", async () => {
    const host = fakeHost();
    const runtime = createPengepulRuntime(host.pi, {
      loadCachedModels: async () => [],
      loadModels: async () => ({
        models: [],
        source: "empty",
        warning: "no relay",
      }),
      createProviderConfig: (models) => ({ models }),
      logWarning: (message) => host.warnings.push(message),
    });

    await runtime.initialize();

    expect(host.registered).toHaveLength(1); // registered, but with zero models
    expect((host.registered[0]?.config as { models: unknown[] }).models).toHaveLength(0);
    expect(host.warnings.join("\n")).toContain("no relay");
    runtime.dispose();
  });

  test("registers no user-facing commands", async () => {
    // The runtime api only exposes registerProvider; a host that counts
    // registerCommand calls would never see one. The live refresh never
    // resolves, so the cache-first registration is the only one.
    const host = fakeHost();
    const runtime = createPengepulRuntime(host.pi, {
      loadCachedModels: async () => [MODEL],
      loadModels: () => new Promise<PengepulModelSource>(() => {}),
      createProviderConfig: (models) => ({ models }),
    });
    await runtime.initialize();
    expect(host.registered).toHaveLength(1);
    runtime.dispose();
  });

  test("coalesces overlapping refreshes", async () => {
    const host = fakeHost();
    let resolveLoad!: (v: PengepulModelSource) => void;
    const runtime = createPengepulRuntime(host.pi, {
      loadCachedModels: async () => [MODEL],
      loadModels: () => new Promise<PengepulModelSource>((resolve) => (resolveLoad = resolve)),
      createProviderConfig: (models) => ({ models }),
    });
    // Start refresh() directly (not via initialize) so we control resolution.
    const a = runtime.refresh();
    const b = runtime.refresh();
    expect(a).toBe(b);
    resolveLoad({ models: [MODEL], source: "live" });
    await a;
    expect(host.registered.length).toBeGreaterThanOrEqual(1);
  });
});
