/**
 * Offline contract test for the Client half.
 *
 * It loads `client.js` the way the browser module loader does, runs `apply`
 * against a stub Context, and captures the contribution handed to
 * `ctx.remote.$mount`. That contribution is then put through the **real**
 * Harness, in two stages:
 *
 *   1. the real Client Typert registry validates the hand-written descriptor
 *      (this is the check that rejected the first version of this plugin, which
 *      is why a negative control proves the check has teeth);
 *   2. the real Client Gateway mounts it, after which the namespace is visible
 *      through `ctx.get` and one call reaches the wire as
 *      `sessionDelete/delete` with `{ request: { sessionId } }`.
 *
 * It also drives the `sessionDeleteUi` Client service the same way a sibling
 * plugin does — publish, refuse an empty request, accept a real one, render the
 * dialog from the store it wrote, press the destructive button — so the tiled
 * panel's dropdown cannot silently stop reaching this dialog.
 *
 *   node test/client-mount.mjs
 *
 * Stage 1 and 2 need the installed Harness to resolve `@deepseek-ai/*`; when it
 * cannot (no dsh installation on this machine) they are reported as skipped.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
let skipped = 0;

/** Record one assertion result. */
function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures.push(label);
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

/** Report one check that could not run in this environment. */
function skip(label, reason) {
  skipped += 1;
  console.log('skip ' + label + ' (' + reason + ')');
}

/** Load one browser bundle and return its `factory`'s exports. */
async function loadClientBundle(path, requireModule) {
  let definition;
  const previous = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
  try {
    await import(pathToFileURL(path).href);
  } finally {
    globalThis.window = previous;
  }
  if (definition === undefined) throw new Error('bundle did not register with __ModuleLoader__: ' + path);
  return definition.factory(requireModule);
}

/** A React stand-in: the factory destructures hooks and defines components. */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: (callback) => callback,
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

/** The minimal Context the Client half uses directly. */
function createStubContext() {
  const contributions = [];
  const registered = [];
  /** Services published through `ctx.provide`, read back the way a sibling plugin would. */
  const provided = new Map();
  /** `ctx.get` answers, so the deletion path can be driven without a Host. */
  const services = new Map();
  const ctx = {
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    provide: (name, value) => {
      provided.set(name, value);
      return () => {
        provided.delete(name);
      };
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_key, callback) => {
        callback();
      },
      register: (definition, component) => {
        registered.push({ ...definition, component });
        return () => {};
      },
    },
    get: (key) => services.get(key),
    remote: {
      $mount: (contribution) => {
        contributions.push(contribution);
        return Promise.resolve(() => {});
      },
    },
  };
  return { ctx, contributions, registered, provided, services };
}

const mod = await loadClientBundle(join(here, '..', 'client.js'), (id) => {
  if (id === 'react') return ReactStub;
  throw new Error('unexpected Client require: ' + id);
});

check('client.js returns inject and apply', typeof mod.apply === 'function' && Array.isArray(mod.inject));
check('the Client half declares the remote service', mod.inject.includes('remote') && mod.inject.includes('slots') && mod.inject.includes('locale'));

const { ctx, contributions, registered, provided, services } = createStubContext();
mod.apply(ctx);
await Promise.resolve();

check('apply calls ctx.remote.$mount exactly once', contributions.length === 1);
const contribution = contributions[0];
check('the contribution declares one descriptor', contribution !== undefined && contribution.descriptors.length === 1);
const descriptor = contribution.descriptors[0];
check('the endpoint is sessionDelete/delete', descriptor.namespace === 'sessionDelete' && descriptor.method === 'delete');
check('the descriptor takes one JSON parameter named request', descriptor.parameters.length === 1 && descriptor.parameters[0].wire === 'request' && descriptor.parameters[0].source === 'json');
check('the input codec is strict, as the Client Gateway mount requires', descriptor.parameters[0].codec.mode === 'strict');
check('the result rides SRC JSON', descriptor.result.mode === 'src-json');
check('the menu row is registered in sidebar.workspaces.session.menu.item', registered.some((definition) => definition.name === 'sidebar.workspaces.session.menu.item' && definition.id === 'session-delete'));
check('the confirmation dialog is registered in shell.overlay', registered.some((definition) => definition.name === 'shell.overlay' && definition.id === 'session-delete.confirm'));
check('exactly two slot registrations were made', registered.length === 2);

