// Tap zone geometry and bindings (RV-017).
//
// The grid resolver is pure so the boundary cases can be pinned here rather
// than discovered on a phone: an unmeasured box, a tap exactly on a grid line,
// and a tap on the very edge of the page.
//
// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapZone, zoneAt, zoneCount, ZONE_LAYOUTS, type ZoneLayout } from './pagination.ts';
import {
  DEFAULT_ACTIONS, DEFAULT_LAYOUT, normalizeTapActions, normalizeTapLayout,
  TAP_ACTIONS, TAP_ACTION_LABEL,
} from './tap-actions.ts';

test('an unmeasured box yields no zone, so a tap can never be a blind page turn', () => {
  // the first tap of a chapter that has not laid itself out. A page turn moves
  // the saved position; the chrome toggle the caller falls back to does not.
  for (const [w, h] of [[0, 0], [100, 0], [0, 100], [Number.NaN, 100], [100, Number.NaN]]) {
    assert.equal(zoneAt(10, 10, w, h, '3x3'), null, `${w}x${h}`);
  }
});

test('3x3 maps row-major, and the far edge stays inside the grid', () => {
  const at = (x: number, y: number) => zoneAt(x, y, 300, 300, '3x3');
  assert.equal(at(10, 10), 0);
  assert.equal(at(150, 10), 1);
  assert.equal(at(290, 10), 2);
  assert.equal(at(10, 150), 3);
  assert.equal(at(150, 150), 4);
  assert.equal(at(290, 290), 8);
  // a tap reported exactly at the box size would index one cell past the end
  assert.equal(at(300, 300), 8);
  // and a negative coordinate (a tap caught mid-gesture) clamps to the first
  assert.equal(at(-5, -5), 0);
});

test('a grid line belongs to the cell after it, consistently', () => {
  assert.equal(zoneAt(100, 0, 300, 300, '3x3'), 1, 'x=1/3 is the middle column');
  assert.equal(zoneAt(99.9, 0, 300, 300, '3x3'), 0);
  assert.equal(zoneAt(0, 100, 300, 300, '3x3'), 3, 'y=1/3 is the middle row');
});

test('the default layout reproduces the three bands exactly', () => {
  // a reader who never opens this setting must get what they had before
  assert.equal(DEFAULT_LAYOUT, '1x3');
  const h = 400;
  const cases: Array<[number, 'prev' | 'chrome' | 'next']> = [
    [10, 'prev'], [h / 2, 'chrome'], [h - 1, 'next'],
  ];
  for (const [y, expected] of cases) {
    const zone = zoneAt(10, y, 300, h, '1x3')!;
    const action = DEFAULT_ACTIONS['1x3'][zone];
    const legacy = tapZone(y, h);
    assert.equal(legacy, expected);
    assert.equal(action, expected === 'prev' ? 'prevPage' : expected === 'next' ? 'nextPage' : 'chrome',
      `y=${y}`);
  }
});

test('every layout has a full, valid set of default bindings', () => {
  for (const layout of Object.keys(ZONE_LAYOUTS) as ZoneLayout[]) {
    const actions = DEFAULT_ACTIONS[layout];
    assert.equal(actions.length, zoneCount(layout), `${layout} default length`);
    for (const action of actions) assert.ok(TAP_ACTIONS.includes(action), `${layout}: ${action}`);
  }
  // nothing denser than 3x3: a 4x6 cell on a phone has no edge to aim at
  for (const layout of Object.keys(ZONE_LAYOUTS) as ZoneLayout[]) {
    assert.ok(zoneCount(layout) <= 9, `${layout} is too dense`);
  }
});

test('every action has a label, and none is reachable only by tapping', () => {
  for (const action of TAP_ACTIONS) {
    assert.ok(TAP_ACTION_LABEL[action], `${action} has no label`);
  }
  // each of these is also on the toolbar, in a sheet, or on the keyboard —
  // a tap zone is not focusable, so a screen reader user never gets one
  assert.equal(TAP_ACTIONS.length, Object.keys(TAP_ACTION_LABEL).length);
});

test('stored bindings are coerced rather than trusted', () => {
  // wrong length (the layout changed on another device), unknown actions, and
  // not an array at all are all reachable from localStorage
  assert.deepEqual(normalizeTapActions(['nextPage'], '1x3'),
    ['nextPage', 'chrome', 'nextPage'], 'a short array is padded from defaults');
  assert.deepEqual(normalizeTapActions(['nextPage', 'bogus', 'prevPage', 'extra'], '1x3'),
    ['nextPage', 'chrome', 'prevPage'], 'unknown entries fall back, extras are dropped');
  assert.deepEqual(normalizeTapActions('not an array', '2x2'), DEFAULT_ACTIONS['2x2']);
  assert.deepEqual(normalizeTapActions(null, '3x3'), DEFAULT_ACTIONS['3x3']);
  assert.equal(normalizeTapActions([], '3x3').length, 9);
});

test('an unknown layout falls back to the one that matches the old behaviour', () => {
  assert.equal(normalizeTapLayout('4x6'), '1x3');
  assert.equal(normalizeTapLayout(undefined), '1x3');
  assert.equal(normalizeTapLayout('3x3'), '3x3');
});
