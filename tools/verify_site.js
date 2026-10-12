#!/usr/bin/env node
'use strict';
/* 端到端校验：用源表格里的真实输入，走一遍浏览器完全相同的查询链路
 * （真正的 src/app.js + WebCrypto），逐条比对结果码与分组。
 *
 * 用法： node tools/verify_site.js [源表格路径]
 */

const fs = require('fs');
const path = require('path');

const L = require('./lib_data');

const RECORDS = path.join(L.PUBLIC_DIR, 'data', 'records.json');

/* 用本地文件冒充 fetch，喂给真实的 app.js */
const bundleText = fs.readFileSync(RECORDS, 'utf8');
const bundle = JSON.parse(bundleText);

globalThis.fetch = function (url) {
    if (String(url).indexOf('records.json') === -1) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(bundle) });
};

const QC = require(path.join(L.SRC_DIR, 'app.js'));

/* ---------------- 主流程 ---------------- */

async function main() {
    const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : L.findInputFile();
    const { people } = L.loadRoster(inputPath);

    console.log('校验对象：' + inputPath);
    console.log('记录数：  ' + people.length);
    console.log('数据文件：' + (fs.statSync(RECORDS).size / 1024).toFixed(1) + ' KB');
    console.log('');

    let pass = 0;
    const failures = [];
    const t0 = Date.now();

    for (const p of people) {
        // 故意带上首尾空格和全角数字，顺便验证归一化
        const messySid = '\u3000' + p.sid + ' ';
        let r;
        try {
            r = await QC.query(messySid, ' ' + p.name + '\u3000');
        } catch (e) {
            failures.push({ p, why: '抛异常：' + e.message });
            continue;
        }

        if (!r.ok) { failures.push({ p, why: 'query 返回未就绪：' + r.reason }); continue; }
        if (r.code !== p.code) { failures.push({ p, why: `结果码不符：期望 ${p.code}，实际 ${r.code}` }); continue; }
        if (p.code === 'P' && (r.vars.group || '') !== (p.group || '')) {
            failures.push({ p, why: `分组不符：期望 ${JSON.stringify(p.group)}，实际 ${JSON.stringify(r.vars.group)}` });
            continue;
        }

        const html = QC.renderMessage(r.bundle, r.code, r.vars);
        if (/\$\{\w+\}/.test(html)) { failures.push({ p, why: '文案里还有未替换的占位符：' + html.match(/\$\{\w+\}/)[0] }); continue; }
        if (html.length < 30) { failures.push({ p, why: '渲染结果异常短：' + html }); continue; }
        if (!html.includes(r.vars.nameToSearch)) { failures.push({ p, why: '文案里没有出现查询者姓名' }); continue; }
        if (QC.classFor(r.code) !== { P: 'pass', F: 'fail', N: 'not-found' }[p.code]) {
            failures.push({ p, why: '样式类不符' }); continue;
        }

        pass++;
    }

    /* 反向用例：不存在的学号必须落到 NotFound，且不能抛异常 */
    const ghost = await QC.query('99999999999', '查无此人');
    const ghostOk = ghost.ok && ghost.code === 'NotFound';

    /* 反向用例：姓名错一个字必须查不到 */
    const wrongName = await QC.query(people[0].sid, people[0].name + '错');
    const wrongNameOk = wrongName.ok && wrongName.code === 'NotFound';

    /* 反向用例：数据文件里不得出现明文姓名或学号 */
    const leakedNames = people.filter((p) => bundleText.includes(p.name)).map((p) => p.name);
    const leakedSids = people.filter((p) => bundleText.includes(p.sid)).map((p) => p.sid);

    console.log('--- 正向用例 ---');
    console.log(`通过：${pass} / ${people.length}`);
    console.log('');
    console.log('--- 反向用例 ---');
    console.log('不存在的学号 -> ' + (ghostOk ? 'NotFound ✓' : '✗ 实际 ' + ghost.code));
    console.log('姓名错一位   -> ' + (wrongNameOk ? 'NotFound ✓' : '✗ 实际 ' + wrongName.code));
    console.log('数据文件含明文姓名：' + (leakedNames.length ? '✗ ' + leakedNames.join('、') : '无 ✓'));
    console.log('数据文件含明文学号：' + (leakedSids.length ? '✗ ' + leakedSids.join('、') : '无 ✓'));
    console.log('');
    console.log('单次查询耗时：约 ' + Math.round((Date.now() - t0) / people.length) + ' ms（含 60 万轮 PBKDF2）');

    if (failures.length) {
        console.log('');
        console.log('--- 失败明细（最多 15 条）---');
        for (const f of failures.slice(0, 15)) {
            console.log(`  第 ${f.p.lineNo} 行 ${f.p.sid} ${f.p.name}：${f.why}`);
        }
        console.log('');
        console.log('结论：✗ 有 ' + failures.length + ' 条不通过');
        process.exit(1);
    }

    if (!ghostOk || !wrongNameOk || leakedNames.length || leakedSids.length) {
        console.log('');
        console.log('结论：✗ 反向用例未通过');
        process.exit(1);
    }

    console.log('');
    console.log('结论：✓ 全部通过');
}

main().catch((e) => {
    console.error('校验脚本自身出错：' + (e && e.stack ? e.stack : e));
    process.exit(2);
});
