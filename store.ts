// store.ts: the forge's state and the domain operations every surface (REST, GraphQL, MCP, git
// smart HTTP) shares, so an object created through one surface is the same object through all of
// them. Everything is in memory. Time is a logical clock seeded at a fixed epoch: check outcomes
// must not depend on the wall clock, so timestamps derive from a creation sequence number.

import {
  buildCommit,
  buildTree,
  isOid,
  oidOf,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './git.ts';

export interface UserRec {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The token's owner: the fixed scenario's viewer (wire.ts SCENARIO_SEED is a constant). */
export const VIEWER: UserRec = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

export const USERS: readonly UserRec[] = [
  VIEWER,
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
];

const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z; every timestamp is this plus a sequence.

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface PullRec {
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedSeq: number;
  mergeCommitSha: string;
  mergeMethod: string;
}

export interface IssueRec {
  dbId: number;
  number: number;
  kind: 'issue' | 'pull';
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  pull: PullRec | null;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface RepoRec {
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  nextNumber: number;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  readonly reposById = new Map<number, RepoRec>();
  private clockSeq = 0;
  private nextRepoDbId = 5000;
  private nextIssueDbId = 20000;
  private nextCommentDbId = 70000;

  /** Advance the logical clock and return the new sequence number. */
  tick(): number {
    this.clockSeq += 1;
    return this.clockSeq;
  }

  get seq(): number {
    return this.clockSeq;
  }

  isoOf(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString();
  }

  isoNow(): string {
    return this.isoOf(this.clockSeq);
  }

  /** The author/committer line REST-created commits carry. */
  authorLine(seq: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${EPOCH_SEC + seq} +0000`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec | 'exists' | 'invalid' {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return 'invalid';
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return 'exists';
    const repo: RepoRec = {
      dbId: this.nextRepoDbId,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      seq: this.tick(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextNumber: 1,
    };
    this.nextRepoDbId += 1;
    this.repos.set(key, repo);
    this.reposById.set(repo.dbId, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | null {
    return this.repos.get(repoKey(owner, name)) ?? null;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.dbId);
  }

  listRepos(owner: string): RepoRec[] {
    const out: RepoRec[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  allocIssueDbId(): number {
    const id = this.nextIssueDbId;
    this.nextIssueDbId += 1;
    return id;
  }

  allocCommentDbId(): number {
    const id = this.nextCommentDbId;
    this.nextCommentDbId += 1;
    return id;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

/** The one forge instance the server serves. */
export const forge = new Forge();

// ---------------------------------------------------------------- object store helpers

export function putObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: RepoRec, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

export const EMPTY_TREE_OID = oidOf('tree', Buffer.alloc(0));

export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = getObject(repo, current);
    if (object === null) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Resolve a branch name, tag name, full ref, HEAD or raw oid to a commit oid. */
export function resolveCommitish(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip === undefined ? null : peelToCommit(repo, tip);
  }
  const candidates: string[] = [];
  if (ref.startsWith('refs/')) candidates.push(ref);
  candidates.push(`refs/heads/${ref}`, `refs/tags/${ref}`);
  for (const name of candidates) {
    const oid = repo.refs.get(name);
    if (oid !== undefined) return peelToCommit(repo, oid);
  }
  if (isOid(ref)) return peelToCommit(repo, ref);
  return null;
}

/** The parent oids of a commit payload, in order. */
export function parseCommitParents(data: Buffer): readonly string[] {
  return parseCommit(data).parents;
}

/** Follow a tag chain to the first non-tag object; returns its oid (or the input's, or null). */
export function peelToObject(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = getObject(repo, current);
    if (object === null) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return null;
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return oid === undefined ? null : oid;
}

export function treeOfCommit(repo: RepoRec, commitOid: string): string | null {
  const object = getObject(repo, commitOid);
  if (object === null || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** All ancestors of `tip` (including `tip`), DFS pre-order following parents in order. */
export function ancestorsPreorder(repo: RepoRec, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

export function ancestorSet(repo: RepoRec, tip: string): Set<string> {
  return new Set(ancestorsPreorder(repo, tip));
}

export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorSet(repo, descendant).has(ancestor);
}

/** The best common ancestor of two commits (BFS by generation from both sides). */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  if (a === b) return a;
  const distA = new Map<string, number>();
  const queueA: string[] = [a];
  distA.set(a, 0);
  while (queueA.length > 0) {
    const oid = queueA.shift() as string;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distA.has(parent)) {
        distA.set(parent, (distA.get(oid) as number) + 1);
        queueA.push(parent);
      }
    }
  }
  const seenB = new Set<string>([b]);
  const queueB: string[] = [b];
  while (queueB.length > 0) {
    const oid = queueB.shift() as string;
    if (distA.has(oid)) return oid;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seenB.has(parent)) {
        seenB.add(parent);
        queueB.push(parent);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- trees

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into path -> blob entry. Missing tree -> empty map. */
export function flattenTree(repo: RepoRec, treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild nested tree objects from a flattened map; returns the root tree oid. */
export function buildTreeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Dir {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1], entry);
  }
  const write = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: write(sub) });
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return write(root);
}

/** Read one path at a commit: a file's blob, or a directory's immediate entries. */
export function readPath(
  repo: RepoRec,
  commitOid: string,
  path: string,
): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
  const treeOid = treeOfCommit(repo, commitOid);
  if (treeOid === null) return null;
  if (path === '' || path === '/') {
    const object = getObject(repo, treeOid);
    if (object === null || object.type !== 'tree') return null;
    return { kind: 'dir', entries: parseTree(object.data) };
  }
  const parts = path.split('/').filter((part) => part !== '');
  let currentTree = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const object = getObject(repo, currentTree);
    if (object === null || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      if (entry.mode === '40000') {
        const sub = getObject(repo, entry.oid);
        if (sub === null || sub.type !== 'tree') return null;
        return { kind: 'dir', entries: parseTree(sub.data) };
      }
      const blob = getObject(repo, entry.oid);
      if (blob === null || blob.type !== 'blob') return null;
      return { kind: 'file', oid: entry.oid, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    currentTree = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------- diffs and merges

function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level add/delete counts between two blob payloads (LCS; coarse fallback for big files). */
export function lineDiffCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  if (oldData.equals(newData)) return { additions: 0, deletions: 0 };
  if (oldData.includes(0) || newData.includes(0)) return { additions: 0, deletions: 0 };
  const a = linesOf(oldData);
  const b = linesOf(newData);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length > 1500 || b.length > 1500) return { additions: b.length, deletions: a.length };
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const up = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = diag + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      diag = up;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The file-level diff between two trees (either may be null for "no tree"). */
export function diffTrees(repo: RepoRec, baseTree: string | null, headTree: string | null): FileChange[] {
  const before = flattenTree(repo, baseTree);
  const after = flattenTree(repo, headTree);
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const oldData = oldEntry === undefined ? null : (getObject(repo, oldEntry.oid)?.data ?? null);
    const newData = newEntry === undefined ? null : (getObject(repo, newEntry.oid)?.data ?? null);
    if (oldEntry === undefined && newEntry !== undefined) {
      const additions = newData !== null && !newData.includes(0) ? linesOf(newData).length : 0;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: newEntry.oid });
    } else if (newEntry === undefined && oldEntry !== undefined) {
      const deletions = oldData !== null && !oldData.includes(0) ? linesOf(oldData).length : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: oldEntry.oid });
    } else if (oldEntry !== undefined && newEntry !== undefined) {
      const counts = lineDiffCounts(oldData ?? Buffer.alloc(0), newData ?? Buffer.alloc(0));
      out.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        sha: newEntry.oid,
      });
    }
  }
  return out;
}

/**
 * A path-wise three-way merge of trees. Returns the merged tree oid, or null when both sides
 * changed the same path differently (a conflict).
 */
export function mergeTrees3(repo: RepoRec, baseTree: string | null, oursTree: string | null, theirsTree: string | null): string | null {
  const base = flattenTree(repo, baseTree);
  const ours = flattenTree(repo, oursTree);
  const theirs = flattenTree(repo, theirsTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, FlatEntry>();
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const bo = b?.oid;
    const oo = o?.oid;
    const to = t?.oid;
    let winner: FlatEntry | undefined;
    if (oo === to) winner = o;
    else if (bo === oo) winner = t;
    else if (bo === to) winner = o;
    else return null;
    if (winner !== undefined) merged.set(path, winner);
  }
  return buildTreeFromFlat(repo, merged);
}

// ---------------------------------------------------------------- contents commits

export interface CommitFilesResult {
  commitOid: string;
  blobs: Map<string, string>;
}

/**
 * Apply file changes (path -> new content, or null to delete) as one commit on a branch, creating
 * the branch (from the default branch's tip) when it does not exist yet. This is what the REST
 * contents API does; the first commit on an unborn default branch has no parent.
 */
export function commitFiles(repo: RepoRec, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): CommitFilesResult {
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const baseTree = tip === undefined ? EMPTY_TREE_OID : treeOfCommit(repo, tip);
  if (baseTree === null) throw new Error('branch tip is not a commit');
  if (!repo.objects.has(EMPTY_TREE_OID)) putObject(repo, 'tree', Buffer.alloc(0));
  const flat = flattenTree(repo, baseTree);
  const blobs = new Map<string, string>();
  for (const [path, content] of changes) {
    if (content === null) {
      flat.delete(path);
    } else {
      const oid = putObject(repo, 'blob', content);
      const existing = flat.get(path);
      flat.set(path, { oid, mode: existing?.mode ?? '100644' });
      blobs.set(path, oid);
    }
  }
  const newTree = buildTreeFromFlat(repo, flat);
  const seq = forge.tick();
  const commitData = buildCommit(newTree, tip === undefined ? [] : [tip], forge.authorLine(seq), message.endsWith('\n') ? message : `${message}\n`);
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitOid);
  return { commitOid, blobs };
}

// ---------------------------------------------------------------- issues and pulls

export function createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
  const issue: IssueRec = {
    dbId: forge.allocIssueDbId(),
    number: repo.nextNumber,
    kind: 'issue',
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: forge.tick(),
    pull: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): IssueRec | null {
  if (branchTip(repo, headRef) === null || branchTip(repo, baseRef) === null) return null;
  const pull: IssueRec = {
    dbId: forge.allocIssueDbId(),
    number: repo.nextNumber,
    kind: 'pull',
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: forge.tick(),
    pull: { headRef, baseRef, merged: false, mergedSeq: 0, mergeCommitSha: '', mergeMethod: '' },
  };
  repo.nextNumber += 1;
  repo.issues.set(pull.number, pull);
  return pull;
}

/** The diff a pull request proposes: merge-base of head and base, against the head tip. */
export function pullFiles(repo: RepoRec, pull: IssueRec): FileChange[] {
  if (pull.pull === null) return [];
  const headTip = branchTip(repo, pull.pull.headRef);
  const baseTip = branchTip(repo, pull.pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : treeOfCommit(repo, base);
  return diffTrees(repo, baseTree, treeOfCommit(repo, headTip));
}

/** Whether a pull request can merge cleanly (a dry three-way merge), and its merged tree. */
export function pullMergeTree(repo: RepoRec, pull: IssueRec): string | null {
  if (pull.pull === null) return null;
  const headTip = branchTip(repo, pull.pull.headRef);
  const baseTip = branchTip(repo, pull.pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : treeOfCommit(repo, base);
  return mergeTrees3(repo, baseTree, treeOfCommit(repo, baseTip), treeOfCommit(repo, headTip));
}

/**
 * Merge a pull request into its base branch. Returns the merge commit oid, or null on conflict.
 * 'squash' lands one single-parent commit with the merged tree; 'merge' lands a two-parent
 * merge commit; 'rebase' is treated as squash (the tree result is identical).
 */
export function mergePull(repo: RepoRec, pull: IssueRec, method: string): string | null {
  if (pull.pull === null || pull.pull.merged) return null;
  const headTip = branchTip(repo, pull.pull.headRef);
  const baseTip = branchTip(repo, pull.pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const mergedTree = pullMergeTree(repo, pull);
  if (mergedTree === null) return null;
  const seq = forge.tick();
  let message: string;
  let parents: string[];
  if (method === 'merge') {
    message = `Merge pull request #${pull.number} from ${pull.pull.headRef}\n`;
    parents = [baseTip, headTip];
  } else {
    message = pull.body === '' ? `${pull.title} (#${pull.number})\n` : `${pull.title} (#${pull.number})\n\n${pull.body}\n`;
    parents = [baseTip];
  }
  const commitOid = putObject(repo, 'commit', buildCommit(mergedTree, parents, forge.authorLine(seq), message));
  repo.refs.set(`refs/heads/${pull.pull.baseRef}`, commitOid);
  pull.pull.merged = true;
  pull.pull.mergedSeq = seq;
  pull.pull.mergeCommitSha = commitOid;
  pull.pull.mergeMethod = method;
  pull.state = 'closed';
  return commitOid;
}

// ---------------------------------------------------------------- GraphQL global ids

/** An opaque, stable global id: base64 of "Type:key". Never the bare database id. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: RepoRec): string {
  return globalId('Repository', String(repo.dbId));
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return globalId(issue.kind === 'pull' ? 'PullRequest' : 'Issue', `${repo.dbId}:${issue.number}`);
}

export function commentGlobalId(repo: RepoRec, comment: CommentRec): string {
  return globalId('IssueComment', `${repo.dbId}:${comment.id}`);
}

export function userGlobalId(user: UserRec): string {
  return globalId('User', String(user.id));
}

// ---------------------------------------------------------------- REST serializers
// One set of shapes for every surface that emits GitHub JSON (REST and MCP), so an object reads
// identically wherever it was created.

export function userJson(user: UserRec): Record<string, unknown> {
  return { login: user.login, id: user.id, type: 'User', site_admin: false };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    owner: userJson(USERS.find((user) => user.login === repo.owner) ?? { id: 0, login: repo.owner, name: repo.owner, email: '' }),
    default_branch: repo.defaultBranch,
    created_at: forge.isoOf(repo.seq),
    updated_at: forge.isoOf(repo.seq),
    pushed_at: forge.isoOf(repo.seq),
    fork: false,
    archived: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: issue.dbId,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name } : labelJson(label);
    }),
    user: userJson(VIEWER),
    comments: issue.comments.length,
    created_at: forge.isoOf(issue.seq),
    updated_at: forge.isoOf(issue.seq),
    closed_at: issue.state === 'closed' ? forge.isoOf(issue.seq) : null,
  };
  if (issue.kind === 'pull') out.pull_request = { merged_at: issue.pull?.merged ? forge.isoOf(issue.pull.mergedSeq) : null };
  return out;
}

export function pullJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const pull = issue.pull as PullRec;
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  return {
    id: issue.dbId,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(VIEWER),
    labels: [],
    head: {
      ref: pull.headRef,
      sha: headTip ?? '',
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(VIEWER),
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip ?? '',
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(VIEWER),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.merged ? forge.isoOf(pull.mergedSeq) : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    created_at: forge.isoOf(issue.seq),
    updated_at: forge.isoOf(issue.seq),
    closed_at: issue.state === 'closed' ? forge.isoOf(issue.seq) : null,
  };
}

export function commentJson(repo: RepoRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, comment),
    body: comment.body,
    user: userJson(VIEWER),
    created_at: forge.isoOf(comment.seq),
    updated_at: forge.isoOf(comment.seq),
  };
}
