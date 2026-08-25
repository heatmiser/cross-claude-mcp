# Cross-Claude MCP — Hub Architecture

## Overview

Cross-Claude MCP enables bidirectional messaging between AI agent sessions (Claude,
Gemini, and future models) running in isolated Podman containers across a LAN.
The system uses a hub-and-spoke model: a central HTTP/PostgreSQL hub mediates all
messages; lightweight bridge sidecars translate between the hub's REST API and each
model's native tool/MCP protocol.

---

## Architecture Diagram

```mermaid
graph TB
    subgraph LAN["Local Area Network"]

        subgraph hub_pod["cross-claude-hub.pod  (LAN host)"]
            direction TB
            server["cross-claude-server\nNode.js REST API\n:3000"]
            postgres["cross-claude-postgres\nPostgreSQL 16\n:5432 pod-internal"]
            server -- "localhost:5432" --> postgres
        end

        subgraph claude_a["Claude Session A  (Workstation)"]
            direction TB
            claude_container_a["claude-gha container\nCLAUDE_CODE_USE_VERTEX=1\n~/.config/gcloud :ro,z"]
            bridge_a["cross-claude-bridge.mjs\nMCP sidecar\npoll every 5 s"]
            claude_container_a <-- "MCP protocol\nnotifications/claude/channel" --> bridge_a
        end

        subgraph claude_b["Claude Session B  (Test System)"]
            direction TB
            claude_container_b["claude-gha container\nCLAUDE_CODE_USE_VERTEX=1\n~/.config/gcloud :ro,z"]
            bridge_b["cross-claude-bridge.mjs\nMCP sidecar\npoll every 5 s"]
            claude_container_b <-- "MCP protocol\nnotifications/claude/channel" --> bridge_b
        end

        subgraph gemini_session["Gemini Session  (future)"]
            direction TB
            gemini_container["gemini-ai-helpers container\nGEMINI_API_KEY or ADC"]
            gemini_bridge["cross-gemini-bridge.mjs\ntool-call sidecar\n(future)"]
            gemini_container <-. "tool-call protocol\n(future)" .-> gemini_bridge
        end

        bridge_a     -- "HTTP REST + MCP_API_KEY" --> server
        bridge_b     -- "HTTP REST + MCP_API_KEY" --> server
        gemini_bridge -. "HTTP REST + MCP_API_KEY\n(future)" .-> server
    end

    vertex["Vertex AI\nGoogle Cloud"]
    claude_container_a -- "ADC (~/.config/gcloud)" --> vertex
    claude_container_b -- "ADC (~/.config/gcloud)" --> vertex
    gemini_container   -. "Gemini API / Vertex AI\n(future)" .-> vertex
```

---

## Components

### Hub Pod (`cross-claude-hub.pod`)

Deployed as a Podman pod (Quadlet) on a LAN-accessible host. The two containers
share a pod network namespace — they communicate over `localhost` with no external
port exposure for PostgreSQL.

#### `cross-claude-postgres.container`

| Property | Value |
|---|---|
| Image | `docker.io/postgres:16` |
| Internal port | `5432` (pod-internal only) |
| Data volume | `%h/.local/share/cross-claude/postgres/data:/var/lib/postgresql/data:Z` |
| Init script | `init-db.sh` mounted at `/docker-entrypoint-initdb.d/` |
| Health check | `pg_isready -U cross_claude` every 5 s, 10 retries, 30 s start period |

The `init-db.sh` creates the cross-claude schema (channels, messages, instances,
shared_data, invite_codes, read_cursors tables) on first start. Schema source of
truth is the existing `db.mjs` DDL — see the **init-db.sh Derivation** section
below for the complete SQL.

#### `cross-claude-server.container`

| Property | Value |
|---|---|
| Image | `localhost/cross-claude-server:latest` (local build, initial) → `ghcr.io/heatmiser/cross-claude-mcp:latest` (future CI) |
| Exposed port | `3000` (published to LAN) |
| Depends on | `cross-claude-postgres.container` (via `After=` + health gate) |
| Environment | `DATABASE_URL`, `MCP_API_KEY`, `PORT=3000` (from Ansible vault / vars) |

---

### Bridge Sidecars

Each AI session container runs a bridge sidecar as a separate process. The bridge
is model-specific; the hub REST API is model-agnostic.

#### `cross-claude-bridge.mjs` (Claude)

