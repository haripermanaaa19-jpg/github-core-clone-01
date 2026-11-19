// mcp.ts: the Model Context Protocol endpoint (POST /mcp), JSON-RPC 2.0 over streamable HTTP.
// It speaks the 2026-07-28 revision via server/discover and the legacy initialize handshake, and
// its tools act on the same store as REST, so objects agree across surfaces. Stateless: no
// session id is issued, and tools/list answers the same bytes on every call.

import type { ServerResponse } from 'node:http';
import {
  VIEWER,
  branchTip,
  commentJson,
  createIssue,
  createPull,
  forge,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
  type RepoRec,
} from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Record<string, unknown>;
}

class ToolFailure extends Error {}

function argString(args: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function requireArg(args: Record<string, unknown>, label: string, ...names: string[]): string {
  const value = argString(args, ...names);
  if (value === null) throw new ToolFailure(`missing required argument: ${label}`);
  return value;
}

function repoArg(args: Record<string, unknown>): RepoRec {
  let owner = argString(args, 'owner');
  let repoName = argString(args, 'repo', 'repository', 'name_or_repo');
  const fullName = argString(args, 'full_name', 'fullName');
  if (repoName === null && fullName !== null) {
    const parts = fullName.split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repoName = parts[1];
    }
  }
  if (repoName === null) throw new ToolFailure('missing required argument: repo');
  const repo = forge.getRepo(owner ?? VIEWER.login, repoName);
  if (repo === null) throw new ToolFailure(`repository ${owner ?? VIEWER.login}/${repoName} not found`);
  return repo;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: true };
}

