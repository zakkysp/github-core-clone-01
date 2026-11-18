// mcp.ts — Model Context Protocol over Streamable HTTP at /mcp: the modern 2026-07-28
// era (server/discover, no handshake, no session) with the legacy initialize handshake
// answered too. Tools act on the same store REST does.

import { VIEWER_LOGIN, type Store } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      }
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== VIEWER_LOGIN) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== VIEWER_LOGIN) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
      });
    }
    case 'list_issues': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== VIEWER_LOGIN) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label })),
        }));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== VIEWER_LOGIN) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const head = String(args.head);
      const base = String(args.base);
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolError(`head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return toolError(`base branch ${base} does not exist`);
      const existing = repo.pulls.find((pull) => pull.head === head && pull.state === 'open');
      const pull = existing ?? store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      const headSha = store.peelToCommit(repo, `refs/heads/${pull.head}`) ?? '';
      const baseSha = store.peelToCommit(repo, `refs/heads/${pull.base}`) ?? '';
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.head, sha: headSha },
        base: { ref: pull.base, sha: baseSha },
      });
    }
    case 'merge_pull_request': {
      const owner = String(args.owner);
      const repoName = String(args.repo);
      if (owner !== VIEWER_LOGIN) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError(`Pull request #${args.pull_number} not found`);
      if (pull.state !== 'open') return toolError(`Pull request #${number} is already closed`);
      const sha = store.mergePull(repo, pull);
      if (sha === null) return toolError(`Pull request #${number} cannot merge (conflict)`);
      return toolResult({ number: pull.number, merged: true, state: pull.state, sha });
    }
    default:
      return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

export interface McpReply {
  status: number;
  json: unknown;
}

/** Handle one POST /mcp body (already read as text). Auth is checked by the server. */
export function handleMcp(store: Store, rawBody: string): McpReply {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const record = body as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const id = record.id === undefined ? null : record.id;
  const isNotification = record.id === undefined;
  const params = isRecord(record.params) ? record.params : {};

  const result = (value: unknown): McpReply => ({ status: 200, json: { jsonrpc: '2.0', id, result: value } });
  const rpcError = (code: number, message: string, data?: unknown): McpReply => ({
    status: 200,
    json: { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } },
  });

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, json: null };
  }
  if (isNotification) {
    return { status: 202, json: null };
  }

  switch (method) {
    case 'server/discover': {
      return result({
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
      return result({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list': {
      return result({ tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(store, toolName, args);
      if (isRecord(outcome) && '__rpcError' in outcome) {
        const rpcErr = outcome.__rpcError as { code: number; message: string };
        return rpcError(rpcErr.code, rpcErr.message);
      }
      return result(outcome);
    }
    default:
      return rpcError(-32601, `Method not found: ${method}`);
  }
}