- Loaded by Claude Code as an MCP server via `--mcp-server` flag or `settings.json`
- Polls the hub REST API every 5 seconds for new messages on subscribed channels
- Persists per-channel cursors to `~/.claude/.cross-claude-bridge-cursors.json` so
  messages are not replayed after restart
- Delivers inbound messages to Claude via `notifications/claude/channel` MCP notifications
- Sends outbound messages via `send_message` / `share_data` MCP tools

#### `cross-gemini-bridge.mjs` (future)

- Same REST API contract, different protocol surface (Gemini function-call schema)
- Hub requires no changes — only the sidecar differs per model

---

### AI Session Containers

| Session type | Image | Auth to AI provider |
|---|---|---|
| Claude | `ghcr.io/opendatahub-io/ai-helpers:latest` | Vertex AI via ADC (`~/.config/gcloud :ro,z`) |
| Gemini (future) | `ghcr.io/heatmiser/gemini-ai-helpers:latest` | `GEMINI_API_KEY` or Vertex AI via ADC |

AI provider auth is entirely independent of hub auth. The hub is LAN-local; AI
inference goes to Google Cloud either way.

---

## Network Topology

```
AI Session Containers (workstation / test system)
  └─ bridge sidecar
       └─ HTTP :3000 ──────────────────────────► cross-claude-server (hub pod, LAN host)
                                                       └─ localhost:5432 ──► cross-claude-postgres

AI Session Containers ──► Vertex AI / Gemini API  (separate path, Google Cloud)
```

PostgreSQL is never exposed outside the pod. Only port `3000` (the REST API) is
published to the LAN. `MCP_API_KEY` is required on all requests.

---

## Authentication

| Boundary | Mechanism |
|---|---|
| Bridge → Hub | `MCP_API_KEY` bearer token (HTTP header) |
| Hub → PostgreSQL | Password auth, credentials in `DATABASE_URL` env var |
| Claude → Vertex AI | Google ADC (`~/.config/gcloud` bind-mount) |
| Gemini → Google AI | `GEMINI_API_KEY` env var or ADC (future) |

Hub credentials (`MCP_API_KEY`, `POSTGRES_PASSWORD`) are stored in Ansible Vault
(`vars/secrets.yml`) and never committed in plaintext.

---

## Data Flow — Message Sent A → B

1. Claude session A calls `send_message` MCP tool with channel + content
2. `cross-claude-bridge.mjs` POSTs to `POST /api/messages` on the hub
3. Hub writes the message row to PostgreSQL and returns `201`
4. Claude session B's bridge polls `GET /api/messages?channel=X&after=<cursor>`
5. Hub queries PostgreSQL, returns new rows
6. Bridge delivers via `notifications/claude/channel` MCP notification
7. Bridge advances its cursor and persists it to `~/.claude/.cross-claude-bridge-cursors.json`

---

## Deployment File Inventory

The Ansible playbook generates the following files. Every file listed here must be
created — nothing is optional for a working deployment.

### Playbook root

```
deploy-cross-claude.yml        # main deploy playbook
teardown-cross-claude.yml      # stops services, removes Quadlets (does NOT delete data volume)
vars/common.yml                # non-secret config (paths, ports, image refs)
vars/secrets.yml               # Ansible Vault — mcp_api_key, postgres_password (gitignored)
vars/secrets.yml.example       # committed template with placeholder values
```

### Jinja2 templates (rendered to `~/.config/containers/systemd/`)

```
templates/cross-claude.pod.j2                    → cross-claude.pod
templates/cross-claude-postgres.container.j2     → cross-claude-postgres.container
templates/cross-claude-server.container.j2       → cross-claude-server.container
```

### Init script (rendered to `~/.local/share/cross-claude/postgres/scripts/`)

```
templates/init-db.sh.j2    → init-db.sh   (mounted at /docker-entrypoint-initdb.d/)
```

### Server image

```
Containerfile              # local podman build → localhost/cross-claude-server:latest
```

### Reference files (kangkodos patterns to copy from)

The following kangkodos files are the direct patterns for the templates above:

| kangkodos file | Cross-claude equivalent |
|---|---|
| `templates/memory.pod.j2` | `templates/cross-claude.pod.j2` |
| `templates/ai-postgres.container.j2` | `templates/cross-claude-postgres.container.j2` |
| `templates/init-db.sh.j2` | `templates/init-db.sh.j2` |
| `vars/common.yml` | `vars/common.yml` (schema pattern) |

The server container has no kangkodos equivalent — write it fresh following the
postgres container template structure.

---

## Containerfile Spec