/*
 * The dialog is also a service: another Client plugin (today the tiled panel's
 * session dropdown) asks for a deletion instead of re-implementing the
 * confirmation and the "stop it first" branch. These checks drive that entry
 * point with no browser: publish → refuse/accept → the dialog's own props see
 * exactly the request that was handed in → confirming calls the Host namespace
 * and notifies the caller through `onDeleted`.
 */
const dialog = provided.get('sessionDeleteUi');
check('the dialog is published as the sessionDeleteUi Client service', dialog !== undefined && typeof dialog.request === 'function');
check('a request without a usable sessionId is refused', dialog.request({ sessionId: '' }) === false && dialog.request({}) === false);

const overlay = registered.find((definition) => definition.id === 'session-delete.confirm');
/** The dialog's own props, including the pending-deletion store it renders from. */
const dialogProps = () => ({ ...overlay.inject(), t: ctx.locale.bind('session-delete') });
/** Depth-first search of the rendered stand-in tree. */
const findAll = (node, predicate, found = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (node.type !== undefined && predicate(node)) found.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, found);
  return found;
};

const deleteCalls = [];
let notified = null;
services.set('remote.sessionDelete', {
  delete: (request) => {
    deleteCalls.push(request);
    return Promise.resolve({ ok: true, value: { deleted: true, sessionId: request.sessionId } });
  },
});
check('an accepted request stores the caller, the title and the callback', dialog.request({
  sessionId: 'session-from-pane',
  displayTitle: '平铺窗格里的会话',
  onDeleted: (sessionId) => {
    notified = sessionId;
  },
}) === true);
const pending = dialogProps().requestStore.getSnapshot();
check('the pending deletion carries the requested session and title', pending.sessionId === 'session-from-pane' && pending.displayTitle === '平铺窗格里的会话');
check('the pending deletion carries the caller callback', typeof pending.onDeleted === 'function');

// Mount the dialog the way React would, then press its confirm button.
const tree = overlay.component({ ...dialogProps(), requestStore: dialogProps().requestStore });
const confirm = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.includes('dshSessionDelete_buttonDanger'));
check('the dialog renders one destructive confirm button', confirm.length === 1);
confirm[0].props.onClick();
for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
check('confirming calls the Host namespace with the same session', deleteCalls.length === 1 && deleteCalls[0].sessionId === 'session-from-pane' && deleteCalls[0].stopActivity === false);
check('the caller is told the session is gone', notified === 'session-from-pane');
check('the pending deletion is cleared afterwards', dialogProps().requestStore.getSnapshot() === null);

let requireProfile;
try {
  requireProfile = createRequire(join(process.env.DSH_PROFILE_DIR ?? '', 'noop.js'));
  requireProfile.resolve('@deepseek-ai/dsh-api-gateway/client');
} catch {
  requireProfile = undefined;
}

