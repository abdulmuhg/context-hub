import { describe, expect, it } from 'vitest';
import { createInterruptRegistry } from '../src/interrupt.js';

describe('the Ctrl+C registry', () => {
  it('runs every registered handler, latest first, and exits once', () => {
    const calls: string[] = [];
    const reg = createInterruptRegistry((code) => calls.push(`exit ${code}`));
    reg.register(() => calls.push('setup'));
    reg.register(() => calls.push('sync'));
    reg.fire();
    expect(calls).toEqual(['sync', 'setup', 'exit 130']);
  });

  it('does not run a handler that was unregistered', () => {
    const calls: string[] = [];
    const reg = createInterruptRegistry((code) => calls.push(`exit ${code}`));
    reg.register(() => calls.push('setup'));
    const stop = reg.register(() => calls.push('sync'));
    stop();
    reg.fire();
    expect(calls).toEqual(['setup', 'exit 130']);
  });

  it('calls onFire once, before the handlers', () => {
    const calls: string[] = [];
    const reg = createInterruptRegistry(() => calls.push('exit'), () => calls.push('newline'));
    reg.register(() => calls.push('a'));
    reg.register(() => calls.push('b'));
    reg.fire();
    expect(calls).toEqual(['newline', 'b', 'a', 'exit']);
  });
});
