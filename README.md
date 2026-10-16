# retry-jitter

Retry async functions with exponential backoff, jitter, and `AbortSignal` support. Zero dependencies, fully typed, ESM + CommonJS.

[![npm](https://img.shields.io/npm/v/retry-jitter)](https://www.npmjs.com/package/retry-jitter)
[![CI](https://github.com/acus9345/retry-jitter/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/retry-jitter/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/retry-jitter)](LICENSE)

- **One function, sensible defaults.** `retry(fn)` makes up to 4 attempts, waiting about 100 ms, 200 ms, then 400 ms between them.
- **Jitter by default**, so many clients that fail together don't all retry at the same moment.
- **Cancellable.** Pass an `AbortSignal` and `retry` stops at once, even mid-wait or mid-attempt.
- **Helpful errors.** Typo an option and it tells you the right name.
- **Tiny.** No dependencies, under 2 KB minified and gzipped. Built for Node 18+; uses only standard `setTimeout`, `Promise`, and `AbortSignal`, so it also runs in browsers, Deno, and Bun.

## Install

```bash
npm install retry-jitter
```

## Quick start

Save this as `quickstart.mjs` and run `node quickstart.mjs`:

```js
import { retry } from "retry-jitter";

let calls = 0;

const result = await retry(async ({ attempt }) => {
  calls++;
  if (attempt < 3) throw new Error(`flaky failure #${attempt}`);
  return "it worked";
});

console.log(result, "after", calls, "attempts"); // it worked after 3 attempts
```

A real-world `fetch`, retrying only server errors and giving up after 10 seconds:

```js
import { retry } from "retry-jitter";

const res = await retry(
  async ({ signal }) => {
    const r = await fetch("https://example.com", { signal });
    if (r.status >= 500) throw new Error(`Server error ${r.status}`);
    return r;
  },
  { retries: 5, signal: AbortSignal.timeout(10_000) },
);

console.log(res.status); // 200
```

CommonJS works too:

```js
const { retry } = require("retry-jitter");
```

## API

### `retry(fn, options?)`

Calls `fn` until it succeeds, waiting longer after each failure. Returns a promise of whatever `fn` returns.

`fn` receives `{ attempt, signal }`: the attempt number (starting at 1) and the `signal` you passed in, so you can forward it to `fetch`.

| Option        | Default    | Description                                                                                         |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `retries`     | `3`        | Retries after the first attempt. `3` means up to 4 attempts. `Infinity` retries until success or abort. |
| `minDelay`    | `100`      | Backoff before the first retry, in ms.                                                              |
| `maxDelay`    | `30000`    | Upper limit for any single wait, in ms.                                                             |
| `factor`      | `2`        | Multiplier applied to the backoff after each retry.                                                 |
| `jitter`      | `"full"`   | `"full"`: random wait between 0 and the backoff. `"equal"`: between half and all of it. `"none"`: exact backoff. |
| `signal`      | none       | An `AbortSignal`. When it aborts, `retry` rejects right away with `signal.reason`.                  |
| `shouldRetry` | retry all  | `(error, attempt) => boolean \| Promise<boolean>`. Return `false` to stop and rethrow that error unchanged. |
| `onRetry`     | none       | `({ error, attempt, delay }) => void`. Called after each failure that will be retried, before waiting. Good for logging. |

Without jitter, the wait before retry `n` is `min(maxDelay, minDelay × factor^(n−1))`.

#### What it throws

| Situation                               | Thrown value                    |
| --------------------------------------- | ------------------------------- |
| Every attempt failed                    | `RetryError`                    |
| `shouldRetry` returned `false`          | The original error, unchanged   |
| `signal` aborted                        | `signal.reason` (usually an `AbortError` or `TimeoutError` `DOMException`) |
| Invalid arguments                       | `TypeError` or `RangeError` with a message explaining the fix |

### `RetryError`

Thrown when every attempt fails. It extends `Error` and adds:

- `attempts`: how many attempts were made
- `errors`: the error from each attempt, oldest first
- `cause`: the error from the last attempt

```js
import { retry, RetryError } from "retry-jitter";

try {
  await retry(() => {
    throw new Error("still down");
  }, { retries: 2, minDelay: 10 });
} catch (err) {
  if (err instanceof RetryError) {
    console.log(err.message);       // All 3 attempts failed. Last error: Error: still down
    console.log(err.cause.message); // still down
  }
}
```

### `backoff(retryNumber, options?)`

Returns the wait in ms before retry number `retryNumber` (1 for the first retry), using the same `minDelay`, `maxDelay`, `factor`, and `jitter` rules. Use it if you write your own retry loop.

```js
import { backoff } from "retry-jitter";

console.log(backoff(1, { jitter: "none" })); // 100
console.log(backoff(3, { jitter: "none" })); // 400
```

## Recipe: retry only some errors, log each retry, cap total time

```js
import { retry } from "retry-jitter";

// Stand-in for your API call: fails twice with a 503, then succeeds.
let calls = 0;
async function callApi() {
  if (++calls < 3) throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  return "ok";
}

const result = await retry(callApi, {
  retries: 10,
  // Retry rate limits and server errors; rethrow anything else right away.
  shouldRetry: (error) => error.status === 429 || error.status >= 500,
  // Log each retry.
  onRetry: ({ error, attempt, delay }) =>
    console.warn(`Attempt ${attempt} failed (${error.message}); retrying in ${delay} ms`),
  // Give up after 30 seconds in total.
  signal: AbortSignal.timeout(30_000),
});

console.log(result); // ok
```

## Troubleshooting

**`SyntaxError: await is only valid in async functions` or `Cannot use import statement outside a module`**
Your file is running as CommonJS. Rename it to `.mjs`, add `"type": "module"` to your `package.json`, or use `const { retry } = require("retry-jitter")` inside an `async` function.

**`retry-jitter: the first argument must be a function, got a Promise`**
You called your function instead of passing it. Write `retry(() => fetch(url))`, not `retry(fetch(url))`.

**`retry-jitter: unknown option "maxRetries". Did you mean "retries"?`**
Option names differ between retry libraries. The error tells you the name this one uses.

**It never stops retrying**
You probably set `retries: Infinity` without a `signal`. Add `signal: AbortSignal.timeout(ms)`, or set a finite `retries`.

**My `fetch` didn't retry on a 500**
`fetch` only rejects on network errors, not on HTTP error statuses. Check `response.ok` or `response.status` and throw, as in the quick start.

**Abort didn't stop my request**
`retry` stops waiting as soon as the signal aborts, but it can't cancel work it doesn't own. Forward the `signal` it gives you: `fetch(url, { signal })`.

## License

[MIT](LICENSE)
