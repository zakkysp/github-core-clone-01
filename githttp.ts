// githttp.ts — git smart HTTP: info/refs advertisements, upload-pack (protocol v2 with
// ls-refs and fetch, plus a v0 fetch), and receive-pack with report-status. All framing is
// pkt-line; all packs are plain objects (no deltas) with a verified SHA-1 trailer.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isObjectId,
  pktLine,
  readPack,
  writePack,
} from './git.ts';
import { fetchObjectSet, isFastForward, type Repo, type Store } from './store.ts';

const AGENT = 'github-core-clone-forge/1.0.0';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** All refs of a repo as advertisement lines, HEAD first, then heads, then tags (peeled). */
function refLines(repo: Repo, store: Store): string[] {
  const lines: string[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip !== undefined) lines.push(`${mainTip} HEAD\n`);
  for (const { name, oid } of store.listRefs(repo)) {
    lines.push(`${oid} ${name}\n`);
    if (name.startsWith('refs/tags/')) {
      const peeled = store.peelObjectToCommit(oid);
      const object = store.objects.get(oid);
      if (peeled !== null && object?.type === 'tag') lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  return lines;
}

function uploadPackCapsV0(repo: Repo): string {
  const mainTip = repo.refs.get('refs/heads/main');
  const symref = mainTip !== undefined ? ` symref=HEAD:refs/heads/main` : '';
  return `side-band-64k side-band ofs-delta thin-pack multi_ack shallow${symref} agent=${AGENT}`;
}

function receivePackCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/** GET /{owner}/{repo}.git/info/refs?service=... — v2 when Git-Protocol: version=2, else v0. */
export function infoRefs(store: Store, owner: string, repoName: string, service: string, gitProtocol: string | null): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const lines = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done\n',
      'object-format=sha1\n',
    ];
    return ok(contentType, encodePktLines(lines.concat(['flush'])));
  }
  // v0: the service preamble, a flush, then the ref lines with capabilities on the first.
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0(repo) : receivePackCaps();
  const refs = refLines(repo, store);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const first = refs[0] as string;
    parts.push(pktLine(`${first.replace(/\n$/, '')}\0${caps}\n`));
    for (const line of refs.slice(1)) parts.push(pktLine(line));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return ok(contentType, Buffer.concat(parts));
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 ls-refs / fetch request body into its argument lines. */
function parseV2Args(body: Buffer): { command: string | null; args: string[] } {
  const packets = decodePktLines(body);
  const args: string[] = [];
  let command: string | null = null;
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim && line.startsWith('command=')) {
      command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  return { command, args };
}

