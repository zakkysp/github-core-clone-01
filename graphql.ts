// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send: viewer/repository reads, issue and pull-request reads and
// mutations, __type introspection, node(id:), and operation batching. No library.

import { VIEWER_ID, VIEWER_LOGIN, isoTime, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// -------------------------------------------------------------------------------------------
// global ids: opaque, stable, deterministic (base64url of a typed key)
// -------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('R', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('I', `${repo.owner}/${repo.name}#${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return encodeGlobalId('P', `${repo.owner}/${repo.name}#${pull.number}`);
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return encodeGlobalId('C', `${repo.owner}/${repo.name}#${issueNumber}:${commentId}`);
}

function repoFromGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  const slash = decoded.key.indexOf('/');
  if (slash < 0) return null;
  return store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1)) ?? null;
}

function issueFromGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'I') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const repo = store.getRepo(...splitOwnerRepo(decoded.key.slice(0, hash)));
  if (repo === undefined) return null;
  const number = Number(decoded.key.slice(hash + 1));
  const issue = repo.issues.find((entry) => entry.number === number);
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'P') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const repo = store.getRepo(...splitOwnerRepo(decoded.key.slice(0, hash)));
  if (repo === undefined) return null;
  const number = Number(decoded.key.slice(hash + 1));
  const pull = repo.pulls.find((entry) => entry.number === number);
  return pull === undefined ? null : { repo, pull };
}

function splitOwnerRepo(fullName: string): [string, string] {
  const slash = fullName.indexOf('/');
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

// -------------------------------------------------------------------------------------------
// the schema surface the suite introspects
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'mergedAt', 'mergeCommit', 'url', 'createdAt', 'updatedAt',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'private', 'url', 'createdAt', 'issue', 'issues',
    'pullRequests', 'pullRequest',
  ],
  User: ['id', 'login', 'name', 'email'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// -------------------------------------------------------------------------------------------
// a tiny GraphQL parser (documents the suite sends: no directives, no fragments but inline)
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeName: string; selections: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode>;
  selections: SelectionNode[];
}

class GraphQLSyntaxError extends Error {}

class Lexer {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skipIgnored();
    // Enough lookahead for the longest keyword the parser peeks at ('mutation').
    return this.text.slice(this.pos, this.pos + 16);
  }

  readName(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) throw new GraphQLSyntaxError(`expected a name at offset ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  readString(): string {
    this.skipIgnored();
    if (this.text[this.pos] !== '"') throw new GraphQLSyntaxError(`expected a string at offset ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) throw new GraphQLSyntaxError('unterminated string');
      const ch = this.text[this.pos] as string;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.text[this.pos + 1];
        this.pos += 2;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next === '"') out += '"';
        else if (next === '\\') out += '\\';
        else if (next === '/') out += '/';
        else if (next === 'u') {
          out += String.fromCharCode(parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += next ?? '';
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  readNumber(): { kind: 'int' | 'float'; value: number } {
    this.skipIgnored();
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos));
    if (match === null) throw new GraphQLSyntaxError(`expected a number at offset ${this.pos}`);
    this.pos += match[0].length;
    const value = Number(match[0]);
    return /[.eE]/.test(match[0]) ? { kind: 'float', value } : { kind: 'int', value };
  }

  expect(token: string): void {
    this.skipIgnored();
    if (!this.text.startsWith(token, this.pos)) throw new GraphQLSyntaxError(`expected ${JSON.stringify(token)} at offset ${this.pos}`);
    this.pos += token.length;
  }

  consume(token: string): boolean {
    this.skipIgnored();
    if (!this.text.startsWith(token, this.pos)) return false;
    this.pos += token.length;
    return true;
  }

  atEnd(): boolean {
    this.skipIgnored();
    return this.pos >= this.text.length;
  }
}

