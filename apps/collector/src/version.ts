declare const __HUB_VERSION__: string | undefined;

/** Stamped by the deploy build as YYYY.MM.DD-<sha>; `dev` when run unbundled. */
export const HUB_VERSION = typeof __HUB_VERSION__ === 'string' ? __HUB_VERSION__ : 'dev';
