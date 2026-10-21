import { describe, expect, it } from 'vitest';
import { canonicalKey, normalizeRemote } from '../src/index.js';

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:abdulmuhg/jsonroom.git', 'github.com/abdulmuhg/jsonroom'],
    ['https://github.com/AbdulMuhg/JsonRoom.git', 'github.com/abdulmuhg/jsonroom'],
    ['https://github.com/abdulmuhg/jsonroom/', 'github.com/abdulmuhg/jsonroom'],
    ['https://user:token@github.com/abdulmuhg/jsonroom', 'github.com/abdulmuhg/jsonroom'],
    ['ssh://git@gitlab.example.com:2222/team/app.git', 'gitlab.example.com/team/app'],
    ['git@github.com-work:Acme/App.git', 'github.com/acme/app'],
    ['git@github.com-personal:abdulmuhg/specialforus.git', 'github.com/abdulmuhg/specialforus'],
    ['ssh://git@gitlab.com_team/group/app.git', 'gitlab.com/group/app'],
    ['git@github.com.example.org:team/app.git', 'github.com.example.org/team/app'],
  ])('%s -> %s', (url, key) => {
    expect(normalizeRemote(url)).toBe(key);
  });

  it.each([['jsonroom'], [''], ['C:\\Users\\you\\project\\jsonroom'], ['/home/you/jsonroom']])(
    'returns null for %s',
    (value) => {
      expect(normalizeRemote(value)).toBeNull();
    },
  );
});

describe('canonicalKey', () => {
  it.each([
    ['github.com-work/acme/app', 'github.com/acme/app'],
    ['bitbucket.org-me/team/app', 'bitbucket.org/team/app'],
    ['github.com/acme/app', 'github.com/acme/app'],
    ['local:github.com-notes', 'local:github.com-notes'],
    ['unfiled', 'unfiled'],
  ])('%s -> %s', (key, want) => {
    expect(canonicalKey(key)).toBe(want);
  });
});
