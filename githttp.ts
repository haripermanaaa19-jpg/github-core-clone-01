// githttp.ts: git smart HTTP — info/refs advertisements (protocol v0 and v2), upload-pack
// (v2 ls-refs and fetch, v0 fetch) with shallow/deepen support, and receive-pack (v0) with
// report-status. The fetch set arithmetic mirrors git's: objects reachable from the client's
// haves (cut at the client's shallow boundary) are excluded; wants are walked to the requested
// depth; commits whose parents were withheld become the new shallow boundary.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  isOid,
  parsePackets,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  type GitObject,
  type Packet,
} from './git.ts';
import {
  ancestorSet,
  getObject,
  isAncestor,
  parseCommitParents,
  peelToCommit,
  peelToObject,
  type RepoRec,
} from './store.ts';

const AGENT = 'forge/1.0';

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendNotFound(res: ServerResponse): void {
  const body = Buffer.from('{"message":"Not Found"}\n', 'utf8');
  sendBuffer(res, 404, 'application/json; charset=utf-8', body);
}

/** Parse every pkt-line in a request body (upload-pack bodies have several flush-separated parts). */
function parseAllPackets(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const head = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('malformed pkt-line header');
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  if (pos !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return packets;
}

function packetText(packet: Packet): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}

/** The refs a repo advertises, in git's order: HEAD, branches sorted, tags sorted. */
function sortedRefs(repo: RepoRec): Array<[string, string]> {
  const heads: Array<[string, string]> = [];
  const tags: Array<[string, string]> = [];
  const other: Array<[string, string]> = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) heads.push([name, oid]);
    else if (name.startsWith('refs/tags/')) tags.push([name, oid]);
    else other.push([name, oid]);
  }
  const byName = (a: [string, string], b: [string, string]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  heads.sort(byName);
  tags.sort(byName);
  other.sort(byName);
  return [...heads, ...tags, ...other];
}

function uploadCaps(repo: RepoRec): string {
  return `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
}

function receiveCaps(): string {
  return `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
}

