import { afterEach, describe, expect, it, vi } from "vitest";
import { backoff, retry, RetryError, type RetryInfo } from "../src/index.js";

const fast = { minDelay: 0 } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retry: happy path", () => {
  it("returns the value on first success without waiting", async () => {
    const fn = vi.fn(() => 42);
    await expect(retry(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("works with async functions", async () => {
    await expect(retry(async () => "ok")).resolves.toBe("ok");
  });

  it("retries until success", async () => {
    let n = 0;
    const result = await retry(() => {
      n++;
      if (n < 3) throw new Error(`fail ${n}`);
      return "done";
    }, fast);
    expect(result).toBe("done");
    expect(n).toBe(3);
  });

  it("passes attempt numbers and the signal to fn", async () => {
    const controller = new AbortController();
    const seen: Array<{ attempt: number; signal: AbortSignal | undefined }> = [];
    await retry(
      (ctx) => {
        seen.push(ctx);
        if (ctx.attempt < 2) throw new Error("x");
      },
      { ...fast, signal: controller.signal },
    );
    expect(seen.map((c) => c.attempt)).toEqual([1, 2]);
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  it("returns undefined/null/falsy results as-is", async () => {
    await expect(retry(() => undefined)).resolves.toBeUndefined();
    await expect(retry(() => null)).resolves.toBeNull();
    await expect(retry(() => 0)).resolves.toBe(0);
    await expect(retry(() => "")).resolves.toBe("");
  });
});

describe("retry: failure", () => {
  it("throws RetryError after retries are exhausted", async () => {
    let n = 0;
    const err = await retry(() => {
      n++;
      throw new Error(`fail ${n}`);
    }, { ...fast, retries: 2 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetryError);
    expect(err).toBeInstanceOf(Error);
    const e = err as RetryError;
    expect(e.name).toBe("RetryError");
    expect(e.attempts).toBe(3);
    expect(e.errors.map((x) => (x as Error).message)).toEqual(["fail 1", "fail 2", "fail 3"]);
    expect((e.cause as Error).message).toBe("fail 3");
    expect(e.message).toBe("All 3 attempts failed. Last error: Error: fail 3");
  });

  it("retries: 0 means a single attempt", async () => {
    const fn = vi.fn(() => {
      throw new Error("nope");
    });
    const e = (await retry(fn, { retries: 0 }).catch((x: unknown) => x)) as RetryError;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.message).toBe("All 1 attempt failed. Last error: Error: nope");
  });

  it("catches synchronous throws", async () => {
    await expect(
      retry(() => {
        throw new TypeError("sync");
      }, { ...fast, retries: 1 }),
    ).rejects.toBeInstanceOf(RetryError);
  });

  it("handles non-Error throw values", async () => {
    const e = (await retry(() => Promise.reject("plain string"), { ...fast, retries: 1 }).catch(
      (x: unknown) => x,
    )) as RetryError;
    expect(e.cause).toBe("plain string");
    expect(e.message).toContain('Last error: "plain string"');

    const e2 = (await retry(() => Promise.reject(undefined), { ...fast, retries: 0 }).catch(
      (x: unknown) => x,
    )) as RetryError;
    expect(e2.message).toContain("Last error: undefined");
  });

  it("shouldRetry=false rethrows the original error unchanged", async () => {
    const original = new Error("400 Bad Request");
    const fn = vi.fn(() => Promise.reject(original));
    await expect(retry(fn, { ...fast, shouldRetry: () => false })).rejects.toBe(original);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("shouldRetry receives error and attempt, and can be async", async () => {
    const calls: Array<[unknown, number]> = [];
    let n = 0;
    await expect(
      retry(
        () => {
          n++;
          throw new Error(String(n));
        },
        {
          ...fast,
          retries: 10,
          shouldRetry: async (error, attempt) => {
            calls.push([(error as Error).message, attempt]);
            return attempt < 3;
          },
        },
      ),
    ).rejects.toThrow("3");
    expect(calls).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 3],
    ]);
  });

  it("onRetry is called before each wait with error, attempt, and delay", async () => {
    const infos: RetryInfo[] = [];
    await retry(
      ({ attempt }) => {
        if (attempt < 3) throw new Error(`e${attempt}`);
      },
      { minDelay: 1, jitter: "none", onRetry: (info) => void infos.push(info) },
    );
    expect(infos.map((i) => [(i.error as Error).message, i.attempt, i.delay])).toEqual([
      ["e1", 1, 1],
      ["e2", 2, 2],
    ]);
  });

  it("onRetry is not called when no retry will happen", async () => {
    const onRetry = vi.fn();
    await retry(() => Promise.reject(new Error("x")), { retries: 0, onRetry }).catch(() => {});
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("retry: timing", () => {
  it("waits the backoff delay between attempts", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(() => Promise.reject(new Error("x")));
    const p = retry(fn, { retries: 3, minDelay: 100, jitter: "none" }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t=100
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200); // t=300
    expect(fn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(400); // t=700
    expect(fn).toHaveBeenCalledTimes(4);
    expect(await p).toBeInstanceOf(RetryError);
  });
});

describe("retry: abort", () => {
  it("rejects immediately if the signal is already aborted, without calling fn", async () => {
    const fn = vi.fn();
    const reason = new Error("stop");
    await expect(retry(fn, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(fn).not.toHaveBeenCalled();
  });

  it("aborting during the wait rejects with signal.reason and stops retrying", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = vi.fn(() => Promise.reject(new Error("x")));
    const p = retry(fn, { minDelay: 10_000, jitter: "none", signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const err = await p;
    expect((err as DOMException).name).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborting mid-attempt rejects even if fn ignores the signal", async () => {
    const controller = new AbortController();
    const p = retry(() => new Promise(() => {}), { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled")), 5);
    await expect(p).rejects.toThrow("cancelled");
  });

  it("does not retry an error thrown because of abort", async () => {
    const controller = new AbortController();
    const fn = vi.fn(({ signal }: { signal: AbortSignal | undefined }) => {
      controller.abort();
      throw signal!.reason;
    });
    await expect(retry(fn, { signal: controller.signal })).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("removes its abort listeners after success", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await retry(({ attempt }) => {
      if (attempt < 3) throw new Error("x");
    }, { minDelay: 1, signal: controller.signal });
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
  });

  it("retries: Infinity keeps going until aborted", async () => {
    const controller = new AbortController();
    let n = 0;
    await expect(
      retry(
        () => {
          if (++n === 50) controller.abort(new Error("enough"));
          throw new Error("x");
        },
        { ...fast, retries: Infinity, signal: controller.signal },
      ),
    ).rejects.toThrow("enough");
    expect(n).toBe(50);
  });
});

describe("retry: large input", () => {
  it("handles many retries with zero delay quickly", async () => {
    let n = 0;
    const start = Date.now();
    const result = await retry(() => {
      if (++n < 1000) throw new Error("x");
      return n;
    }, { ...fast, retries: 1000 });
    expect(result).toBe(1000);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("collects every error when many attempts fail", async () => {
    const e = (await retry(() => Promise.reject(new Error("x")), { ...fast, retries: 500 }).catch(
      (x: unknown) => x,
    )) as RetryError;
    expect(e.attempts).toBe(501);
    expect(e.errors).toHaveLength(501);
  });
});

describe("retry: bad input gives helpful errors", () => {
  it("rejects a non-function", async () => {
    // @ts-expect-error testing bad input
    await expect(retry(fetch("x").catch(() => {}))).rejects.toThrow(
      /first argument must be a function, got a Promise\. Wrap your call in an arrow function/,
    );
    // @ts-expect-error testing bad input
    await expect(retry()).rejects.toThrow("got undefined");
  });

  it("rejects unknown options and suggests the right name", async () => {
    // @ts-expect-error testing bad input
    await expect(retry(() => 1, { maxRetries: 5 })).rejects.toThrow(
      'unknown option "maxRetries". Did you mean "retries"?',
    );
    // @ts-expect-error testing bad input
    await expect(retry(() => 1, { foo: 1 })).rejects.toThrow(/unknown option "foo"\. Valid options:/);
  });

  it.each([
    [{ retries: -1 }, '"retries" must be a whole number'],
    [{ retries: 1.5 }, '"retries" must be a whole number'],
    [{ retries: NaN }, '"retries" must be a whole number'],
    [{ retries: "3" }, '"retries" must be a whole number of 0 or more (or Infinity), got "3"'],
    [{ minDelay: -5 }, '"minDelay" must be a number of 0 or more, got -5'],
    [{ minDelay: Infinity }, '"minDelay" must be a number'],
    [{ maxDelay: NaN }, '"maxDelay" must be a number'],
    [{ factor: 0.5 }, '"factor" must be a number of 1 or more'],
    [{ minDelay: 500, maxDelay: 100 }, '"maxDelay" (100) must be greater than or equal to "minDelay" (500)'],
    [{ jitter: "random" }, '"jitter" must be "full", "equal", or "none", got "random"'],
    [{ signal: new AbortController() }, "Pass controller.signal, not the AbortController itself"],
    [{ shouldRetry: true }, '"shouldRetry" must be a function, got boolean true'],
    [{ onRetry: "log" }, '"onRetry" must be a function'],
  ])("rejects %j", async (options, message) => {
    // @ts-expect-error testing bad input
    await expect(retry(() => 1, options)).rejects.toThrow(message);
  });

  it("rejects non-object options", async () => {
    // @ts-expect-error testing bad input
    await expect(retry(() => 1, 5)).rejects.toThrow("options must be an object, got number 5");
    // @ts-expect-error testing bad input
    await expect(retry(() => 1, null)).rejects.toThrow("options must be an object, got null");
  });

  it("treats explicit undefined options as defaults", async () => {
    await expect(retry(() => 1, { retries: undefined, signal: undefined })).resolves.toBe(1);
  });

  it("does not call fn when options are invalid", async () => {
    const fn = vi.fn();
    await retry(fn, { retries: -1 }).catch(() => {});
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("backoff", () => {
  it("grows exponentially with no jitter", () => {
    expect([1, 2, 3, 4].map((n) => backoff(n, { jitter: "none" }))).toEqual([100, 200, 400, 800]);
  });

  it("respects minDelay, factor, and maxDelay", () => {
    const opts = { minDelay: 50, factor: 3, maxDelay: 1000, jitter: "none" } as const;
    expect([1, 2, 3, 4, 5].map((n) => backoff(n, opts))).toEqual([50, 150, 450, 1000, 1000]);
  });

  it("full jitter stays between 0 and the backoff", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.999999);
    expect(backoff(3)).toBe(0);
    expect(backoff(3)).toBe(400);
  });

  it("equal jitter stays between half and all of the backoff", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.999999);
    expect(backoff(3, { jitter: "equal" })).toBe(200);
    expect(backoff(3, { jitter: "equal" })).toBe(400);
  });

  it("never returns NaN or more than setTimeout allows", () => {
    expect(backoff(10_000, { minDelay: 0, jitter: "none" })).toBe(0);
    expect(backoff(10_000, { maxDelay: Infinity, jitter: "none" })).toBe(2_147_483_647);
    expect(backoff(10_000, { jitter: "none" })).toBe(30_000);
  });

  it("rejects bad retry numbers", () => {
    expect(() => backoff(0)).toThrow("expects a retry number of 1 or more, got 0");
    expect(() => backoff(1.5)).toThrow(RangeError);
  });
});
