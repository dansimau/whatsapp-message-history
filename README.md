# whatsapp-message-history

A standalone WhatsApp archiver. It links to your WhatsApp account as an extra
device (the same mechanism as WhatsApp Web, via [Baileys](https://github.com/WhiskeySockets/Baileys)),
records every message it sees into a SQLite database with full-text search, and
exposes the whole thing, including the initial pairing, through an
[MCP](https://modelcontextprotocol.io) server so any agent can drive it.

Nothing in here depends on a particular agent framework. Point Hermes, Claude
Code, or anything else that speaks MCP at it.

## What it does

- **Archives everything** the linked device receives: direct messages, groups,
  your own messages (including ones you send from your phone), media metadata,
  reactions, edits and deletions. Edits update the stored text; deletions are
  flagged, not removed.
- **Backfills history** on first link by asking WhatsApp for the full history
  sync (what WhatsApp Web shows on a fresh login, typically the last several
  months depending on your phone).
- **SQLite with FTS5** for fast full-text search, plus chats, contacts and
  LID↔phone identity mapping so results show names, not just JIDs.
- **MCP tools** for linking (pairing code or QR image), status, searching,
  reading a chat, and listing chats/contacts.
- **Copy-on-write guard**: on startup it checks whether the data directory is on
  btrfs and, if so, makes sure the database is not subject to copy-on-write
  (see below).

## Requirements

- Node.js 22 or newer.
- Linux, macOS or Windows. The copy-on-write guard only acts on Linux/btrfs.
- A free "linked device" slot on your WhatsApp account (WhatsApp allows four).

## Install and run

```sh
git clone https://github.com/dansimau/whatsapp-message-history.git
cd whatsapp-message-history
npm install
npm run build
npm start            # = node dist/index.js serve
```

The daemon logs to stderr and listens on `http://127.0.0.1:8765/mcp`. Data
lives in `~/.whatsapp-message-history/` by default:

```
~/.whatsapp-message-history/
├── messages.db      # the SQLite archive (WAL mode)
├── session/         # linked-device credentials — treat like a password
└── media/           # only when WMH_DOWNLOAD_MEDIA=true
```

### Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `WMH_DATA_DIR` | `~/.whatsapp-message-history` | Where the database, session and media go |
| `WMH_HOST` / `WMH_PORT` | `127.0.0.1` / `8765` | MCP listen address |
| `WMH_AUTH_TOKEN` | unset | If set, `/mcp` requires `Authorization: Bearer <token>` |
| `WMH_SYNC_FULL_HISTORY` | `true` | Request the full history sync when linking |
| `WMH_DOWNLOAD_MEDIA` | `false` | Also download attachments into `media/` |
| `WMH_LOG_LEVEL` | `info` | pino log level |
| `WMH_BAILEYS_LOG_LEVEL` | `warn` | Log level for the Baileys library |
| `WMH_SERVER_URL` | `http://HOST:PORT/mcp` | Daemon URL used by the `stdio` proxy |

## Connecting an agent

The daemon speaks MCP over **Streamable HTTP** at `/mcp`. If your client can
only spawn stdio servers, use the bundled proxy, which forwards to the daemon:

```sh
whatsapp-message-history stdio      # or: node dist/index.js stdio
```

**Claude Code**

```sh
claude mcp add --transport http whatsapp http://127.0.0.1:8765/mcp
```

**Hermes Agent** (`~/.hermes/config.yaml`)

```yaml
mcp_servers:
  whatsapp:
    url: http://127.0.0.1:8765/mcp
```

**Generic stdio configuration**

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/whatsapp-message-history/dist/index.js", "stdio"]
    }
  }
}
```

## Linking your account (all through MCP)

1. Ask the agent to call `whatsapp_status`. It reports `state: unlinked`.
2. Call `whatsapp_link`:
   - **With `phone_number`** (international format, digits only, e.g.
     `31612345678`): WhatsApp issues an 8-character **pairing code**. On the
     phone go to *Settings → Linked devices → Link a device → Link with phone
     number instead* and type it in. No camera needed, so this works well
     when the agent is driving a headless server.
   - **Without a phone number**: the tool returns a **QR code as a PNG image**
     (plus the raw payload) to scan from *Settings → Linked devices → Link a
     device*. QR codes rotate every ~20 seconds; `whatsapp_link_qr` returns
     the latest one.
3. `whatsapp_status` flips to `state: connected` and the history sync starts.
   Progress is reported in the same tool.

`whatsapp_unlink` logs the device out and deletes `session/`; the archive stays.

## Tools

| Tool | Purpose |
| --- | --- |
| `whatsapp_status` | Link state, pairing progress, history-sync progress, archive stats, CoW status |
| `whatsapp_link` | Start pairing. Returns a pairing code (`phone_number` given) or a QR image |
| `whatsapp_link_qr` | Fetch the current QR image while waiting for a scan |
| `whatsapp_unlink` | Log out and delete the local session (`confirm: true`) |
| `whatsapp_search_messages` | Full-text search with `chat`, `sender`, `from_me`, `since`, `until`, `limit` filters |
| `whatsapp_get_messages` | Read one chat chronologically; page with `before`/`after` or center on `around_message_id` |
| `whatsapp_list_chats` | Chats with message counts, most recent first |
| `whatsapp_list_contacts` | Resolve names, phone numbers and JIDs |

Chats and senders accept a name fragment, a phone number, or a JID. Times
accept ISO 8601, unix seconds, or relative windows like `7d`, `24h`, `30m`.
Search queries match all words; append `*` for prefix matching (`invoic*`).

## The copy-on-write guard

SQLite files on btrfs fragment badly under copy-on-write: every page write
lands in a new extent and a long-lived archive ends up with hundreds of
thousands of them. The fix is the NOCOW attribute (`chattr +C`), which only
takes effect on empty files. So on every startup, before opening the database,
the daemon:

1. Checks whether the data directory is on btrfs (`stat -f`). If not, or if not
   on Linux, there is nothing to do.
2. Sets `+C` on the data directory so newly created files inherit it.
3. If a database already exists *with* copy-on-write, checkpoints its WAL,
   copies it into a fresh file (which inherits NOCOW) and atomically swaps it in.

The outcome is logged at startup and reported by `whatsapp_status`. Note that
NOCOW files are excluded from btrfs data checksumming; that is the usual
trade-off for databases on btrfs.

## Running as a service

`systemd` unit (`~/.config/systemd/user/whatsapp-message-history.service`):

```ini
[Unit]
Description=WhatsApp message archiver
After=network-online.target

[Service]
ExecStart=/usr/bin/node /path/to/whatsapp-message-history/dist/index.js serve
Restart=always
RestartSec=5
Environment=WMH_DATA_DIR=%h/.whatsapp-message-history

[Install]
WantedBy=default.target
```

Docker:

```sh
docker build -t whatsapp-message-history .
docker run -d --name wmh -p 127.0.0.1:8765:8765 -v wmh-data:/data whatsapp-message-history
```

## Development

```sh
npm run dev          # run from source with tsx
npm test             # unit tests (node:test)
npm run typecheck
```

## Privacy and security notes

- `session/` holds the keys that let anyone read your WhatsApp as this device.
  Keep the data directory private (it is created with your user's umask).
- The MCP endpoint binds to localhost by default. If you expose it further,
  set `WMH_AUTH_TOKEN` and put it behind TLS.
- Anything your agent can reach through these tools, it can read. Scope agent
  access accordingly.
- This uses the unofficial WhatsApp Web protocol via Baileys. It is not
  affiliated with or endorsed by WhatsApp/Meta, and accounts have been banned
  for automation in the past. This app only receives messages; it never sends.
