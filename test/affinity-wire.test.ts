import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Context, Model } from "@earendil-works/pi-ai";

import { modelsFromApiResponse, toPengepulModels } from "../extensions/models.ts";

/**
 * Which cache-affinity signal pi actually puts on each dialect's wire.
 *
 * The relay's `conversation_key` resolves a session header, then the body's
 * `prompt_cache_key`, then a hash of the cacheable prefix. Which of those
 * three names the conversation therefore depends on what pi emits per
 * dialect — and the two dialects disagree, so the config in `models.ts`
 * pins the header for both. This file is the measurement behind that pin and
 * behind the relay's precedence order; the reasoning is worth a test because
 * guessing it from the bundled client code gets it backwards.
 */

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

const API_BODY = {
  object: "list",
  data: [
    { id: "claude-sonnet-4-6", object: "model", owned_by: "commandcode" },
    { id: "gpt-5.4", object: "model", owned_by: "codex" },
  ],
};

const SESSION_ID = "probe-session-id";

describe("affinity signal on the wire", () => {
  let server: Server;
  let baseUrl: string;
  let lastBody: Record<string, unknown> = {};
  let lastHeaders: Record<string, string | string[] | undefined> = {};

  beforeEach(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        lastBody = JSON.parse(raw);
        lastHeaders = { ...req.headers };
        res.setHeader("content-type", "text/event-stream");
        res.end(req.url === "/v1/chat/completions" ? OPENAI_SSE : ANTHROPIC_SSE);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no ephemeral port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const context: Context = {
    systemPrompt: "SYSTEM-PROMPT",
    messages: [{ role: "user", content: "reply exactly: pong", timestamp: Date.now() }],
  };

  /** The production model for one id, on this mock base URL. */
  function wireModel(id: string) {
    const entry = toPengepulModels(modelsFromApiResponse(API_BODY), baseUrl).find(
      (candidate) => candidate.id === id,
    );
    if (!entry) throw new Error(`no production model for ${id}`);
    return entry;
  }

  async function send(id: string) {
    const stream = streamSimple(wireModel(id), context, {
      apiKey: "sk-probe",
      sessionId: SESSION_ID,
      env: { PI_CACHE_RETENTION: "long" },
    }) as unknown as AsyncIterable<unknown>;
    for await (const _event of stream) void _event;
  }

  test("Chat Completions names the session in the body and in the header", async () => {
    // Both of the relay's first two rules hold here: the pinned header, and —
    // because the relay now reads it — `prompt_cache_key` as the fallback
    // spelling of the same identity.
    await send("gpt-5.4");

    expect(lastBody.prompt_cache_key).toBe(SESSION_ID);
    expect(lastBody.prompt_cache_retention).toBe("24h");
    expect(lastHeaders["x-session-id"]).toBe(SESSION_ID);
  });

  test("Anthropic Messages names the session in neither the body nor a header the relay reads", async () => {
    // The reason the relay's prefix fallback still carries Messages traffic:
    // there is no `prompt_cache_key` on this wire, and pi-ai hardcodes
    // `x-session-affinity` here rather than the config's `x-session-id`. The
    // assertion is deliberately about absence — if a future pi release starts
    // honouring `sessionAffinityFormat` on this dialect, this test fails and
    // the comment in models.ts is due for a rewrite.
    await send("claude-sonnet-4-6");

    expect(lastBody.prompt_cache_key).toBeUndefined();
    expect(lastBody.system).toBeDefined();
    expect(lastHeaders["x-session-id"]).toBeUndefined();
  });
});
