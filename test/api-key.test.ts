import { describe, expect, test } from "bun:test";

import { extractApiKeys } from "../extensions/api-key.ts";

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
