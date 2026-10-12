/**
 * 删除会话 — Host half: the one operation that permanently removes one Session.
 *
 * The Harness has no Session deletion primitive: the archive set only hides a
 * Session, and session persistence only creates, opens, stats, and lists logs.
 * This row adds the missing operation. It deletes exactly what makes a Session
 * exist — its durable log directory, the projection-cache entry derived from
 * it, and the workspace/archive/pin accounting that keeps it listed.
 *
 * Liveness shapes the operation. A resumed Session's Agent — and with it the
 * log's write handle — stays alive in this process for as long as the Host
 * runs, so "live" is not "running": an idle Session that was merely opened once
 * is still live, and refusing those would refuse almost every row. The
 * operation therefore:
 *
 *   - refuses only a Session whose Agent is actually `running`;
 *   - archives the Session durably before removing a live log. Archival is the
 *     documented wake block (the `agent/pre-step` gate reads the durable archive
 *     set), and `stopActivity` cancels a running turn the way the user's own
 *     stop does — so a still-live Agent cannot append into the deleted log and
 *     resurrect it, even from a queued wake or a goal round;
 *   - waits for the Agent to reach quiescence before unlinking, so no in-flight
 *     drain recreates the file it is writing.
 *
 * The operation is exposed to the browser half over the Typert Gateway as the
 * Remote endpoint `sessionDelete/delete`. A hand-authored bundle cannot resolve
 * `@deepseek-ai/*` packages (Node resolves the linked package's real path, and
 * the dsh install is not on it), so the Remote marker and binding that the
 * generated `TypertRemoteService` would normally carry are written by hand:
 * the Gateway's source-mode discovery only needs the marker property on the
 * class prototype and the `typertRemote` binding on the live Service value.
 *
 * @module @local/dsh-session-delete
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Loader row id, and the plugin's own stable name. */
export const name = 'session-delete';

/** Services the row needs before it activates. */
export const inject = ['sessionPersistence'];

/** Cordis service key, Typert namespace, and wire namespace of the operation. */
export const SERVICE_KEY = 'sessionDelete';

/** How long a stopped Agent is given to reach quiescence before the log is removed. */
const IDLE_TIMEOUT_MS = 5000;

/** Prototype property the Gateway reads for a Service's Remote method markers. */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * The Remote method marker set of this Service, shaped exactly like the one
 * `@Remote('delete')` records: a versioned, frozen prototype descriptor.
 */
const REMOTE_MARKERS = Object.freeze({
  version: 1,
  methods: Object.freeze([
    Object.freeze({ method: 'delete', invocation: Object.freeze({ kind: 'direct' }) }),
  ]),
});

/**
 * Encode one path segment the way the JSONL session backend does, so a Session
 * id whose characters are escaped still resolves to its own directory name.
 * @param raw - the raw session id.
 * @returns the on-disk directory name for that id.
 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Whether one path is an existing directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Human-readable message of any thrown value. */
function messageOf(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Settle after `ms` at the latest, following `work` when it finishes first. */
function settled(work, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    Promise.resolve(work).then(done, done);
  });
}

/** One Session's permanent removal, callable by this plugin's Client half. */
class SessionDeleteService {
  /** @param ctx - the plugin's Host Context (service lookups, DSH home). */
  constructor(ctx) {
    this.ctx = ctx;
  }

  /**
   * The configured session root, when the mounted persistence backend exposes
   * one; otherwise the default `$DSH_HOME/sessions`.
   * @returns the absolute session root directory.
   */
  sessionRoot() {
    const persistence = this.ctx.get('sessionPersistence');
    const root = persistence === undefined ? undefined : persistence.root;
    if (typeof root === 'string' && root !== '') return root;
    return join(this.dshHome(), 'sessions');
  }

  /** The DSH home directory: storage roots hang off it. */
  dshHome() {
    const home = process.env.DSH_HOME;
    return home === undefined || home === '' ? join(homedir(), '.dsh') : home;
  }

  /**
   * The live Agent driving one Session, when this Host has one. Its presence —
   * not the Session's mere residency in the store — is what makes a deletion
   * need the archival guard.
   * @param sessionId - the Session to look up.
   * @returns the Agent, or undefined when this process never resumed it.
   */
  agentOf(sessionId) {
    const agents = this.ctx.get('agents');
    return agents === undefined || typeof agents.get !== 'function' ? undefined : agents.get(sessionId);
  }

