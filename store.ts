// store.ts — the forge's whole state, in memory. Determinism rules: sequential ids, a
// logical clock (never the wall clock) for every stored timestamp, sorted iteration.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  collectCommitContents,
  collectReachable,
  commitDistances,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  type GitObject,
  type ObjectType,
} from './git.ts';

/** The viewer the scenario's token names (the kit's scenario seed is fixed, so this is too). */
export const VIEWER_LOGIN = process.env.FORGE_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** The scenario's day one; every stored timestamp is this plus a logical counter. */
export const EPOCH_SEC = 1735689600;

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  comments: Map<number, IssueComment[]>;
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  seq: number;
}

export function isoTime(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

/** The server's ident line for commits it creates itself. */
export function serverIdent(seq: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${EPOCH_SEC + seq} +0000`;
}

export class Store {
  /** One object store shared by every repository (refs decide what each repo can see). */
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private nextSeq = 1;
  private nextCommitSeq = 1;

  seq(): number {
    const value = this.nextSeq;
    this.nextSeq += 1;
    return value;
  }

  commitSeq(): number {
    const value = this.nextCommitSeq;
    this.nextCommitSeq += 1;
    return value;
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  /** Bumps whenever a genuinely new object enters the store; fetch-pack caching keys on it. */
  generation = 0;

  putObject(object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, object);
      this.generation += 1;
    }
    return oid;
  }

  putObjects(objects: ReadonlyMap<string, GitObject>): void {
    for (const [oid, object] of objects) {
      if (!this.objects.has(oid)) {
        this.objects.set(oid, object);
        this.generation += 1;
      }
    }
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string }): Repo {
    const seq = this.seq();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      issues: [],
      comments: new Map(),
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      seq,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Every ref of a repo, sorted by name. */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** The commit a ref points at (peeling an annotated tag), or null. */
  peelToCommit(repo: Repo, refName: string): string | null {
    const oid = repo.refs.get(refName);
    if (oid === undefined) return null;
    return this.peelObjectToCommit(oid);
  }

  peelObjectToCommit(oid: string): string | null {
    let current = oid;
    for (let i = 0; i < 8; i += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  refTip(repo: Repo, refName: string): string | null {
    const oid = repo.refs.get(refName);
    return oid === undefined ? null : oid;
  }

  /** The flat path map of a commit's tree (files only). */
  treeFlat(commitOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return out;
    flattenTree(this.lookup, parseCommit(object.data).tree, '', out);
    return out;
  }

  /**
   * Commit a new tree (from a flat path map) on `branch` of `repo`, with `parent` as its parent
   * (null for a root commit). Answers the new commit's oid. The branch ref moves to it.
   */
  commitTree(
    repo: Repo,
    branch: string,
    flat: ReadonlyMap<string, { mode: string; oid: string }>,
    message: string,
  ): string {
    const treeOid = buildTreeFromFlat(this.lookup, flat, (object) => this.putObject(object));
    const seq = this.commitSeq();
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const parents: string[] = [];
    if (parent !== undefined && parent !== ZERO_OID) {
      const peeled = this.peelObjectToCommit(parent);
      if (peeled !== null) parents.push(peeled);
    }
    const ident = serverIdent(seq);
    const commit = buildCommit({
      tree: treeOid,
      parents,
      author: ident,
      committer: ident,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = this.putObject({ type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** A three-way merge of `headTip` into `baseTip`. Returns the merged flat map, or null on conflict. */
  threeWayMerge(baseTip: string, headTip: string, targetTip: string): Map<string, { mode: string; oid: string }> | null {
    const base = mergeBase(this.lookup, headTip, targetTip);
    const baseFlat = base === null ? new Map() : this.treeFlat(base);
    const headFlat = this.treeFlat(headTip);
    const targetFlat = this.treeFlat(targetTip);
    const merged = new Map(targetFlat);
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...targetFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const t = targetFlat.get(path);
      const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      const headChanged = !same(b, h);
      const targetChanged = !same(b, t);
      if (headChanged && targetChanged && !same(h, t)) return null;
      if (headChanged) {
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
      }
    }
    return merged;
  }

  /** Whether a pull request from `headTip` into `baseTip` merges cleanly. */
  mergeable(headTip: string, baseTip: string): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (!isObjectId(headTip) || !isObjectId(baseTip)) return 'UNKNOWN';
    if (this.objects.get(headTip) === undefined || this.objects.get(baseTip) === undefined) return 'UNKNOWN';
    return this.threeWayMerge(baseTip, headTip, baseTip) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** The files a pull request changes (merge-base tree vs head tree), with line counts. */
  pullFiles(headTip: string, baseTip: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = mergeBase(this.lookup, headTip, baseTip);
    const baseFlat = base === null ? new Map() : this.treeFlat(base);
    const headFlat = this.treeFlat(headTip);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
    const lineCount = (oid: string | undefined): number => {
      if (oid === undefined) return 0;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'blob') return 0;
      const text = object.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    for (const path of [...paths].sort()) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      const oldLines = lineCount(b?.oid);
      const newLines = lineCount(h?.oid);
      let status = 'modified';
      let additions = 0;
      let deletions = 0;
      if (b === undefined) {
        status = 'added';
        additions = newLines;
      } else if (h === undefined) {
        status = 'removed';
        deletions = oldLines;
      } else {
        additions = Math.max(0, newLines - oldLines);
        deletions = Math.max(0, oldLines - newLines);
        if (additions === 0 && deletions === 0) {
          additions = 1;
        }
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Commits reachable from `tip`, newest first (tip, then parents). */
  listCommits(tip: string): string[] {
    const distances = commitDistances(this.lookup, [tip]);
    const out = [...distances.keys()];
    out.sort((a, b) => (distances.get(a) as number) - (distances.get(b) as number));
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      number: repo.nextIssue,
      id: this.nextIssueId,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: this.seq(),
    };
    this.nextIssueId += 1;
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextCommentId, body, seq: this.seq() };
    this.nextCommentId += 1;
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest {
    const pull: PullRequest = {
      number: repo.nextPull,
      id: this.nextPullId,
      title,
      body,
      head,
      base,
      state: 'open',
      merged: false,
      mergedAt: '',
      mergeSha: null,
      seq: this.seq(),
    };
    this.nextPullId += 1;
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /**
   * Squash-merge `pull` onto its base branch. Returns the merge commit oid, or null when the
   * merge conflicts or the pull cannot merge.
   */
  mergePull(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    const headTip = this.peelToCommit(repo, `refs/heads/${pull.head}`);
    const baseTip = this.peelToCommit(repo, `refs/heads/${pull.base}`);
    if (headTip === null || baseTip === null) return null;
    if (headTip === baseTip) return null;
    const merged = this.threeWayMerge(baseTip, headTip, baseTip);
    if (merged === null) return null;
    const treeOid = buildTreeFromFlat(this.lookup, merged, (object) => this.putObject(object));
    const seq = this.commitSeq();
    const ident = serverIdent(seq);
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
    const commit = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      author: ident,
      committer: ident,
      message,
    });
    const oid = this.putObject({ type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${pull.base}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoTime(seq);
    pull.mergeSha = oid;
    return oid;
  }
}

/** The set of objects a fetch must send: reachable from `wants`, minus what the client holds. */
export function fetchObjectSet(
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowBoundaries: readonly string[],
): { objects: Map<string, GitObject>; boundary: string[]; unshallowed: string[] } {
  const lookup = store.lookup;
  const distances = commitDistances(lookup, wants);
  const included = new Map<string, number>();
  for (const [oid, distance] of distances) {
    if (depth !== null && distance >= depth) continue;
    included.set(oid, distance);
  }
  const excluded = new Set<string>();
  if (depth === null && shallowBoundaries.length === 0) {
    // A plain incremental fetch: the client holds the haves' whole closure.
    for (const oid of collectReachable(lookup, haves)) excluded.add(oid);
  } else {
    // A shallow fetch: the client holds exactly the have commits, not their history.
    for (const have of haves) excluded.add(have);
  }
  for (const oid of [...included.keys()]) {
    if (excluded.has(oid)) included.delete(oid);
  }
  // The boundary: commits at distance depth-1 from a want (the new shallow line).
  const boundary: string[] = [];
  if (depth !== null) {
    for (const [oid, distance] of distances) {
      if (distance === depth - 1) boundary.push(oid);
    }
    boundary.sort();
  }
  const unshallowed: string[] = [];
  if (depth !== null) {
    // An old boundary is unshallowed only when it lies strictly inside the new depth
    // (distance <= depth - 2), so its parents are now delivered. A boundary at exactly
    // depth - 1 stays the shallow line.
    for (const old of shallowBoundaries) {
      const distance = distances.get(old);
      if (distance !== undefined && distance < depth - 1) unshallowed.push(old);
    }
  }
  unshallowed.sort();
  // The object set: each included commit's own contents (tree + blobs), never its
  // parents — that is what keeps a shallow fetch shallow.
  const wanted = new Set<string>();
  for (const oid of included.keys()) {
    for (const reachable of collectCommitContents(lookup, oid)) {
      if (!excluded.has(reachable)) wanted.add(reachable);
    }
  }
  // Tags the wants point at are included by collectReachable; peeled commits too.
  const objects = new Map<string, GitObject>();
  for (const oid of wanted) {
    const object = lookup(oid);
    if (object !== undefined) objects.set(oid, object);
  }
  return { objects, boundary, unshallowed };
}

export function isFastForward(store: Store, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (newOid === ZERO_OID) return true;
  return isAncestor(store.lookup, oldOid, newOid);
}
