/* 计维招新结果查询 —— 查询与解密逻辑
 *
 * 设计：站点是纯静态的，数据文件对所有人可见。保护方式是「提高爆破成本」：
 *   索引 id  = SHA-256( pepper | 姓名 )        —— 用于定位记录，反查不出是谁
 *   载荷 ct  = AES-256-GCM( 记录, key = PBKDF2-SHA256(姓名, salt, 60万轮) )
 * 数据文件里没有明文姓名。
 *
 * 注意：当前版本按「姓名」单字段查询（名单里没有学号）。姓名可猜性高于学号，
 * 60 万轮 PBKDF2 是这里唯一的成本门槛；若日后拿到学号，建议改回双字段。
 */
(function () {
    'use strict';

    var enc = new TextEncoder();
    var dec = new TextDecoder();

    var DATA_URL = 'data/records.json';

    /* ---------------- 编码工具 ---------------- */

    function b64ToBytes(b64) {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function bytesToHex(buf) {
        var b = new Uint8Array(buf), s = '';
        for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
        return s;
    }

    function escapeHtml(v) {
        return String(v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /* ---------------- 输入归一化 ---------------- */

    // 全角 -> 半角，并去掉所有空白
    function toHalfWidth(s) {
        return String(s)
            .replace(/[\uFF01-\uFF5E]/g, function (c) {
                return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
            })
            .replace(/\u3000/g, ' ');
    }

    function normalizeName(name) {
        return toHalfWidth(name).replace(/\s+/g, '').trim();
    }

    /* ---------------- 加解密 ---------------- */

    function hashId(pepper, name) {
        return crypto.subtle
            .digest('SHA-256', enc.encode(pepper + '|' + name))
            .then(bytesToHex);
    }

    function deriveKey(name, saltB64, iterations) {
        return crypto.subtle
            .importKey('raw', enc.encode(name), 'PBKDF2', false, ['deriveKey'])
            .then(function (material) {
                return crypto.subtle.deriveKey(
                    {
                        name: 'PBKDF2',
                        salt: b64ToBytes(saltB64),
                        iterations: iterations,
                        hash: 'SHA-256',
                    },
                    material,
                    { name: 'AES-GCM', length: 256 },
                    false,
                    ['decrypt']
                );
            });
    }

    /* ---------------- 数据加载（带缓存与并发合并） ---------------- */

    var bundlePromise = null;

    function loadBundle() {
        if (!bundlePromise) {
            bundlePromise = fetch(DATA_URL, { cache: 'no-cache' }).then(function (res) {
                if (!res.ok) throw new Error('数据加载失败（HTTP ' + res.status + '）');
                return res.json();
            });
            // 失败时允许重试
            bundlePromise.catch(function () { bundlePromise = null; });
        }
        return bundlePromise;
    }

    /* ---------------- 查询 ---------------- */

    function query(name) {
        var nName = normalizeName(name);

        if (!nName) {
            return Promise.resolve({ ok: false, reason: 'empty' });
        }

        return loadBundle().then(function (bundle) {
            var kdf = bundle.kdf;
            return hashId(kdf.pepper, nName).then(function (id) {
                var rec = bundle.records[id];
                if (!rec) {
                    return {
                        ok: true,
                        code: 'NotFound',
                        bundle: bundle,
                        vars: { nameToSearch: nName, group: '' },
                    };
                }
                return deriveKey(nName, kdf.salt, kdf.iterations).then(function (key) {
                    return crypto.subtle
                        .decrypt({ name: 'AES-GCM', iv: b64ToBytes(rec.iv) }, key, b64ToBytes(rec.ct))
                        .then(function (plain) {
                            var data = JSON.parse(dec.decode(plain));
                            return {
                                ok: true,
                                code: data.code || 'N',
                                bundle: bundle,
                                vars: { nameToSearch: nName, group: data.group || '' },
                            };
                        });
                });
            });
        });
    }

    /* ---------------- 文案渲染 ---------------- */

    var CODE_CLASS = { P: 'pass', F: 'fail', N: 'not-found', NotFound: 'not-found' };

    function renderMessage(bundle, code, vars) {
        var templates = bundle.templates || {};
        // 没有分组时优先用「去掉分组那句」的变体，避免出现「你所进入的组别是：。」
        var key = (!vars.group && templates[code + '_nogroup']) ? code + '_nogroup' : code;
        var tpl = templates[key] || templates[code] || templates.NotFound || '';
        // 未在 vars 中出现的占位符原样保留，方便排查
        return tpl.replace(/\$\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(vars, k) ? escapeHtml(vars[k]) : m;
        });
    }

    function classFor(code) {
        return CODE_CLASS[code] || 'not-found';
    }

    /* ---------------- 页面交互 ---------------- */

    var MAX_ATTEMPTS = 8;      // 连续未找到多少次后进入冷却
    var COOLDOWN_MS = 30000;   // 冷却时长

    function init(doc) {
        var form = doc.getElementById('searchForm');
        var nameInput = doc.getElementById('nameInput');
        var button = doc.getElementById('searchButton');
        var statusEl = doc.getElementById('status');
        var resultEl = doc.getElementById('result');

        var attempts = 0;
        var cooldownUntil = 0;
        var busy = false;

        function setStatus(text, isError) {
            statusEl.textContent = text || '';
            statusEl.className = isError ? 'status error' : 'status';
        }

        function clearResult() {
            resultEl.className = 'result-box';
            resultEl.innerHTML = '';
        }

        function showResult(code, bundle, vars) {
            resultEl.innerHTML = renderMessage(bundle, code, vars);
            resultEl.className = 'result-box ' + classFor(code);
            // 强制重排，确保动画重播
            void resultEl.offsetWidth;
            resultEl.classList.add('visible');
        }

        function onSubmit(e) {
            e.preventDefault();
            if (busy) return;

            var now = Date.now();
            if (now < cooldownUntil) {
                setStatus('查询过于频繁，请 ' + Math.ceil((cooldownUntil - now) / 1000) + ' 秒后再试。', true);
                return;
            }

            var name = nameInput.value;

            if (!normalizeName(name)) {
                setStatus('请输入姓名。', true);
                nameInput.focus();
                return;
            }

            busy = true;
            button.disabled = true;
            clearResult();
            setStatus('查询中…');

            var started = Date.now();

            query(name)
                .then(function (r) {
                    if (!r.ok && r.reason === 'empty') {
                        setStatus('请输入姓名。', true);
                        return;
                    }

                    // 解密很快时不要闪一下就没，保证有可感知的反馈
                    var wait = Math.max(0, 220 - (Date.now() - started));
                    return new Promise(function (resolve) { setTimeout(resolve, wait); }).then(function () {
                        if (r.code === 'NotFound') {
                            attempts++;
                            if (attempts >= MAX_ATTEMPTS) cooldownUntil = Date.now() + COOLDOWN_MS;
                        } else {
                            attempts = 0;
                        }
                        showResult(r.code, r.bundle, r.vars);
                        setStatus('');
                    });
                })
                .catch(function (err) {
                    console.error(err);
                    setStatus('查询失败：' + (err && err.message ? err.message : '未知错误') + '，请刷新页面重试。', true);
                })
                .then(function () {
                    busy = false;
                    button.disabled = false;
                });
        }

        form.addEventListener('submit', onSubmit);

        // 输入变化就撤掉上一个人的结果，避免看串
        nameInput.addEventListener('input', function () {
            clearResult();
            setStatus('');
        });

        nameInput.focus();
    }

    /* ---------------- 导出 ---------------- */

    var QC = {
        normalizeName: normalizeName,
        hashId: hashId,
        deriveKey: deriveKey,
        query: query,
        renderMessage: renderMessage,
        classFor: classFor,
        loadBundle: loadBundle,
        init: init,
        _b64ToBytes: b64ToBytes,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = QC;
    if (typeof window !== 'undefined') window.QC = QC;

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { init(document); });
        } else {
            init(document);
        }
    }
})();
