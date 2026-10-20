import { describe, expect, it } from 'vitest';
import { parsePublicUrl } from '../src/oauth/config.js';

describe('parsePublicUrl', () => {
  it('accepts an https origin', () => {
    expect(parsePublicUrl('https://hub.example.com')).toBe('https://hub.example.com');
  });

  it('accepts and strips a trailing slash', () => {
    expect(parsePublicUrl('https://hub.example.com/')).toBe('https://hub.example.com');
  });

  it('accepts http only for localhost', () => {
    expect(parsePublicUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(parsePublicUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(() => parsePublicUrl('http://example.com')).toThrow(/PUBLIC_URL must look like/);
  });

  it('rejects a path, a missing scheme, a query and a fragment', () => {
    expect(() => parsePublicUrl('https://hub.example.com/hub')).toThrow(/PUBLIC_URL must look like/);
    expect(() => parsePublicUrl('hub.example.com')).toThrow(/PUBLIC_URL must look like/);
    expect(() => parsePublicUrl('https://hub.example.com/?a=1')).toThrow(/PUBLIC_URL must look like/);
    expect(() => parsePublicUrl('https://hub.example.com/#x')).toThrow(/PUBLIC_URL must look like/);
  });
});
