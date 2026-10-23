'use strict';
/* 共享数据层：读取配置、解析表格、归一化字段。
 * 被 build_data.js（构建）和 verify_site.js（校验）共用，保证两边判定一致。 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'build_config.json');
// 构建产物目录。GitHub Pages 走「分支发布」，只能指向仓库根目录或 /docs，所以用 docs。
const PUBLIC_DIR = path.join(ROOT, 'docs');
const SRC_DIR = path.join(ROOT, 'src');

/* ---------------- 配置 ---------------- */

function loadConfig() {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!cfg.templates || !cfg.templates.NotFound) throw new Error('build_config.json 缺少 templates.NotFound');
    return cfg;
}

/* ---------------- 归一化（必须与 src/app.js 完全一致） ---------------- */

function toHalfWidth(s) {
    return String(s)
        .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/\u3000/g, ' ');
}

function normalizeSid(v) {
    return toHalfWidth(v == null ? '' : v).replace(/\s+/g, '').trim();
}

function normalizeName(v) {
    return toHalfWidth(v == null ? '' : v).replace(/\s+/g, '').trim();
}

/* ---------------- 文本解码（UTF-8 / GBK / UTF-16） ---------------- */

function decodeBuffer(buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(buf.subarray(2));
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(buf.subarray(2));
    }
    const utf8 = new TextDecoder('utf-8').decode(buf);
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
        return new TextDecoder('gbk').decode(buf);
    } catch (e) {
        return utf8;
    }
}

/* ---------------- CSV ---------------- */

function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n') {
            row.push(field); rows.push(row); row = []; field = '';
        } else if (c !== '\r') {
            field += c;
        }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* ---------------- xlsx -> csv（交给内置 Python + openpyxl） ---------------- */

function resolvePython() {
    const candidates = [
        process.env.DSH_PYTHON,
        path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
        'python',
        'python3',
    ].filter(Boolean);

    for (const exe of candidates) {
        try {
            execFileSync(exe, ['-c', 'import openpyxl'], { stdio: 'ignore' });
            return exe;
        } catch (e) { /* 试下一个 */ }
    }
    return null;
}

function xlsxToRows(inputPath) {
    const py = resolvePython();
    if (!py) {
        throw new Error(
            '读取 .xlsx 需要 Python + openpyxl，但没找到可用的 Python。\n' +
            '  办法一：把表格另存为 CSV（UTF-8），再重新运行本脚本。\n' +
            '  办法二：用内置 Python 运行，例如\n' +
            '    "C:\\Users\\<你>\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe" tools\\build_data.js'
        );
    }
    const tmp = path.join(os.tmpdir(), 'cst_checker_' + Date.now() + '.csv');
    execFileSync(py, [path.join(__dirname, 'xlsx_to_csv.py'), inputPath, tmp], { stdio: 'inherit' });
    try {
        return parseCsv(decodeBuffer(fs.readFileSync(tmp)));
    } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
    }
}

/* ---------------- 读取任意输入表格 ---------------- */

function readRows(inputPath) {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.xlsx' || ext === '.xlsm') return xlsxToRows(inputPath);
    if (ext === '.xls') {
        throw new Error('不支持旧版 .xls，请在 Excel 里另存为 .xlsx 或 .csv 后重试。');
    }
    return parseCsv(decodeBuffer(fs.readFileSync(inputPath)));
}

/* ---------------- 自动寻找输入文件 ---------------- */

function findInputFile() {
    const dataDir = path.join(ROOT, 'data');
    const preferred = [
        path.join(dataDir, '面试结果.xlsx'),
        path.join(dataDir, '面试结果.csv'),
    ];
    for (const p of preferred) if (fs.existsSync(p)) return p;

    if (fs.existsSync(dataDir)) {
        const hits = fs.readdirSync(dataDir)
            .filter((f) => /\.(xlsx|xlsm|csv)$/i.test(f))
            .map((f) => path.join(dataDir, f));
        if (hits.length) return hits[0];
    }
    const sample = path.join(__dirname, 'sample-data.csv');
    if (fs.existsSync(sample)) return sample;

    throw new Error('没找到数据文件。把表格放到 data\\ 目录，或运行：node tools\\build_data.js <表格路径>');
}

