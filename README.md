English | [中文](README.zh-CN.md)

# dsh-session-delete

Local DSH bundle: a **Delete session** row in the sidebar session menu that
permanently removes one Session.

## What it adds

- A `sidebar.workspaces.session.menu.item` row (`id: session-delete`, order 500,
  right after the shipped `archive` row) in every Session's "…" menu.
- A `shell.overlay` confirmation dialog naming the Session, because the action is
  irreversible.
- One Host operation, exposed to the browser over the Typert Gateway as the
  Remote endpoint `sessionDelete/delete`.

## Behaviour

- Confirming removes the Session's durable log directory from disk
  (`$DSH_HOME/sessions/<project>/<session-id>/`), then clears the derived state
  that would keep listing it: the `session_projcache` file, the pin membership,
  and the owning workspace's `sessionIds` accounting.
- The sidebar row disappears immediately: the workspace accounting change
  arrives on the existing Workspace stream, and the Client Session list is told
  about the removal (`handleSessionRemoved` plus a baseline `refresh`).
- **Live is not running.** A Session that was merely opened once keeps a live
  Agent (and its log write handle) for as long as the Host process runs, so the
  old "this Session is in use" refusal disabled the button for almost every row.
  A live but idle Session is now deleted: first archived durably — the documented
  wake block, since the `agent/pre-step` gate reads the durable archive set — so
  a queued wake, a goal round, or a schedule tick cannot append into the removed
  log and resurrect it. That archival id is deliberately left behind as a
  tombstone for exactly that reason; a Session with no live Agent is simply
  unarchived instead.
- Only an actually **running** Session is refused, and the dialog then offers
  **Stop and delete**: the work is cancelled the way the user's own stop does
  and the deletion proceeds once the Agent is quiescent, so no in-flight drain
  recreates the file being removed.
- An already-vanished Session resolves as `missing`; the dialog treats that as
  done and clears the stale row.

## Notes and limits

- There is no Harness Session-deletion primitive: session persistence only
  creates, opens, stats, and lists logs, and archiving only hides a Session. This
  plugin therefore deletes the artifacts itself and stops at the one thing it
  cannot do safely — deleting under a Session that is producing work right now.
- Deleting the Session you are currently looking at leaves its open conversation
  view pointing at a log that no longer exists; the archived gate keeps that
  still-resident Agent from doing anything, and the row is gone after the
  refresh. Switch away first if the view matters.
- The marker `guarded: true` in the Host outcome means the Session had a live
  Agent, so archival protected the deletion; `missing` means no log was found.
- Attachments referenced by the Session are content-addressed and shared with
  other Sessions; they are left alone.
- The search index (`dsh-session-query-sqlite`) drops the vanished log on its own
  reconciliation.
- A hand-authored bundle cannot `import` `@deepseek-ai/*` packages: the profile
  links this directory, Node resolves the linked package's real path, and the dsh
  installation is not on that path. The Host half therefore writes the Typert
  marker and `typertRemote` binding by hand (what `@Remote(...)` plus
  `TypertRemoteService` normally produce) and registers the value with
  `ctx.provide`; the Client half hand-writes the matching `InvocationDescriptor`
  for `ctx.remote.$mount`.
- That hand-written descriptor must satisfy two Client rules at once: the Gateway
  mount requires every input codec to be `strict`, and the Client Typert registry
  additionally requires a strict codec to carry a `create()` schema factory. The
  input codec therefore ships a permissive pass-through factory that nothing
  re-validates — the Host operation checks its own input. Dropping `create` makes
  the mount reject and the dialog report that deletion is not ready.

## Files

- `index.js` — the Host half: the deletion operation, its refusals, and the
  hand-written Remote binding.
- `client.js` — the Client half: menu row, confirmation dialog, Remote mount.
- `cordis.patch.yml` — inserts the single Host row.
- `locale/{en,zh}.json` — Plugin Manager display metadata.
- `icon.svg` — Plugin Manager artwork.

## Tests

All three run offline against the installed Harness and use only temporary
directories:

- `node test/delete-contract.mjs` — the operation's own semantics against a fake
  Context: the running refusal, the archival guard (and its tombstone) for a live
  Agent, directory discovery, removal, cleanup steps, and the Remote
  marker/binding shape.
- `node test/client-mount.mjs` — loads `client.js` through the browser module
  loader, then validates the captured `$mount` contribution with the **real**
  Client Typert registry and mounts it on the **real** Client Gateway (stubbed
  transport), asserting that the namespace becomes visible to `ctx.get` and that
  calls reach the wire as `sessionDelete/delete` with `request.sessionId` and
  `request.stopActivity`. It includes a negative control proving the registry
  rejects a strict codec without a schema factory.
- `node test/host-endpoint.mjs` — drives the **real** Host Gateway's `invoke()`
  against the real registry, so the hand-written SRC discovery path is exercised
  for the plain, missing, refused-running, and stop-and-delete cases, and the
  Session log directory is really removed.

Each test skips its Harness-dependent checks (with the reason printed) when
`@deepseek-ai/*` cannot be resolved from `$DSH_PROFILE_DIR`.

## Development

A profile links this directory (`link:` in the profile's `package.json`). The
Client half is served from disk, so editing `client.js` is live after a page
reload. The Host half is a Node module imported once by the Loader, and since no
module roots are watched (`hmr.config.root: []`), **editing `index.js` takes
effect only after the Harness process restarts** — re-mounting the row re-runs
the cached module, it does not re-read the file.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).

