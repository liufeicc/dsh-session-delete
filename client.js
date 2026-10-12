/**
 * Client half of the session-delete bundle.
 *
 * It contributes two slots and one Remote namespace:
 *   - a `sidebar.workspaces.session.menu.item` row (id `session-delete`,
 *     order 500, right after the shipped `archive` row) that asks for
 *     confirmation,
 *   - a `shell.overlay` dialog that names the Session and performs the
 *     deletion,
 *   - the `sessionDelete` Remote namespace of this package's Host half,
 *     mounted through `ctx.remote.$mount` with a hand-written descriptor: the
 *     Host side is a source-mode Service, so an explicitly strict input codec
 *     (the Client mount requirement) carries no schema work.
 *
 * After a successful deletion the Client Session list is told about it, so the
 * row disappears immediately instead of waiting for the next baseline pull;
 * the workspace accounting change arrives on the existing Workspace stream.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;

    /** Package identity: module id, Remote package name, and CSS tag identity. */
    const PLUGIN_ID = '@local/dsh-session-delete';
    /** Slot keys this plugin contributes to. */
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    const OVERLAY_SLOT = 'shell.overlay';
    /** Remote namespace/service key of the Host operation. */
    const SERVICE_KEY = 'sessionDelete';
    /** Locale namespace owned by this plugin. */
    const NS = 'session-delete';
    /** Identity of the injected stylesheet. */
    const CSS_ID = PLUGIN_ID + '/client.css';

    const CSS = [
      '.dshSessionDelete_itemWrap{position:relative}',
      '.dshSessionDelete_item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
      '.dshSessionDelete_item:hover:not(:disabled),.dshSessionDelete_item:focus-visible:not(:disabled){background:var(--dsw-alias-bg-layer-1);outline:none}',
      '.dshSessionDelete_item:disabled{opacity:.4;cursor:not-allowed}',
      '.dshSessionDelete_itemDanger{color:var(--dsw-alias-state-error-primary)}',
      '.dshSessionDelete_itemIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}',
      '.dshSessionDelete_itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshSessionDelete_overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}',
      '.dshSessionDelete_mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35))}',
      '.dshSessionDelete_dialog{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:min(400px,100%);padding:22px 24px 20px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.32)}',
      '.dshSessionDelete_title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.dshSessionDelete_desc{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.dshSessionDelete_note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshSessionDelete_error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-word}',
      '.dshSessionDelete_footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:4px}',
      '.dshSessionDelete_button{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}',
      '.dshSessionDelete_button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
      '.dshSessionDelete_button:disabled{opacity:.4;cursor:not-allowed}',
      '.dshSessionDelete_buttonDanger{color:var(--dsw-alias-state-error-primary)}',
      '.dshSessionDelete_buttonDanger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
    ].join('');

    /** Class-name table for the injected stylesheet. */
    const css = {
      itemWrap: 'dshSessionDelete_itemWrap',
      item: 'dshSessionDelete_item',
      itemDanger: 'dshSessionDelete_itemDanger',
      itemIcon: 'dshSessionDelete_itemIcon',
      itemLabel: 'dshSessionDelete_itemLabel',
      overlay: 'dshSessionDelete_overlay',
      mask: 'dshSessionDelete_mask',
      dialog: 'dshSessionDelete_dialog',
      title: 'dshSessionDelete_title',
      desc: 'dshSessionDelete_desc',
      note: 'dshSessionDelete_note',
      error: 'dshSessionDelete_error',
      footer: 'dshSessionDelete_footer',
      button: 'dshSessionDelete_button',
      buttonDanger: 'dshSessionDelete_buttonDanger',
    };

    const zh = {
      'menu.deleteSession': '删除会话',
      'dialog.title': '删除会话',
      'dialog.desc': '确定要永久删除“{title}”吗？',
      'dialog.descUntitled': '确定要永久删除这个会话吗？',
      'dialog.note': '会话记录会从磁盘上删除，无法恢复；已归档、已置顶的状态一并清除。',
      'dialog.confirm': '删除',
      'dialog.cancel': '取消',
      'dialog.busy': '正在删除…',
      'dialog.stopAndDelete': '停止并删除',
      'dialog.stopping': '正在停止…',
      'dialog.notMounted': '删除功能还没准备好，请刷新页面后再试。',
      'dialog.failed': '删除失败',
      'reason.running': '这个会话正在运行，需要先停止它。',
      'reason.invalid': '会话标识无效。',
      'reason.missing': '磁盘上已经找不到这个会话的记录。',
    };

    const en = {
      'menu.deleteSession': 'Delete session',
      'dialog.title': 'Delete session',
      'dialog.desc': 'Permanently delete “{title}”?',
      'dialog.descUntitled': 'Permanently delete this session?',
      'dialog.note': 'Its log is removed from disk and cannot be restored; archive and pin state go with it.',
      'dialog.confirm': 'Delete',
      'dialog.cancel': 'Cancel',
      'dialog.busy': 'Deleting…',
      'dialog.stopAndDelete': 'Stop and delete',
      'dialog.stopping': 'Stopping…',
      'dialog.notMounted': 'Deletion is not ready yet — reload the page and try again.',
      'dialog.failed': 'Deleting failed',
      'reason.running': 'This session is running, so its work has to be stopped first.',
      'reason.invalid': 'The session identity is invalid.',
      'reason.missing': 'No durable record of this session is left on disk.',
    };

    /**
     * The one Remote method of this package: the Host `delete` operation.
     *
     * Two Client-side rules shape this descriptor. `ctx.remote.$mount` insists
     * that every input codec be `strict` (a plugin's own wire input is never
     * validated by a generated schema), while the Client Typert registry demands
     * that a strict codec also expose a `create()` schema factory — so the input
     * carries a permissive pass-through factory. Nothing re-validates the value
     * with it: the args travel to the Host as written, and the Host operation
     * checks its input itself. The result needs no codec work (SRC JSON).
     */
    const REMOTE_DESCRIPTORS = [{
      id: PLUGIN_ID + '#sessionDelete/delete',
      service: SERVICE_KEY,
      namespace: SERVICE_KEY,
      method: 'delete',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: PLUGIN_ID + '#DeleteSessionRequest',
          create: () => ({ parse: (value) => value }),
        },
      }],
      result: { mode: 'src-json' },
    }];

    /** Small trash glyph for the menu row. */
    function TrashIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M3 5h10M6.5 5V3.5h3V5M5 5l.6 8h4.8L11 5M6.8 7.2v4M9.2 7.2v4',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    /** Minimal snapshot store: the pending deletion, shared by row and dialog. */
    function createSnapshotStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set: (next) => {
          if (next === snapshot) return;
          snapshot = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /**
     * One row of a Session's "..." menu: ask for confirmation, never delete here.
     * @param props - the row's Session, the slot's menu state, and the opener.
     * @returns one `role="menuitem"` button.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState();
      return h('div', { className: css.itemWrap },
        h('button', {
          type: 'button',
          role: 'menuitem',
          className: css.item + ' ' + css.itemDanger,
          onClick: () => {
            setMenuOpen(false);
            requestDelete(sessionId, displayTitle);
          },
        },
          h('span', { className: css.itemIcon }, TrashIcon()),
          h('span', { className: css.itemLabel }, t('menu.deleteSession'))));
    }

    /** The dialog's own copy of one refusal or failure. */
    function reasonText(reason, t) {
      if (reason === 'running' || reason === 'invalid' || reason === 'missing') return t('reason.' + reason);
      return t('dialog.failed') + (reason === undefined ? '' : ': ' + String(reason));
    }

    /**
     * The `shell.overlay` entry: nothing while no deletion is pending,
     * otherwise the confirmation for that Session. A Session whose Agent is
     * running comes back as `running`, and the dialog then offers the stopping
     * path instead of a dead end.
     * @param props - the pending-deletion store, the Host operation, and the locale seat.
     * @returns the dialog, or null.
     */
    function DeleteConfirmDialog({ requestStore, deleteSession, getSessions, t }) {
      const request = useSyncExternalStore(requestStore.subscribe, requestStore.getSnapshot);
      const [busy, setBusy] = useState(false);
      const [stopping, setStopping] = useState(false);
      const [error, setError] = useState(null);
      const target = request === null ? null : request.sessionId;
      const dialogRef = useRef(null);

      useEffect(() => {
        setBusy(false);
        setStopping(false);
        setError(null);
      }, [target]);

      const close = useCallback(() => {
        if (!busy) requestStore.set(null);
      }, [busy, requestStore]);

      useEffect(() => {
        if (target === null) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          close();
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [target, close]);

      useEffect(() => {
        if (target === null) return;
        const node = dialogRef.current;
        if (node !== null && typeof node.focus === 'function') node.focus();
      }, [target]);

      if (request === null) return null;

      /**
       * Run one deletion attempt.
       * @param stopActivity - whether the Host may stop running work first.
       */
      const run = (stopActivity) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        deleteSession(request.sessionId, stopActivity).then((outcome) => {
          if (outcome.deleted !== true && outcome.reason !== 'missing') {
            setBusy(false);
            setStopping(outcome.reason === 'running');
            setError(reasonText(outcome.reason, t));
            return;
          }
          const sessions = getSessions();
          if (sessions !== undefined) {
            if (typeof sessions.handleSessionRemoved === 'function') sessions.handleSessionRemoved(request.sessionId);
            if (typeof sessions.refresh === 'function') Promise.resolve(sessions.refresh()).catch(() => {});
          }
          requestStore.set(null);
        }).catch((reason) => {
          setBusy(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      };

      const title = request.displayTitle === undefined || request.displayTitle === '' ? t('dialog.descUntitled') : t('dialog.desc', { title: request.displayTitle });

      return h('div', { className: css.overlay },
        h('div', { className: css.mask, onClick: close, 'aria-hidden': true }),
        h('div', {
          className: css.dialog,
          role: 'alertdialog',
          'aria-modal': true,
          'aria-label': t('dialog.title'),
          tabIndex: -1,
          ref: dialogRef,
        },
          h('h2', { className: css.title }, t('dialog.title')),
          h('p', { className: css.desc }, title),
          h('p', { className: css.note }, t('dialog.note')),
          error === null ? null : h('p', { className: css.error, role: 'alert' }, error),
          h('div', { className: css.footer },
            h('button', { type: 'button', className: css.button, disabled: busy, onClick: close }, t('dialog.cancel')),
            stopping
              ? h('button', {
                  type: 'button',
                  className: css.button + ' ' + css.buttonDanger,
                  disabled: busy,
                  onClick: () => run(true),
                }, busy ? t('dialog.stopping') : t('dialog.stopAndDelete'))
              : h('button', {
                  type: 'button',
                  className: css.button + ' ' + css.buttonDanger,
                  disabled: busy,
                  onClick: () => run(false),
                }, busy ? t('dialog.busy') : t('dialog.confirm')))));
    }

    /** Client half: stylesheet, dictionaries, the Remote namespace, row and dialog. */
    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']');
        if (existing !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = CSS_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'session-delete: styles');

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-delete: dictionaries');
      const t = ctx.locale.bind(NS);

      /**
       * The mount outcome, kept so an unavailable namespace can explain itself
       * instead of only saying "not ready".
       */
      let mountFailure = null;

      ctx.effect(() => {
        let disposed = false;
        let unmount;
        ctx.remote.$mount({ package: PLUGIN_ID, descriptors: REMOTE_DESCRIPTORS }).then((dispose) => {
          if (disposed) void dispose();
          else {
            unmount = dispose;
            mountFailure = null;
          }
        }, (error) => {
          mountFailure = error instanceof Error ? error.message : String(error);
          console.error('[session-delete] mounting the Host namespace failed:', error);
        });
        return () => {
          disposed = true;
          if (unmount !== undefined) void unmount();
        };
      }, 'session-delete: Host namespace');

      const requestStore = createSnapshotStore(null);

      /**
       * Run the Host deletion and unwrap the Remote result.
       * @param sessionId - the Session to remove.
       * @param stopActivity - whether the Host may stop running work first.
       */
      const deleteSession = async (sessionId, stopActivity) => {
        const service = ctx.get('remote.' + SERVICE_KEY);
        if (service === undefined) {
          throw new Error(mountFailure === null ? t('dialog.notMounted') : t('dialog.notMounted') + ' — ' + mountFailure);
        }
        const result = await service.delete({ sessionId, stopActivity: stopActivity === true });
        if (result.ok !== true) throw new Error(result.error === undefined ? t('dialog.failed') : result.error.message);
        return result.value;
      };

      ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
        name: MENU_SLOT,
        id: 'session-delete',
        order: 500,
        locale: NS,
        inject: () => ({
          requestDelete: (sessionId, displayTitle) => {
            requestStore.set({ sessionId, displayTitle: displayTitle ?? '' });
          },
        }),
      }, DeleteSessionMenuItem));

      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: 'session-delete.confirm',
        locale: NS,
        inject: () => ({
          requestStore,
          deleteSession,
          getSessions: () => ctx.get('sessions'),
        }),
      }, DeleteConfirmDialog));
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      apply,
    };
  },
});
