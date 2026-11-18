// git.ts — the git object model, pkt-line framing and packfile codec, written from the
// protocol as the suite's client speaks it. No git binary, no dependency beyond node stdlib.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function makeObject(type: ObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// -------------------------------------------------------------------------------------------
// commits, trees, tags
// -------------------------------------------------------------------------------------------

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Build commit bytes. `author`/`committer` are full ident lines: `Name <email> <ts> +0000`. */
export function buildCommit(parts: CommitParts): Buffer {
  let text = `tree ${parts.tree}\n`;
  for (const parent of parts.parents) text += `parent ${parent}\n`;
  text += `author ${parts.author}\ncommitter ${parts.committer}\n\n${parts.message}`;
  return Buffer.from(text, 'utf8');
}

export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree sort: entries compare by name, directories as if named `name/`. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('malformed tree entry (no space)');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry (no NUL/oid)');
    const mode = data.subarray(pos, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export interface TagParts {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(parts: TagParts): Buffer {
  const text =
    `object ${parts.object}\ntype ${parts.type}\ntag ${parts.tag}\n` +
    (parts.tagger ? `tagger ${parts.tagger}\n` : '') +
    `\n${parts.message}`;
  return Buffer.from(text, 'utf8');
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  kind: PktKind;
  payload: Buffer;
}

/** One pkt-line carrying `payload` (a string is taken as UTF-8, without adding a newline). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const size = body.length + 4;
  if (size > 65520) throw new Error(`pkt-line of ${size} bytes exceeds the 65520-byte limit`);
  const head = Buffer.from(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (line === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else if (line === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole pkt-line stream. Throws on a malformed length or a truncated packet. */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const size = parseInt(head, 16);
    if (size === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (size === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (size === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (size < 4 || pos + size > buf.length) throw new Error('truncated pkt-line packet');
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(pos + 4, pos + size)) });
    pos += size;
  }
  return packets;
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a packfile v2 of plain (undeltified) objects, with a SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const object of objects) {
    const typeCode = PACK_TYPE_CODES[object.type];
    const data = object.data;
    // Varint header: low 4 bits of size in the first byte, then 7 bits per byte.
    const headerBytes: number[] = [];
    let size = data.length;
    let first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const body = pack.subarray(0, pack.length - 20);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  return sha1Hex(Buffer.from(body)) === trailer;
}