class Parser {
  private readonly lexer: Lexer;
  constructor(text: string) {
    this.lexer = new Lexer(text);
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (!this.lexer.atEnd()) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    const peek = this.lexer.peek();
    if (peek.startsWith('query') && !/^[A-Za-z0-9_]/.test(this.lexer.peek().slice(5, 6))) {
      this.lexer.readName();
      operation = 'query';
    } else if (peek.startsWith('mutation')) {
      this.lexer.readName();
      operation = 'mutation';
    }
    let name: string | null = null;
    if (!this.lexer.peek().startsWith('(') && !this.lexer.peek().startsWith('{')) {
      name = this.lexer.readName();
    }
    const variables: Record<string, ValueNode> = {};
    if (this.lexer.consume('(')) {
      while (!this.lexer.consume(')')) {
        this.lexer.expect('$');
        const varName = this.lexer.readName();
        this.lexer.expect(':');
        this.readTypeName();
        if (this.lexer.consume('=')) this.parseValue();
        variables[varName] = { kind: 'null' };
      }
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variables, selections };
  }

  private readTypeName(): void {
    if (this.lexer.consume('[')) {
      this.readTypeName();
      this.lexer.expect(']');
    } else {
      this.lexer.readName();
    }
    this.lexer.consume('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.lexer.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.lexer.consume('}')) {
      if (this.lexer.peek().startsWith('...')) {
        this.lexer.expect('...');
        this.lexer.expect('on');
        const typeName = this.lexer.readName();
        selections.push({ kind: 'inlineFragment', typeName, selections: this.parseSelectionSet() });
        continue;
      }
      const first = this.lexer.readName();
      let alias: string | null = null;
      let name = first;
      if (this.lexer.consume(':')) {
        alias = first;
        name = this.lexer.readName();
      }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.lexer.consume('(')) {
        while (!this.lexer.consume(')')) {
          const argName = this.lexer.readName();
          this.lexer.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      const sub = this.lexer.peek().startsWith('{') ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', field: { alias, name, args, selections: sub } });
    }
    return selections;
  }

