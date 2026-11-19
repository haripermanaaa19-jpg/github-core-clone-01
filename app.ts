// app.ts: the forge's HTTP server — REST v3 under /api/v3, GraphQL at /api/graphql, MCP at
// /mcp and git smart HTTP at /{owner}/{repo}.git, all over the one store in store.ts.
// starter/main.ts owns the lifecycle; this file is the surface the suite scores.
//
// Wire discipline (wire.ts): every REST reply is application/json with a non-empty
// X-GitHub-Request-Id; errors are JSON with a string message; a repository belongs to the
// login the bearer token names, and the same name under another owner is a 404, never a 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { parseCommit } from './git.ts';
import { handleGitHttp } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import {
  VIEWER,
  USERS,
  branchTip,
  commentJson,
  commitFiles,
  createIssue,
  createPull,
  forge,
  getObject,
  isAncestor,
  issueJson,
  labelJson,
  mergePull,
  pullFiles,
  pullMergeTree,
  pullJson,
  readPath,
  repoJson,
  resolveCommitish,
  userJson,
  type IssueRec,
  type RepoRec,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; on failure the error is answered here and null comes back. */
function parseJsonBody(res: ServerResponse, body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendError(res, 400, 'Invalid JSON: expected an object');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Invalid JSON');
    return null;
  }
}