const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: schema(
      {
        name: stringProp('The repository name'),
        description: stringProp('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      ['name'],
    ),
    run: (args) => {
      const name = requireArg(args, 'name', 'name');
      const description = argString(args, 'description') ?? '';
      const isPrivate = args.private === true;
      const created = forge.createRepo(VIEWER.login, name, description, isPrivate);
      if (created === 'exists') throw new ToolFailure(`repository ${VIEWER.login}/${name} already exists`);
      if (created === 'invalid') throw new ToolFailure(`invalid repository name: ${name}`);
      return repoJson(created);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: schema({ owner: stringProp('The repository owner login'), repo: stringProp('The repository name') }, ['repo']),
    run: (args) => repoJson(repoArg(args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: schema(
      {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The issue title'),
        body: stringProp('The issue body'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply' },
      },
      ['repo', 'title'],
    ),
    run: (args) => {
      const repo = repoArg(args);
      const title = requireArg(args, 'title', 'title');
      const body = argString(args, 'body') ?? '';
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map((label) => String(label)) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) throw new ToolFailure(`unknown label: ${label}`);
      }
      return issueJson(repo, createIssue(repo, title, body, labels));
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: schema(
      {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        state: stringProp('Filter by state: open, closed or all'),
      },
      ['repo'],
    ),
    run: (args) => {
      const repo = repoArg(args);
      const state = (argString(args, 'state') ?? 'open').toLowerCase();
      const issues = [...repo.issues.values()]
        .filter((issue) => issue.kind === 'issue')
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return { issues } as unknown as Record<string, unknown>;
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: schema(
      {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        issue_number: { type: 'integer', description: 'The issue number' },
      },
      ['repo', 'issue_number'],
    ),
    run: (args) => {
      const repo = repoArg(args);
      const number = parseInt(requireArg(args, 'issue_number', 'issue_number', 'number'), 10);
      const issue = repo.issues.get(number);
      if (issue === undefined || issue.kind !== 'issue') throw new ToolFailure(`issue ${number} not found`);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: schema(
      {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch name'),
        base: stringProp('The base branch name'),
      },
      ['repo', 'title', 'head', 'base'],
    ),
    run: (args) => {
      const repo = repoArg(args);
      const title = requireArg(args, 'title', 'title');
      const head = requireArg(args, 'head', 'head', 'headRefName');
      const base = requireArg(args, 'base', 'base', 'baseRefName');
      if (branchTip(repo, head) === null) throw new ToolFailure(`head branch ${head} not found`);
      if (branchTip(repo, base) === null) throw new ToolFailure(`base branch ${base} not found`);
      const pull = createPull(repo, title, argString(args, 'body') ?? '', head, base);
      if (pull === null) throw new ToolFailure('could not create the pull request');
      return pullJson(repo, pull);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: schema(
      {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        state: stringProp('Filter by state: open, closed or all'),
      },
      ['repo'],
    ),
    run: (args) => {
      const repo = repoArg(args);
      const state = (argString(args, 'state') ?? 'open').toLowerCase();
      const pulls = [...repo.issues.values()]
        .filter((issue) => issue.kind === 'pull')
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => pullJson(repo, issue));
      return { pull_requests: pulls } as unknown as Record<string, unknown>;
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: schema(
      {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        pull_number: { type: 'integer', description: 'The pull request number' },
        merge_method: stringProp('The merge method: merge, squash or rebase'),
      },
      ['repo', 'pull_number'],
    ),
    run: (args) => {
      const repo = repoArg(args);
      const number = parseInt(requireArg(args, 'pull_number', 'pull_number', 'number'), 10);
      const issue = repo.issues.get(number);
      if (issue === undefined || issue.kind !== 'pull' || issue.pull === null) throw new ToolFailure(`pull request ${number} not found`);
      if (!issue.pull.merged) {
        const method = (argString(args, 'merge_method', 'mergeMethod') ?? 'merge').toLowerCase();
        const merged = mergePull(repo, issue, method);
        if (merged === null) throw new ToolFailure(`pull request ${number} is not mergeable`);
      }
      return pullJson(repo, issue);
    },
  },
  {
    name: 'create_comment',
    description: 'Comment on an issue or pull request.',
    inputSchema: schema(
      {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        issue_number: { type: 'integer', description: 'The issue or pull request number' },
        body: stringProp('The comment body'),
      },
      ['repo', 'issue_number', 'body'],
    ),
    run: (args) => {
      const repo = repoArg(args);
      const number = parseInt(requireArg(args, 'issue_number', 'issue_number', 'number'), 10);
      const issue = repo.issues.get(number);
      if (issue === undefined) throw new ToolFailure(`issue ${number} not found`);
      const comment = { id: forge.allocCommentDbId(), body: requireArg(args, 'body', 'body'), seq: forge.tick() };
      issue.comments.push(comment);
      return commentJson(repo, comment);
    },
  },
];

const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id as never, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcOutcome {
  return { status, payload: { jsonrpc: '2.0', id: id as never, error: { code, message } } };
}

function callTool(params: Record<string, unknown>): unknown {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { __rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  try {
    const resource = tool.run(args);
    const text = JSON.stringify(resource);
    return { content: [{ type: 'text', text }], structuredContent: resource, isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

function handleRpc(request: Record<string, unknown>): RpcOutcome | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  if (id === undefined) return null; // a notification: accepted, no answer
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const outcome = callTool((request.params ?? {}) as Record<string, unknown>) as Record<string, unknown>;
      const marker = outcome.__rpcError as { code: number; message: string } | undefined;
      if (marker !== undefined) return rpcError(id, marker.code, marker.message);
      return rpcResult(id, outcome);
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Serve one POST /mcp body. The caller has already authenticated the request; a body that is not
 * JSON is answered 400 with a JSON-RPC parse error, as the transport requires.
 */
export function handleMcp(res: ServerResponse, bodyText: string): void {
  const send = (status: number, payload: Record<string, unknown> | unknown[] | null): void => {
    if (payload === null) {
      res.writeHead(202, { 'content-length': 0 });
      res.end();
      return;
    }
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const outcomes: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const outcome = handleRpc(entry as Record<string, unknown>);
      if (outcome !== null && outcome.payload !== null) outcomes.push(outcome.payload);
    }
    send(200, outcomes as never);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const outcome = handleRpc(parsed as Record<string, unknown>);
  if (outcome === null) {
    send(202, null);
    return;
  }
  send(outcome.status, outcome.payload);
}