The server image packages `server.mjs` and all runtime dependencies. It is built
locally with `podman build` and tagged `localhost/cross-claude-server:latest`.

`better-sqlite3` is a native module that requires build tools at compile time but
is not used at runtime in HTTP mode (the container always sets `PORT`, which
triggers the PostgreSQL path in `server.mjs`). Use a two-stage build to keep the
final image lean.

```dockerfile
# syntax=docker/dockerfile:1
FROM docker.io/node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && npm ci \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
COPY . .

FROM docker.io/node:22-slim
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
```

**Required environment variables at runtime** (supplied by the Quadlet `Environment=` lines
or Ansible-rendered secrets — never baked into the image):

| Variable | Example | Purpose |
|---|---|---|
| `PORT` | `3000` | Triggers HTTP mode; also sets the listen port |
| `DATABASE_URL` | `postgresql://cross_claude:secret@localhost:5432/cross_claude` | PostgreSQL connection string |
| `MCP_API_KEY` | `<random 32-char hex>` | Bearer token required on all API requests |
| `SERVER_URL` | `http://192.168.1.10:3000` | Used in OAuth metadata URLs; set to LAN address |
| `CLEANUP_DAYS` | `7` | Days before old messages/instances are purged (optional, default 7) |

---

## Quadlet Template Skeletons

These are the three Quadlet files the Ansible playbook renders. The templates use
Jinja2 syntax; Ansible writes the rendered files to `~/.config/containers/systemd/`
and then calls `systemctl --user daemon-reload`.

### `templates/cross-claude.pod.j2`

```ini
[Unit]
Description=Cross-Claude Hub Pod
After=network-online.target
Wants=network-online.target

[Pod]
PodName=cross-claude
PublishPort={{ hub_port }}:3000

[Install]
WantedBy=default.target
```

### `templates/cross-claude-postgres.container.j2`

```ini
[Unit]
Description=Cross-Claude PostgreSQL
After=cross-claude-pod.service
Requires=cross-claude-pod.service

[Container]
Image=docker.io/postgres:16
Pod=cross-claude.pod

Environment=POSTGRES_USER={{ postgres_user }}
Environment=POSTGRES_PASSWORD={{ postgres_password }}
Environment=POSTGRES_DB={{ postgres_db }}

Volume={{ postgres_data_dir }}:/var/lib/postgresql/data:Z
Volume={{ postgres_scripts_dir }}/init-db.sh:/docker-entrypoint-initdb.d/init-db.sh:ro,Z

HealthCmd=pg_isready -U {{ postgres_user }} -d {{ postgres_db }}
HealthInterval=5s
HealthTimeout=5s
HealthRetries=10
HealthStartPeriod=30s

[Service]
Restart=always
TimeoutStartSec=120

[Install]
WantedBy=default.target
```

### `templates/cross-claude-server.container.j2`

```ini
[Unit]
Description=Cross-Claude MCP Server
After=cross-claude-postgres.service
Requires=cross-claude-postgres.service

[Container]
Image={{ server_image }}
Pod=cross-claude.pod

Environment=PORT=3000
Environment=DATABASE_URL=postgresql://{{ postgres_user }}:{{ postgres_password }}@localhost:5432/{{ postgres_db }}
Environment=MCP_API_KEY={{ mcp_api_key }}
Environment=SERVER_URL=http://{{ ansible_default_ipv4.address }}:{{ hub_port }}
Environment=CLEANUP_DAYS={{ cleanup_days }}

[Service]
Restart=always
TimeoutStartSec=60

[Install]
WantedBy=default.target
```

**Important Quadlet constraints (from kangkodos CLAUDE.md):**

- Every `Image=` must use a fully qualified registry prefix (`docker.io/`, `localhost/`,
  `ghcr.io/`) — Fedora enforces `short-name-mode=enforced` and will fail silently at
  start (exit 125) if the prefix is missing.
- Volumes on SELinux-enforcing Fedora require `:Z` (private relabel) for data volumes
  and `:ro,Z` for read-only mounts. Use `:z` only for shared volumes.
- After writing Quadlet files, run `systemctl --user daemon-reload` before starting services.

---

## Ansible Variable Schema

### `vars/common.yml` (non-secret, committed)

