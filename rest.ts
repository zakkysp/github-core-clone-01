// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, all over the in-memory store. Every reply is JSON with a
// string message on errors; pagination follows GitHub's Link rel="next" shape.

import { parseCommit, parseTree } from './git.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  isoTime,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface ApiRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  origin: string;
}

export interface ApiReply {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

function ok(json: unknown, status = 200, headers?: Record<string, string>): ApiReply {
  return { status, json, headers };
}

function err(status: number, message: string): ApiReply {
  return { status, json: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string {
  if (!isRecord(body)) return '';
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function boolField(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** A page of a list, with a Link header when another page follows. */
function paginate<T>(items: readonly T[], req: ApiRequest, basePath: string): { page: T[]; link: string | null } {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(req.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(`${req.origin}${basePath}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: isoTime(repo.seq),
    updated_at: isoTime(repo.seq),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoTime(issue.seq),
    updated_at: isoTime(issue.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = store.peelToCommit(repo, `refs/heads/${pull.head}`) ?? '0000000000000000000000000000000000000000';
  const baseSha = store.peelToCommit(repo, `refs/heads/${pull.base}`) ?? '0000000000000000000000000000000000000000';
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.mergeSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoTime(pull.seq),
    updated_at: isoTime(pull.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Resolve a repo from the path, enforcing that it belongs to the token's login. */
function resolveRepo(store: Store, owner: string, name: string): Repo | ApiReply {
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return repo;
}

function resolveRefCommit(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return store.peelToCommit(repo, `refs/heads/${repo.defaultBranch}`);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = store.objects.get(ref);
    if (object === undefined) return null;
    return store.peelObjectToCommit(ref);
  }
  return store.peelToCommit(repo, `refs/heads/${ref}`);
}

/** The tree oid of `dirPath` inside a commit's tree ('' is the root tree). */
function dirTreeOid(store: Store, commitOid: string, dirPath: string): string | null {
  const object = store.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  let treeOid = parseCommit(object.data).tree;
  if (dirPath === '') return treeOid;
  for (const segment of dirPath.split('/')) {
    const tree = store.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

export function routeRest(store: Store, req: ApiRequest): ApiReply {
  const [first, second, third, ...rest] = req.segments;
  const method = req.method;

  // GET /api/v3/ — the API root.
  if (req.segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      {
        current_user_url: `${req.origin}/api/v3/user`,
        repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
        user_url: `${req.origin}/api/v3/users/{username}`,
        issues_url: `${req.origin}/api/v3/issues`,
      },
      200,
      { 'X-Oauth-Scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (first === 'meta' && req.segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (first === 'user' && req.segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  }

  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (first === 'user' && second === 'repos' && req.segments.length === 2) {
    if (method === 'POST') {
      const name = stringField(req.body, 'name');
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'invalid repository name');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        private: boolField(req.body, 'private', false),
        description: stringField(req.body, 'description'),
      });
      return ok(repoJson(repo), 201);
    }
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN);
      const { page, link } = paginate(repos, req, '/api/v3/user/repos');
      return ok(page.map((repo) => repoJson(repo)), 200, link === null ? undefined : { Link: link });
    }
    return err(404, 'Not Found');
  }

  if (first !== 'repos' || second === undefined || third === undefined) return err(404, 'Not Found');
  const owner = second;
  const repoName = third;
  const sub = rest;

  // /api/v3/repos/{o}/{r} itself.
  if (sub.length === 0) {
    if (method === 'GET') {
      const resolved = resolveRepo(store, owner, repoName);
      if (!isRecord(resolved) || (resolved as ApiReply).status !== undefined) {
        // resolveRepo returns a Repo (a record without `status`) or an ApiReply.
      }
      if ((resolved as Repo).refs !== undefined) return ok(repoJson(resolved as Repo));
      return resolved as ApiReply;
    }
    if (method === 'PATCH') {
      const resolved = resolveRepo(store, owner, repoName);
      if ((resolved as Repo).refs === undefined) return resolved as ApiReply;
      const repo = resolved as Repo;
      if (isRecord(req.body) && typeof req.body.description === 'string') repo.description = req.body.description;
      if (isRecord(req.body) && typeof req.body.private === 'boolean') repo.private = req.body.private;
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      const resolved = resolveRepo(store, owner, repoName);
      if ((resolved as Repo).refs === undefined) return resolved as ApiReply;
      store.deleteRepo(owner, repoName);
      return { status: 204, json: null };
    }
    return err(404, 'Not Found');
  }

  const resource = sub[0] as string;

  // GET /repos/{o}/{r}/branches[/{branch}]
  if (resource === 'branches') {
    const resolved = resolveRepo(store, owner, repoName);
    if ((resolved as Repo).refs === undefined) return resolved as ApiReply;
    const repo = resolved as Repo;
    if (sub.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const branches = store
        .listRefs(repo)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
      return ok(branches);
    }
    if (sub.length === 2) {
      if (method !== 'GET') return err(404, 'Not Found');
      const branch = sub[1] as string;
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return err(404, 'Not Found');
      return ok({ name: branch, commit: { sha: oid } });
    }
    return err(404, 'Not Found');
  }

  // GET /repos/{o}/{r}/commits[?sha=]
  if (resource === 'commits') {
    const resolved = resolveRepo(store, owner, repoName);
    if ((resolved as Repo).refs === undefined) return resolved as ApiReply;
    const repo = resolved as Repo;
    if (method !== 'GET' || sub.length !== 1) return err(404, 'Not Found');
    const tip = resolveRefCommit(store, repo, req.query.get('sha'));
    if (tip === null) return ok([]);
    const commits = store.listCommits(tip).map((oid) => {
      const object = store.objects.get(oid);
      const parts = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
      return {
        sha: oid,
        commit: {
          message: (parts?.message ?? '').replace(/\n+$/, ''),
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
        },
        parents: (parts?.parents ?? []).map((parent) => ({ sha: parent })),
      };
    });
    return ok(commits);
  }

  // /repos/{o}/{r}/git/refs — POST create, GET a head ref.
  if (resource === 'git' && sub[1] === 'refs') {
    const resolved = resolveRepo(store, owner, repoName);
    if ((resolved as Repo).refs === undefined) return resolved as ApiReply;
    const repo = resolved as Repo;
    if (method === 'POST' && sub.length === 2) {
      const ref = stringField(req.body, 'ref');
      const sha = stringField(req.body, 'sha');
      if (!/^refs\/(heads|tags)\/\S+$/.test(ref)) return err(422, 'invalid ref');
      if (!/^[0-9a-f]{40}$/.test(sha) || store.objects.get(sha) === undefined) return err(422, 'invalid sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha } }, 201);
    }
    if (method === 'GET' && sub.length === 4 && sub[2] === 'heads') {
      const branch = sub[3] as string;
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return err(404, 'Not Found');
      return ok({ ref: `refs/heads/${branch}`, object: { sha: oid } });
    }
    return err(404, 'Not Found');
  }

  // /repos/{o}/{r}/contents/{path...}
  if (resource === 'contents') {
    const resolved = resolveRepo(store, owner, repoName);
    if ((resolved as Repo).refs === undefined) return resolved as ApiReply;
    const repo = resolved as Repo;
    const path = sub.slice(1).join('/');
    const ref = req.query.get('ref');
    if (method === 'GET') {
      const tip = resolveRefCommit(store, repo, ref);
      if (tip === null) return err(404, 'Not Found');
      const flat = store.treeFlat(tip);
      const file = flat.get(path);
      if (file !== undefined) {
        const blob = store.objects.get(file.oid);
        const bytes = blob !== undefined && blob.type === 'blob' ? blob.data : Buffer.alloc(0);
        return ok({
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
          sha: file.oid,
          size: bytes.length,
          name: path.split('/').pop() ?? path,
          path,
        });
      }
      // A directory (or the root): list its immediate children.
      const prefix = path === '' ? '' : `${path}/`;
      const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }>();
      for (const [filePath, entry] of flat) {
        if (!filePath.startsWith(prefix)) continue;
        const restPath = filePath.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash < 0) {
          const blob = store.objects.get(entry.oid);
          const size = blob !== undefined && blob.type === 'blob' ? blob.data.length : 0;
          children.set(restPath, { type: 'file', name: restPath, path: filePath, sha: entry.oid, size });
        } else {
          const dirName = restPath.slice(0, slash);
          if (!children.has(dirName)) {
            const dirPath = prefix + dirName;
            const treeOid = dirTreeOid(store, tip, dirPath) ?? '0000000000000000000000000000000000000000';
            children.set(dirName, { type: 'dir', name: dirName, path: dirPath, sha: treeOid });
          }
        }
      }
      if (children.size === 0) return err(404, 'Not Found');
      return ok([...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
    }
    if (method === 'PUT') {
      const message = stringField(req.body, 'message');
      const contentB64 = stringField(req.body, 'content');
      const branch = stringField(req.body, 'branch') || repo.defaultBranch;
      const sha = stringField(req.body, 'sha');
      if (message === '' || contentB64 === '') return err(422, 'message and content are required');
      let contentBytes: Buffer;
      try {
        contentBytes = Buffer.from(contentB64, 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      let tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        // A new branch starts at the default branch's tip (or empty for an unborn repo).
        const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (baseTip !== undefined) repo.refs.set(`refs/heads/${branch}`, baseTip);
        tip = baseTip;
      }
      const flat = tip === undefined ? new Map() : store.treeFlat(store.peelObjectToCommit(tip) ?? tip);
      const existing = flat.get(path);
      if (sha !== '') {
        if (existing === undefined || existing.oid !== sha) return err(409, 'sha does not match the current file');
      }
      const blobOid = store.putObject({ type: 'blob', data: contentBytes });
      flat.set(path, { mode: '100644', oid: blobOid });
      const commitSha = store.commitTree(repo, branch, flat, message);
      const status = existing === undefined ? 201 : 200;
      return ok({ content: { sha: blobOid, encoding: 'base64' }, commit: { sha: commitSha } }, status);
    }
    if (method === 'DELETE') {
      const branch = stringField(req.body, 'branch') || repo.defaultBranch;
      const sha = stringField(req.body, 'sha');
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      const flat = store.treeFlat(store.peelObjectToCommit(tip) ?? tip);
      const existing = flat.get(path);
      if (existing === undefined) return err(404, 'Not Found');
      if (sha !== '' && existing.oid !== sha) return err(409, 'sha does not match the current file');
      flat.delete(path);
      const commitSha = store.commitTree(repo, branch, flat, stringField(req.body, 'message') || 'Delete file');
      return ok({ commit: { sha: commitSha } }, 200);
    }
    return err(404, 'Not Found');
  }

  // POST /repos/{o}/{r}/labels
  if (resource === 'labels') {
    const resolved = resolveRepo(store, owner, repoName);
    if ((resolved as Repo).refs === undefined) return resolved as ApiReply;
    const repo = resolved as Repo;
    if (method === 'POST' && sub.length === 1) {
      const name = stringField(req.body, 'name');
      const color = stringField(req.body, 'color') || 'ededed';
      if (name === '') return err(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return ok({ name, color: existing.color }, 201);
      repo.labels.set(name, { name, color });
      return ok({ name, color }, 201);
    }
    if (method === 'GET' && sub.length === 1) {
      return ok([...repo.labels.values()]);
    }
    return err(404, 'Not Found');
  }

  // /repos/{o}/{r}/issues...
  if (resource === 'issues') {
    const resolved = resolveRepo(store, owner, repoName);
    if ((resolved as Repo).refs === undefined) return resolved as ApiReply;
    const repo = resolved as Repo;
    if (sub.length === 1) {
      if (method === 'POST') {
        const title = stringField(req.body, 'title');
        const bodyText = stringField(req.body, 'body');
        if (title === '') return err(422, 'title is required');
        const labels: string[] = [];
        if (isRecord(req.body) && Array.isArray(req.body.labels)) {
          for (const label of req.body.labels) {
            if (typeof label !== 'string') return err(422, 'labels must be strings');
            if (!repo.labels.has(label)) return err(422, `label ${label} does not exist`);
            labels.push(label);
          }
        }
        const issue = store.createIssue(repo, title, bodyText, labels);
        return ok(issueJson(repo, issue), 201);
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        if (sort === 'created') {
          issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page, link } = paginate(issues, req, `/api/v3/repos/${owner}/${repoName}/issues`);
        return ok(page.map((issue) => issueJson(repo, issue)), 200, link === null ? undefined : { Link: link });
      }
      return err(404, 'Not Found');
    }
    const number = Number(sub[1]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const issue = repo.issues.find((entry) => entry.number === number);
    if (sub.length === 2) {
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'GET') return ok(issueJson(repo, issue));
      if (method === 'PATCH') {
        if (isRecord(req.body) && typeof req.body.state === 'string') {
          if (req.body.state !== 'open' && req.body.state !== 'closed') return err(422, 'invalid state');
          issue.state = req.body.state;
        }
        if (isRecord(req.body) && typeof req.body.title === 'string') issue.title = req.body.title;
        if (isRecord(req.body) && typeof req.body.body === 'string') issue.body = req.body.body;
        return ok(issueJson(repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (sub.length === 3 && sub[2] === 'comments') {
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'POST') {
        const bodyText = stringField(req.body, 'body');
        if (bodyText === '') return err(422, 'body is required');
        const comment = store.createComment(repo, number, bodyText);
        return ok(
          { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: isoTime(comment.seq) },
          201,
        );
      }
      if (method === 'GET') {
        const comments = (repo.comments.get(number) ?? []).map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: isoTime(comment.seq),
        }));
        return ok(comments);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // /repos/{o}/{r}/pulls...
  if (resource === 'pulls') {
    const resolved = resolveRepo(store, owner, repoName);
    if ((resolved as Repo).refs === undefined) return resolved as ApiReply;
    const repo = resolved as Repo;
    if (sub.length === 1) {
      if (method === 'POST') {
        const title = stringField(req.body, 'title');
        const bodyText = stringField(req.body, 'body');
        const head = stringField(req.body, 'head');
        const base = stringField(req.body, 'base');
        if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
        if (repo.refs.get(`refs/heads/${head}`) === undefined) return err(422, `head branch ${head} does not exist`);
        if (repo.refs.get(`refs/heads/${base}`) === undefined) return err(422, `base branch ${base} does not exist`);
        const existing = repo.pulls.find((pull) => pull.head === head && pull.state === 'open');
        if (existing !== undefined) return err(422, 'a pull request from this head branch is already open');
        const pull = store.createPull(repo, title, bodyText, head, base);
        return ok(pullJson(store, repo, pull), 201);
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        const { page, link } = paginate(pulls, req, `/api/v3/repos/${owner}/${repoName}/pulls`);
        return ok(page.map((pull) => pullJson(store, repo, pull)), 200, link === null ? undefined : { Link: link });
      }
      return err(404, 'Not Found');
    }
    const number = Number(sub[1]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (sub.length === 2) {
      if (pull === undefined) return err(404, 'Not Found');
      if (method !== 'GET') return err(404, 'Not Found');
      return ok(pullJson(store, repo, pull));
    }
    if (sub.length === 3 && sub[2] === 'files') {
      if (pull === undefined) return err(404, 'Not Found');
      if (method !== 'GET') return err(404, 'Not Found');
      const headTip = store.peelToCommit(repo, `refs/heads/${pull.head}`);
      const baseTip = store.peelToCommit(repo, `refs/heads/${pull.base}`);
      if (headTip === null || baseTip === null) return ok([]);
      return ok(store.pullFiles(headTip, baseTip));
    }
    if (sub.length === 3 && sub[2] === 'merge') {
      if (pull === undefined) return err(404, 'Not Found');
      if (method !== 'PUT') return err(404, 'Not Found');
      if (pull.state !== 'open') return err(405, 'pull request is already closed');
      const sha = store.mergePull(repo, pull);
      if (sha === null) return err(405, 'merge conflict');
      return ok({ merged: true, sha, message: `Pull request #${pull.number} merged` });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
