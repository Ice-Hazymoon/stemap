declare const __VERSION__: string;

/** Injected by tsdown; running from source has no define, so the version is `dev`. */
export const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