```yaml
# Ansible-resolved home and user
user_home: "{{ ansible_env.HOME }}"
user_name: "{{ ansible_user_id }}"

# Directory paths (all resolved relative to user_home)
quadlet_dir:          "{{ user_home }}/.config/containers/systemd"
postgres_data_dir:    "{{ user_home }}/.local/share/cross-claude/postgres/data"
postgres_scripts_dir: "{{ user_home }}/.local/share/cross-claude/postgres/scripts"

# Service config (non-secret)
hub_port:      3000          # LAN-published port; must match PublishPort in pod template
postgres_user: "cross_claude"
postgres_db:   "cross_claude"
server_image:  "localhost/cross-claude-server:latest"  # override for ghcr.io in production
cleanup_days:  7

# Full service list — used by teardown to stop everything
all_services:
  - cross-claude-pod.service
  - cross-claude-postgres.service
  - cross-claude-server.service

# All Quadlet files managed by the playbook — used by teardown for removal
quadlet_files:
  - "{{ quadlet_dir }}/cross-claude.pod"
  - "{{ quadlet_dir }}/cross-claude-postgres.container"
  - "{{ quadlet_dir }}/cross-claude-server.container"
```

### `vars/secrets.yml` (Ansible Vault, never committed)

```yaml
mcp_api_key:       "REPLACE_WITH_RANDOM_32_CHAR_HEX"
postgres_password: "REPLACE_WITH_STRONG_PASSWORD"
```

### `vars/secrets.yml.example` (committed template)

```yaml
# Copy to secrets.yml, fill in values, then: ansible-vault encrypt vars/secrets.yml
mcp_api_key:       ""
postgres_password: ""
```

---

## init-db.sh Derivation

`init-db.sh` is mounted at `/docker-entrypoint-initdb.d/` and runs once on first
start if the data volume is empty. It must create the full schema in a single
transaction. The SQL below is derived directly from `db.mjs` (`SCHEMA_SQL`,
`INDEX_SQL`, `PG_TRGM_SQL`, `SEED_SQL`) — if `db.mjs` DDL changes, update this
script to match.

The Jinja2 template (`templates/init-db.sh.j2`) renders this script verbatim — no
template variables are needed because PostgreSQL picks up `POSTGRES_USER` and
`POSTGRES_DB` from its own environment.

```bash
#!/bin/bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- Schema

  CREATE TABLE IF NOT EXISTS channels (
    name        TEXT PRIMARY KEY,
    description TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           SERIAL PRIMARY KEY,
    channel      TEXT    NOT NULL REFERENCES channels(name),
    sender       TEXT    NOT NULL,
    content      TEXT    NOT NULL,
    message_type TEXT    DEFAULT 'message',
    in_reply_to  INTEGER REFERENCES messages(id),
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS instances (
    instance_id  TEXT PRIMARY KEY,
    description  TEXT,
    last_seen    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status       TEXT DEFAULT 'online',
    session_token TEXT
  );

  CREATE TABLE IF NOT EXISTS shared_data (
    key        TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    created_by TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    code       TEXT PRIMARY KEY,
    label      TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    used_at    TIMESTAMP,
    used_by    TEXT
  );

  CREATE TABLE IF NOT EXISTS read_cursors (
    channel      TEXT    NOT NULL,
    instance_id  TEXT    NOT NULL,
    last_read_id INTEGER NOT NULL,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel, instance_id)
  );

  CREATE INDEX IF NOT EXISTS idx_read_cursors_updated     ON read_cursors(updated_at);

  -- Indexes

  CREATE INDEX IF NOT EXISTS idx_messages_channel         ON messages(channel);
  CREATE INDEX IF NOT EXISTS idx_messages_sender          ON messages(sender);
  CREATE INDEX IF NOT EXISTS idx_messages_created         ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_in_reply_to     ON messages(in_reply_to);

  -- GIN trigram index for efficient ILIKE search (pg_trgm is bundled in postgres:16)

  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
    ON messages USING GIN (content gin_trgm_ops);

  -- Seed default channel

  INSERT INTO channels (name, description)
    VALUES ('general', 'Default channel for cross-instance communication')
    ON CONFLICT (name) DO NOTHING;
EOSQL
```

**Note:** `pg_trgm` is included in the standard `docker.io/postgres:16` image via
`postgresql-contrib` — no extra package installation is needed.

---

## Deployment

Managed by an Ansible playbook (`deploy-cross-claude.yml`) modeled on the
kangkodos pattern:

- **`vars/common.yml`** — paths, port, image refs, non-secret config
- **`vars/secrets.yml`** — Ansible Vault: `mcp_api_key`, `postgres_password`
- **`templates/`** — Jinja2 templates for Quadlet files and `init-db.sh`
- **`teardown-cross-claude.yml`** — stops services, removes Quadlets (does NOT delete the data volume)