/** Read one varint size from `buf` at `pos`: returns [value, nextPos]. */
function readVarint(buf: Buffer, pos: number): [number, number] {
  let value = buf[pos] & 0x7f;
  let shift = 7;
  pos += 1;
  while (buf[pos - 1] & 0x80) {
    if (pos >= buf.length) throw new Error('truncated pack varint');
    value |= (buf[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return [value, pos];
}

/**
 * Inflate exactly one zlib stream starting at `pos`, knowing the inflated size the pack header
 * promises. inflateSync ignores trailing bytes, so the stream's end is found by binary search
 * for the shortest prefix that inflates to the expected size.
 */
function inflateOne(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - pos;
  const tryAt = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(pos, pos + len));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  let hi = Math.min(remaining, Math.max(16, expectedSize + 32));
  let found = tryAt(hi);
  while (found === null && hi < remaining) {
    hi = Math.min(remaining, hi * 2);
    found = tryAt(hi);
  }
  if (found === null) throw new Error('pack entry zlib stream does not inflate to its declared size');
  let lo = 1;
  let best = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const out = tryAt(mid);
    if (out !== null) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const data = tryAt(best);
  if (data === null) throw new Error('pack entry zlib stream is inconsistent');
  return { data, consumed: best };
}

/** Apply a git binary delta to `base`, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readDeltaVarint();
  const dstSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta source size does not match its base');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (pos >= delta.length) throw new Error('truncated delta copy offset');
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (pos >= delta.length) throw new Error('truncated delta copy size');
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past its base');
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('truncated delta insert');
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (outLen !== dstSize) throw new Error('delta result size does not match its header');
  return Buffer.concat(out);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile, resolving OFS_DELTA and REF_DELTA entries against the pack itself and, for
 * REF_DELTA, the `resolveBase` lookup (the store, or the client's haves).
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): ReadPackResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  if (!verifyPackChecksum(pack)) throw new Error('pack trailer does not match its bytes');
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    ofsBase?: number;
    refBase?: string;
  }
  const raw: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    if (pos >= end) throw new Error('pack ends before its declared object count');
    const entryOffset = pos;
    const first = pack[pos];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    pos += 1;
    while (pack[pos - 1] & 0x80) {
      if (pos >= end) throw new Error('truncated pack entry header');
      size |= (pack[pos] & 0x7f) << shift;
      shift += 7;
      pos += 1;
    }
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: offset encoding, base sits that many bytes before this entry.
      let byte = pack[pos];
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        if (pos >= end) throw new Error('truncated ofs-delta offset');
        byte = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      ofsBase = entryOffset - offset;
    } else if (typeCode === 7) {
      if (pos + 20 > end) throw new Error('truncated ref-delta base');
      refBase = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (!(typeCode in PACK_TYPES)) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const inflated = inflateOne(pack, pos, size);
    raw.push({ offset: entryOffset, typeCode, size, data: inflated.data, ofsBase, refBase });
    pos += inflated.consumed;
  }
  const byOffset = new Map<number, RawEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry, depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.ofsBase !== undefined) {
        const baseEntry = byOffset.get(entry.ofsBase);
        if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseEntry, depth + 1);
      } else if (entry.refBase !== undefined) {
        base = objects.get(entry.refBase) ?? options.resolveBase?.(entry.refBase);
        if (base === undefined) throw new Error(`ref-delta base ${entry.refBase} is not available`);
      }
      if (base === undefined) throw new Error('delta entry has no base');
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    return { type: PACK_TYPES[entry.typeCode] as ObjectType, data: entry.data };
  };
  for (const entry of raw) {
    const object = resolve(entry, 0);
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, deltaCount };
}

// -------------------------------------------------------------------------------------------
// reachability over an object store
// -------------------------------------------------------------------------------------------

/** All commits reachable from `tips`, with each commit's shortest distance in generations. */
export function commitDistances(lookup: ObjectLookup, tips: readonly string[]): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const tip of tips) {
    if (isObjectId(tip) && !distances.has(tip)) {
      distances.set(tip, 0);
      queue.push([tip, 0]);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const [oid, distance] = queue[head] as [string, number];
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (!distances.has(tag.object)) {
        distances.set(tag.object, distance);
        queue.push([tag.object, distance]);
      }
      continue;
    }
    if (object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      if (!distances.has(parent)) {
        distances.set(parent, distance + 1);
        queue.push([parent, distance + 1]);
      }
    }
  }
  return distances;
}

/** Every object id reachable from `tips` (commits, tags, trees, blobs). */
/** The objects a single commit (or tag pointing at one) carries: itself, its tree, and
 * every tree/blob under it — but NOT its parent commits. Used for shallow fetches,
 * where the client must not receive history beyond the requested depth. */
export function collectCommitContents(lookup: ObjectLookup, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      stack.push(parseCommit(object.data).tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

export function collectReachable(lookup: ObjectLookup, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    if (isObjectId(tip) && tip !== ZERO_OID) stack.push(tip);
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target === ancestor) return true;
      if (!seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
      continue;
    }
    if (object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/** The best common ancestor of `a` and `b` (nearest to `b` by generation), or null. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stackA.push(parent);
    }
  }
  const distancesB = commitDistances(lookup, [b]);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const [oid, distance] of distancesB) {
    if (ancestorsA.has(oid) && distance < bestDistance) {
      best = oid;
      bestDistance = distance;
    }
  }
  return best;
}

/** Flatten a tree into path -> {mode, oid} (files only). */
export function flattenTree(lookup: ObjectLookup, treeOid: string, prefix: string, out: Map<string, { mode: string; oid: string }>): void {
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(lookup, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
}

/**
 * Build the tree objects for a flat path map, storing each new tree with `put` (which answers
 * its oid) and returning the root tree's oid. Reuses existing identical trees when present.
 */
export function buildTreeFromFlat(
  lookup: ObjectLookup,
  flat: ReadonlyMap<string, { mode: string; oid: string }>,
  put: (object: GitObject) => string,
): string {
  interface DirNode {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, value] of [...flat.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const existing = lookup(hashObject('tree', data));
    if (existing !== undefined) return hashObject('tree', data);
    return put({ type: 'tree', data });
  };
  return build(root);
}
