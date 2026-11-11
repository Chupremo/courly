import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../players.js', import.meta.url), 'utf8').replace(/^import[^;]+;/m, '');
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };

function setup(result) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', textContent: '', innerHTML: '', hidden: false, listeners: {}, attributes: {},
      addEventListener(type, handler) { this.listeners[type] = handler; },
      setAttribute(key, value) { this.attributes[key] = value; },
      insertAdjacentHTML(_position, html) { this.innerHTML += html; }, focus() {}
    });
    return nodes.get(id);
  }
  let currentResult = result;
  const context = {
    document: { getElementById: node }, URL, URLSearchParams,
    location: { search: '', href: 'https://courtly.test/players.html' },
    history: { replaceState() {} }, console: { error() {} },
    supabase: { from() { return { select() { return { eq() { return { in() { return { order: async () => currentResult }; } }; } }; } }; } }
  };
  vm.runInNewContext(source, context);
  return { node, setResult(next) { currentResult = next; } };
}

test('editing filters after a failed load preserves the recoverable error state', async () => {
  const app = setup({ error: new Error('Offline') });
  await flush();
  app.node('search').value = 'badminton';
  app.node('search').listeners.input();
  assert.match(app.node('listings').innerHTML, /couldn’t load/);
  assert.match(app.node('listings').innerHTML, /data-action="retry"/);
  assert.equal(app.node('count').textContent, 'Venues unavailable');
  assert.equal(app.node('listings').attributes['aria-busy'], 'false');
});

test('missing rates are not advertised as zero-price court rentals', async () => {
  const app = setup({ data: [{ name: 'Test venue', slug: 'sample', courts: [{ name: 'Court 1', sport: 'Badminton', hourly_rate: null }] }], error: null });
  await flush();
  assert.match(app.node('listings').innerHTML, /Rates not listed/);
  assert.doesNotMatch(app.node('listings').innerHTML, /₱0/);
});

test('a selected sport shows matching courts and their prices at mixed-sport venues', async () => {
  const app = setup({ data: [{ name: 'Mixed venue', slug: 'mixed', courts: [{ name: 'Basketball court', sport: 'Basketball', hourly_rate: 100 }, { name: 'Tennis court', sport: 'Tennis', hourly_rate: 500 }] }], error: null });
  await flush();
  app.node('sport').value = 'Tennis';
  app.node('sport').listeners.input();
  assert.match(app.node('listings').innerHTML, /Tennis court/);
  assert.match(app.node('listings').innerHTML, /₱500/);
  assert.doesNotMatch(app.node('listings').innerHTML, /Basketball court|₱100/);
});

test('retry recovers listings after a network error without losing a search', async () => {
  const app = setup({ error: new Error('Offline') });
  await flush();
  app.node('search').value = 'Test';
  app.setResult({ data: [{ name: 'Test venue', slug: 'sample', courts: [{name:'Court 1',is_active:true}] }], error: null });
  app.node('listings').listeners.click({ target: { closest: () => ({ dataset: { action: 'retry' } }) } });
  await flush();
  assert.equal(app.node('search').value, 'Test');
  assert.match(app.node('listings').innerHTML, /Test venue/);
  assert.equal(app.node('count').textContent, '1 venue found');
});
