import { describe, expect, it } from 'vitest';
import { normalizeRemote } from '../src/index.js';

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:abdulmuhg/jsonroom.git', 'github.com/abdulmuhg/jsonroom'],
    ['https://github.com/AbdulMuhg/JsonRoom.git', 'github.com/abdulmuhg/jsonroom'],
    ['https://github.com/abdulmuhg/jsonroom/', 'github.com/abdulmuhg/jsonroom'],
    ['https://user:token@github.com/abdulmuhg/jsonroom', 'github.com/abdulmuhg/jsonroom'],
    ['ssh://git@gitlab.example.com:2222/team/app.git', 'gitlab.example.com/team/app'],
  ])('%s -> %s', (url, key) => {
    expect(normalizeRemote(url)).toBe(key);
  });

  it.each([['jsonroom'], [''], ['C:\\Users\\abdul\\project\\jsonroom'], ['/home/abdul/jsonroom']])(
    'returns null for %s',
    (value) => {
      expect(normalizeRemote(value)).toBeNull();
    },
  );
});
