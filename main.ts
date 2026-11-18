// main.ts — entrypoint: start the forge on an ephemeral port, register it with the
// harness environment, then wait until the harness says it is done.

import { createForgeServer } from './server.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  // Plain stdout log lines; they never enter stored state.
  console.log(`[forge] ${message}`);
}

async function registerWithRetry(registerUrl: string, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const { status } = await postJson(registerUrl, { port }, 5_000);
      if (status === 200 || status === 201) {
        log(`registered port ${port} with the harness environment`);
        return true;
      }
      if (status === 409) {
        // Another entry already holds the register slot; keep serving, the
        // harness will only ever poll the first registration.
        log('register returned 409: another entry is already registered');
        return true;
      }
      log(`register attempt ${attempt + 1} got HTTP ${status}`);
    } catch (err) {
      log(`register attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(500);
  }
  return false;
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const { server } = createForgeServer();
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) throw new Error('could not bind an ephemeral port');

  // Local development: no harness environment, just serve until killed.
  if (ENV_URL === '') {
    log(`forge listening on port ${port} (no MAKEFUN_ENV_URL, local mode)`);
    return;
  }

  const registerUrl = `${ENV_URL.replace(/\/$/, '')}/register`;
  const doneUrl = `${ENV_URL.replace(/\/$/, '')}/done`;

  const registered = await registerWithRetry(registerUrl, port);
  if (!registered) throw new Error('could not register with the harness environment');

  for (;;) {
    try {
      const { status, text } = await getJson(doneUrl, 10_000);
      if (status === 200) {
        const parsed = JSON.parse(text) as { done?: boolean };
        if (parsed.done === true) break;
      }
    } catch {
      // A transient read failure is not a reason to quit; keep polling.
    }
    await sleep(250);
  }

  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
