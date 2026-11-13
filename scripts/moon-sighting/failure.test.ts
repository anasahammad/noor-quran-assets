import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { extraCaStatus } from './check.ts';
import { causeChain, failureKind, failureOf, HttpError } from './newspapers.ts';
import { expect } from './testing.ts';

// What Node's fetch (undici) throws: TypeError("fetch failed") with the real error in `cause`.
const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('fetch failures name their cause', () => {
  it('a missing intermediate certificate (what islamicfoundation.gov.bd does)', () => {
    const error = fetchFailed(
      coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'),
    );
    expect(failureKind(error)).toBe('tls');
    expect(failureOf(error)).toMatch(
      /^error \(fetch failed; cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate\) \[certificate chain problem/,
    );
  });

  it('a dropped or timed-out connection reads as a probable IP block', () => {
    const reset = fetchFailed(coded('ECONNRESET', 'read ECONNRESET'));
    expect(failureKind(reset)).toBe('network');
    expect(failureOf(reset)).toMatch(/cause: ECONNRESET: read ECONNRESET\) \[.*blocks the runner/);
    // undici: ConnectTimeoutError inside, sometimes behind an AggregateError of addresses.
    const timeout = fetchFailed(
      new AggregateError([coded('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error')], 'x'),
    );
    expect(failureKind(timeout)).toBe('network');
    expect(causeChain(timeout).map((c) => c.code)).toEqual([null, 'UND_ERR_CONNECT_TIMEOUT']);
  });

  it('DNS, HTTP status and timeouts', () => {
    expect(failureKind(fetchFailed(coded('ENOTFOUND', 'getaddrinfo ENOTFOUND x')))).toBe('dns');
    expect(failureOf(new HttpError(403))).toBe('blocked (HTTP 403)');
    expect(failureOf(new HttpError(404))).toBe('HTTP 404');
    expect(failureOf(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
  });

  it('an error without a cause keeps its message', () => {
    expect(failureOf(new Error('boom'))).toBe('error (boom)');
  });
});

describe('NODE_EXTRA_CA_CERTS status', () => {
  it('says whether the certificate file is there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-'));
    const pem = join(dir, 'ca.pem');
    writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n');
    expect(extraCaStatus(pem)).toMatch(/\(1 certificate\)$/);
    expect(extraCaStatus(join(dir, 'missing.pem'))).toMatch(/cannot be read/);
    expect(extraCaStatus(undefined)).toMatch(/not set/);
  });

  it('the committed certificate is the Sectigo DV R36 intermediate', () => {
    expect(extraCaStatus(join(import.meta.dirname, 'certs/sectigo-dv-r36.pem'))).toMatch(
      /\(1 certificate\)$/,
    );
  });
});
