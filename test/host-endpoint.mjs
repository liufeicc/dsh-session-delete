/**
 * Offline contract test for the Host endpoint the Client half calls.
 *
 * The Client resolves `sessionDelete/delete` over the Typert Gateway, and the
 * Gateway resolves the Host side by source-mode discovery: it reads the
 * `typertRemote` binding on the Service value, a Remote marker list on the
 * class prototype, and the method's own parameter names. Because a local bundle
 * cannot import `@deepseek-ai/*` (Node resolves this linked package's real path,
 * where the dsh installation is not on the module path), all three are written
 * by hand — so they are checked here against the **real** Gateway and registry
 * from the installed Harness, whose `invoke()` is carrier-independent.
 *
 *   node test/host-endpoint.mjs
 *
 * Needs the installed Harness to resolve `@deepseek-ai/*`; without it the test
 * reports the reason and skips.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
let skipped = 0;

/** Record one assertion result. */
function check(label, condition) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures.push(label);
  console.log('FAIL ' + label);
}

/** Report one check that could not run in this environment. */
function skip(label, reason) {
  skipped += 1;
  console.log('skip ' + label + ' (' + reason + ')');
}

const profileDir = process.env.DSH_PROFILE_DIR;
let requireFromProfile;
try {
  requireFromProfile = profileDir === undefined || profileDir === '' ? undefined : createRequire(join(profileDir, 'noop.js'));
} catch {
  requireFromProfile = undefined;
}

let resolve;
try {
  resolve = (id) => pathToFileURL(requireFromProfile.resolve(id)).href;
  resolve('@deepseek-ai/dsh-api-gateway');
} catch {
  resolve = undefined;
}

if (resolve === undefined) {
  skip('the real Gateway resolves and invokes the Host endpoint', 'the installed Harness is not resolvable from $DSH_PROFILE_DIR');
  console.log('\nall checks passed (1 skipped)');
} else {
  const cordis = await import(resolve('@deepseek-ai/cordis'));
  const registry = await import(resolve('@deepseek-ai/dsh-typert-registry'));
  const gateway = await import(resolve('@deepseek-ai/dsh-api-gateway'));
  const plugin = await import(pathToFileURL(join(here, '..', 'index.js')).href);

  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-root-'));
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-home-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  try {
    const sessionId = 'session-11111111-2222-3333-4444-555555555555';
    const directory = join(root, '--tmp-project--', sessionId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'log');

    const ctx = new cordis.Context();
    new registry.TypertRegistry(ctx);
    check('the real Typert registry is mounted', ctx.get('typert') !== undefined);

    const host = new gateway.TypertGatewayService(ctx);
    const detached = [];
    const archived = [];
    const agents = new Map();
    const runningId = 'session-22222222-2222-2222-2222-222222222222';
    const runningDir = join(root, '--tmp-project--', runningId);
    await mkdir(runningDir, { recursive: true });
    await writeFile(join(runningDir, 'session.v4.jsonl.zstd'), 'log');
    agents.set(runningId, {
      id: runningId,
      status: 'running',
      whenIdle: () => Promise.resolve(),
    });

    ctx.provide('sessionPersistence', { root });
    ctx.provide('agents', { get: (id) => agents.get(id) });
    ctx.provide('workspaceRegistry', {
      list: () => [{
        title: 'tmp-project',
        sessionIds: [sessionId, runningId],
        detachSession: (id) => {
          detached.push(id);
          return Promise.resolve();
        },
      }],
      archiveSession: (id, options) => {
        archived.push(id + ':' + String(options?.stopActivity === true));
        return Promise.resolve();
      },
      unpinSession: () => Promise.resolve(),
      unarchiveSession: () => Promise.resolve(),
    });
    plugin.apply(ctx);
    check('apply provides the sessionDelete service', ctx.get('sessionDelete') !== undefined);

    const result = await host.invoke({
      namespace: 'sessionDelete',
      method: 'delete',
      args: { request: { sessionId } },
    });
    check('the real Gateway resolved the SRC endpoint and invoked it', result !== undefined && result.deleted === true);
    check('the durable log directory is gone', (await stat(directory).then(() => false, () => true)));
    check('the workspace accounting was detached', detached.includes(sessionId));

    const missing = await host.invoke({
      namespace: 'sessionDelete',
      method: 'delete',
      args: { request: { sessionId } },
    });
    check('a second call reports the Session as missing', missing !== undefined && missing.deleted === false && missing.reason === 'missing');

    const live = await host.invoke({
      namespace: 'sessionDelete',
      method: 'delete',
      args: { request: { sessionId: 'session-99999999-9999-9999-9999-999999999999' } },
    });
    check('an unknown Session reports missing', live !== undefined && live.deleted === false && live.reason === 'missing');

    // The running path reached through the same wire: the optional
    // `stopActivity` field travels in the single `request` argument.
    const refused = await host.invoke({
      namespace: 'sessionDelete',
      method: 'delete',
      args: { request: { sessionId: runningId } },
    });
    check('a running Session is refused over the wire', refused !== undefined && refused.deleted === false && refused.reason === 'running');
    check('the refusal left the log alone', await stat(runningDir).then(() => true, () => false));

    const stopped = await host.invoke({
      namespace: 'sessionDelete',
      method: 'delete',
      args: { request: { sessionId: runningId, stopActivity: true } },
    });
    check('stopActivity deletes the running Session', stopped !== undefined && stopped.deleted === true && stopped.guarded === true);
    check('the running Session was archived with stopActivity', archived.includes(runningId + ':true'));
    check('the running Session log is gone', (await stat(runningDir).then(() => false, () => true)));
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed');
  process.exitCode = 1;
} else if (skipped === 0) {
  console.log('\nall checks passed');
}
