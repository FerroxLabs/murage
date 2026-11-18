"""r8b regressions against the built r8 head. All fixtures are local."""
import importlib.util
import pathlib
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('r8tests', pathlib.Path(__file__).with_name('murage-control_test.py'))
r8 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r8)
mc = r8.mc


class Admission(r8.ControlRig):
    def test_probes_continue_during_memory_send(self):
        self.app.items = [r8.item(901)]
        self.fault('fault-journal-erofs')
        self.fault('hold-event-heartbeat')
        self.start()
        self.assertTrue(r8.wait_for(lambda: pathlib.Path(self.root, 'barrier-event_heartbeat').exists()))
        before = self.app.requests
        self.assertTrue(r8.wait_for(lambda: self.app.requests >= before + 3, timeout=2),
                        'independent intake stopped probing during the memory-only CP call')
        self.assertEqual(self.accepted_keys(), [])
        # Once local storage returns, intake must journal and ACK another item
        # while the earlier memory-only CP request remains blocked.
        self.clear('fault-journal-erofs')
        next_item = r8.item(903)
        self.app.items.append(next_item)
        self.assertTrue(r8.wait_for(lambda: next_item['id'] in (self.ack() or {}).get('acked', []), timeout=2),
                        'the slow CP request delayed admission after local recovery')
        self.assertIn(next_item['id'], r8.journal_state(self.journal)['ids'])
        self.assertEqual(self.accepted_keys(), [])

    def test_positive_hold_probes_continue_while_receipt_publication_is_pending(self):
        channel = mc.Channel(self.journal, self.ack_path, expected_uid=r8.os.getuid())
        channel.unpublished.set()
        positive = {'ok': True, 'homeEvents': {'items': [], 'outboxDegraded': 1}}
        with patch.object(mc, 'app_report', return_value=positive), patch.object(channel, 'publish_ack', return_value=False):
            for _ in range(mc.HOLD_PROBES):
                mc.intake_once(channel, '')
        self.assertTrue(channel.hold_open, 'receipt publication cannot hide three positive degradation probes')
        body = channel.events_for_body(mc.CHANNEL_TYPES, 0)
        self.assertEqual(len(body), 1, 'the owned hold does not need an app ACK and has its reserved receipt')
        self.assertEqual(body[0]['type'], r8.FAILURE)
        zero = {'ok': True, 'homeEvents': {'items': [], 'outboxDegraded': 0}}
        with patch.object(mc, 'app_report', return_value=zero), patch.object(channel, 'publish_ack', return_value=False):
            mc.intake_once(channel, '')
        self.assertTrue(channel.hold_open, 'a zero captured while publication is pending cannot end the episode')
        self.assertTrue(channel.publish_ack())
        with patch.object(mc, 'app_report', return_value=zero):
            mc.intake_once(channel, '')
        self.assertFalse(channel.hold_open, 'a fresh zero after publication completes the episode')
        if channel.fd >= 0:
            r8.os.close(channel.fd)

    def test_inflight_probe_cannot_cross_pending_ack(self):
        self.check_inflight(False)

    def test_inflight_probe_cannot_cross_published_ack(self):
        self.check_inflight(True)
        # Also start a probe after publication begins but before its file is visible.
        channel = mc.Channel(self.journal, self.ack_path, expected_uid=r8.os.getuid())
        writing, reading, finish_write, finish_reply = [threading.Event() for _ in range(4)]
        real_public = mc.atomic_public
        row = r8.item(904)
        def publish(*args):
            writing.set()
            if not finish_write.wait(3): raise RuntimeError('publication fixture deadline')
            return real_public(*args)
        def report(_):
            reading.set()
            if not finish_reply.wait(3): raise RuntimeError('probe fixture deadline')
            return {'ok': True, 'homeEvents': {'items': [row], 'outboxDegraded': 0}}
        with patch.object(mc, 'atomic_public', publish), patch.object(mc, 'app_report', report):
            writer = threading.Thread(target=channel.publish_ack)
            probe = threading.Thread(target=mc.intake_once, args=(channel, ''))
            writer.start()
            try:
                self.assertTrue(writing.wait(3))
                probe.start()
                self.assertTrue(reading.wait(3))
                finish_write.set()
                writer.join(3)
                self.assertFalse(writer.is_alive())
                finish_reply.set()
                probe.join(3)
                self.assertFalse(probe.is_alive())
            finally:
                finish_write.set(); finish_reply.set()
                writer.join(3)
                if probe.ident is not None: probe.join(3)
        self.assertNotIn(row['id'], channel.ids, 'a response begun during the ACK write still read the preceding receipt')
        if channel.fd >= 0:
            r8.os.close(channel.fd)

    def check_inflight(self, publish):
        channel = mc.Channel(self.journal, self.ack_path, expected_uid=r8.os.getuid())
        started, release = threading.Event(), threading.Event()
        row = r8.item(902)
        def report(_):
            started.set()
            self.assertTrue(release.wait(3))
            return {'ok': True, 'homeEvents': {'items': [row], 'outboxDegraded': 0}}
        with patch.object(mc, 'app_report', report):
            thread = threading.Thread(target=mc.intake_once, args=(channel, ''))
            thread.start()
            self.assertTrue(started.wait(3))
            channel.unpublished.set()
            if publish:
                self.assertTrue(channel.publish_ack())
                channel.unpublished.clear()
            release.set()
            thread.join(3)
            self.assertFalse(thread.is_alive())
        self.assertNotIn(row['id'], channel.ids, 'a probe that read the old ACK was admitted after the acceptance boundary')
        self.assertEqual(channel.degraded_probes, 0)
        channel.unpublished.clear()
        with patch.object(mc, 'app_report', return_value={'ok': True, 'homeEvents': {'items': [row], 'outboxDegraded': 1}}):
            mc.intake_once(channel, '')
        self.assertIn(row['id'], channel.ids, 'a fresh probe after publication must be admitted')
        if channel.fd >= 0:
            r8.os.close(channel.fd)

