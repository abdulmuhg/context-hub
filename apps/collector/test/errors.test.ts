import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BadCodeError, Fail, friendlyMessage, HttpStatusError, plainReason, UnreachableError } from '../src/errors.js';
import { tempDir } from './helpers.js';

const withCause = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const named = (name: string): Error => Object.assign(new Error('x'), { name });

describe('plainReason', () => {
  it('maps network failures to plain words', () => {
    expect(plainReason(withCause('ENOTFOUND'))).toBe("the address wasn't found");
    expect(plainReason(withCause('EAI_AGAIN'))).toBe("the address wasn't found");
    expect(plainReason(withCause('ECONNREFUSED'))).toBe('the connection was refused');
    expect(plainReason(withCause('ECONNRESET'))).toBe('the connection was dropped');
    expect(plainReason(named('TimeoutError'))).toBe("it didn't answer in time");
    expect(plainReason(named('AbortError'))).toBe("it didn't answer in time");
    for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
      expect(plainReason(withCause(code))).toBe("its certificate couldn't be checked");
    }
  });

  it('falls back to the error message', () => {
    expect(plainReason(new Error('odd'))).toBe('odd');
  });
});

describe('friendlyMessage', () => {
  const dir = tempDir();
  const NEW_LINE = 'Get a new line from Sign-ins → Add a computer and paste it.';

  it('explains a refused code', () => {
    expect(friendlyMessage(new BadCodeError(), dir)).toBe(`That code didn't work: it has expired, was already used, or was mistyped. ${NEW_LINE}`);
  });

  it('explains an unreachable hub', () => {
    expect(friendlyMessage(new UnreachableError('https://hub.test', "the address wasn't found"), dir)).toBe(
      "Can't reach https://hub.test (the address wasn't found). Check your internet connection and the address, then try again.",
    );
  });

  it('says the computer was disconnected on 401 and 403', () => {
    for (const status of [401, 403]) {
      expect(friendlyMessage(new HttpStatusError('GET', '/api/status', status), dir)).toBe(`This computer was disconnected from the hub. ${NEW_LINE}`);
    }
  });

  it('keeps the old messages of the typed errors', () => {
    expect(new UnreachableError('https://h', 'r').message).toBe('could not reach https://h: r');
    expect(new HttpStatusError('GET', '/x', 500).message).toBe('GET /x: server answered 500');
  });

  it('shows a Fail as it is', () => {
    expect(friendlyMessage(new Fail('Missing project.'), dir)).toBe('Missing project.');
  });

  it('keeps the stack off the screen and in the log', () => {
    const hubDir = tempDir();
    const message = friendlyMessage(new TypeError('boom'), hubDir);
    expect(message).toBe(`Something went wrong: boom. Details are in ${join(hubDir, 'error.log')}`);
    expect(readFileSync(join(hubDir, 'error.log'), 'utf8')).toContain('TypeError: boom');
  });
});
