#!/usr/bin/env python3
"""Require completed differential and benign measurements before accepting proof."""
import argparse
import json
import pathlib


def summarize(shards):
    fields = ('inputs', 'unsafe', 'benign_inputs', 'benign_overstrict',
              'corpus_mutations', 'grammar', 'port_gate_comparisons')
    assert shards, 'no shards'
    assert len({shard['input_sha256'] for shard in shards}) == len(shards), 'duplicate shard'
    for shard in shards:
        assert all(type(shard[k]) is int and shard[k] >= 0 for k in fields)
        assert shard['network'] == 'none', 'network isolation missing'
        assert shard.get('comparison') == 'reader-priority', 'reader priority comparison missing'
        assert shard.get('widened_target_positions') == 7, 'target grammar not widened'
        if shard['inputs']:
            assert set(shard.get('target_positions', {})) == {'loop','assignment','with-as','except-as','import-as','del','augmented'}
            assert all(value > 0 for value in shard['target_positions'].values())
        assert shard['port_gate_comparisons'] == shard['inputs'] + shard['benign_inputs']
        assert shard['grammar'] + shard['corpus_mutations'] == shard['inputs']
        assert shard['benign_overstrict'] <= shard['benign_inputs']
        assert shard['oracle_sha256'] == shards[0]['oracle_sha256'], 'oracle changed'
        assert shard['port_sha256'] == shards[0]['port_sha256'], 'port changed'
        assert shard['generator_sha256'] == shards[0]['generator_sha256'], 'generator changed'
    total = {key: sum(shard[key] for shard in shards) for key in fields}
    total['total_inputs'] = total['inputs'] + total['benign_inputs']
    total['target_positions'] = {key: sum(shard.get('target_positions', {}).get(key,0) for shard in shards) for key in ['loop','assignment','with-as','except-as','import-as','del','augmented']}
    total['over_strict_rate'] = (total['benign_overstrict'] / total['benign_inputs']
                                if total['benign_inputs'] else None)
    total['accepted'] = (total['inputs'] >= 2_000_000 and total['unsafe'] == 0
                         and total['benign_inputs'] >= 100_000
                         and total['over_strict_rate'] is not None
                         and total['over_strict_rate'] < .01)
    return total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('shards', nargs='+')
    args = parser.parse_args()
    shards = [json.loads(pathlib.Path(path).read_text()) for path in args.shards]
    total = summarize(shards)
    report = dict(total, shard_paths=args.shards, shards=shards)
    pathlib.Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(total))
    return 0 if total['accepted'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
