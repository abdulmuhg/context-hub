const WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 10;
const BLOCK_MS = 15 * 60_000;

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
      this.failures.set(address, recent);
    }
  }
}