/* ---------------- 表头匹配 ---------------- */

function buildHeaderIndex(header, cfg) {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
    const index = {};
    for (const key of Object.keys(cfg.columns)) {
        const aliases = cfg.columns[key].map(norm);
        const pos = header.findIndex((h) => aliases.includes(norm(h)));
        index[key] = pos; // -1 表示这一列不存在
    }
    return index;
}

/* ---------------- 结果码映射 ---------------- */

function mapCode(raw, cfg) {
    const key = String(raw == null ? '' : raw).replace(/\s+/g, '').trim();
    if (cfg.codeMap[key] != null) return cfg.codeMap[key];
    const lower = key.toLowerCase();
    if (cfg.codeMap[lower] != null) return cfg.codeMap[lower];
    return null;
}

/* ---------------- 主流程：表格 -> 规整后的名单 ---------------- */

function loadRoster(inputPath) {
    const cfg = loadConfig();
    const rows = readRows(inputPath);
    if (rows.length < 2) throw new Error('表格里没有数据行（只有表头？）');

    const header = rows[0];
    const col = buildHeaderIndex(header, cfg);

    const missing = [];
    // 学号是可选的：名单里没有学号时，站点按姓名查询
    if (col.name < 0) missing.push('姓名');
    if (col.code < 0) missing.push('结果');
    if (missing.length) {
        throw new Error(
            '表头里找不到这些列：' + missing.join('、') + '\n' +
            '  实际表头：' + header.map((h) => JSON.stringify(String(h))).join(', ') + '\n' +
            '  请在 tools\\build_config.json 的 columns 里补上对应别名。'
        );
    }

    const people = [];
    const warnings = [];
    const seen = new Map();
    const unmapped = new Set();

    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const lineNo = i + 1;
        const sid = col.sid >= 0 ? normalizeSid(r[col.sid]) : '';
        const name = normalizeName(r[col.name]);
        const rawCode = r[col.code];
        let group = col.group >= 0 ? String(r[col.group] == null ? '' : r[col.group]).trim() : '';
        // 名单里没填分组时用配置里的默认组
        if (!group && cfg.defaultGroup) group = String(cfg.defaultGroup).trim();

        if (!name) {
            if (sid) warnings.push(`第 ${lineNo} 行：缺姓名，已跳过（学号 ${sid}）`);
            continue;
        }

        const code = mapCode(rawCode, cfg);
        if (code == null) {
            unmapped.add(String(rawCode));
            warnings.push(`第 ${lineNo} 行：结果值 ${JSON.stringify(String(rawCode))} 无法识别，已按 N（无记录）处理`);
        }

        const finalCode = code == null ? 'N' : code;

        if (sid && !/^\d{6,20}$/.test(sid)) {
            warnings.push(`第 ${lineNo} 行：学号 ${JSON.stringify(sid)} 不是 6-20 位纯数字，请确认`);
        }

        const dedupKey = sid ? sid + '|' + name : name;
        if (seen.has(dedupKey)) {
            warnings.push(`第 ${lineNo} 行：与第 ${seen.get(dedupKey)} 行重复（同名或同学号），后者会被覆盖`);
        }
        seen.set(dedupKey, lineNo);

        people.push({ sid, name, code: finalCode, group, lineNo });
    }

    return { cfg, people, warnings, unmapped: [...unmapped], header };
}

/* ---------------- 构建期变量替换（只替换 vars 里的，运行时占位符保留） ---------------- */

function expandTemplates(cfg) {
    const out = {};
    for (const key of Object.keys(cfg.templates)) {
        out[key] = cfg.templates[key].replace(/\$\{(\w+)\}/g, (m, k) =>
            Object.prototype.hasOwnProperty.call(cfg.vars || {}, k) ? cfg.vars[k] : m
        );
    }
    return out;
}

module.exports = {
    ROOT, CONFIG_PATH, PUBLIC_DIR, SRC_DIR,
    loadConfig, loadRoster, findInputFile, expandTemplates,
    normalizeSid, normalizeName, toHalfWidth,
    parseCsv, decodeBuffer, readRows,
};
