const WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 10;
const BLOCK_MS = 15 * 60_000;
/** Upper bound on tracked addresses, so a flood of made-up addresses cannot exhaust memory. */
const MAX_TRACKED = 10_000;

/** Counts failed logins per client address and blocks an address that fails too often. */
export class AuthLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  isBlocked(address: string): boolean {
    const until = this.blockedUntil.get(address);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.blockedUntil.delete(address);
    return false;
  }

  recordFailure(address: string): void {
    const t = this.now();
    const recent = (this.failures.get(address) ?? []).filter((at) => t - at < WINDOW_MS);
    recent.push(t);
    if (recent.length >= MAX_FAILURES) {
      this.blockedUntil.set(address, t + BLOCK_MS);
      this.failures.delete(address);
    } else {
      this.failures.delete(address); // re-insert so the map stays ordered by last failure
      this.failures.set(address, recent);
      while (this.failures.size > MAX_TRACKED) {
        const oldest = this.failures.keys().next().value;
        if (oldest === undefined) break;
        this.failures.delete(oldest);
      }
    }
    for (const [addr, until] of this.blockedUntil) {
      if (this.blockedUntil.size <= MAX_TRACKED && t < until) break;
      this.blockedUntil.delete(addr);
    }
  }

  /** How many addresses are being tracked. Used by tests. */
  size(): number {
    return this.failures.size + this.blockedUntil.size;
  }
}