  parseValue(): ValueNode {
    const peek = this.lexer.peek();
    if (peek.startsWith('$')) {
      this.lexer.expect('$');
      return { kind: 'variable', name: this.lexer.readName() };
    }
    if (peek.startsWith('"')) return { kind: 'string', value: this.lexer.readString() };
    if (peek.startsWith('[')) {
      this.lexer.expect('[');
      const values: ValueNode[] = [];
      while (!this.lexer.consume(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (peek.startsWith('{')) {
      this.lexer.expect('{');
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.lexer.consume('}')) {
        const name = this.lexer.readName();
        this.lexer.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (/^-?[0-9]/.test(peek)) {
      const number = this.lexer.readNumber();
      return number.kind === 'int' ? { kind: 'int', value: number.value } : { kind: 'float', value: number.value };
    }
    const name = this.lexer.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }
}

function valueOf(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Readonly<Record<string, unknown>>;
  errors: Array<{ message: string }>;
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  if (arg === undefined) return undefined;
  return valueOf(arg.value, ctx.variables);
}

function unknownField(typeName: string, fieldName: string, ctx: ExecContext): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function repoObject(ctx: ExecContext, repo: Repo, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = repoGlobalId(repo);
        break;
      case 'databaseId':
        out[key] = repo.id;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[key] = userObject(ctx, field.selections);
        break;
      case 'defaultBranchRef': {
        const tip = ctx.store.peelToCommit(repo, `refs/heads/${repo.defaultBranch}`);
        out[key] = tip === null ? null : { name: repo.defaultBranch };
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'private':
        out[key] = repo.private;
        break;
      case 'url':
        out[key] = `https://github.com/${repo.owner}/${repo.name}`;
        break;
      case 'createdAt':
        out[key] = isoTime(repo.seq);
        break;
      case 'issue': {
        const number = argValue(field, 'number', ctx);
        const issue = typeof number === 'number' ? repo.issues.find((entry) => entry.number === number) : undefined;
        out[key] = issue === undefined ? null : issueObject(ctx, repo, issue, field.selections);
        break;
      }
      case 'issues':
        out[key] = issuesConnection(ctx, repo, field);
        break;
      case 'pullRequests':
        out[key] = pullRequestsConnection(ctx, repo, field);
        break;
      case 'pullRequest': {
        const number = argValue(field, 'number', ctx);
        const pull = typeof number === 'number' ? repo.pulls.find((entry) => entry.number === number) : undefined;
        out[key] = pull === undefined ? null : pullObject(ctx, repo, pull, field.selections);
        break;
      }
      default:
        unknownField('Repository', field.name, ctx);
        out[key] = null;
    }
  }
  return out;
}

function userObject(ctx: ExecContext, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = encodeGlobalId('U', VIEWER_LOGIN);
        break;
      case 'login':
        out[key] = VIEWER_LOGIN;
        break;
      case 'name':
        out[key] = 'ada iversen';
        break;
      case 'email':
        out[key] = 'adaiversen@example.invalid';
        break;
      default:
        unknownField('User', field.name, ctx);
        out[key] = null;
    }
  }
  return out;
}

function issueObject(ctx: ExecContext, repo: Repo, issue: Issue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = issueGlobalId(repo, issue);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'state':
        out[key] = issue.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'url':
        out[key] = `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        break;
      case 'createdAt':
        out[key] = isoTime(issue.seq);
        break;
      case 'updatedAt':
        out[key] = isoTime(issue.seq);
        break;
      case 'author':
        out[key] = userObject(ctx, field.selections);
        break;
      case 'labels':
        out[key] = { nodes: issue.labels.map((name) => ({ name })) };
        break;
      case 'comments':
        out[key] = { nodes: (repo.comments.get(issue.number) ?? []).map((comment) => ({ id: commentGlobalId(repo, issue.number, comment.id), body: comment.body })) };
        break;
      default:
        unknownField('Issue', field.name, ctx);
        out[key] = null;
    }
  }
  return out;
}

function pullObject(ctx: ExecContext, repo: Repo, pull: PullRequest, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = pullGlobalId(repo, pull);
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'mergeable': {
        const headTip = ctx.store.peelToCommit(repo, `refs/heads/${pull.head}`);
        const baseTip = ctx.store.peelToCommit(repo, `refs/heads/${pull.base}`);
        out[key] = headTip === null || baseTip === null ? 'UNKNOWN' : ctx.store.mergeable(headTip, baseTip);
        break;
      }
      case 'headRefName':
        out[key] = pull.head;
        break;
      case 'baseRefName':
        out[key] = pull.base;
        break;
      case 'headRef':
        out[key] = { name: pull.head };
        break;
      case 'baseRef':
        out[key] = { name: pull.base };
        break;
      case 'mergedAt':
        out[key] = pull.merged ? pull.mergedAt : null;
        break;
      case 'mergeCommit':
        out[key] = pull.mergeSha === null ? null : { oid: pull.mergeSha };
        break;
      case 'url':
        out[key] = `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
        break;
      case 'createdAt':
        out[key] = isoTime(pull.seq);
        break;
      case 'updatedAt':
        out[key] = isoTime(pull.seq);
        break;
      case 'files': {
        const first = argValue(field, 'first', ctx);
        const headTip = ctx.store.peelToCommit(repo, `refs/heads/${pull.head}`);
        const baseTip = ctx.store.peelToCommit(repo, `refs/heads/${pull.base}`);
        let files: Array<{ path: string }> = [];
        if (headTip !== null && baseTip !== null) {
          files = ctx.store.pullFiles(headTip, baseTip).map((entry) => ({ path: entry.filename }));
        }
        const limit = typeof first === 'number' ? first : files.length;
        const connection: Record<string, unknown> = {};
        for (const sub of field.selections) {
          if (sub.kind === 'inlineFragment') continue;
          const subField = sub.field;
          const subKey = subField.alias ?? subField.name;
          if (subField.name === 'nodes') {
            connection[subKey] = files.slice(0, limit).map((file) => {
              const node: Record<string, unknown> = {};
              for (const nodeSel of subField.selections) {
                if (nodeSel.kind === 'inlineFragment') continue;
                const nodeField = nodeSel.field;
                node[nodeField.alias ?? nodeField.name] = nodeField.name === 'path' ? file.path : null;
              }
              return node;
            });
          } else if (subField.name === 'totalCount') {
            connection[subKey] = files.length;
          }
        }
        out[key] = connection;
        break;
      }
      default:
        unknownField('PullRequest', field.name, ctx);
        out[key] = null;
    }
  }
  return out;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issuesConnection(ctx: ExecContext, repo: Repo, field: { args: Array<{ name: string; value: ValueNode }>; selections: SelectionNode[] }): Record<string, unknown> {
  const first = argValue(field as never, 'first', ctx);
  const after = argValue(field as never, 'after', ctx);
  const states = argValue(field as never, 'states', ctx);
  const orderBy = argValue(field as never, 'orderBy', ctx);
  let issues = [...repo.issues];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderField = (orderBy !== null && typeof orderBy === 'object' ? (orderBy as Record<string, unknown>).field : undefined) as string | undefined;
  const orderDirection = (orderBy !== null && typeof orderBy === 'object' ? (orderBy as Record<string, unknown>).direction : undefined) as string | undefined;
  if (orderField === 'CREATED_AT' || orderField === undefined) {
    issues.sort((a, b) => (orderDirection === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  }
  if (typeof after === 'string' && after !== '') {
    const afterNumber = decodeCursor(after);
    if (afterNumber !== null) {
      // The cursor names the last issue of the previous page; continue after it in page order.
      const index = issues.findIndex((issue) => issue.number === afterNumber);
      if (index >= 0) issues = issues.slice(index + 1);
    }
  }
  const limit = typeof first === 'number' ? first : issues.length;
  const page = issues.slice(0, limit);
  const hasNextPage = issues.length > limit;
  const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
  const out: Record<string, unknown> = {};
  for (const selection of field.selections) {
    if (selection.kind === 'inlineFragment') continue;
    const sub = selection.field;
    const key = sub.alias ?? sub.name;
    if (sub.name === 'nodes') {
      out[key] = page.map((issue) => issueObject(ctx, repo, issue, sub.selections));
    } else if (sub.name === 'pageInfo') {
      const info: Record<string, unknown> = {};
      for (const infoSel of sub.selections) {
        if (infoSel.kind === 'inlineFragment') continue;
        const infoField = infoSel.field;
        const infoKey = infoField.alias ?? infoField.name;
        if (infoField.name === 'hasNextPage') info[infoKey] = hasNextPage;
        else if (infoField.name === 'endCursor') info[infoKey] = endCursor;
        else if (infoField.name === 'hasPreviousPage') info[infoKey] = false;
        else if (infoField.name === 'startCursor') info[infoKey] = page.length > 0 ? encodeCursor((page[0] as Issue).number) : null;
      }
      out[key] = info;
    } else if (sub.name === 'totalCount') {
      out[key] = issues.length;
    }
  }
  return out;
}

function pullRequestsConnection(ctx: ExecContext, repo: Repo, field: { args: Array<{ name: string; value: ValueNode }>; selections: SelectionNode[] }): Record<string, unknown> {
  const first = argValue(field as never, 'first', ctx);
  const open = repo.pulls.filter((pull) => pull.state === 'open');
  const limit = typeof first === 'number' ? first : open.length;
  const page = open.slice(0, limit);
  const out: Record<string, unknown> = {};
  for (const selection of field.selections) {
    if (selection.kind === 'inlineFragment') continue;
    const sub = selection.field;
    const key = sub.alias ?? sub.name;
    if (sub.name === 'nodes') {
      out[key] = page.map((pull) => pullObject(ctx, repo, pull, sub.selections));
    } else if (sub.name === 'totalCount') {
      out[key] = open.length;
    } else if (sub.name === 'pageInfo') {
      out[key] = { hasNextPage: open.length > limit, endCursor: null };
    }
  }
  return out;
}

function typeObject(ctx: ExecContext, name: string, selections: SelectionNode[]): Record<string, unknown> | null {
  const fields = TYPE_FIELDS[name];
  const enums = TYPE_ENUM_VALUES[name];
  if (fields === undefined && enums === undefined) return null;
  const out: Record<string, unknown> = { name };
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === 'fields') {
      out[key] = (fields ?? []).map((fieldName) => ({ name: fieldName }));
    } else if (field.name === 'enumValues') {
      out[key] = (enums ?? []).map((value) => ({ name: value }));
    } else if (field.name === 'name') {
      out[key] = name;
    } else if (field.name === 'kind') {
      out[key] = enums !== undefined ? 'ENUM' : 'OBJECT';
    } else {
      out[key] = null;
    }
  }
  return out;
}

