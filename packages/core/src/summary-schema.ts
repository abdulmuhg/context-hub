import * as z from 'zod/v4';

export interface DigestItem {
  text: string;
  /** Position of the message that supports this item, when the model gave one. */
  seq: number | null;
}

export interface DigestBody {
  goal: string;
  done: DigestItem[];
  decisions: { what: string; why: string; seq: number | null }[];
  open_items: DigestItem[];
  key_refs: string[];
}

const Item = z.object({
  text: z.string(),
  seq: z.number().int().nullable().describe('Position of the supporting message, from the [n] prefix, or null'),
});

export const DigestSchema = z.object({
  goal: z.string().describe('What the user was trying to achieve in this session, in one or two sentences'),
  done: z.array(Item).describe('What was actually done'),
  decisions: z
    .array(z.object({ what: z.string(), why: z.string(), seq: z.number().int().nullable() }))
    .describe('Decisions that were made, each with its reason'),
  open_items: z.array(Item).describe('What is unfinished, blocked or planned next'),
  key_refs: z.array(z.string()).describe('Important file paths, commands and links'),
});

export const StateSchema = z.object({
  summary: z.string().describe('One sentence: the current state of the project'),
  body: z.string().describe('The state page in Markdown'),
});

export type StatePage = z.infer<typeof StateSchema>;

const Drop = z.object({
  item: z.number().int().describe('The number of the line, as given'),
  session_id: z.string().describe('The id of the session that shows it, exactly as given'),
});

export const ReviewSchema = z.object({
  drop_open: z.array(Drop).describe('Open items that a session shows are done, decided or no longer needed'),
  drop_current: z.array(Drop).describe('Current-state lines that a newer session contradicts'),
  summary: z.string().describe('One sentence of at most 25 words: where the project stands, written from the page without the dropped lines'),
});

/** The JSON Schema form of a zod schema, as `claude --json-schema` takes it. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  // Claude Code's --json-schema rejects a "$schema" naming draft 2020-12, so it is left out.
  const { $schema: _draft, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** What a computer sends with a session: its digest, or the reason there is none. */
export type UploadDigest =
  | { body: DigestBody; model: string }
  | { refused: string; model: string }
  | { failed: string }
  | { summary_to_follow: true };
