// 시뮬레이터 스모크 테스트(빠른 소규모). 전체 측정은 `npm run sim` 으로 따로 실행한다.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Sim} = require('../tools/sim/engine.cjs');
const {runGame} = require('../tools/sim/run-game.cjs');
const {Policy} = require('../tools/sim/policy.cjs');

test('headless simulator finishes seeded runs deterministically without errors', () => {
    const sim = new Sim();
    const a = runGame(sim, {cls: 'warrior', diff: 1, seed: 42, policy: new Policy()});
    assert.equal(a.stuck, null, String(a.stuck));
    assert.equal(a.errors, 0);
    assert.ok(a.cleared || a.death, 'run must end in clear or death');
    assert.ok(a.battleActions > 0 && a.rooms > 0);
    const b = runGame(sim, {cls: 'warrior', diff: 1, seed: 42, policy: new Policy()});
    assert.deepEqual(b, a, 'same seed must reproduce the same run');
    const c = runGame(sim, {cls: 'mage', diff: 6, seed: 7, policy: new Policy({botAlly: true, botBossFloor: 1, roles: 'attack'})});
    assert.equal(c.stuck, null, String(c.stuck));
    assert.equal(c.errors, 0);
    assert.ok(c.bot && ['win', 'death'].includes(c.bot.result), 'bot boss summoned and resolved');
});