/** POST git-upload-pack with Git-Protocol: version=2 (ls-refs or fetch). */
function uploadPackV2(store: Store, repo: Repo, body: Buffer): GitResponse {
  const contentType = 'application/x-git-upload-pack-result';
  let parsed: { command: string | null; args: string[] };
  try {
    parsed = parseV2Args(body);
  } catch (err) {
    return badRequest(`malformed pkt-line stream: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.command === 'ls-refs') {
    const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of parsed.args) {
      if (arg === 'peel') lsArgs.peel = true;
      else if (arg === 'symrefs') lsArgs.symrefs = true;
      else if (arg === 'unborn') lsArgs.unborn = true;
      else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
    }
    const out: Buffer[] = [];
    const mainTip = repo.refs.get('refs/heads/main');
    const keep = (name: string): boolean =>
      lsArgs.prefixes.length === 0 || lsArgs.prefixes.some((prefix) => name.startsWith(prefix));
    if (keep('HEAD')) {
      if (mainTip === undefined) {
        if (lsArgs.unborn) {
          const attrs = lsArgs.symrefs ? ' symref-target:refs/heads/main' : '';
          out.push(pktLine(`unborn HEAD${attrs}\n`));
        }
      } else {
        const attrs = lsArgs.symrefs ? ' symref-target:refs/heads/main' : '';
        out.push(pktLine(`${mainTip} HEAD${attrs}\n`));
      }
    }
    for (const { name, oid } of store.listRefs(repo)) {
      if (!keep(name)) continue;
      let line = `${oid} ${name}`;
      if (lsArgs.peel && name.startsWith('refs/tags/')) {
        const object = store.objects.get(oid);
        if (object?.type === 'tag') {
          const peeled = store.peelObjectToCommit(oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      out.push(pktLine(`${line}\n`));
    }
    out.push(Buffer.from('0000', 'ascii'));
    return ok(contentType, Buffer.concat(out));
  }
  if (parsed.command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const arg of parsed.args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) {
        const n = Number(arg.slice(7).trim());
        if (Number.isInteger(n) && n > 0) depth = n;
      }
    }
    return fetchResponse(store, repo, wants, haves, shallow, depth, true);
  }
  return badRequest(`unknown v2 command ${JSON.stringify(parsed.command)}`);
}

/** Build the fetch response: acknowledgments, shallow-info and a sideband packfile section. */
/** Small FIFO cache of deflated fetch packs, keyed by store generation + fetch arguments. */
const packCache = new Map<string, Buffer>();

function fetchResponse(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | null,
  v2: boolean,
): GitResponse {
  const contentType = 'application/x-git-upload-pack-result';
  const validWants = wants.filter((oid) => isObjectId(oid) && store.objects.has(oid));
  if (validWants.length === 0) {
    // Nothing to send: an empty pack would still be a pack, so answer no packfile section.
    const parts: Buffer[] = [];
    if (v2) {
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine('NAK\n'));
      parts.push(Buffer.from('0000', 'ascii'));
      if (depth !== null) {
        parts.push(pktLine('shallow-info\n'));
        parts.push(Buffer.from('0000', 'ascii'));
      }
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    return ok(contentType, Buffer.concat(parts));
  }
  const { objects, boundary, unshallowed } = fetchObjectSet(store, validWants, haves, depth, shallow);
  // Identical fetch requests produce identical packs (the object graph only grows, and the
  // generation in the key changes whenever a new object lands), so cache the deflated pack:
  // the clone workload issues dozens of identical depth-1 fetches in parallel.
  const packKey = `${store.generation}|${validWants.join(',')}|${haves.join(',')}|${depth ?? ''}|${shallow.join(',')}`;
  let pack = packCache.get(packKey);
  if (pack === undefined) {
    pack = writePack([...objects.values()]);
    if (packCache.size >= 8) {
      const oldest = packCache.keys().next().value as string | undefined;
      if (oldest !== undefined) packCache.delete(oldest);
    }
    packCache.set(packKey, pack);
  }
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pktLine('acknowledgments\n'));
    if (haves.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const have of haves) {
        if (store.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
      }
      parts.push(pktLine('ready\n'));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    if (depth !== null) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of unshallowed) parts.push(pktLine(`unshallow ${oid}\n`));
      for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
      parts.push(Buffer.from('0000', 'ascii'));
    }
    parts.push(pktLine('packfile\n'));
    for (let pos = 0; pos < pack.length; pos += 65515) {
      const chunk = pack.subarray(pos, Math.min(pack.length, pos + 65515));
      const payload = Buffer.concat([Buffer.from([1]), chunk]);
      parts.push(pktLine(payload));
    }
    parts.push(Buffer.from('0000', 'ascii'));
  } else {
    // v0: plain NAK/ACK/shallow lines, then the pack as sideband band-1 packets.
    if (haves.length === 0) parts.push(pktLine('NAK\n'));
    else {
      for (const have of haves) {
        if (store.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
      }
    }
    for (const oid of unshallowed) parts.push(pktLine(`unshallow ${oid}\n`));
    for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (let pos = 0; pos < pack.length; pos += 65515) {
      const chunk = pack.subarray(pos, Math.min(pack.length, pos + 65515));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(Buffer.from('0000', 'ascii'));
  }
  return ok(contentType, Buffer.concat(parts));
}

/** POST git-upload-pack without a v2 header: a v0 fetch. */
function uploadPackV0(store: Store, repo: Repo, body: Buffer): GitResponse {
  const contentType = 'application/x-git-upload-pack-result';
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return badRequest(`malformed pkt-line stream: ${err instanceof Error ? err.message : String(err)}`);
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        wants.push(space < 0 ? rest : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isInteger(n) && n > 0) depth = n;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  return fetchResponse(store, repo, wants, haves, shallow, depth, false);
}

/** POST /{owner}/{repo}.git/git-upload-pack — dispatch on the Git-Protocol header. */
export function uploadPack(store: Store, owner: string, repoName: string, body: Buffer, gitProtocol: string | null): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  try {
    if (gitProtocol === 'version=2') return uploadPackV2(store, repo, body);
    return uploadPackV0(store, repo, body);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack — apply commands, fast-forward only. */
export function receivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const contentType = 'application/x-git-receive-pack-result';
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const commands: PushCommand[] = [];
  let sideband = false;
  let packStart = body.length;
  // Walk the command pkt-lines by hand and stop at the flush: the pack that follows is
  // binary and must not be parsed as pkt-lines.
  let pos = 0;
  let malformed: string | null = null;
  while (pos < body.length) {
    if (pos + 4 > body.length) {
      malformed = 'truncated pkt-line length';
      break;
    }
    const head = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      malformed = `bad pkt-line length ${JSON.stringify(head)}`;
      break;
    }
    const size = parseInt(head, 16);
    if (size === 0) {
      packStart = pos + 4;
      pos = body.length;
      break;
    }
    if (size < 4 || pos + size > body.length) {
      malformed = 'truncated pkt-line packet';
      break;
    }
    const payload = body.subarray(pos + 4, pos + size).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = nul >= 0 ? payload.slice(0, nul) : payload;
    const caps = nul >= 0 ? payload.slice(nul + 1) : '';
    if (caps.includes('side-band-64k')) sideband = true;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(line);
    if (match === null) {
      malformed = `bad push command ${JSON.stringify(line.slice(0, 80))}`;
      break;
    }
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    pos += size;
  }
  if (malformed !== null) return badRequest(`malformed pkt-line stream: ${malformed}`);
  if (commands.length === 0) return badRequest('no push commands');
  // Unpack first: a pack is present whenever a command creates or updates a ref.
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (updatesRef) {
    const packBytes = body.subarray(packStart);
    if (packBytes.length === 0) {
      unpackError = 'missing packfile';
    } else {
      try {
        const read = readPack(Buffer.from(packBytes), { resolveBase: (oid) => store.objects.get(oid) });
        store.putObjects(read.objects);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined || current === ZERO_OID) {
          reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} remote ref does not match\n`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      // Create or update: the new tip must exist and the update must fast-forward.
      if (store.objects.get(command.newOid) === undefined) {
        reportLines.push(`ng ${command.ref} new tip is not in the pack\n`);
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} remote ref does not match\n`);
        continue;
      }
      if (!isFastForward(store, current, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  }
  const reportBody = encodePktLines([...reportLines, 'flush']);
  if (sideband) {
    const parts: Buffer[] = [];
    // The report-status stream rides inside band-1 sideband packets.
    for (let pos = 0; pos < reportBody.length; pos += 65515) {
      const chunk = reportBody.subarray(pos, Math.min(reportBody.length, pos + 65515));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    return ok(contentType, Buffer.concat(parts));
  }
  return ok(contentType, reportBody);
}
