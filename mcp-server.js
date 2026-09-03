const sql = require('mssql');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');

function loadTargets() {
  const targets = new Map();

  if (process.env.LOG_TARGETS) {
    let parsed;
    try {
      parsed = JSON.parse(process.env.LOG_TARGETS);
    } catch (err) {
      throw new Error(`LOG_TARGETS is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('LOG_TARGETS must be a non-empty JSON array');
    }
    for (const entry of parsed) {
      if (!entry.name) {
        throw new Error('Every entry in LOG_TARGETS needs a "name"');
      }
      if (targets.has(entry.name)) {
        throw new Error(`Duplicate target name in LOG_TARGETS: "${entry.name}"`);
      }
      targets.set(entry.name, {
        server: entry.server,
        port: entry.port ? Number(entry.port) : undefined,
        database: entry.database,
        user: entry.user,
        password: entry.password,
        options: {
          encrypt: entry.encrypt !== false,
          trustServerCertificate: entry.trustServerCertificate === true
        }
      });
    }
  } else {
    // Fall back to a single target from the plain MSSQL_* variables.
    targets.set('default', {
      server: process.env.MSSQL_SERVER,
      port: process.env.MSSQL_PORT ? Number(process.env.MSSQL_PORT) : undefined,
      database: process.env.MSSQL_DATABASE,
      user: process.env.MSSQL_USER,
      password: process.env.MSSQL_PASSWORD,
      options: {
        encrypt: process.env.MSSQL_ENCRYPT !== 'false',
        trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true'
      }
    });
  }

  return targets;
}

const targets = loadTargets();
const targetNames = [...targets.keys()];
const defaultTargetName = targetNames[0];

const pools = new Map();
function getPool(targetName) {
  const config = targets.get(targetName);
  if (!config) {
    throw new Error(`Unknown target "${targetName}". Available targets: ${targetNames.join(', ')}`);
  }
  if (!pools.has(targetName)) {
    const promise = new sql.ConnectionPool(config).connect().catch(err => {
      pools.delete(targetName);
      throw err;
    });
    pools.set(targetName, promise);
  }
  return pools.get(targetName);
}

const LOG_MESSAGES_QUERY = `
  SELECT TOP (@limit) Id, LogSourceId, LogSourceName, LogLevelId, LogLevelName, Category,
         Message, Timestamp, SourceTimestamp, Hostname, ContextData, ClientText, CustomerText
  FROM   LogMessagesView
  WHERE (@levelName IS NULL OR LogLevelName = @levelName)
    AND (@minLevelId IS NULL OR LogLevelId >= @minLevelId)
    AND (@maxLevelId IS NULL OR LogLevelId <= @maxLevelId)
    AND (@search IS NULL OR Message LIKE '%' + @search + '%')
    AND (@since IS NULL OR Timestamp >= @since)
  ORDER BY Id DESC
`;

async function queryLogs({ target, limit, levelName, minLevelId, maxLevelId, search, since }) {
  const pool = await getPool(target);
  const result = await pool.request()
    .input('limit', sql.Int, limit)
    .input('levelName', sql.NVarChar, levelName ?? null)
    .input('minLevelId', sql.Int, minLevelId ?? null)
    .input('maxLevelId', sql.Int, maxLevelId ?? null)
    .input('search', sql.NVarChar, search ?? null)
    .input('since', sql.DateTime2, since ?? null)
    .query(LOG_MESSAGES_QUERY);
  return result.recordset;
}

const server = new McpServer(
  { name: 'log-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.registerTool(
  'query_logs',
  {
    title: 'Query logs',
    description: 'Query recent log entries from LogMessagesView (MSSQL), most recent first. ' +
      'Every target database uses the same LogLevelId scale: 0=Trace, 1=Debug, 2=Information, ' +
      '3=Warning, 4=Error, 5=Critical, 6=None. Use minLevelId/maxLevelId to search a range of ' +
      'severities (e.g. minLevelId=3 for Warning and above, or minLevelId=2 maxLevelId=3 for ' +
      'Information through Warning) instead of matching a single levelName.',
    inputSchema: {
      target: z.enum(targetNames).optional().default(defaultTargetName)
        .describe(`Which database to query. Available: ${targetNames.join(', ')} (default "${defaultTargetName}")`),
      limit: z.number().int().min(1).max(1000).optional().default(200)
        .describe('Maximum number of rows to return (default 200, max 1000)'),
      levelName: z.string().optional()
        .describe('Filter by exact LogLevelName, e.g. "Error", "Warning", "Information"'),
      minLevelId: z.number().int().min(0).max(6).optional()
        .describe('Filter to rows with LogLevelId >= this value. Scale: 0=Trace, 1=Debug, 2=Information, 3=Warning, 4=Error, 5=Critical, 6=None'),
      maxLevelId: z.number().int().min(0).max(6).optional()
        .describe('Filter to rows with LogLevelId <= this value. Scale: 0=Trace, 1=Debug, 2=Information, 3=Warning, 4=Error, 5=Critical, 6=None'),
      search: z.string().optional()
        .describe('Filter to rows whose Message contains this substring'),
      since: z.string().optional()
        .describe('Filter to rows with Timestamp >= this ISO 8601 datetime')
    }
  },
  async ({ target, limit, levelName, minLevelId, maxLevelId, search, since }) => {
    const rows = await queryLogs({ target, limit, levelName, minLevelId, maxLevelId, search, since });
    return {
      content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }]
    };
  }
);

serveStdio(() => server, {
  onerror: err => console.error('[log-mcp]', err)
});

process.on('SIGINT', async () => {
  await Promise.all([...pools.values()].map(p => p.then(pool => pool.close()).catch(() => {})));
  process.exit(0);
});
