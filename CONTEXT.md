# pi-pengepul-provider

A pi provider adapter for pengepul, a relay that pools subscription accounts (Claude, Codex, and OpenAI-compatible endpoints) and serves them over native wire protocols.

## Language

**Relay**:
A pengepul instance serving pooled upstream accounts on one base URL.
_Avoid_: server, proxy, gateway

**Relay base**:
The scheme, host, and port a client reaches the relay on, without `/v1`; each wire appends its own path to it.
_Avoid_: endpoint, host, URL

**Dialect**:
One of the two wire protocols the relay serves — Anthropic Messages or OpenAI Chat Completions — chosen per model id.
_Avoid_: protocol, format, API type

**Catalog**:
The set of model ids the relay advertises on `GET /v1/models`, enriched with metadata from pi's builtin catalog.
_Avoid_: model list, inventory

**Pool**:
The set of upstream accounts a relay rotates requests across for one provider.
_Avoid_: fleet, group

**Credential**:
The pengepul entry in pi's `auth.json`: an API key for the relay, plus the relay base it applies to.
_Avoid_: config, token, secrets

## Relationships

- A **Relay** holds one or more **Pools**, one per upstream provider.
- One **Relay base** serves both **Dialects**; the **Catalog** tells which model id speaks which.
- A **Credential** binds one API key to one **Relay base**; the `PENGEPUL_*` environment variables override either field.
- The **Catalog** is per **Relay**; moving the base re-points every model in it.

## Example dialogue

> **Dev:** "The client box points at a different machine. Does the **Credential** carry the **Relay base**?"
> **Domain expert:** "Yes — key and base live together, so pi resolves both from one entry. Move the relay and you change one field; the **Catalog** follows on the next refresh."
>
> **Dev:** "And if the base moves while pi is offline?"
> **Domain expert:** "The cached **Catalog** is re-stamped against the current base on restore, so nothing keeps serving the old host."

## Flagged ambiguities

- "base URL" was used for both the **Relay base** (no `/v1`) and a per-model URL that ends in `/v1` for the Chat Completions **Dialect**. Resolved: **Relay base** is the root; per-model URLs are derived from it.
- "config" was used for pi's `auth.json`, pengepul's own `config.yaml`, and `models.json`. Resolved: the **Credential** is the configuration surface, with the `PENGEPUL_*` environment variables as overrides on top of it; pengepul's `config.yaml` is not read; `models.json` is not a supported surface for this provider.
