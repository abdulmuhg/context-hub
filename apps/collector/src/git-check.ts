import type { State } from './config.js';
import { factsHash, gatherFacts, renderFacts, renderSection, type CommandRunner } from './git-facts.js';
import { checkoutFor, type ResolveDeps } from './project.js';
import type { PageLeft } from './summaries.js';

/** Why a project was not checked: its checkout is not known on this computer. */
export const NO_CHECKOUT = 'no checkout on this computer';

/** What a project's page is checked against: facts for the review, the section for the page, and a hash of the facts. */
export interface GitCheck {
  facts: string;
  as_of: string;
  section: string;
  hash: string;
}

/**
 * Gathers git facts for each project that still has its recorded checkout on
 * this computer. A recorded path that is gone, or that now holds another
 * project, is forgotten. Projects that cannot be checked are returned with why.
 */
export function prepareGitChecks(
  keys: string[],
  state: State,
  deps: ResolveDeps & { run: CommandRunner },
  o: { now: Date; computer: string; aliases?: Record<string, string> },
): { checks: Map<string, GitCheck>; skipped: PageLeft[] } {
  const checks = new Map<string, GitCheck>();
  const skipped: PageLeft[] = [];
  for (const key of keys) {
    const path = state.repos?.[key];
    const found = path ? checkoutFor(path, deps) : null;
    if (!path || !found || (o.aliases?.[found.key] ?? found.key) !== key) {
      if (state.repos) delete state.repos[key];
      skipped.push({ project: key, reason: NO_CHECKOUT });
      continue;
    }
    const facts = gatherFacts(path, key, deps.run);
    if (!facts) {
      skipped.push({ project: key, reason: 'git found no default branch' });
      continue;
    }
    checks.set(key, { facts: renderFacts(facts), as_of: o.now.toISOString(), section: renderSection(facts, { computer: o.computer, at: o.now }), hash: factsHash(facts) });
  }
  return { checks, skipped };
}
