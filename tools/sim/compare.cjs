#!/usr/bin/env node
'use strict';
// 같은 시드(직업·난이도·회차)끼리 짝지어 기준(base)과 변형의 클리어율을 비교한다.
// 예) node tools/sim/compare.cjs sim-out/before/base.jsonl sim-out/before/botAlly.jsonl [더 많은 변형...]
const {load, pct, DIFF_KO, mean} = require('./analyze.cjs');

function pairs(base, variant) {
    const idx = new Map(base.map(r => [r.cls + '|' + r.diff + '|' + r.seed, r]));
    const out = [];
    for (const v of variant) { const b = idx.get(v.cls + '|' + v.diff + '|' + v.seed); if (b) out.push([b, v]); }
    return out;
}
// 짝 비교: 차이 = 변형 클리어율 − 기준 클리어율, 95% 신뢰구간(정규 근사)
function pairedDiff(ps) {
    const n = ps.length;
    if (!n) return {n: 0};
    let b = 0, c = 0, kb = 0, kv = 0;
    for (const [x, y] of ps) { kb += x.cleared; kv += y.cleared; if (x.cleared && !y.cleared) b++; if (!x.cleared && y.cleared) c++; }
    const d = (c - b) / n;
    const se = Math.sqrt(Math.max(0, (b + c) / n - d * d) / n);
    return {n, base: kb / n, variant: kv / n, d, lo: d - 1.96 * se, hi: d + 1.96 * se};
}
function row(label, r) {
    return `| ${label} | ${r.n} | ${pct(r.base)}% | ${pct(r.variant)}% | ${r.d >= 0 ? '+' : ''}${pct(r.d)}%p (${pct(r.lo)}~${pct(r.hi)}) |`;
}
function compareTable(base, variants, {byDiff = true} = {}) {
    const L = ['| 변형 · 난이도 | 짝 런 | 기준 | 변형 | 차이 (95% CI) |', '|---|---:|---:|---:|---:|'];
    for (const [name, v] of variants) {
        const ps = pairs(base, v);
        L.push(row(`**${name}** 전체`, pairedDiff(ps)));
        if (byDiff) for (const d of [...new Set(ps.map(p => p[0].diff))].sort()) L.push(row(`${name} · ${DIFF_KO[d]}`, pairedDiff(ps.filter(p => p[0].diff === d))));
    }
    return L.join('\n');
}
function botBossTable(variants) {
    const L = ['| 소환 층(이상) | 소환 런 | 소환 전투 사망률 | 승리 시 EXP | 승리 시 골드 | 승리 시 장비 | 전투 후 HP |', '|---|---:|---:|---:|---:|---:|---:|'];
    for (const [name, v] of variants) {
        const s = v.filter(r => r.bot && r.bot.result);
        const w = s.filter(r => r.bot.result === 'win');
        const dead = s.filter(r => r.bot.result === 'death').length;
        L.push(`| ${name} | ${s.length} | ${pct(dead / Math.max(1, s.length))}% | ${mean(w.map(r => r.bot.expGain)).toFixed(0)} | ${mean(w.map(r => r.bot.goldGain)).toFixed(0)} | ${mean(w.map(r => r.bot.itemGain)).toFixed(2)} | ${pct(mean(w.map(r => r.bot.hpAfter || 0)), 0)}% |`);
    }
    return L.join('\n');
}

if (require.main === module) {
    const files = process.argv.slice(2);
    const base = load([files[0]]);
    const vs = files.slice(1).map(f => [f.replace(/^.*\//, '').replace(/\.jsonl$/, ''), load([f])]);
    console.log(compareTable(base, vs));
    if (vs.some(([, v]) => v.some(r => r.bot))) { console.log(''); console.log(botBossTable(vs.filter(([, v]) => v.some(r => r.bot)))); }
}
module.exports = {pairs, pairedDiff, compareTable, botBossTable};
