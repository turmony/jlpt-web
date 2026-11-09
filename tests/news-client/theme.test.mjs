import test from 'node:test';
import assert from 'node:assert/strict';
import {parseColor, isDarkColor, resolveTheme, normalizeMode} from '../../news-client/theme.mjs';

test('parseColor reads rgb(), rgba() and the space-separated forms', () => {
  assert.deepEqual(parseColor('rgb(255, 255, 255)'), {r: 255, g: 255, b: 255, a: 1});
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), {r: 10, g: 20, b: 30, a: 0.5});
  assert.deepEqual(parseColor('rgb(10 20 30 / 40%)'), {r: 10, g: 20, b: 30, a: 0.4});
  assert.equal(parseColor('transparent'), null);
  assert.equal(parseColor(''), null);
  assert.equal(parseColor('color(srgb 1 1 1)'), null);
});

test('isDarkColor judges by perceived luminance', () => {
  assert.equal(isDarkColor({r: 0, g: 0, b: 0}), true);
  assert.equal(isDarkColor({r: 24, g: 25, b: 26}), true);
  assert.equal(isDarkColor({r: 255, g: 255, b: 255}), false);
  assert.equal(isDarkColor({r: 240, g: 240, b: 120}), false);
  assert.equal(isDarkColor({r: 30, g: 60, b: 160}), true);
});

test('resolveTheme: a manual mode wins, auto follows the page', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
});

test('normalizeMode falls back to auto for anything unknown', () => {
  assert.equal(normalizeMode('dark'), 'dark');
  assert.equal(normalizeMode('light'), 'light');
  assert.equal(normalizeMode('auto'), 'auto');
  assert.equal(normalizeMode('blue'), 'auto');
  assert.equal(normalizeMode(null), 'auto');
});
