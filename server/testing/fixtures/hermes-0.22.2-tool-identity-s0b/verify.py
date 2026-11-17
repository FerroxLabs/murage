"""Offline S0b evidence contract. Run in the isolated test container."""
import json
import hashlib
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent


def read(name):
    return json.loads((ROOT / name).read_text())


def wire():
    return [dict(json.loads(line), wireLine=n) for n, line in
            enumerate((ROOT / 'frames.jsonl').read_text().splitlines(), 1)]


def messages(scenario):
    return [(e['wireLine'], json.loads(e['line'])) for e in wire()
            if e['direction'] == 'stdout' and e['scenario'] == scenario]


def starts(scenario):
    return [(n, m['params']['update']) for n, m in messages(scenario)
            if m.get('params', {}).get('update', {}).get('sessionUpdate') == 'tool_call']


class Evidence(unittest.TestCase):
    def test_G1_video(self):
        start, = starts('video-analyze')
        self.assertEqual(start[1]['title'], 'video_analyze')
        self.assertEqual(start[1]['kind'], 'other')
        self.assertEqual(start[1]['rawInput'], read('scenarios.json')[0]['input'])

    def test_G2_unregistered(self):
        responses = [json.loads(s) for s in (ROOT / 'model-responses.jsonl').read_text().splitlines()]
        for scenario, name in [('unregistered-memory', 'memory: x'), ('unregistered-zz', 'zz')]:
            with self.subTest(name=name):
                calls = [r['response']['choices'][0]['message'].get('tool_calls', [])
                         for r in responses if r['scenario'] == scenario]
                self.assertEqual(calls[0][0]['function']['name'], name)
                self.assertTrue(any(m.get('result', {}).get('stopReason') == 'end_turn'
                                    for _, m in messages(scenario)))
                if name == 'zz':
                    self.assertEqual(starts(scenario), [])
                else:
                    start, = starts(scenario)
                    self.assertTrue(start[1]['title'].startswith('memory: '))
                    self.assertEqual(start[1]['kind'], 'other')
                    self.assertFalse(any(m.get('method') == 'session/request_permission'
                                         for _, m in messages(scenario)))
                    end, = [m['params']['update'] for _, m in messages(scenario)
                            if m.get('params', {}).get('update', {}).get('toolCallId') == start[1]['toolCallId']
                            and m['params']['update'].get('status') == 'completed']
                    self.assertIn('saved', end['content'][0]['content']['text'])
        requests = [json.loads(s) for s in (ROOT / 'model-requests.jsonl').read_text().splitlines()]
        unknown = next(m for r in requests if r['scenario'] == 'unregistered-zz' and r['request'] == 2
                       for m in r['tool_results'] if m['tool_call_id'] == 'stub-unregistered-zz')
        self.assertIn("Tool 'zz' does not exist", unknown['content'])

    def test_G3_execute_code(self):
        start, = starts('execute-code-terminal')
        self.assertEqual(start[1]['kind'], 'execute')
        asks = [(n, m['params']['toolCall']) for n, m in messages('execute-code-terminal')
                if m.get('method') == 'session/request_permission']
        self.assertTrue(asks)
        self.assertEqual(asks[0][1]['rawInput']['command'], '<execute_code> (plugin approval rule)')
        self.assertLess(asks[0][0], start[0])
        self.assertEqual(len(asks), 3)
        self.assertEqual(asks[1][1]['rawInput']['command'], '<terminal> (plugin approval rule)')
        self.assertEqual(asks[2][1]['rawInput'], {
            'command': "python3 -c 'print(42)'", 'description': 'script execution via -e/-c flag',
        })
        self.assertLess(start[0], asks[1][0])
        self.assertLess(asks[1][0], asks[2][0])
        self.assertTrue(start[1]['title'].startswith('execute_code: '))
        completed, = [(n, m['params']['update']) for n, m in messages('execute-code-terminal')
                      if m.get('params', {}).get('update', {}).get('toolCallId') == start[1]['toolCallId']
                      and m['params']['update'].get('status') == 'completed']
        self.assertLess(asks[2][0], completed[0])
        self.assertIn("'output': '42'", completed[1]['content'][0]['content']['text'])
        # The harmless whole-script call has only the Murage hook ask.
        self.assertEqual(sum(m.get('method') == 'session/request_permission'
                             for _, m in messages('execute-code-plain')), 1)

    def test_G4_codex(self):
        hooks = [json.loads(s) for s in (ROOT / 'codex-hooks.jsonl').read_text().splitlines()]
        self.assertEqual([h['tool_name'] for h in hooks], ['Bash', 'Bash', 'mcp__s0b__echo'])
        self.assertEqual([h['tool_use_id'] for h in hooks], ['call-0', 'call-1', 'call-2'])
        self.assertTrue(all(h['hook_event_name'] == 'PreToolUse' for h in hooks))
        self.assertEqual(hooks[0]['tool_input'], {'command': 'printf s0b-codex'})
        self.assertEqual(hooks[2]['tool_input'], {'text': 's0b-codex-echo'})
        self.assertEqual(read('codex-workspace-after.json')['proof.txt'], 's0b\n')
        frames = [json.loads(json.loads(s)['line']) for s in (ROOT / 'codex-frames.jsonl').read_text().splitlines()]
        starts = [m['params']['item'] for m in frames if m.get('method') == 'item/started']
        self.assertTrue({'commandExecution', 'fileChange', 'mcpToolCall'} <= {i['type'] for i in starts})
        self.assertEqual(next(i for i in starts if i['id'] == hooks[1]['tool_use_id'])['type'], 'fileChange')
        for m in frames:
            if m.get('id') == 4 and 'result' in m:
                self.assertEqual(m['result']['data'][0]['hooks'][0]['trustStatus'], 'trusted')

    @unittest.skip('G5 OPEN: actual gate-box installation/stamp was not supplied; no equivalence claim')
    def test_G5_gate_binary(self):
        pass

    def test_ISOLATION(self):
        self.assertEqual(read('runtime.json')['interfaces'], ['lo'])
        self.assertIn('v0.22.2', read('runtime.json')['version_stdout'])
        self.assertEqual(read('codex-runtime.json')['interfaces'], ['lo'])

    def test_HASHES(self):
        provenance = read('PROVENANCE.json')
        self.assertEqual(provenance['gates']['G2']['status'], 'FALLBACK_B_REQUIRED')
        self.assertEqual(provenance['gates']['G5']['status'], 'OPEN')
        for name, digest in provenance['files'].items():
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest, name)
        self.assertEqual((ROOT / 'ask-hook.cjs').read_bytes(),
                         (ROOT.parent / 'hermes-0.22.2-tool-identity' / 'ask-hook.cjs').read_bytes())


if __name__ == '__main__':
    unittest.main(verbosity=2)