Generated Quadlet files land in `~/.config/containers/systemd/` and are managed
by `systemctl --user`. The playbook must call `systemctl --user daemon-reload`
after writing Quadlet files and before starting services.

**Playbook task sequence:**

1. Create data and scripts directories (`postgres_data_dir`, `postgres_scripts_dir`)
2. Build server image: `podman build -t localhost/cross-claude-server:latest .`
   (run from the repo root; tag matches `server_image` in `vars/common.yml`)
3. Render and write Quadlet templates to `quadlet_dir`
4. Render and write `init-db.sh` to `postgres_scripts_dir`
5. `systemctl --user daemon-reload`
6. Start `cross-claude-pod.service`, `cross-claude-postgres.service`,
   `cross-claude-server.service` (in that order, each with a `wait_for` health gate)

---

## Image Build Strategy

| Phase | Server image source | Trigger |
|---|---|---|
| Prototype | `localhost/cross-claude-server:latest` — local `podman build` | Manual, developer workstation |
| Production | `ghcr.io/heatmiser/cross-claude-mcp:latest` — GitHub Actions CI | Push / merge to `main` |

The Ansible playbook accepts a `server_image` variable (`vars/common.yml`) so
switching from local to registry image requires only changing that one value and
re-running the playbook.

---

## Testing

With the hub pod running locally (deployed via Ansible), the existing npm test
suite runs against a real PostgreSQL instance by pointing `CROSS_CLAUDE_URL` at
the hub:

```bash
CROSS_CLAUDE_URL=http://localhost:3000 \
CROSS_CLAUDE_API_KEY=<mcp_api_key from secrets.yml> \
npm test
```

This covers the integration gaps that the current in-process tests cannot:
- PostgreSQL pool error handler (finding 2)
- `pg_trgm` GIN index (finding 6)
- `idx_messages_in_reply_to` index (finding 8)

### Acceptance Criteria

A deployment is complete when all of the following pass:

1. **All three systemd units active:**
   ```bash
   systemctl --user status cross-claude-pod.service \
                           cross-claude-postgres.service \
                           cross-claude-server.service
   ```
   All three must show `Active: active (running)`.

2. **Health endpoint responds:**
   ```bash
   curl -s http://localhost:3000/health | python3 -m json.tool
   ```
   Must return `{"status":"ok", ...}` with HTTP 200.

3. **Auth works:**
   ```bash
   curl -s -H "Authorization: Bearer <mcp_api_key>" \
        http://localhost:3000/api/channels
   ```
   Must return `{"channels":[...]}` (not 401).

4. **Full test suite passes against live PostgreSQL:**
   ```bash
   CROSS_CLAUDE_URL=http://localhost:3000 \
   CROSS_CLAUDE_API_KEY=<mcp_api_key> \
   npm test
   ```
   Must report 117 passed, 0 failed.

5. **Bridge end-to-end test passes:**
   ```bash
   CROSS_CLAUDE_URL=http://localhost:3000 \
   CROSS_CLAUDE_API_KEY=<mcp_api_key> \
   node test-bridge.mjs
   ```
   Must report 5 passed, 0 failed (Suite A cursor persistence + Suite B live push).

---

## Open Items

| # | Item | Status |
|---|---|---|
| 1 | No content size limits | Fixed — PR #1 |
| 2 | PostgreSQL pool no error handler | Fixed — PR #1 |
| 3 | `poll_interval_seconds: 0` busy-loop | Fixed — PR #1 |
| 4 | Bridge restart drops messages | Fixed — PR #1 |
| 5 | Railway URL silent fallback | Fixed — PR #2 |
| 6 | `searchMessages` full table scan | Fixed — PR #2 |
| 7 | Dead `effectiveAfter()` function | Fixed — PR #2 |
| 8 | Missing `idx_messages_in_reply_to` index | Fixed — PR #2 |
| 9 | `listen_live` description over-promises | Fixed — PR #3 |
| 10 | No security headers (helmet) | Fixed — PR #3 |
| 11 | Stale channel subscriptions on re-register | Fixed — PR #3 |
| — | Ansible playbook + Quadlet templates | Not started |
| — | `Containerfile` for server image | Not started |
| — | `init-db.sh` from `db.mjs` DDL | Not started |
| — | Local end-to-end deployment test | Blocked on above |
| — | `cross-gemini-bridge.mjs` | Future |
