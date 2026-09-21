import { describe, expect, test } from "bun:test";

import {
  credentialApiKey,
  credentialRelayBase,
  relayBaseFromConfigText,
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

describe("relayBaseFromConfigText", () => {
  test("builds a base from the relay's host and port", () => {
    expect(relayBaseFromConfigText("host: 10.0.0.5\nport: 9000\n")).toBe("http://10.0.0.5:9000");
  });

  test("treats an empty host as loopback, which is how pengepul writes the default", () => {
    expect(relayBaseFromConfigText("host: ''\nport: 8317\n")).toBe("http://127.0.0.1:8317");
    expect(relayBaseFromConfigText('host: ""\nport: 8317\n')).toBe("http://127.0.0.1:8317");
    expect(relayBaseFromConfigText("port: 8317\n")).toBe("http://127.0.0.1:8317");
  });

  test("treats a bind-all host as loopback: every interface is not a destination", () => {
    // A relay told to listen on 0.0.0.0 is reached on loopback by a client on
    // the same box. Handing 0.0.0.0 to fetch works on Linux by accident and
    // fails elsewhere, so the bind-all spellings resolve to the loopback name.
    expect(relayBaseFromConfigText("host: 0.0.0.0\nport: 8317\n")).toBe("http://127.0.0.1:8317");
    expect(relayBaseFromConfigText("host: '::'\nport: 8317\n")).toBe("http://127.0.0.1:8317");
    expect(relayBaseFromConfigText("host: [::]\nport: 8317\n")).toBe("http://127.0.0.1:8317");
    expect(relayBaseFromConfigText("host: '*'\nport: 9000\n")).toBe("http://127.0.0.1:9000");
  });

  test("ignores unrelated keys and comments", () => {
    const text = [
      "# pengepul",
      "auth-dir: ~/.pengepul",
      "host: 10.0.0.5",
      "api-keys:",
      "- sk-local-abc",
      "port: 8317",
      "body-limit: 200mb",
    ].join("\n");
    expect(relayBaseFromConfigText(text)).toBe("http://10.0.0.5:8317");
  });

  test("returns undefined without a usable port, or with no text at all", () => {
    expect(relayBaseFromConfigText("host: 10.0.0.5\n")).toBeUndefined();
    expect(relayBaseFromConfigText("port: not-a-port\n")).toBeUndefined();
    expect(relayBaseFromConfigText("port: 0\n")).toBeUndefined();
    expect(relayBaseFromConfigText("")).toBeUndefined();
    expect(relayBaseFromConfigText(undefined)).toBeUndefined();
  });
});

describe("resolveRelayBase", () => {
  test("prefers the credential, then the environment, then the relay's own config", () => {
    expect(
      resolveRelayBase({
        credential: "http://10.10.1.100:8317",
        environment: "http://env:8317",
        config: "http://config:8317",
      }),
    ).toBe("http://10.10.1.100:8317");
    expect(
      resolveRelayBase({ environment: "http://env:8317", config: "http://config:8317" }),
    ).toBe("http://env:8317");
    expect(resolveRelayBase({ config: "http://config:8317" })).toBe("http://config:8317");
  });

  test("falls back to loopback when nothing is configured", () => {
    expect(resolveRelayBase({})).toBe("http://127.0.0.1:8317");
  });

  test("skips blank sources instead of letting them win", () => {
    expect(resolveRelayBase({ credential: "  ", environment: "http://env:8317" })).toBe(
      "http://env:8317",
    );
  });

  test("normalizes a trailing /v1 or slash from any source", () => {
    expect(resolveRelayBase({ credential: "https://relay.example.com/v1" })).toBe(
      "https://relay.example.com",
    );
    expect(resolveRelayBase({ environment: "http://10.10.1.100:8317/v1/" })).toBe(
      "http://10.10.1.100:8317",
    );
    expect(resolveRelayBase({ config: "http://config:8317/" })).toBe("http://config:8317");
  });
});

describe("resolveApiKey", () => {
  test("prefers the credential, then the environment, then the relay's own config", () => {
    expect(
      resolveApiKey({ credential: "sk-credential", ambient: "sk-ambient" }),
    ).toBe("sk-credential");
    expect(resolveApiKey({ ambient: "sk-ambient" })).toBe("sk-ambient");
    expect(resolveApiKey({})).toBeUndefined();
  });

  test("skips blank values", () => {
    expect(resolveApiKey({ credential: "   ", ambient: "sk-ambient" })).toBe("sk-ambient");
    expect(resolveApiKey({ ambient: "  " })).toBeUndefined();
  });
});
