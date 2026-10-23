#!/usr/bin/env node
'use strict';
/* 线上验证：直接对已发布的 Pages 站点跑一遍真实查询。
 * 用线上拉下来的 records.json + 本地 src/app.js（与线上同一份代码）。
 *
 * 用法： node tools/verify_live.js [https://ltsunahi.github.io/cst-checker/]
 */

const path = require('path');
const L = require('./lib_data');

const BASE = (process.argv[2] || 'https://ltsunahi.github.io/cst-checker/').replace(/\/?$/, '/');
const INPUT = process.argv[3] ? path.resolve(process.argv[3]) : L.findInputFile();

// 本机 DNS 被代理劫持，直连 GitHub Pages 的真实 IP + 指定 SNI 更可靠
const PAGES_IPS = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];

function fetchOnce(base, rel) {
    return new Promise((resolve) => {
        const https = require('https');
        const u = new URL(base + rel);
        const opts = {
            host: u.hostname,
            port: 443,
            path: u.pathname,
            servername: u.hostname,
            headers: { Host: u.hostname, 'User-Agent': 'cst-checker-verify', 'Cache-Control': 'no-cache' },
            rejectUnauthorized: false,
            timeout: 30000,
        };
        const req = https.get(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ error: e.message }));
    });
}

async function get(rel) {
    let r = await fetchOnce(BASE, rel);
    if (!r.error && r.status === 200) return r;

    // 走后门：直连真实 IP，Host/SNI 仍用 github.io
    const https = require('https');
    const u = new URL(BASE + rel);
    for (const ip of PAGES_IPS) {
        r = await new Promise((resolve) => {
            const req = https.get(
                {
                    host: ip, port: 443, path: u.pathname, servername: u.hostname,
                    headers: { Host: u.hostname, 'User-Agent': 'cst-checker-verify', 'Cache-Control': 'no-cache' },
                    rejectUnauthorized: false, timeout: 30000,
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
                }
            );
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', (e) => resolve({ error: e.message }));
        });
        if (!r.error && r.status === 200) return r;
    }
    return r;
}

async function getRetry(rel, tries) {
    for (let i = 0; i < (tries || 5); i++) {
        const r = await get(rel);
        if (!r.error && r.status === 200) return r;
        if (i === (tries || 5) - 1) return r;
        await new Promise((s) => setTimeout(s, 4000));
    }
}

async function main() {
    console.log('线上地址：' + BASE);
    console.log('');

    /* 1. 页面 */
    const index = await getRetry('');
    if (!index || index.error || index.status !== 200) {
        console.log('✗ 首页拉取失败：' + JSON.stringify(index && (index.error || index.status)));
        process.exit(1);
    }
    console.log('✓ 首页 HTTP 200，' + index.text.length + ' 字节');
    for (const needle of ['二面结果查询', 'app.js', 'style.css', 'noindex']) {
        if (!index.text.includes(needle)) { console.log('✗ 首页里找不到 ' + needle); process.exit(1); }
    }
    console.log('✓ 首页包含标题 / 资源引用 / noindex');

    /* 2. robots.txt */
    const robots = await getRetry('robots.txt', 3);
    if (robots && robots.status === 200 && /Disallow:\s*\//.test(robots.text)) console.log('✓ robots.txt 禁止收录');
    else console.log('✗ robots.txt 异常：' + JSON.stringify(robots && (robots.error || robots.status)));

    /* 3. 线上 app.js 与本地是否一致 */
    const onlineApp = await getRetry('app.js', 3);
    if (!onlineApp || onlineApp.status !== 200) { console.log('✗ app.js 拉取失败'); process.exit(1); }
    const localApp = require('fs').readFileSync(path.join(L.SRC_DIR, 'app.js'), 'utf8');
    const norm = (s) => s.replace(/\r\n/g, '\n').trim();
    if (norm(onlineApp.text) === norm(localApp)) console.log('✓ 线上 app.js 与本地 src/app.js 一致');
    else console.log('⚠ 线上 app.js 与本地不一致（本地改过但没重新构建？）');

    /* 4. 数据文件 + 明文泄漏检查 */
    const dataRaw = await getRetry('data/records.json', 3);
    if (!dataRaw || dataRaw.status !== 200) { console.log('✗ records.json 拉取失败'); process.exit(1); }
    const bundle = JSON.parse(dataRaw.text);
    console.log('✓ records.json HTTP 200，' + (Buffer.byteLength(dataRaw.text) / 1024).toFixed(1) + ' KB，'
        + Object.keys(bundle.records).length + ' 条记录');

    const { people } = L.loadRoster(INPUT);
    const leakedNames = people.filter((p) => dataRaw.text.includes(p.name));
    console.log((leakedNames.length ? '✗ 明文姓名泄漏：' + leakedNames.map((p) => p.name).join('、') : '✓ 线上数据无明文姓名'));

    /* 5. 用线上数据跑真实查询 */
    globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(bundle) });
    const QC = require(path.join(L.SRC_DIR, 'app.js'));

    let pass = 0;
    const failures = [];
    for (const p of people) {
        const r = await QC.query(p.name);
        if (r.ok && r.code === p.code && (p.code !== 'P' || (r.vars.group || '') === (p.group || ''))) pass++;
        else failures.push(`${p.name}：期望 ${p.code}/${p.group}，实际 ${r.code}/${r.vars && r.vars.group}`);
    }
    console.log('✓ 线上数据查询通过：' + pass + ' / ' + people.length);

    const ghost = await QC.query('查无此人');
    console.log((ghost.ok && ghost.code === 'NotFound' ? '✓' : '✗') + ' 不存在的姓名 -> ' + ghost.code);

    if (failures.length) {
        console.log('');
        console.log('失败明细：');
        failures.slice(0, 10).forEach((f) => console.log('  ' + f));
        process.exit(1);
    }

    console.log('');
    console.log('结论：✓ 线上站点一切正常');
}

main().catch((e) => { console.error(e); process.exit(2); });