class Episode(r8.ControlRig):
    def test_completion_is_not_claimed_until_its_record_is_durable(self):
        channel = mc.Channel(self.journal, self.ack_path, expected_uid=r8.os.getuid())
        for _ in range(mc.HOLD_PROBES):
            channel.hold_tick(1)
        with patch.object(channel, 'append', return_value=False):
            channel.hold_tick(0)
            self.assertTrue(channel.hold_open, 'a failed completion append cannot close the episode')
            for _ in range(mc.HOLD_PROBES):
                channel.hold_tick(1)
            self.assertEqual(channel.episode, 1, 'undurable completion cannot create another hold')
        channel.retry()
        self.assertTrue(channel.hold_open, 'positive probes cancel an uncommitted completion')
        channel.hold_tick(0)
        self.assertFalse(channel.hold_open)
        if channel.fd >= 0:
            r8.os.close(channel.fd)

    def test_completion_survives_compaction_and_restart(self):
        # r8-passing guard: the built journal already represents completion.
        channel = mc.Channel(self.journal, self.ack_path, expected_uid=r8.os.getuid())
        for _ in range(mc.HOLD_PROBES):
            channel.hold_tick(1)
        self.assertEqual(channel.episode, 1)
        channel.hold_tick(0)
        channel.compact()
        if channel.fd >= 0:
            r8.os.close(channel.fd)
        channel = mc.Channel(self.journal, self.ack_path, expected_uid=r8.os.getuid())
        self.assertFalse(channel.hold_open, 'completion must survive compaction and restart')
        for _ in range(mc.HOLD_PROBES):
            channel.hold_tick(1)
        self.assertEqual(channel.episode, 2, 'recovery then restart must permit the next episode')
        channel.compact()
        if channel.fd >= 0:
            r8.os.close(channel.fd)
        channel = mc.Channel(self.journal, self.ack_path, expected_uid=r8.os.getuid())
        for _ in range(mc.HOLD_PROBES * 2):
            channel.hold_tick(1)
        self.assertEqual(channel.episode, 2, 'an in-episode restart must not create another episode')


class HoldCapacity(r8.ControlRig):
    def test_hold_reaches_cp_after_32_dirty_acceptances(self):
        self.app.items = [r8.item(n) for n in range(1001, 1033)]
        self.fault('fault-journal-erofs')
        self.start()
        self.assertTrue(r8.wait_for(lambda: len(set(self.accepted_keys())) == 32), 'setup must fill the ordinary dirty limit')
        self.fault('hold-heartbeat')
        # Keep another failure and another restore pending while the hold is detected.
        # The hold owns its slot and cannot be displaced by the app failure slot.
        extra = r8.item(1100)
        app_failure = r8.item(1101, r8.FAILURE)
        self.app.items.extend([extra, app_failure])
        self.app.degraded = 2
        before = self.app.requests
        self.assertTrue(r8.wait_for(lambda: self.app.requests >= before + 8))
        app_failure = {**r8.item(1102, r8.FAILURE), 'at': r8.BASE_AT + 1_000_000}
        self.app.items.append(app_failure)
        before = self.app.requests
        self.assertTrue(r8.wait_for(lambda: self.app.requests >= before + 3))
        self.clear('hold-heartbeat')
        holds = lambda: [k for k in self.accepted_keys() if k[0] == r8.FAILURE and k[1] != app_failure['at']]
        self.assertTrue(r8.wait_for(lambda: len(holds()) == 1), 'DIRTY_MAX blocked the owned hold alert')
        before = len(self.bodies())
        self.assertTrue(r8.wait_for(lambda: len(self.bodies()) >= before + 5))
        accepted = set(self.accepted_keys())
        self.assertEqual(len(accepted), 33, '32 ordinary dirty keys plus exactly one reserved hold')
        self.assertNotIn((extra['type'], extra['at']), accepted, 'the reserved slot cannot carry ordinary traffic')
        self.assertNotIn((app_failure['type'], app_failure['at']), accepted, 'the ordinary failure slot cannot consume the hold reservation')
        self.app.degraded = 0
        before = self.app.requests
        self.assertTrue(r8.wait_for(lambda: self.app.requests >= before + 4))
        self.app.degraded = 2
        before = self.app.requests
        self.assertTrue(r8.wait_for(lambda: self.app.requests >= before + 4))
        self.assertEqual(len(holds()), 1, 'undurable completion must retain the same reserved hold')
        self.clear('fault-journal-erofs')
        self.assertTrue(r8.wait_for(lambda: (extra['type'], extra['at']) in self.accepted_keys()), 'ordinary traffic resumes after durable flush')
        records = r8.read_records(self.journal)[0]
        sent = [(op['type'], op['at']) for rec in records for op in rec if op['r'] == 'sent']
        self.assertEqual(sent[:33], self.accepted_keys()[:33], 'the reserved hold preserves the acceptance prefix')


