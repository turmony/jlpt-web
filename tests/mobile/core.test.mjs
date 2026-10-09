import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCards, createSession, createTapHandler, adjacentRanges } from '../../mobile/core.mjs';

const cards = Array.from({ length: 10 }, (_, i) => ({
  id: `N1-G-${String(31 + i).padStart(4, '0')}`, level: 'N1', number: 31 + i,
  images: { connection: `connection-${i}.png`, example: `example-${i}.png` },
}));
const catalog = { schema: 1, cards };

test('quick ranges use the same inclusive length on either side', () => {
  assert.deepEqual(adjacentRanges('41', '50'), { previous: [31, 40], next: [51, 60] });
  assert.deepEqual(adjacentRanges(21, 25), { previous: [16, 20], next: [26, 30] });
});

test('quick ranges reject invalid input and omit ranges outside 1–9999', () => {
  assert.deepEqual(adjacentRanges(1, 10), { previous: null, next: [11, 20] });
  assert.deepEqual(adjacentRanges(9990, 9999), { previous: [9980, 9989], next: null });
  for (const [start, end] of [['', 50], [51, 50], [0, 10], [1.5, 10], [1, 10000]]) {
    assert.equal(adjacentRanges(start, end), null);
  }
});

test('N1 31–40 selects ten cards with twenty images in order', () => {
  const selected = selectCards(catalog, 'N1', '31', '40');
  assert.equal(selected.length, 10);
  assert.equal(selected[0].id, 'N1-G-0031');
  assert.equal(selected[9].id, 'N1-G-0040');
  assert.equal(new Set(selected.flatMap(c => Object.values(c.images))).size, 20);
});

test('reversed, non-integer, zero and invalid levels are rejected', () => {
  for (const [level, start, end] of [['N1', 40, 31], ['N1', '31.5', 40], ['N1', 0, 40], ['N9', 31, 40], ['N1', '', 40]]) {
    assert.throws(() => selectCards(catalog, level, start, end));
  }
});

test('missing card identifies its number instead of silently skipping', () => {
  assert.throws(() => selectCards({ cards: cards.filter(c => c.number !== 35) }, 'N1', 31, 40), /0035/);
});

test('missing screenshot identifies the card', () => {
  const incomplete = structuredClone(catalog);
  incomplete.cards[0].images.example = null;
  assert.throws(() => selectCards(incomplete, 'N1', 31, 40), /0031.*图片/);
});

test('saved progress restores a card and stale ids return to the first', () => {
  assert.equal(createSession(cards, 'N1-G-0035').current.id, 'N1-G-0035');
  assert.equal(createSession(cards, 'N1-G-9999').current.id, 'N1-G-0031');
});

test('navigation stays inside range and resets to connection', () => {
  const session = createSession(cards);
  session.move(-1);
  assert.equal(session.index, 0);
  session.toggle();
  assert.equal(session.side, 'example');
  session.move(1);
  assert.equal(session.side, 'connection');
  assert.equal(session.index, 1);
  session.jump(40);
  session.move(1);
  assert.equal(session.index, 9);
  assert.throws(() => session.jump(41), /区间/);
  assert.equal(session.index, 9);
});

test('double tap cancels pending single tap', async () => {
  const actions = [];
  const taps = createTapHandler({ single: x => actions.push(`single:${x}`), double: () => actions.push('double'), delay: 20 });
  taps.tap(1, { x: 10, y: 10 });
  taps.tap(1, { x: 12, y: 12 });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(actions, ['double']);
});

test('single tap runs once and cancellation suppresses navigation', async () => {
  const actions = [];
  const taps = createTapHandler({ single: x => actions.push(x), double: () => actions.push('double'), delay: 10 });
  taps.tap(-1, { x: 10, y: 10 });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(actions, [-1]);
  taps.tap(1, { x: 10, y: 10 });
  taps.cancel();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(actions, [-1]);
});

test('two distant taps are distinct singles', async () => {
  const actions = [];
  const taps = createTapHandler({ single: x => actions.push(x), double: () => actions.push('double'), delay: 10 });
  taps.tap(-1, { x: 10, y: 10 });
  taps.tap(1, { x: 200, y: 10 });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(actions, [-1, 1]);
});

test('second touch reserves the pending tap until released', async () => {
  const actions = [];
  const taps = createTapHandler({ single: x => actions.push(x), double: () => actions.push('double'), delay: 25 });
  taps.tap(1, { x: 10, y: 10 });
  taps.start({ x: 12, y: 12 });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(actions, []);
  taps.tap(1, { x: 12, y: 12 });
  assert.deepEqual(actions, ['double']);
});
