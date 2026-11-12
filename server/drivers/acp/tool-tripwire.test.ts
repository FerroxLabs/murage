import { describe, expect, it } from 'vitest';
import { ToolTripwire } from './tool-tripwire.ts';
describe('Hermes turn-local allow bindings', () => {
  it('missing identities never match by fallback, but exact IDs do', () => {
    const table = new ToolTripwire(); table.record('ask', undefined, {}, 'session');
    expect(table.accepts('execution', undefined, {}, 'session')).toBe(false);
    expect(table.accepts('ask', undefined, {}, 'session')).toBe(true);
  });
  it('identity, input and session all constrain fallback', () => {
    const table = new ToolTripwire(); table.record('ask', 'terminal', { command: 'pwd' }, 'session');
    expect(table.accepts('execution', 'read_file', { command: 'pwd' }, 'session')).toBe(false);
    expect(table.accepts('execution', 'terminal', { command: 'ls' }, 'session')).toBe(false);
    expect(table.accepts('execution', 'terminal', { command: 'pwd' }, 'foreign')).toBe(false);
    expect(table.accepts('execution', 'terminal', { command: 'pwd' }, 'session')).toBe(true);
    expect(table.accepts('execution', undefined, undefined, 'session')).toBe(true);
    expect(table.accepts('second', 'terminal', { command: 'pwd' }, 'session')).toBe(false);
    expect(table.accepts('ask', 'terminal', { command: 'pwd' }, 'session')).toBe(false);
  });
  it('ambiguous fallback and empty execution IDs fail closed', () => {
    const table = new ToolTripwire(); table.record('a', 'terminal', {}, 's'); table.record('b', 'terminal', {}, 's');
    expect(table.accepts('x', 'terminal', {}, 's')).toBe(false);
    for (const id of [undefined, null, '', ' ']) expect(table.accepts(id, 'terminal', {}, 's')).toBe(false);
    expect(table.accepts('a', 'terminal', {}, 's')).toBe(true);
  });
});

it('a failed response write retires the allow', () => {
  const table = new ToolTripwire();
  const retire = table.record('ask', 'terminal', {}, 's'); retire();
  expect(table.accepts('ask', 'terminal', {}, 's')).toBe(false);
});
