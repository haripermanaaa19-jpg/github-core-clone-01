// git.ts: the git object model, packfiles and pkt-lines, implemented from the git protocol
// documentation on the Node standard library only (node:crypto for SHA-1, node:zlib for deflate).
// Objects are stored raw (the exact bytes after the "<type> <len>\0" header); parsing extracts
// fields without ever re-serializing, so anything a client pushed round-trips byte-exactly.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_BY_CODE: Readonly<Record<number, ObjType | 'ofs-delta' | 'ref-delta'>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};
const CODE_BY_TYPE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

/** The object id of a payload: SHA-1 over "<type> <len>\0" + data. */
export function oidOf(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- commits, trees, tags

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function buildCommit(tree: string, parents: readonly string[], author: string, message: string): Buffer {
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${author}\ncommitter ${author}\n\n`;
  return Buffer.from(head + message, 'utf8');
}

export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = ZERO_OID;
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('malformed tree: no mode terminator');
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no name terminator');
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: names byte-wise, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- deltas

/** Apply a git delta (the payload of an ofs-delta / ref-delta object) to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('malformed delta: truncated size');
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: delta expects ${sourceSize}, base is ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('malformed delta: opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

// ---------------------------------------------------------------- packs

/**
 * Inflate the zlib stream starting at `start`, returning the payload and the offset just past the
 * stream. The zlib `info` option reports exactly how many input bytes the stream consumed; where
 * that is unavailable, fall back to searching for the shortest prefix that inflates to exactly
 * `expectedSize` bytes (inflateSync ignores trailing bytes, and a shorter prefix cannot inflate).
 */
function inflateEntry(buf: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  try {
    const result = inflateSync(buf.subarray(start), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (Buffer.isBuffer(result.buffer) && result.buffer.length === expectedSize && typeof result.engine?.bytesWritten === 'number') {
      return { data: result.buffer, next: start + result.engine.bytesWritten };
    }
  } catch {
    // fall through to the prefix search
  }
  const remaining = buf.length - start;
  const tryLength = (length: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(start, start + length));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  // Grow an upper bound exponentially, then binary-search the shortest working prefix inside it.
  let hi = Math.min(remaining, Math.max(64, expectedSize + 32));
  let found = tryLength(hi);
  while (found === null && hi < remaining) {
    hi = Math.min(remaining, hi * 2);
    found = tryLength(hi);
  }
  if (found === null) {
    found = tryLength(remaining);
    if (found === null) throw new Error('pack entry does not inflate');
    return { data: found, next: buf.length };
  }
  let lo = 1;
  let high = hi;
  while (lo < high) {
    const mid = (lo + high) >> 1;
    if (tryLength(mid) !== null) high = mid;
    else lo = mid + 1;
  }
  const data = tryLength(lo);
  if (data === null) throw new Error('pack entry does not inflate');
  return { data, next: start + lo };
}

export interface PackObject extends GitObject {
  readonly oid: string;
}

/**
 * Read a whole packfile into memory, resolving ofs-delta and ref-delta entries. A ref-delta base
 * that is not in the pack is looked up through `resolveExternal` (a thin pack against objects the
 * server already holds); without a resolver such a pack is an error.
 */
export function readPack(buf: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): PackObject[] {
  if (buf.length < 12 + 20 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const digest = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    kind: ObjType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset: number;
    baseOid: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    let byte = buf[pos];
    pos += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const kind = TYPE_BY_CODE[code];
    if (kind === undefined) throw new Error(`unknown pack object type ${code}`);
    let baseOffset = -1;
    let baseOid = '';
    if (kind === 'ofs-delta') {
      let b = buf[pos];
      pos += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryStart - offset;
    } else if (kind === 'ref-delta') {
      baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateEntry(buf, pos, size);
    pos = inflated.next;
    byOffset.set(entryStart, raw.length);
    raw.push({ offset: entryStart, kind, data: inflated.data, baseOffset, baseOid });
  }

  const plainByOid = new Map<string, number>();
  raw.forEach((entry, index) => {
    if (entry.kind !== 'ofs-delta' && entry.kind !== 'ref-delta') plainByOid.set(oidOf(entry.kind, entry.data), index);
  });
  const resolved = new Array<PackObject | null>(raw.length).fill(null);
  const resolving = new Set<number>();
  const resolveAt = (index: number): PackObject => {
    const memo = resolved[index];
    if (memo !== null) return memo;
    if (resolving.has(index)) throw new Error('delta chain is cyclic');
    resolving.add(index);
    const entry = raw[index];
    let object: PackObject;
    if (entry.kind === 'ofs-delta') {
      const baseIndex = byOffset.get(entry.baseOffset);
      if (baseIndex === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolveAt(baseIndex);
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data, oid: oidOf(base.type, data) };
    } else if (entry.kind === 'ref-delta') {
      let base: GitObject | undefined;
      const plainIndex = plainByOid.get(entry.baseOid);
      if (plainIndex !== undefined) base = resolveAt(plainIndex);
      if (base === undefined) {
        for (let j = 0; j < raw.length && base === undefined; j += 1) {
          if (j === index) continue;
          const candidate = resolveAt(j);
          if (candidate.oid === entry.baseOid) base = candidate;
        }
      }
      if (base === undefined) base = resolveExternal?.(entry.baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data, oid: oidOf(base.type, data) };
    } else {
      object = { type: entry.kind, data: entry.data, oid: oidOf(entry.kind, entry.data) };
    }
    resolving.delete(index);
    resolved[index] = object;
    return object;
  };
  const objects: PackObject[] = [];
  for (let i = 0; i < raw.length; i += 1) objects.push(resolveAt(i));
  return objects;
}

/** Write a packfile of plain (undeltified) objects: header, zlib-deflated entries, SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    let rest = object.data.length;
    const code = CODE_BY_TYPE[object.type];
    const headBytes: number[] = [];
    let first = (code << 4) | (rest & 0x0f);
    rest >>= 4;
    if (rest > 0) first |= 0x80;
    headBytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Parse as many whole pkt-lines as `buf` holds. Returns the packets and the unconsumed rest (a
 * partial packet, or — for receive-pack — the packfile that follows the command flush).
 */
export function parsePackets(buf: Buffer, offset = 0): { packets: Packet[]; rest: Buffer; consumed: number } {
  const packets: Packet[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const head = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      break; // a flush ends the pkt-line stream; anything after it is not pkt-lines
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
    if (length < 4 || pos + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, rest: buf.subarray(pos), consumed: pos - offset };
}

/** Parse a request body that is pkt-lines all the way through (upload-pack), keeping delimiters. */
export function parseRequestPackets(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const head = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('malformed pkt-line header');
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      break;
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
  return packets;
}
