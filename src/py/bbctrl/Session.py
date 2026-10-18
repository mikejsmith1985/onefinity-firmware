################################################################################
#                                                                              #
#                    Shared screen session for every browser                   #
#                                                                              #
################################################################################
#
# The controller is used from several screens at once: the touchscreen at the
# machine, a PC and a phone.  Machine state was always shared, but dialogs,
# wizard steps and error popups lived in each browser.  This module keeps that
# "screen session" on the controller so every screen shows the same thing.
#
# The session is a small set of named values, published in the live state as
# 'ui' = {name: {'v': value, 'rev': n}}.  A write may name the revision it was
# based on (compare-and-set).  If another screen got there first the write is
# refused and the caller gets the current value back.  Wizards use this so a
# step that sends G-code (a probe, a move) runs on exactly one screen even when
# Next is pressed on two screens at once.
#
# Values live in memory only: a restart starts a clean session, the same as
# closing every browser.  Durable documents (settings, notes, history) stay in
# the next-store files; 'store_rev' in the live state tells every screen when
# one of them changed so it can re-read it straight away.
#
# Errors are published too: 'last_error' = {'id', 'msg'} for the newest error
# in the log, so OK on one screen ('err_ack' in the session) clears it on all.

import json
import time


MAX_VALUE_BYTES = 128 * 1024
MAX_TOTAL_BYTES = 512 * 1024
NAME_CHARS = set('abcdefghijklmnopqrstuvwxyz0123456789-_.')


class Session(object):
    def __init__(self, ctrl):
        self.ctrl = ctrl
        self.values = {}   # name -> {'v': value, 'rev': n, 'at': t}
        self.store_revs = {}
        self.error_id = 0
        self._tombs = {}   # name -> last revision, kept after a clear

        ctrl.state.set('ui', {})
        ctrl.state.set('store_rev', {})
        ctrl.state.set('last_error', None)

        try: ctrl.log.add_listener(self._on_log)
        except Exception: pass


    @staticmethod
    def valid_name(name):
        return (isinstance(name, str) and 0 < len(name) <= 40 and
                all(c in NAME_CHARS for c in name))


    def _publish(self):
        # A new dict every time: the state only broadcasts values that changed.
        self.ctrl.state.set('ui', {k: {'v': e['v'], 'rev': e['rev']}
                                   for k, e in self.values.items()})


    def get(self, name):
        e = self.values.get(name)
        return {'v': e['v'], 'rev': e['rev']} if e else {'v': None, 'rev': 0}


    def put(self, name, value, rev = None):
        '''Set a value.  With rev, only if the current revision is rev.

        Returns (ok, {'v', 'rev'}): the new entry, or the current one when
        the write was refused.  A value of None clears the entry, but its
        revision keeps counting so a stale write can never bring it back.'''

        if not self.valid_name(name): raise ValueError('Bad session name')

        size = len(json.dumps(value))
        if MAX_VALUE_BYTES < size: raise ValueError('Session value too large')

        cur = self.values.get(name)
        cur_rev = cur['rev'] if cur else self._tomb_rev(name)

        if rev is not None and int(rev) != cur_rev:
            return False, self.get(name) if cur else {'v': None, 'rev': cur_rev}

        total = size + sum(len(json.dumps(e['v'])) for k, e in
                           self.values.items() if k != name)
        if MAX_TOTAL_BYTES < total: raise ValueError('Session is full')

        new_rev = cur_rev + 1
        self._tombs[name] = new_rev
        if value is None: self.values.pop(name, None)
        else: self.values[name] = {'v': value, 'rev': new_rev, 'at': time.time()}

        self._publish()
        return True, {'v': value, 'rev': new_rev}


    # Revisions of cleared entries, so compare-and-set stays correct across
    # a clear and a re-open.
    def _tomb_rev(self, name): return self._tombs.get(name, 0)


    def store_changed(self, name):
        '''A next-store document was written: tell every screen.'''
        self.store_revs = dict(self.store_revs)
        self.store_revs[name] = self.store_revs.get(name, 0) + 1
        self.ctrl.state.set('store_rev', self.store_revs)


    def _on_log(self, msg):
        log = msg.get('log') if isinstance(msg, dict) else None
        if not log or log.get('level') not in ('error', 'critical'): return
        self.error_id += 1
        self.ctrl.state.set('last_error', {'id': self.error_id,
                                           'msg': log.get('msg', ''),
                                           'at': time.time()})
