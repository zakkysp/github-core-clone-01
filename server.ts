// server.ts — the HTTP server: routing, bearer auth, request ids, body reading. One
// process, in-memory store, keep-alive on. All replies are JSON except the git smart-HTTP
// ones, which carry their own content types.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { routeRest } from './rest.ts';
import { Store, isoTime } from './store.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function bearerOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (SHOP_TOKEN !== '') {
    return header === `Bearer ${SHOP_TOKEN}`;
  }
  // No token configured (local runs): any non-empty bearer is accepted, none is refused.
  return typeof header === 'string' && header.startsWith('Bearer ') && header.slice(7) !== '';
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createForgeServer(): { server: Server; store: Store } {
  const store = new Store();
  let requestCounter = 0;

  const sendJson = (res: ServerResponse, status: number, json: unknown, extraHeaders?: Record<string, string>): void => {
    const body = json === null ? '' : JSON.stringify(json);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-GitHub-Request-Id': `req-${requestCounter}`,
      ...(extraHeaders ?? {}),
    };
    res.writeHead(status, headers);
    res.end(body);
  };

  const sendGit = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  };

  const server = createServer((req, res) => {
    void (async () => {
      requestCounter += 1;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // GET /healthz — the boot probe, no auth.
        if (pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repo = decodeURIComponent(gitMatch[2] as string);
          const rest = gitMatch[3] as string;
          const gitProtocol = req.headers['git-protocol'] ?? null;
          if (method === 'GET' && rest === 'info/refs') {
            const service = url.searchParams.get('service') ?? '';
            const answer = infoRefs(store, owner, repo, service, gitProtocol);
            sendGit(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (method === 'POST' && rest === 'git-upload-pack') {
            const body = await readBody(req);
            const answer = uploadPack(store, owner, repo, body, gitProtocol);
            sendGit(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (method === 'POST' && rest === 'git-receive-pack') {
            const body = await readBody(req);
            const answer = receivePack(store, owner, repo, body);
            sendGit(res, answer.status, answer.contentType, answer.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // POST /api/graphql
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!bearerOk(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Request body is not valid JSON' });
            return;
          }
          sendJson(res, 200, executeGraphQL(store, parsed));
          return;
        }

        // POST /mcp
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end('{}');
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!bearerOk(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          const answer = handleMcp(store, raw.toString('utf8'));
          if (answer.json === null) {
            res.writeHead(answer.status);
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.json);
          return;
        }

        // /api/v3/...
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!bearerOk(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const segments = pathname
            .slice('/api/v3'.length)
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment) => decodeURIComponent(segment));
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Request body is not valid JSON' });
                return;
              }
            }
          }
          const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
          const reply = routeRest(store, { method, segments, query: url.searchParams, body, origin });
          if (reply.status === 204) {
            res.writeHead(204, { 'X-GitHub-Request-Id': `req-${requestCounter}`, 'Content-Type': 'application/json; charset=utf-8' });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.json, reply.headers);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });

  return { server, store };
}

export { isoTime };
