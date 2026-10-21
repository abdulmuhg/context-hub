import { describe, expect, it } from 'vitest';
import { DigestSchema, jsonSchemaOf, ReviewSchema, StateSchema } from '../src/index.js';

describe('jsonSchemaOf', () => {
  // Claude Code refuses a --json-schema that names draft 2020-12 ("no schema with key or ref").
  it('leaves out $schema, for every schema sent to claude -p', () => {
    for (const schema of [DigestSchema, StateSchema, ReviewSchema]) expect(jsonSchemaOf(schema)).not.toHaveProperty('$schema');
  });

  it('keeps the shape of the digest', () => {
    const s = jsonSchemaOf(DigestSchema) as { type: string; required: string[] };
    expect(s.type).toBe('object');
    expect(s.required).toEqual(expect.arrayContaining(['goal', 'done', 'decisions', 'open_items', 'key_refs']));
  });
});
