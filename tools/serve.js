#!/usr/bin/env node
'use strict';
/* 本地预览服务器（只为开发用，部署不需要）
 * 用法： node tools/serve.js  ->  http://127.0.0.1:8788/
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8788);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';

    const file = path.join(ROOT, path.normalize(rel).replace(/^[\\/]+/, ''));
    if (!file.startsWith(ROOT)) {
        res.writeHead(403).end('403');
        return;
    }

    fs.readFile(file, (err, buf) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
        });
        res.end(buf);
    });
}).listen(PORT, '127.0.0.1', () => {
    console.log('预览地址：http://127.0.0.1:' + PORT + '/');
    console.log('（按 Ctrl+C 停止）');
});