if (requireProfile === undefined) {
  skip('the real Client Typert registry accepts the descriptor', 'the installed Harness is not resolvable');
  skip('the real Client Gateway mounts the namespace', 'the installed Harness is not resolvable');
} else {
  const cordis = await import(pathToFileURL(requireProfile.resolve('@deepseek-ai/cordis')).href);
  const registryModule = await loadClientBundle(requireProfile.resolve('@deepseek-ai/dsh-typert-registry/client'), (id) => {
    if (id === '@deepseek-ai/cordis') return cordis;
    throw new Error('unexpected registry require: ' + id);
  });

  const registryCtx = new cordis.Context();
  await registryModule.apply(registryCtx);
  try {
    registryCtx.typert.remotes.register(contribution);
    check('the real Client Typert registry accepts the descriptor', true);
  } catch (error) {
    check('the real Client Typert registry accepts the descriptor', false, error instanceof Error ? error.message : String(error));
  }

  // Negative control: a strict codec without the schema factory is what the
  // registry refused before this plugin worked, so the check above is not
  // passing vacuously. Its endpoint differs so the refusal can only be the codec.
  let refused = false;
  let refusal = '';
  try {
    registryCtx.typert.remotes.register({
      package: contribution.package + '.control',
      descriptors: [{
        ...descriptor,
        id: contribution.package + '.control#sessionDeleteControl/delete',
        namespace: 'sessionDeleteControl',
        parameters: [{ ...descriptor.parameters[0], codec: { mode: 'strict', typeSymbol: 'control#Request' } }],
      }],
    });
  } catch (error) {
    refused = true;
    refusal = error instanceof Error ? error.message : String(error);
  }
  check('the registry refuses a strict codec without a schema factory', refused && refusal.includes('create()'), refusal);

  // Stage 2: the real Client Gateway mounts the contribution. Its transport is
  // stubbed, so the assertion is about mounting and argument shape, not network.
  const calls = [];
  const connection = {
    rpc: {
      call: (channel, endpoint, payload) => {
        calls.push({ channel, endpoint, args: payload.args });
        return Promise.resolve({ ok: true, value: { deleted: true, sessionId: payload.args.request.sessionId } });
      },
    },
    start: () => ({ stop() {} }),
    generation: { getSnapshot: () => ({ host: { home: '/tmp' } }), subscribe: () => () => {} },
    isLoopback: true,
    registerGenerationSource: () => () => {},
  };
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    close() {}
  };
  try {
    const pageCtx = new cordis.Context();
    pageCtx.provide('connection', connection);
    await registryModule.apply(pageCtx);
    const gatewayModule = await loadClientBundle(requireProfile.resolve('@deepseek-ai/dsh-api-gateway/client'), (id) => {
      if (id === '@deepseek-ai/cordis') return cordis;
      if (id === '@deepseek-ai/dsh-typert-protocol') return requireProfile('@deepseek-ai/dsh-typert-protocol');
      if (id === '@deepseek-ai/dsh-client-store') {
        return { createSnapshotStore: () => ({ getSnapshot: () => undefined, subscribe: () => () => {}, set() {} }) };
      }
      throw new Error('unexpected gateway require: ' + id);
    });
    await gatewayModule.apply(pageCtx);
    check('the real Client Gateway mounted its remote service', pageCtx.get('remote') !== undefined);

    let mountError;
    try {
      await pageCtx.remote.$mount(contribution);
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
    }
    check('the real Client Gateway mounts the contribution', mountError === undefined, mountError);
    const service = mountError === undefined ? pageCtx.get('remote.sessionDelete') : undefined;
    check('the mounted namespace is visible through ctx.get', service !== undefined);
    if (service !== undefined) {
      const result = await service.delete({ sessionId: 'session-offline-check' });
      check('the call result passes through untouched', result !== undefined && result.ok === true && result.value.deleted === true);
      check('the call reached the wire as sessionDelete/delete', calls.length === 1 && calls[0].endpoint === 'sessionDelete/delete' && calls[0].channel === '/api');
      check('the wire args carry request.sessionId', calls.length === 1 && calls[0].args.request.sessionId === 'session-offline-check');

      // The dialog's second button sends the same endpoint with the Host's
      // `stopActivity` field, which the single JSON `request` parameter carries.
      await service.delete({ sessionId: 'session-offline-check', stopActivity: true });
      check('stopActivity travels inside the request argument', calls.length === 2 && calls[1].args.request.stopActivity === true);
    }
  } finally {
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
  }
}

// A cheap guard against the two halves drifting apart: the Host half is the same
// package and owns the service key both sides name.
const hostSource = readFileSync(join(here, '..', 'index.js'), 'utf8');
check('the Host half exports the same service key', hostSource.includes("SERVICE_KEY = 'sessionDelete'"));

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nall checks passed' + (skipped === 0 ? '' : ' (' + String(skipped) + ' skipped)'));
}
