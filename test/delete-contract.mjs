/**
 * Offline contract test for the Session deletion operation.
 *
 * It drives the Host half against a temporary session root and a fake Context,
 * so the parts that decide what happens to real user data — the running
 * refusal, the archival guard for a live Agent, the directory discovery, the
 * removal, and the cleanup steps — are checked without a running Harness and
 * without touching `$DSH_HOME`.
 *
 *   node test/delete-contract.mjs
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SERVICE_KEY, apply } from '../index.js';

const failures = [];

/** Record one assertion result. */
function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures.push(label);
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

/** Whether a path exists. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A fake Host Context: `provide` captures, `get` reads the given services. */
function createContext(services) {
  const provided = new Map();
  return {
    provide: (name, value) => provided.set(name, value),
    get: (name) => services[name],
    provided,
  };
}

const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'));
const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-home-'));
process.env.DSH_HOME = home;

const project = '--tmp-project--';
const storedId = 'session-00000000-0000-0000-0000-000000000000';
const idleId = 'session-11111111-1111-1111-1111-111111111111';
const runningId = 'session-22222222-2222-2222-2222-222222222222';
const absentId = 'session-ffffffff-ffff-ffff-ffff-ffffffffffff';

/** Create one Session's directory with a log file in it. */
async function seed(sessionId) {
  const directory = join(root, project, sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'log');
  return directory;
}

try {
  const storedDir = await seed(storedId);
  const idleDir = await seed(idleId);
  const runningDir = await seed(runningId);

  const calls = [];
  /** One fake Agent, as the Host registry would carry it. */
  const agentFor = (sessionId, status) => ({
    id: sessionId,
    status,
    whenIdle: () => {
      calls.push('whenIdle:' + sessionId);
      return Promise.resolve();
    },
  });
  const agents = new Map([
    [idleId, agentFor(idleId, 'idle')],
    [runningId, agentFor(runningId, 'running')],
  ]);
  const workspaces = [storedId, idleId, runningId].map((sessionId) => ({
    title: 'tmp-project',
    sessionIds: [sessionId],
    detachSession: (id) => {
      calls.push('detach:' + id);
      return Promise.resolve();
    },
  }));
  const services = {
    sessionPersistence: { root },
    agents: { get: (id) => agents.get(id) },
    workspaceRegistry: {
      list: () => workspaces,
      archiveSession: (id, options) => {
        calls.push('archive:' + id + ':' + String(options?.stopActivity === true));
        return Promise.resolve();
      },
      unarchiveSession: (id) => {
        calls.push('unarchive:' + id);
        return Promise.resolve();
      },
      unpinSession: (id) => {
        calls.push('unpin:' + id);
        return Promise.resolve();
      },
    },
  };

  const ctx = createContext(services);
  apply(ctx);
  const service = ctx.provided.get(SERVICE_KEY);
  check('apply provides the ' + SERVICE_KEY + ' Service', service !== undefined);

  // The Gateway's source-mode discovery reads exactly these: a live
  // `typertRemote` binding on the Service value, a versioned marker list on its
  // class prototype, and identifier parameter names in the method source.
  const binding = Reflect.get(service, 'typertRemote');
  check('the binding points at the live Service value', binding.service === service);
  check('the binding key and namespace match', binding.serviceKey === SERVICE_KEY && binding.namespace === SERVICE_KEY);
  const markers = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), '@deepseek-ai/dsh-typert-protocol/remote-methods');
  const marker = markers === undefined ? undefined : markers.value;
  check('the prototype carries a version 1 marker list', marker !== undefined && marker.version === 1 && marker.methods.length === 1);
  check('the marker exports delete as a direct method', marker.methods[0].method === 'delete' && marker.methods[0].invocation.kind === 'direct');
  const implementation = Object.getPrototypeOf(service)[marker.methods[0].method];
  const source = Function.prototype.toString.call(implementation);
  const parameters = source.slice(source.indexOf('(') + 1, source.indexOf(')')).split(',').map((part) => part.trim()).filter(Boolean);
  check('the method declares exactly the wire parameter "request"', parameters.length === 1 && parameters[0] === 'request');

  const invalid = await service.delete({ sessionId: '' });
  check('an empty id is refused as invalid', invalid.deleted === false && invalid.reason === 'invalid');

  const absent = await service.delete({ sessionId: absentId });
  check('an unknown Session reports missing', absent.deleted === false && absent.reason === 'missing');

  // A running Session: refused first, and only the explicit stopping path is
  // allowed to cancel the turn.
  const refused = await service.delete({ sessionId: runningId });
  check('a running Session is refused without stopActivity', refused.deleted === false && refused.reason === 'running');
  check('the refusal archived nothing', calls.filter((call) => call.startsWith('archive:')).length === 0);
  check('the refused Session keeps its log', await exists(runningDir));

  const stopped = await service.delete({ sessionId: runningId, stopActivity: true });
  check('a running Session is deleted with stopActivity', stopped.deleted === true && stopped.directory === runningDir);
  check('stopping archived the Session with stopActivity', calls.includes('archive:' + runningId + ':true'));
  check('the running Session was awaited to quiescence', calls.includes('whenIdle:' + runningId));
  check('the running Session log is gone', (await exists(runningDir)) === false);
  check('a guarded Session keeps its archival tombstone', !calls.includes('unarchive:' + runningId));

  // A live but idle Session — the common case, because a resumed Agent stays
  // alive for the whole Host run — is deleted, with archival as the wake guard.
  const idle = await service.delete({ sessionId: idleId });
  check('a live idle Session is deleted', idle.deleted === true && idle.guarded === true);
  check('the idle Session was guarded by archival', calls.includes('archive:' + idleId + ':true'));
  check('the idle Session log is gone', (await exists(idleDir)) === false);
  check('the workspace accounting was detached', calls.includes('detach:' + idleId));
  check('pin membership was cleared', calls.includes('unpin:' + idleId));

  // A Session no Agent holds needs no guard, so the archive set is left alone.
  const stored = await service.delete({ sessionId: storedId });
  check('a stored Session is deleted', stored.deleted === true && stored.guarded === false);
  check('an unguarded Session is not archived', !calls.includes('archive:' + storedId + ':true'));
  check('an unguarded Session is unarchived instead', calls.includes('unarchive:' + storedId));
  check('no cleanup step failed', Array.isArray(stored.failures) && stored.failures.length === 0);

  const again = await service.delete({ sessionId: storedId });
  check('a second deletion reports missing', again.deleted === false && again.reason === 'missing');
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
