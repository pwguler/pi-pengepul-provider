import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import loadExtension from "../extensions/index.ts";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

/**
 * True end-to-end test: a local mock pengepul relay serves /v1/models, and the
 * real extension seam registers the provider with the discovered models.
 */

const MODELS_BODY = {
  object: "list",
  data: [
    { id: "claude-sonnet-4-6", object: "model", created: 1, owned_by: "anthropic" },
    { id: "claude-opus-5", object: "model", created: 2, owned_by: "anthropic" },
    { id: "gpt-5.4", object: "model", created: 3, owned_by: "codex" },
    // Prefixed and multi-segment on purpose: this is the only id here whose
    // catalog entry is reachable by a shape other than the id itself, so it is
    // what pins the lookup's multi-form walk. With the walk removed, every
    // bare fixture above still resolves and only this one changes.
    { id: "commandcode/deepseek/deepseek-v4-pro", object: "model", created: 4, owned_by: "commandcode" },
  ],
};

describe("pi-pengepul-provider end to end", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  const received: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-pengepul-e2e-"));

    server = createServer((req, res) => {
      received["path"] = req.url;
      received["x-api-key"] = (req.headers["x-api-key"] as string) ?? undefined;
      received["authorization"] = (req.headers["authorization"] as string) ?? undefined;

      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(MODELS_BODY));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no ephemeral port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  test("registers the pengepul provider with discovered models", async () => {
    process.env["PENGEPUL_BASE_URL"] = baseUrl;
    process.env["PENGEPUL_MODELS_CACHE"] = join(dir, "pengepul-models.json");
    process.env["PENGEPUL_API_KEY"] = "sk-local-e2e";
    process.env["PENGEPUL_MODELS_TIMEOUT_MS"] = "3000";

    const registered: Array<{ name: string; config: ProviderConfig }> = [];

    const fakePi = {
      registerProvider: (name: string, config: ProviderConfig) =>
        registered.push({ name, config }),
      on: () => {},
    } as never;

    await loadExtension(fakePi);

    // Expect at least the initial registration to carry the discovered models.
    const registration = registered.find((r) => r.name === "pengepul");
    expect(registration).toBeDefined();
    const models = registration!.config.models ?? [];
    expect(models.length).toBe(4);

    const claude = models.find((m) => m.id === "claude-sonnet-4-6");
    expect(claude?.api).toBe("anthropic-messages");
    expect(claude?.baseUrl).toBe(baseUrl);
    // Metadata is inherited from pi's builtin catalog through the seam:
    // claude-sonnet-4-6 is a 1M-context, image-capable model there.
    expect(claude?.contextWindow).toBe(1_000_000);
    expect(claude?.input).toContain("image");

    const gpt = models.find((m) => m.id === "gpt-5.4");
    expect(gpt?.api).toBe("openai-completions");
    expect(gpt?.baseUrl).toBe(`${baseUrl}/v1`);

    // The multi-segment id resolved through a catalog shape, not a heuristic:
    // the mock relay sends no pricing, and the heuristic path prices every
    // unknown model at zero, so a nonzero input rate can only come from the
    // deepseek catalog's entry for it.
    const deepseek = models.find((m) => m.id === "commandcode/deepseek/deepseek-v4-pro");
    expect(deepseek?.cost.input).toBeGreaterThan(0);
    expect(deepseek?.api).toBe("openai-completions");

    // Model discovery used the configured API key.
    expect(received["path"]).toBe("/v1/models");
    expect(received["x-api-key"]).toBe("sk-local-e2e");

    // Clean up env so we don't leak into other tests.
    delete process.env["PENGEPUL_BASE_URL"];
    delete process.env["PENGEPUL_MODELS_CACHE"];
    delete process.env["PENGEPUL_API_KEY"];
    delete process.env["PENGEPUL_MODELS_TIMEOUT_MS"];
  }, 10_000);
});