class LossBound(r8.ControlRig):
    def test_app_keys_e2_before_old_control_ends(self):
        # Bound PIN: both real writers end, with E2 keyed between their endings.
        repo = r8.HERE.parent.parent
        app_dir = pathlib.Path(self.root, 'app')
        app_dir.mkdir()
        (app_dir / 'ctl').mkdir()
        (app_dir / 'events').mkdir()
        (app_dir / 'ctl' / 'outbox-erofs').write_text('')
        env = dict(r8.os.environ, VITEST='1', NODE_ENV='test', MURAGE_TRUSTED_PROXY='1',
                   J5B_CTL=str(app_dir / 'ctl'), J5B_HOME_EVENTS_TS=str(repo / 'server/home-events.ts'),
                   J5B_STUCK_MARKER=str(app_dir / 'stuck'), MURAGE_HOME_EVENTS_DIR=str(app_dir / 'events'),
                   MURAGE_HOME_EVENTS_OUTBOX=str(app_dir / 'home-events.outbox'),
                   MURAGE_HOME_EVENTS_ACK_FILE=self.ack_path, MURAGE_HOME_EVENTS_ACK_UID=str(r8.os.getuid()))
        def app_start():
            proc = r8.subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', str(repo / 'server/cloud-home/testdata/j5b-home-child.mjs')],
                                      env=env, stdin=r8.subprocess.PIPE, stdout=r8.subprocess.PIPE, stderr=r8.subprocess.PIPE, text=True)
            self.procs.append(proc)
            import select
            self.assertTrue(select.select([proc.stdout], [], [], 5)[0], 'app fixture startup deadline')
            self.assertTrue(r8.json.loads(proc.stdout.readline())['ready'])
            return proc
        def call(proc, **cmd):
            import select
            proc.stdin.write(r8.json.dumps(cmd) + '\n')
            proc.stdin.flush()
            self.assertTrue(select.select([proc.stdout], [], [], 5)[0], 'app fixture response deadline')
            response = r8.json.loads(proc.stdout.readline())
            self.assertTrue(response['ok'])
            return response
        pathlib.Path(self.ack_path).write_text(r8.json.dumps({'v': 1, 'control': 1, 'acked': [], 'accepted': []}))
        app = app_start()
        e1, e2 = r8.item(1201), {**r8.item(1202), 'at': r8.item(1201)['at']}
        call(app, cmd='report', **e1)
        self.app.items = call(app, cmd='health')['body']['homeEvents']['items']
        self.assertEqual(self.app.items, [e1])
        self.fault('fault-journal-erofs')
        control = self.start()
        key = (e1['type'], e1['at'])
        self.assertTrue(r8.wait_for(lambda: key in self.accepted_keys()))
        self.fault('hold-intake')
        self.kill(app)
        app = app_start()
        call(app, cmd='report', **e2)
        e2_fields = call(app, cmd='health')['body']['homeEvents']
        self.assertEqual(e2_fields['items'], [e2], 'E2 is keyed at E1 time before old control ends')
        self.assertIsNone(control.poll(), 'the old control must still be alive when E2 is keyed')
        self.assertEqual(r8.journal_state(self.journal)['adds'], [], 'E1 was memory-only at control')
        self.app.items = e2_fields['items']
        self.kill(control)
        self.clear('hold-intake')
        self.clear('fault-journal-erofs')
        self.start()
        self.assertTrue(r8.wait_for(lambda: self.accepted_keys().count(key) == 2),
                        'interleaved endings reuse E1 key; CP retains and suppresses that key')


if __name__ == '__main__':
    unittest.main()
