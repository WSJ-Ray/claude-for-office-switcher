# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DeepSeek Office Gateway — a Python FastAPI backend + React/Vite admin frontend that proxies the Claude Office add-in's Anthropic Messages API to upstream providers (DeepSeek, Moonshot, OpenAI, etc.). The gateway supports multi-provider routing, automatic failover by priority, streaming SSE forwarding, format translation (Anthropic ↔ OpenAI Chat Completions), and a SQLite-backed admin panel.

## Quick Commands

**Start dev server (backend):**
```bash
python gateway.py            # runs on PORT env or 4000
# or with auto-reload:
uvicorn gateway:app --reload --host 0.0.0.0 --port 4000
```

**Start frontend dev server:**
```bash
cd web && npm run dev        # Vite on :5173, proxies /v1 /admin /health to localhost:4000
```

**Build frontend for production:**
```bash
cd web && npm run build      # outputs to ../static/
```

**Install deps:**
```bash
pip install -r requirements.txt
cd web && npm install
```

## Architecture

### Entry Point — `gateway.py`
Creates the FastAPI app, mounts CORS, includes two routers (`proxy` + `admin`), serves the built SPA from `static/`, and seeds defaults (currently disabled).

### Routing Layer — `app/routes/`
- **[proxy.py](app/routes/proxy.py)** — `/v1/messages`, `/v1/models`. Receives Anthropic-format requests from the Office add-in, resolves the best provider+upstream model via `db.find_mappings_by_client_model()`, and forwards with automatic failover across candidates ordered by `priority`. Handles both streaming (`StreamingResponse`) and non-streaming paths. Logs every request to SQLite.
- **[admin.py](app/routes/admin.py)** — `/admin/*` CRUD for providers, model mappings, stats, logs, and preview-models. Auth-protected via `GATEWAY_TOKEN`.

### Provider Adapters — `app/providers/`
Strategy-pattern adapters that speak different upstream protocols. All expose `list_models()`, `send()`, `stream()` and always return **Anthropic-format** to the gateway.

- **[base.py](app/providers/base.py)** — Abstract `BaseProvider` interface.
- **[anthropic.py](app/providers/anthropic.py)** — Transparent proxy to Anthropic-compatible endpoints (DeepSeek, Moonshot). Strips `tools.type: "custom"` fields. Extracts token usage from SSE `message_start`/`message_delta` events.
- **[openai_chat.py](app/providers/openai_chat.py)** — Translates Anthropic requests → OpenAI Chat Completions, sends upstream, then translates the response back to Anthropic format using modules in `app/translation/`.

Register new formats by adding to `REGISTRY` in **[providers/__init__.py](app/providers/__init__.py)**.

### Translation — `app/translation/`
Bidirectional Anthropic ↔ OpenAI Chat Completions converters.

- **[__init__.py](app/translation/__init__.py)** — `anthropic_to_openai_request()`: converts request bodies (messages, tools, tool_choice, system prompt).
- **[o2a.py](app/translation/o2a.py)** — `openai_to_anthropic_response()` and `openai_stream_to_anthropic_sse()`: converts non-streaming and streaming responses.

### Database — `app/db.py`
SQLite schema with three tables:
- **providers** — name, format, base_url, api_key, enabled, is_default, extra_config
- **model_mappings** — provider_id → client_model → upstream_model, with priority for failover
- **request_logs** — timestamp, provider, tokens, ttft, duration, status, error

Key functions: `find_mappings_by_client_model()` returns candidates ordered by priority (failover queue). `stats_*()` helpers for dashboard metrics.

### Frontend — `web/`
React + Vite + Tailwind admin panel. Pages: **Dashboard**, **Providers**, **Mappings**, **Logs**. Uses TanStack Query for data fetching, React Router for navigation. Built output goes to `../static/` and is served by FastAPI.

### Auth
Single token via `GATEWAY_TOKEN` env var. Verified in `app/auth.verify_auth()` against `Authorization: Bearer <token>` or `x-api-key` header.

## Important Constraints

- **client_model mapping rule**: `client_model` must contain one of `sonnet`, `opus`, or `haiku` (enforced in admin routes). This is because the Claude Office add-in only recognizes model IDs containing these tokens.
- The gateway always speaks Anthropic Messages API to the client, regardless of upstream format.
- Streaming SSE: the `AnthropicAdapter` passes through raw upstream bytes while parsing usage from SSE event boundaries. The `OpenAIChatAdapter` converts OpenAI SSE chunks to Anthropic SSE events.
- Data directory: `data/gateway.db` stores all config and logs. Preserve across restarts.
