// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only subprocess. Every cut keeps its real SQLite handles open until SIGKILL.
import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, statSync, truncateSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { IndexWalWriter, MEMW_C_BYTES, MEMW_W_STEP_BYTES, openIndexWal, readSidecar, readWalHeader, walCheckpointModes, walTestHooks, writeSidecar, WalStop } from '../index-wal.ts';
const [mode, path, cut] = process.argv.slice(2), MB = 1024 * 1024;
const length = () => existsSync(path + '-wal') ? statSync(path + '-wal').size : 0;
const meta = (db: DatabaseSync, key: string) => db.prepare('SELECT value FROM index_meta WHERE key=?').get(key)?.value;
const sidecar = () => readSidecar(path, '-walattempt');
let opened: ReturnType<typeof openIndexWal> | undefined;
function pause(details: object): never {
    process.send!({ pid: process.pid, cut, handlesOpen: opened?.writable.isOpen && opened.guard.isOpen, ...details });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw Error('crash cut resumed');
}
if (mode === 'reopen-failed-stop')
    walTestHooks.fault = (name, op) => {
        if (name === '-walstop' && op === 'write')
            throw Error('fixture EIO');
    };
walTestHooks.exit = code => pause({ exit: code, marker: sidecar(), walBytes: length() });
const o = openIndexWal(path, { charge: async () => true });
opened = o;
if (o.verdict.state !== 'stopped')
    o.verdict = await o.wal.openCheck();