  /**
   * Find the durable directory of one Session: every project directory under
   * the session root is searched for a child named after the encoded id, so
   * the caller never re-derives the cwd grouping key.
   * @param sessionId - the Session whose directory is looked for.
   * @returns the absolute directory path, or undefined when no log exists.
   */
  async findSessionDir(sessionId) {
    const root = this.sessionRoot();
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const segment = encodeSegment(sessionId);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, entry.name, segment);
      if (await isDirectory(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * Stop a live Session's work and durably block its later wakes, so the log
   * this operation is about to unlink is not recreated by an append.
   *
   * Archival is the guard rather than a bookkeeping step: the durable archive
   * set is exactly what the `agent/pre-step` gate reads, so a queued wake, a
   * goal round, or a schedule tick cannot start a turn on the deleted Session.
   * `stopActivity` also cancels a running turn the way the user's own stop
   * does, and the wait keeps an in-flight drain from landing after the unlink.
   * @param sessionId - the live Session whose log will be removed.
   * @param agent - its live Agent.
   * @returns the names of the guard steps that failed.
   */
  async guard(sessionId, agent) {
    const failures = [];
    const registry = this.ctx.get('workspaceRegistry');
    if (registry !== undefined) {
      try {
        await registry.archiveSession(sessionId, { stopActivity: true });
      } catch (error) {
        failures.push('archive: ' + messageOf(error));
      }
    }
    try {
      await settled(typeof agent.whenIdle === 'function' ? agent.whenIdle() : undefined, IDLE_TIMEOUT_MS);
    } catch (error) {
      failures.push('idle wait: ' + messageOf(error));
    }
    return failures;
  }

  /**
   * Drop the derived state that outlives the log: the persisted projection
   * cache entry, the pin membership, the workspace accounting the sidebar
   * lists this Session from, and — for a Session no live Agent can wake — the
   * archival tombstone. A live Session stays archived on purpose: that id is
   * what keeps its still-resident Agent from writing a fresh log. Failures
   * here are reported per step and never resurrect the Session, so they do not
   * fail the deletion.
   * @param sessionId - the already-deleted Session.
   * @param guarded - whether a live Agent was archived to protect the deletion.
   * @returns the names of the cleanup steps that failed.
   */
  async cleanup(sessionId, guarded) {
    const failures = [];
    const cached = join(this.dshHome(), 'storages', 'session_projcache', 'sessions', sessionId + '.json');
    try {
      await rm(cached, { force: true });
    } catch (error) {
      failures.push('projection cache: ' + messageOf(error));
    }
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) return failures;
    const steps = [['unpin', () => registry.unpinSession(sessionId)]];
    if (!guarded) steps.push(['unarchive', () => registry.unarchiveSession(sessionId)]);
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        failures.push(step + ': ' + messageOf(error));
      }
    }
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue;
      try {
        await workspace.detachSession(sessionId);
      } catch (error) {
        failures.push('detach from ' + workspace.title + ': ' + messageOf(error));
      }
    }
    return failures;
  }

  /**
   * Permanently delete one Session.
   *
   * A running Session is refused unless the caller passes `stopActivity`, which
   * is what the dialog's "stop and delete" offers: the work is stopped and then
   * the log is removed. An unknown Session is reported as absent instead of
   * failing, so a stale row can be cleared.
   * @param request - the wire request carrying `sessionId` and optional `stopActivity`.
   * @returns a plain JSON outcome: `deleted`, and on refusal why.
   */
  async delete(request) {
    const sessionId = request === null || typeof request !== 'object' ? undefined : request.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return { deleted: false, reason: 'invalid' };
    const stopActivity = request.stopActivity === true;
    const agent = this.agentOf(sessionId);
    if (agent !== undefined && agent.status === 'running' && !stopActivity) return { deleted: false, reason: 'running' };

    const failures = [];
    if (agent !== undefined) failures.push(...(await this.guard(sessionId, agent)));

    const directory = await this.findSessionDir(sessionId);
    if (directory === undefined) return { deleted: false, reason: 'missing', failures };

    await rm(directory, { recursive: true, force: true });
    failures.push(...(await this.cleanup(sessionId, agent !== undefined)));
    return { deleted: true, sessionId, directory, guarded: agent !== undefined, failures };
  }
}

Object.defineProperty(SessionDeleteService.prototype, REMOTE_METHODS, {
  configurable: true,
  value: REMOTE_MARKERS,
});

/**
 * Register the Session deletion Service so the Gateway can resolve
 * `sessionDelete/delete` for this Client.
 *
 * `ctx.provide` registers the value under a Cordis service key owned by this
 * plugin's fiber, and the hand-written `typertRemote` binding plus the
 * prototype markers above are exactly what the Gateway's source-mode discovery
 * reads; nothing else about the generated Remote machinery is required.
 * @param ctx - Host Context of this plugin row.
 */
export function apply(ctx) {
  const service = new SessionDeleteService(ctx);
  Object.defineProperty(service, 'typertRemote', {
    configurable: true,
    value: Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY }),
  });
  ctx.provide(SERVICE_KEY, service);
}
