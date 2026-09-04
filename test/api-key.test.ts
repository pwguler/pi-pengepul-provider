import { describe, expect, test } from "bun:test";

import { extractApiKeys, resolveApiKey, API_KEY_ENV } from "../src/api-key.ts";

describe("extractApiKeys", () => {
  test("parses an inline flow sequence", () => {
    const text = "api-keys: [sk-local-a, sk-local-b]\nport: 8317\n";
    expect(extractApiKeys(text)).toEqual(["sk-local-a", "sk-local-b"]);
  });

  test("parses a block sequence", () => {
    const text = "api-keys:\n  - sk-local-a\n  - sk-local-b\nport: 8317\n";
    expect(extractApiKeys(text)).toEqual(["sk-local-a", "sk-local-b"]);
  });

  test("parses a block sequence flush with the key (pengepul's own writer)", () => {
    const text = "auth-dir: ~/.pengepul\napi-keys:\n- sk-local-a\nbody-limit: 200mb\n";
    expect(extractApiKeys(text)).toEqual(["sk-local-a"]);
  });

  test("keeps scanning across blanks and comments, stops at the next key", () => {
    const text = "api-keys:\n# rotated keys\n\n  - sk-local-a\n\nhost: ''\n- not-a-key-list\n";
    expect(extractApiKeys(text)).toEqual(["sk-local-a"]);
  });

  test("parses a single inline scalar", () => {
    const text = "api-keys: sk-local-a\n";
    expect(extractApiKeys(text)).toEqual(["sk-local-a"]);
  });

  test("returns an empty array when there is no api-keys entry", () => {
    const text = "port: 8317\nhost: ''\n";
    expect(extractApiKeys(text)).toEqual([]);
  });

  test("strips quotes around values", () => {
    const text = 'api-keys: ["sk-local-a"]\n';
    expect(extractApiKeys(text)).toEqual(["sk-local-a"]);
  });
});

describe("resolveApiKey", () => {
  const noConfig = () => undefined;
  const configWith = (...keys: string[]) => () =>
    `port: 8317\napi-keys:\n${keys.map((k) => `  - ${k}`).join("\n")}\n`;

  test("prefers the env override", () => {
    const result = resolveApiKey({ [API_KEY_ENV]: "sk-env" }, configWith("sk-config"));
    expect(result).toEqual({ key: "sk-env", source: "env" });
  });

  test("falls back to the config file when env is absent", () => {
    const result = resolveApiKey({}, configWith("sk-config"));
    expect(result).toEqual({ key: "sk-config", source: "config" });
  });

  test("ignores a whitespace-only env override", () => {
    const result = resolveApiKey({ [API_KEY_ENV]: "   " }, configWith("sk-config"));
    expect(result).toEqual({ key: "sk-config", source: "config" });
  });

  test("returns none when neither env nor config carries a key", () => {
    const result = resolveApiKey({}, noConfig);
    expect(result).toEqual({ source: "none" });
    expect(result.key).toBeUndefined();
  });

  test("uses a custom config path from the env", () => {
    const reads: string[] = [];
    const read = (path: string) => {
      reads.push(path);
      return path === "/custom/config.yaml" ? "api-keys: [sk-custom]\n" : undefined;
    };
    const result = resolveApiKey({ PENGEPUL_CONFIG: "/custom/config.yaml" }, read);
    expect(result).toEqual({ key: "sk-custom", source: "config" });
    expect(reads).toContain("/custom/config.yaml");
  });
});
