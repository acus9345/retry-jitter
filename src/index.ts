/**
 * retry-jitter: retry async functions with exponential backoff, jitter,
 * and AbortSignal support.
 *
 * @packageDocumentation
 */

/**
 * How randomness is applied to each backoff delay.
 *
 * - `"full"` (default): a random delay between 0 and the backoff value.
 *   Best at spreading out many clients that fail at the same time.
 * - `"equal"`: half the backoff value plus a random amount up to the other half.
 * - `"none"`: exactly the backoff value, with no randomness.
 */
export type Jitter = "full" | "equal" | "none";

/** Passed to your function on every attempt. */
export interface RetryContext {
  /** The current attempt number, starting at 1 for the first try. */
  attempt: number;
  /** The `signal` you passed in options, if any. Forward it to `fetch` and similar APIs. */
  signal: AbortSignal | undefined;
}

/** Passed to `onRetry` after a failed attempt, before waiting. */
export interface RetryInfo {
  /** The error thrown by the failed attempt. */
  error: unknown;
  /** The attempt number that failed, starting at 1. */
  attempt: number;
  /** How long retry will wait before the next attempt, in milliseconds. */
  delay: number;
}

/** Options for {@link retry}. Every option is optional. */
export interface RetryOptions {
  /**
   * How many times to retry after the first attempt fails.
   * `3` means up to 4 attempts in total. Use `Infinity` to retry until
   * success or until `signal` aborts. Default: `3`.
   */
  retries?: number | undefined;
  /** Backoff before the first retry, in milliseconds. Default: `100`. */
  minDelay?: number | undefined;
  /** Upper limit for any single backoff, in milliseconds. Default: `30000`. */
  maxDelay?: number | undefined;
  /** Multiplier applied to the backoff after each retry. Default: `2`. */
  factor?: number | undefined;
  /** Jitter strategy. Default: `"full"`. See {@link Jitter}. */
  jitter?: Jitter | undefined;
  /**
   * Cancels the whole operation. When it aborts, `retry` rejects right away
   * with `signal.reason`, even if your function ignores the signal.
   */
  signal?: AbortSignal | undefined;
  /**
   * Decides whether an error is worth retrying. Return `false` to stop and
   * rethrow that error unchanged. Default: retry every error.
   */
  shouldRetry?: ((error: unknown, attempt: number) => boolean | Promise<boolean>) | undefined;
  /** Called after each failed attempt that will be retried, before waiting. */
  onRetry?: ((info: RetryInfo) => void | Promise<void>) | undefined;
}

/**
 * Thrown when every attempt failed. The last error is on `cause`, and every
 * error, in order, is on `errors`.
 */
export class RetryError extends Error {
  /** Total number of attempts made. */
  readonly attempts: number;
  /** The error from each attempt, oldest first. */
  readonly errors: unknown[];
  /** The error from the last attempt. */
  override readonly cause: unknown;

  constructor(errors: unknown[]) {
    const last = errors[errors.length - 1];
    const n = errors.length;
    super(
      `All ${n} attempt${n === 1 ? "" : "s"} failed. Last error: ${describe(last)}`,
    );
    this.name = "RetryError";
    this.attempts = n;
    this.errors = errors;
    this.cause = last;
  }
}

const DEFAULTS = {
  retries: 3,
  minDelay: 100,
  maxDelay: 30_000,
  factor: 2,
  jitter: "full",
} as const satisfies RetryOptions;

/** Largest delay `setTimeout` accepts; longer values fire immediately. */
const MAX_TIMEOUT = 2_147_483_647;

const KNOWN_OPTIONS = new Set([
  "retries",
  "minDelay",
  "maxDelay",
  "factor",
  "jitter",
  "signal",
  "shouldRetry",
  "onRetry",
]);

/** Names people commonly reach for from other retry libraries. */
const ALIASES: Record<string, string> = {
  maxRetries: "retries",
  attempts: "retries",
  maxAttempts: "retries",
  times: "retries",
  delay: "minDelay",
  initialDelay: "minDelay",
  baseDelay: "minDelay",
  minTimeout: "minDelay",
  maxTimeout: "maxDelay",
  multiplier: "factor",
  onFailedAttempt: "onRetry",
  retryIf: "shouldRetry",
};

/**
 * Calls `fn` until it succeeds, waiting longer between each failure.
 *
 * @example
 * ```ts
 * const res = await retry(() => fetch("https://example.com"));
 * ```
 *
 * @param fn - The function to run. It receives `{ attempt, signal }`.
 * @param options - See {@link RetryOptions}. Every option is optional.
 * @returns Whatever `fn` returns on its first successful attempt.
 * @throws {@link RetryError} when every attempt fails.
 * @throws The original error when `shouldRetry` returns `false`.
 * @throws `signal.reason` when `signal` aborts.
 */
