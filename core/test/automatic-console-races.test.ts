import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { AutomaticPoolConsole } from '../src/automatic-console.ts';
import { revisionedSecrets } from '../src/automatic-approval.ts';
import type { Provider } from '../src/types.ts';
const provider = (id: string): Provider => ({ id, name: `Fake ${id}`, baseUrl: `http://127.0.0.1:1/${id}`, models: ['mock-coder'], protocols: ['chat'], route: 'chat-translate', routePinned: true, streamUsage: false, createdAt: 'fake' });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'es-automatic-console-races-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), values = new Map([['a', 'fake-secret-a'], ['b', 'fake-secret-b']]);
  const hook: { read?: (id: string) => Promise<void> } = {};
  const raw = { get: async (id: string) => { const v = values.get(id); await hook.read?.(id); return v; }, set: async (id: string, v: string) => { values.set(id, v); }, delete: async (id: string) => { values.delete(id); } };
  const secrets = revisionedSecrets(store, raw);
  store.upsertProvider(provider('a')); store.upsertProvider(provider('b'));
  const binding = { harness: 'aider', providerId: 'a', model: 'mock-coder' }; store.setBinding(binding);
  const console = new AutomaticPoolConsole(store, secrets), members = ['a/mock-coder', 'b/mock-coder'];
  return { store, values, hook, secrets, console, binding, members };
}
test('confirm installs no grant whose local source revision changed after async validation', async t => {
  const results = [];
  for (let ticks = 1; ticks <= 12; ticks++) {
    const f = fixture(t), p = await f.console.preview('a/mock-coder', 'aider');
    const expected = f.store.providerConfigurationRevision('a'); let staleAtInstall = false, installed = false, changed = false;
    const install = f.store.installAutomaticPoolAndBind.bind(f.store);
    f.store.installAutomaticPoolAndBind = (pool, harness) => { installed = true; staleAtInstall = expected !== f.store.providerConfigurationRevision('a'); install(pool,harness); };
    let once = true;
    f.hook.read = async id => { if(id === 'b' && once) { once = false; let left = ticks;
      const later = () => { if (--left) queueMicrotask(later); else { changed = true; f.store.upsertProvider({ ...f.store.provider('a')!, billing: 'subscription' }); } };
      queueMicrotask(later);
    } };
    let status; try { await f.console.confirm(p.confirmationId); status = 'accepted'; } catch { status = 'rejected'; }
    await new Promise<void>(r => setTimeout(r, 0));
    results.push({ ticks, status, installed, staleAtInstall, changed });
  }
  assert.equal(results.filter(r => r.staleAtInstall).length, 0, 'Confirmed grant was already locally stale at the atomic install call');
});

test('preview never stores a review whose source revision changed after the mint await', async t => {
  const results = [];
  for (let ticks = 1; ticks <= 12; ticks++) {
    const f = fixture(t); const expected = f.store.providerConfigurationRevision('a'); let staleAtStore = false, stored = false;
    const pending = (f.console as any).pending as Map<string, unknown>; const set = pending.set.bind(pending);
    pending.set = (key,value) => { stored = true; staleAtStore = expected !== f.store.providerConfigurationRevision('a'); return set(key,value); };
    let once = true; f.hook.read = async id => { if(id === 'b' && once) { once = false; let left = ticks;
      const later = () => { if (--left) queueMicrotask(later); else f.store.upsertProvider({ ...f.store.provider('a')!, billing: 'subscription' }); }; queueMicrotask(later);
    } };
    let status; try { await f.console.preview('a/mock-coder', 'aider'); status = 'accepted'; } catch { status = 'rejected'; }
    await new Promise<void>(r => setTimeout(r, 0)); results.push({ ticks, status, stored, staleAtStore });
  }
  assert.equal(results.filter(r => r.staleAtStore).length, 0);
});
test('idempotent retry never clones a successful result after a local source change in its final await gap', async t => {
  const results = [];
  for (let ticks = 1; ticks <= 12; ticks++) {
    const f = fixture(t), p = await f.console.preview('a/mock-coder', 'aider'); await f.console.confirm(p.confirmationId);
    const expected = f.store.providerConfigurationRevision('a'), result = (f.console as any).pending.get(p.confirmationId).result;
    let staleAtClone = false, cloned = false; const clone = globalThis.structuredClone;
    globalThis.structuredClone = ((value, options) => { if (value === result) { cloned = true; staleAtClone = expected !== f.store.providerConfigurationRevision('a'); } return clone(value, options); }) as typeof globalThis.structuredClone;
    let once = true; f.hook.read = async id => { if(id === 'b' && once) { once = false; let left = ticks;
      const later = () => { if (--left) queueMicrotask(later); else f.store.upsertProvider({ ...f.store.provider('a')!, billing: 'subscription' }); }; queueMicrotask(later);
    } };
    let status; try { await f.console.confirm(p.confirmationId); status = 'accepted'; } catch { status = 'rejected'; } finally { globalThis.structuredClone = clone; }
    await new Promise<void>(r => setTimeout(r, 0)); results.push({ ticks, status, cloned, staleAtClone });
  }
  assert.equal(results.filter(r => r.staleAtClone).length, 0);
});
