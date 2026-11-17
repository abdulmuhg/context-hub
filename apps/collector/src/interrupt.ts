/**
 * Every command that wants to clean up on Ctrl+C registers a handler here. One Ctrl+C runs them all, the latest
 * registered first, so a command nested inside another releases what it took before the outer one reports.
 * `onFire` runs once before them; `exit` runs once after.
 */
export function createInterruptRegistry(
  exit: (code: number) => void,
  onFire?: () => void,
): { register(handler: () => void): () => void; fire(): void } {
  const handlers: Array<() => void> = [];
  return {
    register(handler) {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    fire() {
      onFire?.();
      for (const handler of [...handlers].reverse()) handler();
      exit(130);
    },
  };
}
