# 计维二面结果查询

计算机维护队（华南农业大学 Computer Serving Team）招新第二轮面试结果查询页。
纯静态站，部署在 GitHub Pages，无后端、无外部依赖、无追踪。

线上地址：<https://ltsunahi.github.io/cst-checker/>

---

## 一、怎么用

### 换名单（最常用）

1. 把表格放进 `data\` 目录，命名成 `面试结果.xlsx`（或 `.csv`）
2. 双击运行 `build.cmd`，或者手动：

   ```
   node tools\build_data.js
   ```

3. 看 `build-report.txt` 有没有警告，没问题就提交推送：

   ```
   git add -A && git commit -m "更新名单" && git push
   ```

推送后 GitHub Actions 会自动发布，1 分钟左右生效。

**表格需要的列**（顺序无所谓，列名可换，别名在 `tools\build_config.json` 里配）：

| 列 | 必填 | 说明 |
| --- | --- | --- |
| 学号 | ✅ | 查询用；建议 6-20 位纯数字 |
| 姓名 | ✅ | 查询用；全角/空格会自动处理 |
| 结果 | ✅ | 支持 `通过`/`未通过`/`无记录`，也支持 `P`/`F`/`N` |
| 分组 | ○ | 通过后会显示「你所进入的组别是：xxx」 |

### 换文案 / 换年份 / 换群号

改 `tools\build_config.json` 里的 `vars`：

```json
"vars": {
  "year": "2025",
  "deadline": "10月17日中午12:00前",
  "groupName": "25计维大家庭",
  "groupQq": "1056563049"
}
```

`templates` 里的四种结果文案改完记得重新构建。

### 本地预览

```
node tools\serve.js
```

然后打开 <http://127.0.0.1:8788/>。
（不要直接双击 `index.html`，`file://` 协议下浏览器会拦掉数据请求。）

### 上线前自检

```
node tools\verify_site.js
```

会用**源表格里的每一条真实输入**跑一遍和浏览器完全相同的查询链路
（真实的 `src/app.js` + WebCrypto），逐条比对结果码与分组，并检查：

- 数据文件里有没有残留明文姓名/学号
- 不存在的学号是否落到「无记录」
- 姓名错一个字是否查不到

---

## 二、目录结构

```
cst-checker/
├─ src/                     源文件（改这里）
│  ├─ index.html
│  ├─ style.css
│  ├─ app.js                查询 + 解密，零依赖
│  └─ assets/logo.png       队徽
├─ tools/
│  ├─ build_config.json     文案、变量、列名别名
│  ├─ build_data.js         构建：表格 -> 加密数据
│  ├─ lib_data.js           共享：读表、归一化、列匹配
│  ├─ xlsx_to_csv.py        读 .xlsx（用内置 Python + openpyxl）
│  ├─ verify_site.js        端到端自检
│  ├─ make_preview.js       生成截图用的预览页
│  ├─ serve.js              本地预览服务器
│  └─ sample-data.csv       示例数据（假数据）
├─ public/                  构建产物 = 部署目录（不要手改）
├─ data/                    放真实名单（**已被 .gitignore 忽略**）
└─ .github/workflows/deploy.yml
```

`build_data.js` 每次运行会做三件事：把 `src/` 复制进 `public/`、生成 `public/data/records.json`、写 `public/robots.txt`。

---

## 三、数据是怎么保护的

站点是纯静态的，数据文件对所有人可见，所以保护思路是**提高爆破成本**，不是「绝对安全」。做法：

```
索引  id = SHA-256( pepper | 学号 | 姓名 )                        → 定位记录
载荷  ct = AES-256-GCM( 记录, key = PBKDF2-SHA256(学号|姓名, salt, 60万轮) )
```

- 数据文件里**既没有明文学号，也没有明文姓名**，连「谁报名了」都看不出
- 必须**学号和姓名同时输对**才能解密那一条；只知其一、或拿到整个文件，都解不开
- 想爆破某个人，得猜 学号 × 姓名 的组合，每次尝试要跑 60 万轮 PBKDF2（实测约 92 ms），成本远高于参考站那种「密钥明文放站上」的做法

**必须知道的局限**：前端能解开的东西，攻击者拿到文件后理论上也能暴力解开，只是代价高。所以——

- 页面**只能放面试结果和分组**，不要放手机号、邮箱、身份证、录取专业
- 真要放敏感信息，得加一个服务端校验接口（Cloudflare Workers / Vercel 免费额度即可），前端不变

**其他加固**：`noindex,nofollow` + `robots.txt` 防搜索引擎收录；查询失败只提示「未查询到」，不区分「学号不存在」和「姓名不对」，避免被当成枚举工具；连续 8 次查不到会冷却 30 秒；用户输入在代入文案前做了 HTML 转义。

---

## 四、部署

仓库 `Ltsunahi/cst-checker`，分支 `main`。Pages 来源选 **GitHub Actions**，
`.github/workflows/deploy.yml` 会在每次 push 后自动把 `public/` 发上去。

如果 Actions 用不了，退路是：Settings → Pages → Source 选 `Deploy from a branch`，
分支 `main`、目录 `/docs`，然后让构建脚本输出到 `docs/` 即可。
