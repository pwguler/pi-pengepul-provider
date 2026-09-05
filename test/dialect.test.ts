import { describe, expect, test } from "bun:test";

import {
  baseUrlForDialect,
  dialectForModelId,
  modelsUrl,
  normalizeRootBaseUrl,
} from "../extensions/dialect.ts";

describe("dialectForModelId", () => {
  test("routes claude-* to Anthropic Messages", () => {
    expect(dialectForModelId("claude-sonnet-4-6")).toBe("anthropic-messages");
    expect(dialectForModelId("claude-opus-5")).toBe("anthropic-messages");
  });

  test("routes an anthropic/<model> prefix to Anthropic Messages", () => {
    expect(dialectForModelId("anthropic/claude-opus-5")).toBe("anthropic-messages");
  });

  test("routes gpt-*, codex-* and o<N> bare ids to OpenAI Chat Completions", () => {
    expect(dialectForModelId("gpt-5.4")).toBe("openai-completions");
    expect(dialectForModelId("gpt-5.1-mini")).toBe("openai-completions");
    expect(dialectForModelId("codex-mini")).toBe("openai-completions");
    expect(dialectForModelId("o3")).toBe("openai-completions");
    expect(dialectForModelId("o4-mini")).toBe("openai-completions");
  });

  test("routes any other <provider>/<model> prefix to OpenAI Chat Completions", () => {
    expect(dialectForModelId("groq/llama-3.3-70b-versatile")).toBe("openai-completions");
    expect(dialectForModelId("opencode/foo")).toBe("openai-completions");
  });

  test("routes an unknown bare id to OpenAI Chat Completions by default", () => {
    expect(dialectForModelId("some-unknown-model")).toBe("openai-completions");
  });
});

describe("normalizeRootBaseUrl", () => {
  test("strips a trailing /v1 and any trailing slashes", () => {
    expect(normalizeRootBaseUrl("http://127.0.0.1:8317/v1")).toBe("http://127.0.0.1:8317");
    expect(normalizeRootBaseUrl("http://127.0.0.1:8317/v1/")).toBe("http://127.0.0.1:8317");
    expect(normalizeRootBaseUrl("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317");
    expect(normalizeRootBaseUrl("http://127.0.0.1:8317/")).toBe("http://127.0.0.1:8317");
  });
});

describe("baseUrlForDialect", () => {
  test("Anthropic Messages uses the root base URL (no /v1)", () => {
    expect(baseUrlForDialect("http://127.0.0.1:8317", "anthropic-messages")).toBe(
      "http://127.0.0.1:8317",
    );
    expect(baseUrlForDialect("http://127.0.0.1:8317/v1", "anthropic-messages")).toBe(
      "http://127.0.0.1:8317",
    );
  });

  test("OpenAI Chat Completions uses /v1 (never doubled)", () => {
    expect(baseUrlForDialect("http://127.0.0.1:8317", "openai-completions")).toBe(
      "http://127.0.0.1:8317/v1",
    );
    expect(baseUrlForDialect("http://127.0.0.1:8317/v1", "openai-completions")).toBe(
      "http://127.0.0.1:8317/v1",
    );
  });
});

describe("modelsUrl", () => {
  test("appends /v1/models to the relay root", () => {
    expect(modelsUrl("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317/v1/models");
    expect(modelsUrl("http://127.0.0.1:8317/v1")).toBe("http://127.0.0.1:8317/v1/models");
  });
});
