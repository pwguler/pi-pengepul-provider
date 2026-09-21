import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";

import { modelsFromApiResponse, toPengepulModels } from "../extensions/models.ts";

/**
 * Wire round trip: pi-ai's builtin stream functions, pointed at a mock pengepul
 * relay through the provider's own model mapping, must reach the right route and
 * parse the real SSE dialects.
 *
 * This is the proof that the dialect/baseUrl split works against the wires
 * pengepul actually serves — not just that the mapped shape looks right. The
 * models come from `toPengepulModels`, so the compat flags under test are the
 * ones production ships.
 */

const API_BODY = {
  object: "list",
  data: [
    { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
    { id: "gpt-5.4", object: "model", owned_by: "codex" },
  ],
};

const OPENAI_SSE = [
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}',
  "",
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":1}}}',
  "",
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}',
  "",
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  "",
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  "",
  'event: message_stop\ndata: {"type":"message_stop"}',
  "",
].join("\n");

describe("pengepul wire round trip", () => {
  let server: Server;
  let baseUrl: string;
  let lastRoute: string | undefined;
  let lastAuth: string | undefined;
  let lastHeaders: Record<string, string | string[] | undefined> = {};

  beforeEach(async () => {
    server = createServer((req, res) => {
      lastRoute = req.url;
      lastHeaders = { ...req.headers };
      lastAuth =
        (req.headers["authorization"] as string | undefined) ??
        (req.headers["x-api-key"] as string | undefined);
      const body = req.url === "/v1/chat/completions" ? OPENAI_SSE : ANTHROPIC_SSE;
      res.setHeader("content-type", "text/event-stream");
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no ephemeral port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function model(api: "openai-completions" | "anthropic-messages", id: string): Model<typeof api> {
    const entry = toPengepulModels(modelsFromApiResponse(API_BODY), baseUrl).find(
      (candidate) => candidate.id === id,
    );
    if (!entry) throw new Error(`no production model for ${id}`);
    if (entry.api !== api) throw new Error(`${id} maps to ${entry.api}, not ${api}`);
    return entry as Model<typeof api>;
  }

  const context: Context = {
    messages: [{ role: "user", content: "reply exactly: pong", timestamp: Date.now() }],
  };

  async function collect(stream: AssistantMessageEventStream) {
    let message;
    for await (const event of stream) {
      if (event.type === "done") message = event.message;
      if (event.type === "error") throw new Error(event.error?.errorMessage ?? "stream error");
    }
    return message;
  }

  test("OpenAI Chat Completions wire reaches /v1/chat/completions", async () => {
    const message = await collect(
      streamSimple(model("openai-completions", "gpt-5.4"), context, { apiKey: "sk-local-e2e" }),
    );

    expect(lastRoute).toBe("/v1/chat/completions");
    expect(lastAuth).toBe("Bearer sk-local-e2e");
    const text = message?.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toContain("pong");
    expect(message?.stopReason).toBe("stop");
  });

  test("Anthropic Messages wire reaches /v1/messages", async () => {
    const message = await collect(
      streamSimple(model("anthropic-messages", "claude-sonnet-4-6"), context, {
        apiKey: "sk-local-e2e",
      }),
    );

    // pi-ai 0.85.1 (through @anthropic-ai/sdk 0.123.0, which this branch's
    // lockfile bump pulled in) appends `?beta=true` to the Messages path; the
    // relay routes on the path and ignores the query, so the assertion covers
    // both rather than pinning the client's current spelling.
    expect(lastRoute?.split("?")[0]).toBe("/v1/messages");
    expect(lastAuth).toBe("sk-local-e2e"); // x-api-key header, no Bearer prefix
    const text = message?.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toContain("pong");
    expect(message?.stopReason).toBe("stop");
  });

  test("OpenAI Chat Completions wire carries the relay's session affinity header", async () => {
    // Production mapping, not a hand-built model: the relay's conversation_key
    // reads x-session-id before it reads the body's `prompt_cache_key`, pi
    // emits that header only for the openrouter affinity format, and the
    // detected default for a non-OpenRouter base URL is `openai` (session_id +
    // x-client-request-id + x-session-affinity) — a header set the relay
    // ignores. This is the end-to-end proof the mapping pins both fields, so a
    // session that hops accounts mid-conversation keeps its cached prefix
    // instead of re-billing it.
    await collect(
      streamSimple(model("openai-completions", "gpt-5.4"), context, {
        apiKey: "sk-local-e2e",
        sessionId: "sess-pengepul-1",
      }),
    );

    expect(lastRoute).toBe("/v1/chat/completions");
    expect(lastHeaders["x-session-id"]).toBe("sess-pengepul-1");
    expect(lastHeaders["x-session-affinity"]).toBeUndefined();
  });

  // No Messages-dialect affinity test here: through pi-ai 0.85.1 the
  // anthropic-messages client hardcodes `x-session-affinity` and ignores
  // `compat.sessionAffinityFormat`, which this relay does not read. The pin in
  // models.ts is forward-compatible — it takes effect on a pi release carrying
  // the sessionAffinityFormat support that pi main has — so the config-level
  // assertion in models.test.ts is the only honest test until then, and
  // affinity-wire.test.ts records the absence it is waiting on.
});