export async function retry<T>(
  fn: (context: RetryContext) => T | PromiseLike<T>,
  options: RetryOptions = {},
): Promise<T> {
  if (typeof fn !== "function") {
    throw new TypeError(
      `retry-jitter: the first argument must be a function, got ${typeName(fn)}. ` +
        `Wrap your call in an arrow function: retry(() => fetch(url)).`,
    );
  }
  const opts = resolveOptions(options);
  const { signal } = opts;
  const errors: unknown[] = [];

  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await raceAbort(
        Promise.resolve().then(() => fn({ attempt, signal })),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      errors.push(error);

      if (attempt > opts.retries) throw new RetryError(errors);
      if (opts.shouldRetry && !(await opts.shouldRetry(error, attempt))) {
        throw error;
      }

      const delay = backoff(attempt, opts);
      if (opts.onRetry) await opts.onRetry({ error, attempt, delay });
      await sleep(delay, signal);
    }
  }
}

/**
 * Returns how long to wait before retry number `retryNumber` (1 for the first
 * retry), using the same rules as {@link retry}. Useful if you write your own
 * retry loop.
 *
 * @example
 * ```ts
 * backoff(1, { jitter: "none" }); // 100
 * backoff(3, { jitter: "none" }); // 400
 * ```
 */
export function backoff(
  retryNumber: number,
  options: Omit<RetryOptions, "retries" | "signal" | "shouldRetry" | "onRetry"> = {},
): number {
  if (!Number.isInteger(retryNumber) || retryNumber < 1) {
    throw new RangeError(
      `retry-jitter: backoff() expects a retry number of 1 or more, got ${describe(retryNumber)}.`,
    );
  }
  const { minDelay, maxDelay, factor, jitter } = resolveOptions(options);
  const base =
    minDelay === 0
      ? 0
      : Math.min(maxDelay, minDelay * Math.pow(factor, retryNumber - 1));
  let delay: number;
  if (jitter === "full") delay = Math.random() * base;
  else if (jitter === "equal") delay = base / 2 + Math.random() * (base / 2);
  else delay = base;
  return Math.min(Math.round(delay), MAX_TIMEOUT);
}

interface ResolvedOptions {
  retries: number;
  minDelay: number;
  maxDelay: number;
  factor: number;
  jitter: Jitter;
  signal: AbortSignal | undefined;
  shouldRetry: RetryOptions["shouldRetry"];
  onRetry: RetryOptions["onRetry"];
}

function resolveOptions(options: RetryOptions): ResolvedOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError(
      `retry-jitter: options must be an object, got ${typeName(options)}. ` +
        `Example: retry(fn, { retries: 5 }).`,
    );
  }
  for (const key of Object.keys(options)) {
    if (KNOWN_OPTIONS.has(key)) continue;
    const hint = ALIASES[key];
    throw new TypeError(
      `retry-jitter: unknown option "${key}".` +
        (hint ? ` Did you mean "${hint}"?` : "") +
        ` Valid options: ${[...KNOWN_OPTIONS].join(", ")}.`,
    );
  }

  const o = { ...DEFAULTS, ...stripUndefined(options) } as ResolvedOptions;

  if (!(Number.isInteger(o.retries) || o.retries === Infinity) || o.retries < 0) {
    throw new RangeError(
      `retry-jitter: "retries" must be a whole number of 0 or more (or Infinity), got ${describe(o.retries)}.`,
    );
  }
  checkNumber("minDelay", o.minDelay, 0);
  checkNumber("maxDelay", o.maxDelay, 0, true);
  checkNumber("factor", o.factor, 1);
  if (o.maxDelay < o.minDelay) {
    throw new RangeError(
      `retry-jitter: "maxDelay" (${o.maxDelay}) must be greater than or equal to "minDelay" (${o.minDelay}).`,
    );
  }
  if (o.jitter !== "full" && o.jitter !== "equal" && o.jitter !== "none") {
    throw new TypeError(
      `retry-jitter: "jitter" must be "full", "equal", or "none", got ${describe(o.jitter)}.`,
    );
  }
  if (o.signal !== undefined && !isAbortSignal(o.signal)) {
    throw new TypeError(
      `retry-jitter: "signal" must be an AbortSignal, got ${typeName(o.signal)}. ` +
        `Pass controller.signal, not the AbortController itself.`,
    );
  }
  for (const name of ["shouldRetry", "onRetry"] as const) {
    if (o[name] !== undefined && typeof o[name] !== "function") {
      throw new TypeError(
        `retry-jitter: "${name}" must be a function, got ${typeName(o[name])}.`,
      );
    }
  }
  return o;
}

function checkNumber(name: string, value: unknown, min: number, allowInfinity = false): void {
  const ok =
    typeof value === "number" &&
    value >= min &&
    (Number.isFinite(value) || (allowInfinity && value === Infinity));
  if (!ok) {
    throw new RangeError(
      `retry-jitter: "${name}" must be a number of ${min} or more, got ${describe(value)}.`,
    );
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function"
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    // A 0 ms timer still costs a full clock tick (~15 ms on Windows), so skip it.
    if (ms <= 0) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return String(value);
  } catch {
    return typeName(value);
  }
}

function typeName(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "function") return "a function";
  if (typeof value === "object") {
    const ctor = (value as object).constructor?.name;
    return ctor && ctor !== "Object" ? `a ${ctor}` : "an object";
  }
  return `${typeof value} ${describe(value)}`;
}