if (mode.startsWith('reopen')) {
    const result = { pid: process.pid, verdict: { ...o.verdict, fileId: String('fileId' in o.verdict ? o.verdict.fileId : '') }, checkpoints: walCheckpointModes(), marker: sidecar(), walBytes: length() };
    (o.wal as IndexWalWriter).closeForQuarantine();
    process.send!(result, () => process.disconnect!());
}
else {
    assert.equal(o.verdict.state, 'writable');
    const seq = () => JSON.parse(String(meta(o.writable, 'wal_check'))).seq as number;
    const rows = (db: DatabaseSync, bytes: number) => {
        db.exec('CREATE TABLE IF NOT EXISTS t(x BLOB)');
        const put = db.prepare('INSERT INTO t VALUES(zeroblob(?))');
        for (let left = bytes; left > 0; left -= 4000)
            put.run(Math.min(4000, left));
    };
    const fill = async (bytes: number) => {
        o.wal.write('open', 4 * MB, () => rows(o.writable, bytes));
        await o.wal.check();
    };
    const pin = () => {
        const r = new DatabaseSync(path, { readOnly: true });
        r.exec('BEGIN');
        r.prepare('SELECT count(*) FROM sqlite_schema').get();
        return () => r.close();
    };
    function spill(bytes: number) {
        const len = length();
        truncateSync(path + '-wal', len + bytes);
        if (len >= 32)
            return;
        const raw = Buffer.alloc(32);
        raw.writeUInt32BE(0x377f0682, 0);
        raw.writeUInt32BE(3007000, 4);
        raw.writeUInt32BE(4096, 8);
        raw.writeUInt32BE(9, 12);
        raw.writeUInt32BE(123, 16);
        raw.writeUInt32BE(456, 20);
        let s0 = 0, s1 = 0;
        for (let i = 0; i < 24; i += 8) {
            s0 = (s0 + raw.readUInt32LE(i) + s1) >>> 0;
            s1 = (s1 + raw.readUInt32LE(i + 4) + s0) >>> 0;
        }
        raw.writeUInt32BE(s0, 24);
        raw.writeUInt32BE(s1, 28);
        const fd = openSync(path + '-wal', 'r+');
        try {
            writeSync(fd, raw);
        }
        finally {
            closeSync(fd);
        }
    }
    const failed = () => assert.throws(() => o.wal.write('fill', MEMW_W_STEP_BYTES, () => {
        throw Error('fixture full');
    }), /fixture full/);
    const ready = () => pause({ walBytes: length(), header: readWalHeader(path), marker: sidecar(), seal: meta(o.writable, 'wal_check'), stopRow: meta(o.writable, 'wal_over_stop'), rows: o.writable.prepare('SELECT count(*) AS n FROM t').get()?.n });
    await fill(100000);
    switch (cut) {
        case '8i-pass-commit':
            o.wal.write('fill', MEMW_W_STEP_BYTES, () => rows(o.writable, 3 * MB));
            break;
        case '8i-breach-commit':
            o.wal.write('fill', MEMW_W_STEP_BYTES, () => rows(o.writable, 6 * MB));
            break;
        case '8i-resolved-tail':
            await fill(3 * MB);
            failed();
            spill(2 * MB);
            await o.wal.check();
            assert.equal((sidecar() as any).value.state, 'resolved');
            break;
        case '8k-restart-commit': {
            const release = pin();
            for (let i = 0; i < 3; i++)
                await fill(3 * MB);
            release();
            o.wal.write('fill', MEMW_W_STEP_BYTES, () => rows(o.writable, 4000));
            await o.wal.check();
            const id = readWalHeader(path)!.id;
            o.wal.write('fill', MEMW_W_STEP_BYTES, () => rows(o.writable, 3 * MB));
            assert.notEqual(readWalHeader(path)!.id, id);
            break;
        }
        case '8l-truncate-copy': {
            const release = pin();
            await fill(2 * MB);
            walTestHooks.checkpoint = (db, mode) => {
                if (mode === 'TRUNCATE') {
                    release();
                    db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
                    ready();
                }
                return db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as any;
            };
            await o.wal.sealAndTruncate();
            throw Error('missed truncate cut');
        }
        case '8o-seal-commit':
        case 'S21d-seal-commit':
            walTestHooks.sealBody = db => rows(db, cut === '8o-seal-commit' ? 200000 : 12000);
            walTestHooks.point = name => {
                if (name === 'after-commit')
                    ready();
            };
            await o.wal.sealAndTruncate();
            throw Error('missed commit cut');
        case 'S21d-group-commit':
            o.wal.write('group', 64 * 1024, () => rows(o.writable, 200000));
            break;
        case 'S21d-rollback-tail':
            failed();
            spill(MEMW_W_STEP_BYTES + o.wal.pageSize + 24);
            break;
        case 'S21e-marker-before-frame':
            writeSidecar(path, '-walattempt', { fileId: o.wal.fileId.toString(), seq: seq() + 1, kind: 'fill', reserve: MEMW_W_STEP_BYTES, state: 'in_flight', checkedEnd: 0 }, false);
            break;
        case 'S21g-resolved-commit':
        case 'S21g-past-checked-end':
            assert.equal((await o.wal.sealAndTruncate()).truncated, true);
            failed();
            truncateSync(path + '-wal', 3 * MB);
            await o.wal.check();
            o.wal.write('fill', MEMW_W_STEP_BYTES, () => rows(o.writable, 4000));
            if (cut === 'S21g-past-checked-end')
                truncateSync(path + '-wal', 3 * MB + o.wal.pageSize + 24);
            break;
        case 'S21h-stale-marker':
            await fill(4000);
            spill(64 * 1024);
            writeSidecar(path, '-walattempt', { fileId: o.wal.fileId.toString(), seq: seq() - 1, kind: 'fill', reserve: MEMW_W_STEP_BYTES, state: 'in_flight', checkedEnd: length() }, false);
            break;
        case '8q-unchecked-rise': {
            const db = new DatabaseSync(path);
            db.exec('PRAGMA wal_autocheckpoint=0');
            rows(db, 6 * MB);
            break;
        }
        case 'S23-stopped':
            await assert.rejects(async () => {
                o.wal.write('fill', MEMW_W_STEP_BYTES, () => rows(o.writable, 6 * MB));
                await o.wal.check();
            }, WalStop);
            break;
        case 'S21a-resolved-rollback':
            assert.equal((await o.wal.sealAndTruncate()).truncated, true);
            failed();
            spill(MB);
            await o.wal.check();
            break;
        case 'S21c-unchecked-tail':
            failed();
            spill(20 * MB);
            break;
        case 'S21b-stopped-tail':
            failed();
            spill(20 * MB);
            await assert.rejects(() => o.wal.check(), WalStop);
            break;
        case 'S-STOPDUR-after-walstop':
            o.wal.write('fill', MEMW_W_STEP_BYTES, () => rows(o.writable, 100000));
            spill(MEMW_C_BYTES);
            walTestHooks.point = name => {
                if (name === 'after-walstop')
                    ready();
            };
            await o.wal.check();
            throw Error('missed stop cut');
        case '8m-remove-log': break;
        case 'S20-unreadable-exit': {
            const release = pin();
            for (let i = 0; i < 4; i++)
                await fill(3 * MB);
            release();
            o.wal.write('open', 4 * MB, () => rows(o.writable, 4000));
            walTestHooks.walHeader = () => null;
            await o.wal.check();
            await o.wal.check();
            await o.wal.check();
            throw Error('missed unresolved exit');
        }
        default: throw Error('unknown cut');
    }
    ready();
}
