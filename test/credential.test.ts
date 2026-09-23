import { describe, expect, test } from "bun:test";

import {
  credentialApiKey,
  credentialRelayBase,
  resolveApiKey,
  resolveRelayBase,
} from "../extensions/credential.ts";

describe("credentialRelayBase", () => {
  test("reads a baseUrl off the credential", () => {
    expect(credentialRelayBase({ type: "api_key", baseUrl: "http://10.10.1.100:8317" })).toBe(
      "http://10.10.1.100:8317",
    );
  });

  test("trims, and ignores blank or non-string values", () => {
    expect(credentialRelayBase({ baseUrl: "  http://relay:9000  " })).toBe("http://relay:9000");
    expect(credentialRelayBase({ baseUrl: "   " })).toBeUndefined();
    expect(credentialRelayBase({ baseUrl: 8317 })).toBeUndefined();
    expect(credentialRelayBase({})).toBeUndefined();
    expect(credentialRelayBase(undefined)).toBeUndefined();
  });
});

describe("credentialApiKey", () => {
  test("reads a key off the credential and ignores blank or non-string values", () => {
    expect(credentialApiKey({ type: "api_key", key: "sk-local-abc" })).toBe("sk-local-abc");
    expect(credentialApiKey({ key: "  sk-local-abc  " })).toBe("sk-local-abc");
    expect(credentialApiKey({ key: "" })).toBeUndefined();
    expect(credentialApiKey({ key: 42 })).toBeUndefined();
    expect(credentialApiKey(undefined)).toBeUndefined();
  });
});

describe("resolveRelayBase", () => {
  test("prefers the environment override, then the credential", () => {
    expect(
      resolveRelayBase({
        environment: "http://env:8317",
        credential: "http://10.10.1.100:8317",
      }),
    ).toBe("http://env:8317");
    expect(resolveRelayBase({ credential: "http://10.10.1.100:8317" })).toBe(
      "http://10.10.1.100:8317",
    );
  });

  test("falls back to loopback when nothing is configured", () => {
    expect(resolveRelayBase({})).toBe("http://127.0.0.1:8317");
  });

  test("skips a blank source instead of letting it win", () => {
    expect(resolveRelayBase({ environment: "  ", credential: "http://cred:8317" })).toBe(
      "http://cred:8317",
    );
  });

  test("normalizes a trailing /v1 or slash from any source", () => {
    expect(resolveRelayBase({ environment: "https://relay.example.com/v1" })).toBe(
      "https://relay.example.com",
    );
    expect(resolveRelayBase({ credential: "http://10.10.1.100:8317/v1/" })).toBe(
      "http://10.10.1.100:8317",
    );
  });
});

describe("resolveApiKey", () => {
  test("prefers the environment override, then the credential", () => {
    expect(resolveApiKey({ environment: "sk-env", credential: "sk-credential" })).toEqual({
      key: "sk-env",
      source: "PENGEPUL_API_KEY",
    });
    expect(resolveApiKey({ credential: "sk-credential" })).toEqual({
      key: "sk-credential",
      source: "stored credential",
    });
  });

  test("reports nothing when neither source carries a key", () => {
    expect(resolveApiKey({})).toBeUndefined();
  });

  test("skips blank values", () => {
    expect(resolveApiKey({ environment: "   ", credential: "sk-credential" })).toEqual({
      key: "sk-credential",
      source: "stored credential",
    });
    expect(resolveApiKey({ environment: "  " })).toBeUndefined();
    expect(resolveApiKey({ credential: "   " })).toBeUndefined();
  });
});