function executeOperation(store: Store, operation: OperationNode, variables: Readonly<Record<string, unknown>>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: ExecContext = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'inlineFragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (operation.operation === 'query') {
      switch (field.name) {
        case 'viewer':
          data[key] = userObject(ctx, field.selections);
          break;
        case 'repository': {
          const owner = argValue(field, 'owner', ctx);
          const name = argValue(field, 'name', ctx);
          const repo = typeof owner === 'string' && typeof name === 'string' ? store.getRepo(owner, name) : undefined;
          data[key] = repo === undefined ? null : repoObject(ctx, repo, field.selections);
          break;
        }
        case 'node': {
          const id = argValue(field, 'id', ctx);
          let node: Record<string, unknown> | null = null;
          if (typeof id === 'string') {
            const repo = repoFromGlobalId(store, id);
            if (repo !== null) {
              node = { id };
              for (const sub of field.selections) {
                if (sub.kind === 'inlineFragment') {
                  if (sub.typeName === 'Repository') {
                    const repoFields = repoObject(ctx, repo, sub.selections);
                    Object.assign(node, repoFields);
                  }
                  continue;
                }
                if (sub.field.name === 'id') node.id = repoGlobalId(repo);
                else unknownField('Node', sub.field.name, ctx);
              }
            }
          }
          data[key] = node;
          break;
        }
        case '__type': {
          const name = argValue(field, 'name', ctx);
          data[key] = typeof name === 'string' ? typeObject(ctx, name, field.selections) : null;
          break;
        }
        default:
          unknownField('Query', field.name, ctx);
          data[key] = null;
      }
    } else {
      switch (field.name) {
        case 'createIssue': {
          const input = argValue(field, 'input', ctx);
          const created = mutateCreateIssue(ctx, input);
          data[key] = created === null ? null : { issue: created };
          break;
        }
        case 'closeIssue': {
          const input = argValue(field, 'input', ctx);
          const closed = mutateCloseIssue(ctx, input);
          data[key] = closed === null ? null : { issue: closed };
          break;
        }
        case 'createPullRequest': {
          const input = argValue(field, 'input', ctx);
          const created = mutateCreatePullRequest(ctx, input);
          data[key] = created === null ? null : { pullRequest: created };
          break;
        }
        case 'mergePullRequest': {
          const input = argValue(field, 'input', ctx);
          const merged = mutateMergePullRequest(ctx, input);
          data[key] = merged === null ? null : { pullRequest: merged };
          break;
        }
        case 'addComment': {
          const input = argValue(field, 'input', ctx);
          const added = mutateAddComment(ctx, input);
          data[key] = added === null ? null : { commentEdge: { node: added } };
          break;
        }
        default:
          unknownField('Mutation', field.name, ctx);
          data[key] = null;
      }
    }
  }
  return { data: ctx.errors.length > 0 && operation.operation === 'query' && Object.values(data).every((v) => v === null) ? null : data, errors: ctx.errors };
}

