#!/usr/bin/env node
'use strict';
/* 生成 public/_preview.html —— 仅供无头浏览器截图用，不参与部署。
 * 用真实数据文件里的文案模板「同步」渲染，绕开异步解密，便于截图。
 * 用法： node tools/make_preview.js
 */

const fs = require('fs');
const path = require('path');

const L = require('./lib_data');

const bundle = JSON.parse(fs.readFileSync(path.join(L.PUBLIC_DIR, 'data', 'records.json'), 'utf8'));

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>预览</title>
<link rel="icon" href="assets/logo.png">
<link rel="stylesheet" href="style.css">
</head>
<body>
<main class="container">
    <header>
        <img src="assets/logo.png" alt="计算机维护队队徽" id="logo" width="160" height="160">
        <h1>二面结果查询</h1>
        <p>欢迎查询计算机维护队第 21 届招新第二轮面试结果</p>
    </header>
    <form class="search-box" id="searchForm" autocomplete="off" novalidate>
        <div class="field">
            <label for="nameInput">姓名</label>
            <input type="text" id="nameInput" name="name" placeholder="请输入你的姓名" maxlength="20">
        </div>
        <button type="submit" id="searchButton">查 询</button>
    </form>
    <div id="status" class="status" role="status" aria-live="polite"></div>
    <div id="result" class="result-box"></div>
</main>
<footer><p>如有疑惑，请联系QQ：<span class="nb">3071315830</span> 或微信号：<span class="nb">OIUU-UUIO</span></p></footer>
<script src="app.js"></script>
<script>
var TEMPLATES = ${JSON.stringify(bundle.templates)};
document.addEventListener('DOMContentLoaded', function () {
    var q = new URLSearchParams(location.search);
    if (q.get('blank')) return;
    var name = q.get('name') || '梁凯翔';
    document.getElementById('nameInput').value = name;
    var code = q.get('code') || 'P';
    var vars = { nameToSearch: name, group: q.get('group') || '技术组' };
    var el = document.getElementById('result');
    el.innerHTML = window.QC.renderMessage({ templates: TEMPLATES }, code, vars);
    el.className = 'result-box ' + window.QC.classFor(code);
    void el.offsetWidth;
    el.classList.add('visible');
});
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(L.PUBLIC_DIR, '_preview.html'), html, 'utf8');
console.log('已生成 docs\\_preview.html');
