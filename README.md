# log-mcp

An MCP (Model Context Protocol) server that exposes `LogMessagesView` from a
SQL Server database as a queryable tool for MCP clients (e.g. Claude Desktop,
Claude Code).

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your SQL Server connection details,
or set the same variables in your MCP client's server config.

### Single database

- `MSSQL_SERVER`
- `MSSQL_PORT` (default `1433`)
- `MSSQL_DATABASE`
- `MSSQL_USER`
- `MSSQL_PASSWORD`
- `MSSQL_ENCRYPT` (default `true`)
- `MSSQL_TRUST_SERVER_CERTIFICATE` (default `false`)

### Multiple databases

All target databases must share the same `LogMessagesView` structure. Set
`LOG_TARGETS` to a JSON array instead of the plain `MSSQL_*` variables (when
set, `LOG_TARGETS` takes precedence and the `MSSQL_*` variables are ignored):

```json
LOG_TARGETS=[
  { "name": "prod",    "server": "prod-sql-host",    "database": "Logs", "user": "login", "password": "secret" },
  { "name": "staging", "server": "staging-sql-host", "database": "Logs", "user": "login", "password": "secret" }
]
```

Each entry accepts the same fields as the single-database setup
(`server`, `port`, `database`, `user`, `password`, `encrypt`,
`trustServerCertificate`), keyed by `name` instead of an `MSSQL_` prefix.
The `query_logs` tool then exposes a `target` parameter to pick which
database to query, defaulting to the first entry in the array.

The server speaks MCP over stdio, so it doesn't load `.env` itself — export
the variables in your shell, or set them in the client's server `env` block,
e.g. for Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "log-mcp": {
      "command": "node",
      "args": ["D:/code/ai/yaaia/log-mcp/mcp-server.js"],
      "env": {
        "MSSQL_SERVER": "your-sql-server-host",
        "MSSQL_DATABASE": "your-database-name",
        "MSSQL_USER": "your-sql-login",
        "MSSQL_PASSWORD": "your-sql-password"
      }
    }
  }
}
```

## Tool

### `query_logs`

Queries `LogMessagesView`, most recent rows first:

```sql
SELECT TOP (@limit) Id, LogSourceId, LogSourceName, LogLevelId, LogLevelName, Category,
       Message, Timestamp, SourceTimestamp, Hostname, ContextData, ClientText, CustomerText
FROM   LogMessagesView
ORDER BY Id DESC
```

Parameters (all optional):

- `target` (string): which database to query, when `LOG_TARGETS` defines more than one (defaults to the first configured target)
- `limit` (number, default 200, max 1000): maximum rows to return
- `levelName` (string): filter by exact `LogLevelName` (e.g. `"Error"`)
- `minLevelId` / `maxLevelId` (number, 0-6): filter by `LogLevelId` range, using the level scale below (e.g. `minLevelId=3` for Warning and above)
- `search` (string): filter to rows whose `Message` contains this substring
- `since` (string, ISO 8601 datetime): filter to rows with `Timestamp >=` this value

Every target database uses the same `LogLevelId` scale:

| Id | Level |
| -- | ----- |
| 0  | Trace |
| 1  | Debug |
| 2  | Information |
| 3  | Warning |
| 4  | Error |
| 5  | Critical |
| 6  | None |

## Testing

```bash
npm run inspect
```

This launches the server under the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
so you can call `query_logs` interactively without wiring up a full client.
