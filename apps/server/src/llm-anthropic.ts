import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LlmRefusal, PromptedLlm, type AskCall, type Effort } from '@context-hub/core';
import type { UsageRecord } from './usage.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export type { Effort };

/** The one SDK method this file needs. The real client satisfies it; tests pass a stub. */
export interface ParseClient {
  messages: { parse: (args: any) => Promise<any> };
}

export class AnthropicLlm extends PromptedLlm {
  readonly model: string;
  private readonly client: ParseClient;
  private readonly effort: Effort;
  private readonly onUsage: ((u: UsageRecord) => void) | undefined;

  constructor(opts: { client?: ParseClient; model?: string; effort?: Effort; onUsage?: (u: UsageRecord) => void } = {}) {
    super();
    this.onUsage = opts.onUsage;
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? 'low';
  }

  protected async ask<T>({ system, user, schema, kind, project }: AskCall): Promise<T> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: this.effort, format: zodOutputFormat(schema as Parameters<typeof zodOutputFormat>[0]) },
    });
    // Refusals and incomplete answers are billed too, so record before checking them.
    const usage = response.usage;
    if (usage && this.onUsage) {
      try {
        this.onUsage({
          model: this.model,
          kind,
          project,
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_read_tokens: usage.cache_read_input_tokens ?? 0,
          cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
        });
      } catch (e) {
        console.error(`usage not recorded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // A refusal is a normal HTTP 200 response, not an exception.
    if (response.stop_reason === 'refusal') throw new LlmRefusal(response.stop_details?.category ?? 'unspecified');
    if (response.stop_reason === 'max_tokens' || response.parsed_output == null) {
      throw new Error(`the model returned an incomplete answer (${response.stop_reason})`);
    }
    return response.parsed_output as T;
  }
}
