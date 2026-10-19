#!/usr/bin/env node
'use strict';
// 병렬 시뮬레이션 실행기. 결과는 런마다 JSON 한 줄(JSONL).
// 예) node tools/sim/simulate.cjs --runs 200 --diffs 1-6 --out sim-out/base.jsonl
//     node tools/sim/simulate.cjs --runs 100 --diffs 2,3 --variant botBoss5 --botBossFloor 5
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const CLASSES = ['warrior', 'rogue', 'mage', 'cleric', 'hunter', 'dhampir', 'paladin', 'druid', 'berserker', 'madman', 'bard', 'princess', 'necro', 'monk', 'alchemist', 'succubus'];

function parseArgs(argv) {
    const a = {runs: 50, diffs: '1-6', classes: 'all', seed: 1, workers: Math.max(1, os.cpus().length), out: null, variant: 'base', source: null};
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) { a[k] = true; continue; }
        a[k] = v; i++;
    }
    const range = s => String(s).split(',').flatMap(x => { const m = /^(\d+)-(\d+)$/.exec(x); if (!m) return [+x]; const r = []; for (let i = +m[1]; i <= +m[2]; i++) r.push(i); return r; });
    a.diffs = range(a.diffs);
    a.classes = a.classes === 'all' ? CLASSES : String(a.classes).split(',');
    a.runs = +a.runs; a.seed = +a.seed; a.workers = +a.workers;
    return a;
}

function policyOpts(a) {
    const o = {};
    if (a.botAlly) o.botAlly = true;
    if (a.botBossFloor) o.botBossFloor = +a.botBossFloor;
    if (a.roles) o.roles = a.roles;
    if (a.dragonNest) o.dragonNest = a.dragonNest;
    if (a.noDefendCharge) o.defendCharge = false;
    if (a.potionBattleHp) o.potionBattleHp = +a.potionBattleHp;
    if (a.potionRestHp) o.potionRestHp = +a.potionRestHp;
    return o;
}

// 시드: (기본 시드, 직업, 난이도, 회차)로 결정. 변형(variant) 간에 같은 시드를 써서 짝지은 비교가 되게 한다.
function seedFor(base, ci, diff, i) { return ((base * 1000003) ^ (ci * 7919 + diff * 104729 + i * 15485863)) >>> 0; }

if (isMainThread) {
    const a = parseArgs(process.argv);
    const jobs = [];
    for (const diff of a.diffs) for (let ci = 0; ci < a.classes.length; ci++) for (let i = 0; i < a.runs; i++) {
        const cls = a.classes[ci];
        jobs.push({cls, diff, seed: seedFor(a.seed, CLASSES.indexOf(cls), diff, i)});
    }
    const out = a.out ? fs.createWriteStream(a.out) : null;
    if (a.out) fs.mkdirSync(path.dirname(path.resolve(a.out)), {recursive: true});
    const n = Math.min(a.workers, jobs.length);
    let done = 0, cleared = 0;
    const t0 = Date.now();
    const chunks = Array.from({length: n}, (_, w) => jobs.filter((_, j) => j % n === w));
    let alive = n;
    for (const chunk of chunks) {
        const w = new Worker(__filename, {workerData: {jobs: chunk, opts: policyOpts(a), variant: a.variant, source: a.source}});
        w.on('message', rec => {
            done++; if (rec.cleared) cleared++;
            if (out) out.write(JSON.stringify(rec) + '\n');
            if (!a.quiet && done % 200 === 0) process.stderr.write(`  ${done}/${jobs.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
        });
        w.on('error', e => { console.error(e); process.exitCode = 1; });
        w.on('exit', () => {
            if (--alive === 0) {
                if (out) out.end();
                console.log(`${a.variant}: ${done} runs, clear ${(100 * cleared / Math.max(1, done)).toFixed(1)}%, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            }
        });
    }
} else {
    const {Sim, loadSource} = require('./engine.cjs');
    const {Policy} = require('./policy.cjs');
    const {runGame} = require('./run-game.cjs');
    const sim = new Sim(loadSource(workerData.source));
    for (const job of workerData.jobs) {
        const rec = runGame(sim, Object.assign({}, job, {policy: new Policy(workerData.opts), variant: workerData.variant}));
        parentPort.postMessage(rec);
    }
}

module.exports = {CLASSES, seedFor};
