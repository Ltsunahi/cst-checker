#!/usr/bin/env node
'use strict';
/* 构建：表格 -> public/data/records.json（逐条加密）+ 把 src 同步进 public
 *
 * 用法：
 *   node tools/build_data.js                     # 自动从 data\ 找表格
 *   node tools/build_data.js data\面试结果.xlsx   # 指定表格
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const L = require('./lib_data');

const PUBLIC = L.PUBLIC_DIR;
const SRC = L.SRC_DIR;
const DATA_OUT = path.join(PUBLIC, 'data');
const RECORDS = path.join(DATA_OUT, 'records.json');
const REPORT = path.join(L.ROOT, 'build-report.txt');

/* ---------------- 加解密（必须与 src/app.js 完全一致） ---------------- */

function hashId(pepper, sid, name) {
    return crypto.createHash('sha256').update(pepper + '|' + sid + '|' + name, 'utf8').digest('hex');
}

function deriveKey(sid, name, salt, iterations) {
    return crypto.pbkdf2Sync(Buffer.from(sid + '|' + name, 'utf8'), salt, iterations, 32, 'sha256');
}

function encryptRecord(key, payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString('base64'),
        // WebCrypto 的 AES-GCM 要求密文尾部带 16 字节认证标签
        ct: Buffer.concat([body, tag]).toString('base64'),
    };
}

/* ---------------- 目录准备 ---------------- */

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, entry.name);
        const d = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

/* ---------------- 主流程 ---------------- */

function main() {
    const inputArg = process.argv[2];
    const inputPath = inputArg ? path.resolve(inputArg) : L.findInputFile();

    if (!fs.existsSync(inputPath)) {
        console.error('找不到输入文件：' + inputPath);
        process.exit(1);
    }

    const started = Date.now();
    console.log('读入：' + inputPath);

    const { cfg, people, warnings, unmapped, header } = L.loadRoster(inputPath);
    if (!people.length) {
        console.error('没有解析出任何有效记录，已中止。');
        process.exit(1);
    }

    const iterations = (cfg.crypto && cfg.crypto.iterations) || 600000;
    const pepper = crypto.randomBytes(32).toString('hex');
    const salt = crypto.randomBytes(16);

    const templates = L.expandTemplates(cfg);
    const records = {};
    let collisions = 0;

    for (const p of people) {
        const id = hashId(pepper, p.sid, p.name);
        if (records[id]) collisions++;
        const key = deriveKey(p.sid, p.name, salt, iterations);
        records[id] = encryptRecord(key, { code: p.code, group: p.group || '' });
    }

    const bundle = {
        version: 1,
        generatedAt: new Date().toISOString(),
        kdf: {
            salt: salt.toString('base64'),
            iterations,
            pepper,
        },
        templates,
        records,
    };

    /* 同步 src -> public，并写入数据与 robots */
    copyDir(SRC, PUBLIC);
    fs.mkdirSync(DATA_OUT, { recursive: true });
    fs.writeFileSync(RECORDS, JSON.stringify(bundle), 'utf8');
    fs.writeFileSync(path.join(PUBLIC, 'robots.txt'),
        'User-agent: *\nDisallow: /\n', 'utf8');

    /* 统计 */
    const byCode = {};
    for (const p of people) byCode[p.code] = (byCode[p.code] || 0) + 1;

    const sizeKb = (fs.statSync(RECORDS).size / 1024).toFixed(1);
    const lines = [];
    lines.push('构建时间：' + new Date().toISOString());
    lines.push('输入文件：' + inputPath);
    lines.push('表头：' + header.map((h) => String(h)).join(' | '));
    lines.push('有效记录：' + people.length + ' 条');
    lines.push('结果分布：' + Object.entries(byCode).map(([k, v]) => `${k}=${v}`).join('  '));
    lines.push('PBKDF2 迭代：' + iterations);
    lines.push('数据文件：' + RECORDS + '（' + sizeKb + ' KB）');
    if (collisions) lines.push('⚠ 学号+姓名哈希碰撞：' + collisions + ' 次');
    if (unmapped.length) lines.push('⚠ 无法识别的结果值：' + JSON.stringify(unmapped));
    if (warnings.length) {
        lines.push('');
        lines.push('警告（' + warnings.length + ' 条）：');
        for (const w of warnings) lines.push('  - ' + w);
    }

    fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');

    console.log('');
    console.log('有效记录：' + people.length + ' 条');
    console.log('结果分布：' + Object.entries(byCode).map(([k, v]) => `${k}=${v}`).join('  '));
    console.log('数据文件：public\\data\\records.json（' + sizeKb + ' KB）');
    if (warnings.length) console.log('警告 ' + warnings.length + ' 条，详见 build-report.txt');
    console.log('未识别的结果值：' + (unmapped.length ? JSON.stringify(unmapped) : '无'));
    console.log('耗时 ' + (Date.now() - started) + ' ms');
    console.log('');
    console.log('完成。预览：node tools\\serve.js   然后打开 http://127.0.0.1:8788/');
}

main();