function readSelections(
  ctx: ExecContext,
  node: Record<string, unknown> | null,
  selections: SelectionNode[],
  kind: 'issue' | 'pull',
  repo: Repo,
  entity: Issue | PullRequest,
): Record<string, unknown> | null {
  if (node === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    const full = kind === 'issue' ? issueObject(ctx, repo, entity as Issue, [selection]) : pullObject(ctx, repo, entity as PullRequest, [selection]);
    out[key] = full[key] ?? null;
  }
  return out;
}

function mutateCreateIssue(ctx: ExecContext, input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'createIssue needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const repo = typeof record.repositoryId === 'string' ? repoFromGlobalId(ctx.store, record.repositoryId) : null;
  if (repo === null || typeof record.title !== 'string') {
    ctx.errors.push({ message: 'createIssue: unknown repository or missing title.' });
    return null;
  }
  const issue = ctx.store.createIssue(repo, record.title, typeof record.body === 'string' ? record.body : '', []);
  return { number: issue.number, id: issueGlobalId(repo, issue) };
}

function mutateCloseIssue(ctx: ExecContext, input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'closeIssue needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const found = typeof record.issueId === 'string' ? issueFromGlobalId(ctx.store, record.issueId) : null;
  if (found === null) {
    ctx.errors.push({ message: 'closeIssue: unknown issue.' });
    return null;
  }
  found.issue.state = 'closed';
  return { number: found.issue.number, id: issueGlobalId(found.repo, found.issue), state: 'CLOSED' };
}

