import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS } from '../utils/fetch.js';

describe('fetchWithTimeout', () => {
  it('aborts a hanging request after timeoutMs', async () => {
    const orig = globalThis.fetch;
    // A fetch that never resolves unless its signal aborts.
    globalThis.fetch = (url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      }, { once: true });
    });
    try {
      await assert.rejects(() => fetchWithTimeout('http://x', {}, 30));
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('resolves normally when the request completes before the timeout', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true });
    try {
      const res = await fetchWithTimeout('http://x', {}, 1000);
      assert.equal(res.ok, true);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('opts out (plain fetch, no injected signal) when timeoutMs <= 0', async () => {
    const orig = globalThis.fetch;
    let sawSignal = 'unset';
    globalThis.fetch = async (url, opts) => { sawSignal = opts?.signal; return { ok: true }; };
    try {
      await fetchWithTimeout('http://x', {}, 0);
      assert.equal(sawSignal, undefined);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('exports a sane default timeout', () => {
    assert.ok(DEFAULT_FETCH_TIMEOUT_MS >= 5000 && DEFAULT_FETCH_TIMEOUT_MS <= 60000);
  });
});
