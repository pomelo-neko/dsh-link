// dsh-link helper: drive the Alibaba Cloud OpenAPI MCP that MCPHub already configures.
// Usage:
//   node integrations/aliyun-mcp.mjs list
//   node integrations/aliyun-mcp.mjs call <toolName> '<jsonArgs>'
//   node integrations/aliyun-mcp.mjs raw <jsonRpcMethod> '<jsonParams>'
// The OAuth access token is read from MCPHub's mcp_settings.json at runtime (never printed).
import process from 'node:process';
import path from 'node:path';
import { promises as fs, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Tool arguments: inline JSON, or @path/to/args.json (PowerShell mangles inline quotes). */
function parseArgsArg(value) {
  if (!value) return {};
  const text = value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value;
  return JSON.parse(text);
}

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '.';
const MCPHUB_SETTINGS = process.env.MCPHUB_SETTINGS ?? path.join(HOME, '.mcphub', 'mcp_settings.json');
const SDK_BASE = process.env.DSH_MCP_SDK
  ?? path.join(process.env.DSH_HOME ?? HOME, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');

async function serverConfig(name = process.env.ALIYUN_MCP_SERVER ?? 'openapi-mcp-core') {
  const raw = JSON.parse(await fs.readFile(MCPHUB_SETTINGS, 'utf8'));
  const entry = raw.mcpServers?.[name];
  if (!entry) throw new Error(`MCP server "${name}" not found in ${MCPHUB_SETTINGS}`);
  // Default: go through MCPHub, which owns (and refreshes) the OAuth session for this server.
  if (process.env.ALIYUN_MCP_VIA_HUB !== '0') {
    const hub = (process.env.MCPHUB_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
    return { url: hub + '/mcp/' + name, token: process.env.MCPHUB_TOKEN ?? null, raw: entry, transport: 'hub' };
  }
  const token = entry.oauth?.accessToken ?? entry.headers?.Authorization?.replace(/^Bearer\s+/i, '') ?? process.env.ALIYUN_MCP_TOKEN;
  if (!token) throw new Error(`no access token configured for "${name}" (oauth.accessToken missing)`);
  return { url: entry.url, token, raw: entry, transport: 'direct' };
}

export async function connect(name) {
  const { url, token, transport } = await serverConfig(name);
  const { Client } = await import(pathToFileURL(path.join(SDK_BASE, 'client', 'index.js')).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(SDK_BASE, 'client', 'streamableHttp.js')).href);
  const client = new Client({ name: 'dshlink-aliyun', version: '0.1.0' }, { capabilities: {} });
  const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: 'Bearer ' + token } } : undefined
  });
  await client.connect(httpTransport);
  client.dshlinkTransport = transport;
  return client;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const client = await connect();
  try {
    if (!command || command === 'list') {
      const { tools } = await client.listTools();
      const rows = tools.map((tool) => ({ name: tool.name, description: (tool.description ?? '').split('\n')[0].slice(0, 110) }));
      if (process.argv.includes('--json')) {
        process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
      } else {
        for (const row of rows) console.log(`${row.name}\n    ${row.description}`);
        console.log(`\n${rows.length} tool(s)`);
      }
      return;
    }
    if (command === 'call') {
      const name = rest[0];
      const args = parseArgsArg(rest[1]);
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      process.stdout.write(text + '\n');
      if (result.isError) process.exitCode = 1;
      return;
    }
    if (command === 'raw') {
      const method = rest[0];
      const params = parseArgsArg(rest[1]);
      const result = await client.request({ method, params }, (await import(pathToFileURL(path.join(SDK_BASE, 'types.js')).href)).ResultSchema ?? undefined);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    console.error(`unknown command: ${command}\nusage: aliyun-mcp.mjs list | call <tool> '<json>' | raw <method> '<json>'`);
    process.exitCode = 2;
  } finally {
    await client.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`aliyun-mcp: ${err.message}`);
    process.exitCode = 1;
  });
}