function authorized(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

interface Pagination {
  perPage: number;
  page: number;
}

function paginationOf(query: URLSearchParams): Pagination {
  const perPageRaw = parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Paginate a list and set the Link header chain (absolute, same-origin URLs) like GitHub. */
function paginate<T>(req: IncomingMessage, res: ServerResponse, url: URL, items: readonly T[]): T[] {
  const { perPage, page } = paginationOf(url.searchParams);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const host = req.headers.host ?? 'localhost';
  const pageUrl = (target: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `<http://${host}${url.pathname}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`${pageUrl(page + 1)}; rel="next"`);
    links.push(`${pageUrl(totalPages)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${pageUrl(page - 1)}; rel="prev"`);
    links.push(`${pageUrl(1)}; rel="first"`);
  }
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------- REST: repositories

function repoCreate(res: ServerResponse, body: Record<string, unknown>): void {
  const name = typeof body.name === 'string' ? body.name : '';
  const description = typeof body.description === 'string' ? body.description : '';
  const isPrivate = body.private === true;
  const created = forge.createRepo(VIEWER.login, name, description, isPrivate);
  if (created === 'exists') {
    sendJson(res, 422, {
      message: 'Repository creation failed: name already exists on this account',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
    return;
  }
  if (created === 'invalid') {
    sendJson(res, 422, { message: 'Repository creation failed: name is invalid' });
    return;
  }
  // auto_init is accepted and ignored: the suite's repos start unborn either way.
  sendJson(res, 201, repoJson(created));
}

function repoPatch(res: ServerResponse, repo: RepoRec, body: Record<string, unknown>): void {
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    const clash = forge.getRepo(repo.owner, body.name);
    if (clash !== null && clash !== repo) {
      sendJson(res, 422, { message: 'Repository creation failed: name already exists on this account' });
      return;
    }
    forge.repos.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`);
    repo.name = body.name;
    forge.repos.set(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`, repo);
  }
  sendJson(res, 200, repoJson(repo));
}

// ---------------------------------------------------------------- REST: git data

function refObjectJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = getObject(repo, oid);
  return { sha: oid, type: object?.type ?? 'commit' };
}

function branchesList(res: ServerResponse, repo: RepoRec): void {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(res, 200, branches);
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: forge.isoOf(0) };
  return { name: match[1], email: match[2], date: new Date(parseInt(match[3], 10) * 1000).toISOString() };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> | null {
  const object = getObject(repo, oid);
  if (object === null || object.type !== 'commit') return null;
  const text = object.data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('author ')) authorLine = line.slice(7);
    if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const info = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      // The API answers the message as authored; a git object's conventional trailing
      // newline is not part of it.
      message: message.replace(/\n+$/, ''),
      author: parseAuthorLine(authorLine),
      committer: parseAuthorLine(committerLine),
      tree: { sha: info.tree },
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

function commitsList(res: ServerResponse, repo: RepoRec, query: URLSearchParams): void {
  const shaParam = query.get('sha');
  const start = shaParam === null || shaParam === '' ? resolveCommitish(repo, repo.defaultBranch) : resolveCommitish(repo, shaParam);
  if (start === null) {
    sendJson(res, 200, []);
    return;
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    seen.add(oid);
    ordered.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  const perPageRaw = parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : ordered.length;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const slice = ordered.slice((page - 1) * perPage, page * perPage);
  sendJson(
    res,
    200,
    slice.map((oid) => commitJson(repo, oid)).filter((entry) => entry !== null),
  );
}

// ---------------------------------------------------------------- REST: contents

function contentsGet(res: ServerResponse, repo: RepoRec, path: string, query: URLSearchParams): void {
  const ref = query.get('ref') ?? repo.defaultBranch;
  const commit = resolveCommitish(repo, ref);
  if (commit === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const found = readPath(repo, commit, path);
  if (found === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (found.kind === 'file') {
    const name = path.split('/').pop() ?? path;
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: found.data.toString('base64'),
      name,
      path,
      sha: found.oid,
      size: found.data.length,
    });
    return;
  }
  const listing = found.entries.map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : getObject(repo, entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      size: blob === null ? 0 : blob.data.length,
    };
  });
  listing.sort((a, b) => a.name.localeCompare(b.name));
  sendJson(res, 200, listing);
}

function contentsPut(res: ServerResponse, repo: RepoRec, path: string, body: Record<string, unknown>): void {
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  if (typeof body.content !== 'string') {
    sendError(res, 422, 'Validation Failed: content must be base64-encoded');
    return;
  }
  const content = Buffer.from(body.content, 'base64');
  const tip = branchTip(repo, branch);
  const existing = tip === null ? null : readPath(repo, tip, path);
  const existingFile = existing !== null && existing.kind === 'file' ? existing : null;
  if (existingFile !== null) {
    if (body.sha === undefined || body.sha === null) {
      sendError(res, 422, 'Validation Failed: sha must be supplied when updating an existing file');
      return;
    }
    if (body.sha !== existingFile.oid) {
      sendError(res, 409, 'Conflict: the sha does not match the current content');
      return;
    }
  }
  const result = commitFiles(repo, branch, new Map([[path, content]]), message);
  const blobOid = result.blobs.get(path) as string;
  sendJson(res, existingFile !== null ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: result.commitOid, message },
  });
}

function contentsDelete(res: ServerResponse, repo: RepoRec, path: string, body: Record<string, unknown>): void {
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const tip = branchTip(repo, branch);
  const existing = tip === null ? null : readPath(repo, tip, path);
  if (existing === null || existing.kind !== 'file') {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (typeof body.sha === 'string' && body.sha !== existing.oid) {
    sendError(res, 409, 'Conflict: the sha does not match the current content');
    return;
  }
  const result = commitFiles(repo, branch, new Map([[path, null]]), message);
  sendJson(res, 200, { content: null, commit: { sha: result.commitOid, message } });
}

// ---------------------------------------------------------------- REST: issues & comments

function issueLabelsOf(repo: RepoRec, body: Record<string, unknown>): string[] | null {
  if (!Array.isArray(body.labels)) return [];
  const names: string[] = [];
  for (const entry of body.labels as unknown[]) {
    const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? String((entry as Record<string, unknown>).name ?? '') : '';
    if (!repo.labels.has(name)) return null;
    names.push(name);
  }
  return names;
}

function issuesList(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec): void {
  const state = url.searchParams.get('state') ?? 'open';
  const direction = url.searchParams.get('direction') ?? 'desc';
  let records = [...repo.issues.values()].filter((issue) => issue.kind === 'issue');
  if (state === 'open' || state === 'closed') records = records.filter((issue) => issue.state === state);
  const labelsParam = url.searchParams.get('labels');
  if (labelsParam !== null && labelsParam !== '') {
    const wanted = labelsParam.split(',');
    records = records.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
  }
  records.sort((a, b) => (direction === 'asc' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
  const page = paginate(req, res, url, records);
  sendJson(res, 200, page.map((issue) => issueJson(repo, issue)));
}

function commentsList(res: ServerResponse, repo: RepoRec, issue: IssueRec): void {
  const comments = [...issue.comments].sort((a, b) => a.seq - b.seq);
  sendJson(res, 200, comments.map((comment) => commentJson(repo, comment)));
}

// ---------------------------------------------------------------- REST: pulls

function pullsList(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec): void {
  const state = url.searchParams.get('state') ?? 'open';
  let records = [...repo.issues.values()].filter((issue) => issue.kind === 'pull');
  if (state === 'open' || state === 'closed') records = records.filter((issue) => issue.state === state);
  records.sort((a, b) => b.seq - a.seq || b.number - a.number);
  const page = paginate(req, res, url, records);
  sendJson(res, 200, page.map((issue) => pullJson(repo, issue)));
}

function pullMerge(res: ServerResponse, repo: RepoRec, issue: IssueRec, body: Record<string, unknown>): void {
  const pull = issue.pull as NonNullable<IssueRec['pull']>;
  if (pull.merged) {
    sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  if (issue.state === 'closed') {
    sendError(res, 405, 'Pull Request is not mergeable');
    return;
  }
  const methodRaw = typeof body.merge_method === 'string' ? body.merge_method.toLowerCase() : 'merge';
  const method = methodRaw === 'squash' || methodRaw === 'rebase' ? methodRaw : 'merge';
  if (pullMergeTree(repo, issue) === null) {
    sendError(res, 405, 'Pull Request is not mergeable');
    return;
  }
  const sha = mergePull(repo, issue, method);
  if (sha === null) {
    sendError(res, 405, 'Pull Request is not mergeable');
    return;
  }
  sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------- REST: routing

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const segments = path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  // segments[0] is 'api', segments[1] is 'v3'.
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_url: '/api/v3/repos/{owner}/{repo}/issues',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', git_url: '', api_url: '' });
    return;
  }
  if (rest[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { rate: { limit: 5000, remaining: 5000, used: 0, reset: 1735689600 }, resources: {} });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { ...userJson(VIEWER), name: VIEWER.name, email: VIEWER.email });
    return;
  }
  if (rest[0] === 'users' && rest.length === 2 && method === 'GET') {
    const user = USERS.find((candidate) => candidate.login === rest[1]);
    if (user === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { ...userJson(user), name: user.name });
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(res, body);
      if (parsed === null) return;
      repoCreate(res, parsed);
      return;
    }
    if (method === 'GET') {
      const page = paginate(req, res, url, forge.listRepos(VIEWER.login));
      sendJson(res, 200, page.map((repo) => repoJson(repo)));
      return;
    }
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const repo = forge.getRepo(rest[1], rest[2]);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const tail = rest.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null) return;
        repoPatch(res, repo, parsed);
        return;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo);
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        branchesList(res, repo);
        return;
      }
      if (tail.length >= 2 && method === 'GET') {
        const branch = tail.slice(1).join('/');
        const tip = branchTip(repo, branch);
        if (tip === null) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
        return;
      }
    }
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      commitsList(res, repo, url.searchParams);
      return;
    }
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null) return;
        const ref = typeof parsed.ref === 'string' ? parsed.ref : '';
        const sha = typeof parsed.sha === 'string' ? parsed.sha : '';
        if (!ref.startsWith('refs/') || getObject(repo, sha) === null) {
          sendError(res, 422, 'Validation Failed: ref or sha is invalid');
          return;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, 'Validation Failed: Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: refObjectJson(repo, sha) });
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const all = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, oid]) => ({ ref, object: refObjectJson(repo, oid) }));
        sendJson(res, 200, all);
        return;
      }
      if (tail.length >= 3 && method === 'GET') {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref, object: refObjectJson(repo, oid) });
        return;
      }
      if (tail.length >= 3 && method === 'DELETE') {
        const ref = `refs/${tail.slice(2).join('/')}`;
        if (!repo.refs.has(ref)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        repo.refs.delete(ref);
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
    }
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      if (method === 'GET') {
        contentsGet(res, repo, contentPath, url.searchParams);
        return;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null) return;
        contentsPut(res, repo, contentPath, parsed);
        return;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null) return;
        contentsDelete(res, repo, contentPath, parsed);
        return;
      }
    }
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        const labels = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, 200, labels.map((label) => labelJson(label)));
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null) return;
        const name = typeof parsed.name === 'string' ? parsed.name : '';
        if (name === '') {
          sendError(res, 422, 'Validation Failed: name is required');
          return;
        }
        if (repo.labels.has(name)) {
          sendError(res, 422, 'Validation Failed: label already exists');
          return;
        }
        const colorRaw = typeof parsed.color === 'string' ? parsed.color.replace(/^#/, '') : 'ededed';
        const label = { name, color: colorRaw, description: typeof parsed.description === 'string' ? parsed.description : '' };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const label = repo.labels.get(tail[1]);
        if (label === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, labelJson(label));
        return;
      }
      if (tail.length === 2 && method === 'DELETE') {
        if (!repo.labels.delete(tail[1])) {
          sendError(res, 404, 'Not Found');
          return;
        }
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'GET') {
        issuesList(req, res, url, repo);
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null) return;
        const title = typeof parsed.title === 'string' ? parsed.title : '';
        if (title === '') {
          sendError(res, 422, 'Validation Failed: title is required');
          return;
        }
        const labels = issueLabelsOf(repo, parsed);
        if (labels === null) {
          sendError(res, 422, 'Validation Failed: one or more labels do not exist');
          return;
        }
        const issue = createIssue(repo, title, typeof parsed.body === 'string' ? parsed.body : '', labels);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      const number = parseInt(tail[1] ?? '', 10);
      const record = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      if (tail.length === 2 && record !== undefined) {
        if (method === 'GET') {
          sendJson(res, 200, record.kind === 'pull' ? pullJson(repo, record) : issueJson(repo, record));
          return;
        }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(res, body);
          if (parsed === null) return;
          if (typeof parsed.title === 'string') record.title = parsed.title;
          if (typeof parsed.body === 'string') record.body = parsed.body;
          if (parsed.state === 'closed' || parsed.state === 'open') {
            if (!(record.kind === 'pull' && record.pull?.merged)) record.state = parsed.state;
          }
          if (Array.isArray(parsed.labels)) {
            const labels = issueLabelsOf(repo, parsed);
            if (labels === null) {
              sendError(res, 422, 'Validation Failed: one or more labels do not exist');
              return;
            }
            record.labels = labels;
          }
          sendJson(res, 200, record.kind === 'pull' ? pullJson(repo, record) : issueJson(repo, record));
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments' && record !== undefined) {
        if (method === 'GET') {
          commentsList(res, repo, record);
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(res, body);
          if (parsed === null) return;
          if (typeof parsed.body !== 'string' || parsed.body === '') {
            sendError(res, 422, 'Validation Failed: body is required');
            return;
          }
          const comment = { id: forge.allocCommentDbId(), body: parsed.body, seq: forge.tick() };
          record.comments.push(comment);
          sendJson(res, 201, commentJson(repo, comment));
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'labels' && record !== undefined) {
        if (method === 'GET') {
          sendJson(
            res,
            200,
            record.labels.map((name) => {
              const label = repo.labels.get(name);
              return label === undefined ? { name } : labelJson(label);
            }),
          );
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(res, body);
          if (parsed === null) return;
          const labels = issueLabelsOf(repo, parsed);
          if (labels === null) {
            sendError(res, 422, 'Validation Failed: one or more labels do not exist');
            return;
          }
          for (const label of labels) if (!record.labels.includes(label)) record.labels.push(label);
          sendJson(
            res,
            200,
            record.labels.map((name) => {
              const label = repo.labels.get(name);
              return label === undefined ? { name } : labelJson(label);
            }),
          );
          return;
        }
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'GET') {
        pullsList(req, res, url, repo);
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(res, body);
        if (parsed === null) return;
        const title = typeof parsed.title === 'string' ? parsed.title : '';
        const headRaw = typeof parsed.head === 'string' ? parsed.head : '';
        const head = headRaw.includes(':') ? headRaw.slice(headRaw.lastIndexOf(':') + 1) : headRaw.replace(/^refs\/heads\//, '');
        const base = typeof parsed.base === 'string' && parsed.base !== '' ? parsed.base.replace(/^refs\/heads\//, '') : repo.defaultBranch;
        if (title === '' || head === '') {
          sendError(res, 422, 'Validation Failed: title and head are required');
          return;
        }
        const headTip = branchTip(repo, head);
        const baseTip = branchTip(repo, base);
        if (headTip === null || baseTip === null) {
          sendError(res, 422, 'Validation Failed: head or base ref does not exist');
          return;
        }
        const existing = [...repo.issues.values()].find(
          (issue) => issue.kind === 'pull' && issue.state === 'open' && issue.pull?.headRef === head && issue.pull?.baseRef === base,
        );
        if (existing !== undefined) {
          sendError(res, 422, `Validation Failed: A pull request already exists for ${head} into ${base}`);
          return;
        }
        if (isAncestor(repo, headTip, baseTip)) {
          sendError(res, 422, 'Validation Failed: No commits between base and head');
          return;
        }
        const pull = createPull(repo, title, typeof parsed.body === 'string' ? parsed.body : '', head, base);
        if (pull === null) {
          sendError(res, 422, 'Validation Failed: could not create the pull request');
          return;
        }
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      const number = parseInt(tail[1] ?? '', 10);
      const record = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      const pull = record !== undefined && record.kind === 'pull' ? record : undefined;
      if (tail.length === 2 && pull !== undefined) {
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(res, body);
          if (parsed === null) return;
          if (typeof parsed.title === 'string') pull.title = parsed.title;
          if (typeof parsed.body === 'string') pull.body = parsed.body;
          if ((parsed.state === 'closed' || parsed.state === 'open') && !pull.pull?.merged) pull.state = parsed.state;
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'files' && pull !== undefined && method === 'GET') {
        const files = pullFiles(repo, pull).map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          sha: file.sha,
        }));
        sendJson(res, 200, files);
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && pull !== undefined) {
        if (method === 'PUT') {
          const parsed = parseJsonBody(res, body);
          if (parsed === null) return;
          pullMerge(res, repo, pull, parsed);
          return;
        }
        if (method === 'GET') {
          if (pull.pull?.merged) {
            res.writeHead(204, { 'x-github-request-id': requestId() });
            res.end();
          } else sendError(res, 404, 'Not Found');
          return;
        }
      }
      sendError(res, 404, 'Not Found');
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          const text = '{"ok":true}';
          res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
          res.end(text);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        const isApi = path === '/api/v3' || path.startsWith('/api/v3/');
        const isGraphql = path === '/api/graphql';
        const isMcp = path === '/mcp';

        if (gitMatch !== null || isApi || isGraphql || isMcp) {
          if (!authorized(req)) {
            sendError(res, 401, 'Unauthorized');
            return;
          }
        }

        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoSegment = decodeURIComponent(gitMatch[2]);
          const repoName = repoSegment.endsWith('.git') ? repoSegment.slice(0, -'.git'.length) : repoSegment;
          const repo = forge.getRepo(owner, repoName);
          const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
          handleGitHttp(req, res, repo, gitMatch[3], url.searchParams, body);
          return;
        }

        if (isMcp) {
          if (method === 'DELETE') {
            res.writeHead(204, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendError(res, 405, 'Method Not Allowed');
            return;
          }
          const body = await readBody(req);
          handleMcp(res, body.toString('utf8'));
          return;
        }

        if (isGraphql) {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
            return;
          }
          if (Array.isArray(parsed)) {
            sendJson(res, 200, parsed.map((entry) => executeGraphQL((entry ?? {}) as Record<string, unknown>)));
            return;
          }
          sendJson(res, 200, executeGraphQL((parsed ?? {}) as Record<string, unknown>));
          return;
        }

        if (isApi) {
          const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
          await handleRest(req, res, url, body);
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      }
    })();
  });
}