function infoRefs(repo: RepoRec, service: string, version2: boolean, res: ServerResponse): void {
  const contentType = `application/x-${service}-advertisement`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (version2 && service === 'git-upload-pack') {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(pktFlush());
    sendBuffer(res, 200, contentType, Buffer.concat(parts));
    return;
  }
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps();
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    lines.push(`${headTip ?? ZERO_OID} HEAD`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}`);
      const peeled = peelToObject(repo, oid);
      if (peeled !== null && peeled !== oid) lines.push(`${peeled} ${name}^{}`);
    }
  }
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(pktFlush());
  sendBuffer(res, 200, contentType, Buffer.concat(parts));
}

// ---------------------------------------------------------------- ls-refs (protocol v2)

function lsRefs(repo: RepoRec, args: readonly string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  if (matches('HEAD')) {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const target = `refs/heads/${repo.defaultBranch}`;
    if (headTip === undefined) {
      if (unborn) parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelToObject(repo, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

interface FetchPlan {
  objects: GitObject[];
  newShallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

/** Commits reachable from `starts`, stopping (inclusively) at commits in `cut`. */
function commitClosure(repo: RepoRec, starts: readonly string[], cut: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...starts];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    out.add(oid);
    if (cut.has(oid)) continue;
    for (const parent of parseCommitParents(object.data)) stack.push(parent);
  }
  return out;
}

/** Every object (commits, trees, blobs, tags on the way) reachable from the given commits. */
function objectClosure(repo: RepoRec, commits: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const addTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    const object = getObject(repo, treeOid);
    if (object === null || object.type !== 'tree') return;
    out.set(treeOid, object);
    const text = object.data;
    let pos = 0;
    while (pos < text.length) {
      const space = text.indexOf(0x20, pos);
      const nul = text.indexOf(0x00, space + 1);
      if (space < 0 || nul < 0) break;
      const mode = text.toString('ascii', pos, space);
      const childOid = text.toString('hex', nul + 1, nul + 21);
      if (mode === '40000') addTree(childOid);
      else {
        const child = getObject(repo, childOid);
        if (child !== null) out.set(childOid, child);
      }
      pos = nul + 21;
    }
  };
  for (const oid of commits) {
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    out.set(oid, object);
    const tree = parseCommitTree(object.data);
    if (tree !== null) addTree(tree);
  }
  return out;
}

function parseCommitTree(data: Buffer): string | null {
  const firstNl = data.indexOf(0x0a);
  const firstLine = data.toString('utf8', 0, firstNl < 0 ? data.length : firstNl);
  return firstLine.startsWith('tree ') ? firstLine.slice(5).trim() : null;
}

function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  const clientShallow = new Set(request.shallow);
  const existingHaves = request.haves.filter((oid) => {
    const object = getObject(repo, oid);
    return object !== null && object.type === 'commit';
  });
  const excludedCommits = commitClosure(repo, existingHaves, clientShallow);
  const excludedObjects = objectClosure(repo, excludedCommits);

  // Tag objects on the peel path of each want are part of the transfer.
  const extraObjects = new Map<string, GitObject>();
  const seedCommits: string[] = [];
  for (const want of request.wants) {
    let current = want;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = getObject(repo, current);
      if (object === null) break;
      if (object.type === 'commit') {
        seedCommits.push(current);
        break;
      }
      if (object.type === 'tag') {
        extraObjects.set(current, object);
        current = parseTagTarget(object.data);
        continue;
      }
      // A tree/blob want: send just that object.
      extraObjects.set(current, object);
      break;
    }
  }

  // Layered BFS from the seeds (layer 1 = the seeds), honoring deepen and the exclusion set.
  const included = new Set<string>();
  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seedCommits) {
    if (!layer.has(seed)) {
      layer.set(seed, 1);
      queue.push(seed);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head];
    const depth = layer.get(oid) as number;
    if (request.deepen !== null && depth > request.deepen) continue;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    if (!excludedCommits.has(oid)) included.add(oid);
    // A plain fetch stops at the client's haves; a deepen fetch walks through them, because
    // the layers below a shallow have are exactly what is being deepened into.
    if (excludedCommits.has(oid) && request.deepen === null) continue;
    if (request.deepen !== null && depth >= request.deepen) continue;
    for (const parent of parseCommitParents(object.data)) {
      if (!layer.has(parent)) {
        layer.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }

  const includedObjects = objectClosure(repo, included);
  for (const [oid, object] of extraObjects) includedObjects.set(oid, object);
  for (const oid of excludedObjects.keys()) includedObjects.delete(oid);
  // Deterministic pack order: commits first (BFS order), then the rest by oid.
  const objects: GitObject[] = [];
  const seen = new Set<string>();
  for (const oid of queue) {
    const object = includedObjects.get(oid);
    if (object !== undefined && included.has(oid)) {
      objects.push(object);
      seen.add(oid);
    }
  }
  const rest = [...includedObjects.entries()]
    .filter(([oid]) => !seen.has(oid))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [, object] of rest) objects.push(object);

  const newShallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of included) {
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    const parents = parseCommitParents(object.data);
    const covered = parents.every((parent) => included.has(parent) || excludedCommits.has(parent));
    if (parents.length > 0 && !covered && !clientShallow.has(oid)) newShallow.push(oid);
  }
  // A commit the client held as shallow stops being shallow once its parents are all present
  // client-side — sent now, or already held (which is why it was in the exclusion closure).
  for (const oid of clientShallow) {
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    const parents = parseCommitParents(object.data);
    if (parents.length === 0) continue;
    const covered = parents.every((parent) => included.has(parent) || excludedCommits.has(parent));
    if (covered) unshallow.push(oid);
  }
  newShallow.sort();
  unshallow.sort();
  return { objects, newShallow, unshallow, commonHaves: existingHaves };
}

function parseTagTarget(data: Buffer): string {
  const text = data.toString('utf8');
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl < 0 ? text : text.slice(0, firstNl);
  return firstLine.startsWith('object ') ? firstLine.slice(7).trim() : ZERO_OID;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  return parts;
}

function fetchV2(repo: RepoRec, args: readonly string[], res: ServerResponse): void {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.deepen = parseInt(arg.slice(7), 10);
    else if (arg === 'done') done = true;
  }
  for (const want of request.wants) {
    if (!isOid(want) || getObject(repo, want) === null) {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: unknown object\n'));
      return;
    }
  }
  const plan = planFetch(repo, request);
  if (!done) {
    // A negotiation round: acknowledgments only, no packfile yet (gitprotocol-v2).
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    if (plan.commonHaves.length === 0) parts.push(pktLine('NAK\n'));
    else for (const have of plan.commonHaves) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktFlush());
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.newShallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.newShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function fetchV0(repo: RepoRec, packets: readonly Packet[], res: ServerResponse): void {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  for (const packet of packets) {
    const line = packetText(packet);
    if (line.startsWith('want ')) request.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) request.deepen = parseInt(line.slice(7), 10);
  }
  for (const want of request.wants) {
    if (!isOid(want) || getObject(repo, want) === null) {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: unknown object\n'));
      return;
    }
  }
  const plan = planFetch(repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.commonHaves.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function uploadPack(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  let packets: Packet[];
  try {
    packets = parseAllPackets(body);
  } catch {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: malformed pkt-lines\n'));
    return;
  }
  const firstData = packets.find((packet) => packet.kind === 'data');
  const firstLine = firstData === undefined ? '' : packetText(firstData);
  if (firstLine.startsWith('command=')) {
    // Protocol v2: command line, capability lines, a delimiter, then arguments, then flush.
    const command = firstLine.slice('command='.length);
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const args = (delimIndex < 0 ? packets.slice(1) : packets.slice(delimIndex + 1))
      .filter((packet) => packet.kind === 'data')
      .map(packetText);
    if (command === 'ls-refs') {
      lsRefs(repo, args, res);
      return;
    }
    if (command === 'fetch') {
      fetchV2(repo, args, res);
      return;
    }
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(`error: unknown command ${command}\n`));
    return;
  }
  fetchV0(repo, packets, res);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  let parsed: { packets: Packet[]; rest: Buffer };
  try {
    parsed = parsePackets(body);
  } catch {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: malformed pkt-lines\n'));
    return;
  }
  const commands: PushCommand[] = [];
  let clientCaps = '';
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    let line = packetText(packet);
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      clientCaps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length !== 3 || !isOid(fields[0]) || !isOid(fields[1])) continue;
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  }
  if (commands.length === 0) {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: no ref commands\n'));
    return;
  }
  // Store the pack's objects first: objects stay even when a ref update is refused.
  let unpackLine = 'unpack ok';
  if (parsed.rest.length > 0) {
    try {
      const objects = readPack(parsed.rest, (oid) => getObject(repo, oid) ?? undefined);
      for (const object of objects) {
        if (!repo.objects.has(object.oid)) repo.objects.set(object.oid, { type: object.type, data: object.data });
      }
    } catch (error) {
      unpackLine = `unpack ${error instanceof Error ? error.message : 'error'}`;
    }
  }
  const reportStatus = clientCaps.split(' ').some((cap) => cap === 'report-status' || cap.startsWith('report-status='));
  const sideband = clientCaps.split(' ').includes('side-band-64k');
  const lines: string[] = [`${unpackLine}\n`];
  for (const command of commands) {
    lines.push(`${applyPushCommand(repo, command, unpackLine === 'unpack ok')}\n`);
  }
  if (!reportStatus) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportBytes = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
  let bodyOut: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < reportBytes.length; offset += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportBytes.subarray(offset, Math.min(reportBytes.length, offset + CHUNK))])));
    }
    parts.push(pktFlush());
    bodyOut = Buffer.concat(parts);
  } else {
    bodyOut = reportBytes;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', bodyOut);
}

/** Apply one ref update; returns its report-status line ("ok <ref>" or "ng <ref> <reason>"). */
function applyPushCommand(repo: RepoRec, command: PushCommand, unpackOk: boolean): string {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/') && !ref.startsWith('refs/')) {
    return `ng ${ref} invalid ref name`;
  }
  if (!unpackOk && newOid !== ZERO_OID) return `ng ${ref} unpack failed`;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // A delete.
    if (current === ZERO_OID) return `ng ${ref} reference does not exist`;
    if (ref === `refs/heads/${repo.defaultBranch}`) return `ng ${ref} refusing to delete the current branch`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const target = getObject(repo, newOid);
  if (target === null) return `ng ${ref} bad object ${newOid}`;
  if (current !== oldOid) return `ng ${ref} stale info`;
  if (oldOid === ZERO_OID) {
    // A create.
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current === newOid) return `ok ${ref}`;
  if (ref.startsWith('refs/tags/')) return `ng ${ref} already exists`;
  // A branch update: fast-forward only.
  const newCommit = peelToCommit(repo, newOid);
  const oldCommit = peelToCommit(repo, oldOid);
  if (newCommit === null || oldCommit === null) return `ng ${ref} bad object`;
  if (!isAncestor(repo, oldCommit, newCommit)) return `ng ${ref} non-fast-forward`;
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// ---------------------------------------------------------------- entry point

/**
 * Serve one git smart-HTTP request. `tail` is 'info/refs', 'git-upload-pack' or
 * 'git-receive-pack'; the caller has already authenticated the request.
 */
export function handleGitHttp(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRec | null,
  tail: string,
  query: URLSearchParams,
  body: Buffer,
): void {
  if (repo === null) {
    sendNotFound(res);
    return;
  }
  try {
    if (tail === 'info/refs') {
      const service = query.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: missing or unknown service\n'));
        return;
      }
      const protocol = req.headers['git-protocol'];
      const version2 = typeof protocol === 'string' && protocol.split(':').includes('version=2');
      infoRefs(repo, service, version2, res);
      return;
    }
    if (tail === 'git-upload-pack') {
      uploadPack(repo, body, res);
      return;
    }
    if (tail === 'git-receive-pack') {
      receivePack(repo, body, res);
      return;
    }
    sendNotFound(res);
  } catch {
    if (!res.headersSent) sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: bad request\n'));
    else res.end();
  }
}