function mutateCreatePullRequest(ctx: ExecContext, input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'createPullRequest needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const repo = typeof record.repositoryId === 'string' ? repoFromGlobalId(ctx.store, record.repositoryId) : null;
  const head = typeof record.headRefName === 'string' ? record.headRefName : '';
  const base = typeof record.baseRefName === 'string' ? record.baseRefName : '';
  if (repo === null || head === '' || base === '') {
    ctx.errors.push({ message: 'createPullRequest: unknown repository or missing head/base.' });
    return null;
  }
  if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
    ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist.' });
    return null;
  }
  const existing = repo.pulls.find((pull) => pull.head === head && pull.state === 'open');
  const pull = existing ?? ctx.store.createPull(repo, typeof record.title === 'string' ? record.title : '', '', head, base);
  return {
    number: pull.number,
    id: pullGlobalId(repo, pull),
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.head,
    baseRefName: pull.base,
  };
}

function mutateMergePullRequest(ctx: ExecContext, input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'mergePullRequest needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const found = typeof record.pullRequestId === 'string' ? pullFromGlobalId(ctx.store, record.pullRequestId) : null;
  if (found === null) {
    ctx.errors.push({ message: 'mergePullRequest: unknown pull request.' });
    return null;
  }
  const sha = ctx.store.mergePull(found.repo, found.pull);
  if (sha === null) {
    ctx.errors.push({ message: 'mergePullRequest: the pull request cannot merge.' });
    return null;
  }
  return { number: found.pull.number, merged: true, state: 'MERGED' };
}

function mutateAddComment(ctx: ExecContext, input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object') {
    ctx.errors.push({ message: 'addComment needs an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const found = typeof record.subjectId === 'string' ? issueFromGlobalId(ctx.store, record.subjectId) : null;
  if (found === null || typeof record.body !== 'string') {
    ctx.errors.push({ message: 'addComment: unknown subject or missing body.' });
    return null;
  }
  const comment = ctx.store.createComment(found.repo, found.issue.number, record.body);
  return { id: commentGlobalId(found.repo, found.issue.number, comment.id), body: comment.body };
}

// -------------------------------------------------------------------------------------------
// entry point: one operation object, or an array of them (operation batching)
// -------------------------------------------------------------------------------------------

export interface GraphQLEnvelope {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(store: Store, body: unknown): GraphQLEnvelope | GraphQLEnvelope[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(store, entry));
  }
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): GraphQLEnvelope {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object with query and variables.' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  const variables = (record.variables !== null && typeof record.variables === 'object' ? record.variables : {}) as Readonly<Record<string, unknown>>;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request needs a query string.' }] };
  }
  let operations: OperationNode[];
  try {
    operations = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'GraphQL document holds no operation.' }] };
  }
  // The suite sends one operation per body (or a batch of one-operation bodies); run the first,
  // or the one the operationName names.
  let operation = operations[0] as OperationNode;
  if (typeof record.operationName === 'string') {
    const named = operations.find((entry) => entry.name === record.operationName);
    if (named !== undefined) operation = named;
  }
  const result = executeOperation(store, operation, variables);
  if (result.errors.length > 0) {
    return { data: result.data, errors: result.errors };
  }
  return { data: result.data };
}
