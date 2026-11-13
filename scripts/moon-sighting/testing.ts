// A small jest-style `expect` and `fn` on top of node:assert, so the tests run with the built-in
// `node --test` (no packages to install, no network).
import assert from 'node:assert/strict';

const ASYMMETRIC = Symbol('asymmetric');
type Asymmetric = { [ASYMMETRIC]: (value: unknown) => boolean; toString: () => string };
const asymmetric = (test: (value: unknown) => boolean, name: string): Asymmetric => ({
  [ASYMMETRIC]: test,
  toString: () => name,
});
const isAsymmetric = (value: unknown): value is Asymmetric =>
  typeof value === 'object' && value !== null && ASYMMETRIC in value;

function matches(actual: unknown, expected: unknown, partial: boolean): boolean {
  if (isAsymmetric(expected)) return expected[ASYMMETRIC](actual);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matches(actual[i], item, partial))
    );
  }
  if (typeof expected === 'object' && expected !== null && !(expected instanceof Uint8Array)) {
    if (typeof actual !== 'object' || actual === null) return false;
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const keys = Object.keys(e).filter((k) => e[k] !== undefined);
    if (!partial) {
      const actualKeys = Object.keys(a).filter((k) => a[k] !== undefined);
      if (actualKeys.length !== keys.length) return false;
    }
    return keys.every((k) => matches(a[k], e[k], partial));
  }
  return Object.is(actual, expected);
}

const show = (value: unknown) => {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (isAsymmetric(v) ? String(v) : v), 2);
  } catch {
    return String(value);
  }
};

type Mock = ((...args: unknown[]) => unknown) & { calls: unknown[][] };

export function fn<A extends unknown[], R>(impl?: (...args: A) => R) {
  const calls: unknown[][] = [];
  const mock = ((...args: A) => {
    calls.push(args);
    return impl?.(...args);
  }) as ((...args: A) => R) & { calls: unknown[][] };
  mock.calls = calls;
  return mock;
}

function matchers(actual: unknown, negate: boolean) {
  const check = (pass: boolean, message: () => string) => {
    if (pass === negate) assert.fail(negate ? `not: ${message()}` : message());
  };
  return {
    toBe: (expected: unknown) =>
      check(Object.is(actual, expected), () => `expected ${show(actual)} to be ${show(expected)}`),
    toEqual: (expected: unknown) =>
      check(matches(actual, expected, false), () => `expected ${show(actual)} to equal ${show(expected)}`),
    toMatchObject: (expected: unknown) =>
      check(matches(actual, expected, true), () => `expected ${show(actual)} to match ${show(expected)}`),
    toBeNull: () => check(actual === null, () => `expected ${show(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, () => `expected ${show(actual)} to be undefined`),
    toContain: (item: unknown) =>
      check(
        typeof actual === 'string'
          ? actual.includes(String(item))
          : Array.isArray(actual) && actual.some((a) => Object.is(a, item)),
        () => `expected ${show(actual)} to contain ${show(item)}`,
      ),
    toMatch: (pattern: RegExp | string) =>
      check(
        typeof actual === 'string' &&
          (typeof pattern === 'string' ? actual.includes(pattern) : pattern.test(actual)),
        () => `expected ${show(actual)} to match ${String(pattern)}`,
      ),
    toHaveLength: (length: number) =>
      check(
        (actual as { length?: number })?.length === length,
        () => `expected length ${length}, got ${show((actual as { length?: number })?.length)}`,
      ),
    toThrow: (pattern?: RegExp | string) => {
      let thrown: unknown = null;
      let threw = false;
      try {
        (actual as () => unknown)();
      } catch (error) {
        threw = true;
        thrown = error;
      }
      const message = (thrown as Error | null)?.message ?? '';
      check(
        threw &&
          (pattern === undefined ||
            (typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message))),
        () => `expected a throw matching ${String(pattern)}, got ${threw ? message : 'no throw'}`,
      );
    },
    toHaveBeenCalled: () =>
      check((actual as Mock).calls.length > 0, () => 'expected the mock to have been called'),
    toHaveBeenCalledTimes: (n: number) =>
      check(
        (actual as Mock).calls.length === n,
        () => `expected ${n} calls, got ${(actual as Mock).calls.length}`,
      ),
  };
}

export function expect(actual: unknown) {
  return {
    ...matchers(actual, false),
    not: matchers(actual, true),
    rejects: {
      toThrow: async (pattern?: RegExp | string) => {
        try {
          await actual;
        } catch (error) {
          const message = (error as Error).message;
          if (
            pattern === undefined ||
            (typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message))
          )
            return;
          assert.fail(`rejected with "${message}", expected ${String(pattern)}`);
        }
        assert.fail('expected the promise to reject');
      },
    },
  };
}

expect.stringMatching = (pattern: RegExp) =>
  asymmetric((v) => typeof v === 'string' && pattern.test(v), `stringMatching(${pattern})`);
expect.stringContaining = (text: string) =>
  asymmetric((v) => typeof v === 'string' && v.includes(text), `stringContaining(${text})`);
expect.objectContaining = (shape: Record<string, unknown>) =>
  asymmetric((v) => matches(v, shape, true), `objectContaining(${show(shape)})`);
expect.any = (ctor: unknown) =>
  asymmetric(
    (v) =>
      ctor === String
        ? typeof v === 'string'
        : ctor === Number
          ? typeof v === 'number'
          : v instanceof (ctor as new () => unknown),
    'any',
  );
