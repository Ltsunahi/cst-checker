#!/usr/bin/env python3
"""导出队员名单（学号 / 姓名 / 手机号 / QQ / 微信）为 Excel、CSV 或 JSON。

输出格式由 --out 的扩展名决定，也可以用 --format 强制指定：
  .xlsx / .xlsm -> Excel      .csv -> CSV      .json -> JSON

读取输入文件时：
  - 支持 xlsx / xls / csv / json；
  - 第一行是表头就按列名匹配（认「学号、姓名、手机号、QQ、微信」等中文名，也认英文别名）；
  - 没有表头就按「学号、姓名、手机号、QQ、微信」的顺序按位置读取。

用法示例：
  python export_contacts.py --roster data\\面试结果.csv --source "二面表.xlsx" ^
      --ref "一面表.xlsx" --out data\\队员名单.xlsx

注意：产物含个人联系方式，不要提交到公开仓库。
"""
import argparse
import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    import openpyxl
    from openpyxl.styles import Font, Alignment
    from openpyxl.utils import get_column_letter
except ImportError:
    sys.stderr.write("缺少 openpyxl，请用内置 Python 运行。\n")
    sys.exit(2)

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass

# 输出列（顺序即导出的列顺序）
OUT_COLUMNS = ["学号", "姓名", "手机号", "QQ", "微信"]

ALIASES = {
    "学号": ("学号", "学籍号", "考生号", "sid", "studentid", "id"),
    "姓名": ("姓名", "人名", "名字", "name"),
    "手机号": ("手机号", "手机", "电话", "联系方式", "手机号码", "phone", "tel"),
    "QQ": ("qq", "qq号", "qq号码"),
    "微信": ("微信", "微信号", "wechat", "weixin", "vx"),
}

# 结果列只在 roster 里用
RESULT_ALIASES = ("结果", "二面结果", "面试结果", "result", "status")


def norm(v):
    return re.sub(r"\s+", "", str(v if v is not None else "")).strip()


def clean_cell(v):
    """单元格转字符串；整数值的 float 去掉 .0（Excel 常把学号读成数字）"""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def is_sid(v):
    return bool(re.fullmatch(r"\d{6,20}", norm(v)))


# ---------------- 读取各种格式 ----------------

def _rows_from_xlsx(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    wb.close()
    return rows


def _xls_to_xlsx(path):
    """用 LibreOffice 把 .xls 转成 .xlsx，转不了返回 None"""
    soffice = None
    for cand in ("soffice", "libreoffice",
                 r"C:\Program Files\LibreOffice\program\soffice.exe",
                 r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"):
        got = shutil.which(cand) or (cand if os.path.isfile(cand) else None)
        if got:
            soffice = got
            break
    if not soffice:
        return None
    outdir = tempfile.mkdtemp(prefix="xls_conv_")
    try:
        subprocess.run(
            [soffice, "--headless", "--convert-to", "xlsx", "--outdir", outdir, path],
            check=True, capture_output=True, timeout=120,
        )
        base = os.path.splitext(os.path.basename(path))[0] + ".xlsx"
        out = os.path.join(outdir, base)
        return out if os.path.exists(out) else None
    except Exception:
        return None


def read_rows(path):
    ext = os.path.splitext(path)[1].lower()

    if ext in (".xlsx", ".xlsm"):
        return _rows_from_xlsx(path)

    if ext == ".xls":
        converted = _xls_to_xlsx(path)
        if not converted:
            raise SystemExit(
                "读不了 .xls：没找到可用的 LibreOffice。\n"
                "  办法一：在 Excel / WPS 里另存为 .xlsx 或 .csv 再试；\n"
                "  办法二：安装 LibreOffice 后重试。"
            )
        return _rows_from_xlsx(converted)

    if ext == ".csv":
        with open(path, "rb") as f:
            raw = f.read()
        if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
            text = raw.decode("utf-16")
        else:
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = raw.decode("gbk", errors="replace")
        return [r for r in csv.reader(io.StringIO(text))]

    if ext == ".json":
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for key in ("data", "list", "rows", "items", "members"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
        if not isinstance(data, list):
            raise SystemExit("JSON 顶层既不是数组，也没有 data/list/rows/items/members 字段。")
        if not data:
            return []
        if isinstance(data[0], dict):
            header = list(data[0].keys())
            return [header] + [[d.get(h, "") for h in header] for d in data]
        return [list(r) for r in data]

    raise SystemExit("不支持的文件类型：%s（只支持 xlsx / xls / csv / json）" % ext)


# ---------------- 表头识别 ----------------

def _alias_hit(cell, aliases):
    h = norm(cell).lower()
    if not h:
        return False
    for a in aliases:
        a = a.lower()
        if h == a:
            return True
        # 模糊匹配要避免 "qq邮箱" 这种误命中
        if len(a) > 1 and a in h and not h.isdigit():
            return True
    return False


def looks_like_header(row):
    for cell in row:
        for aliases in ALIASES.values():
            if _alias_hit(cell, aliases):
                return True
        if _alias_hit(cell, RESULT_ALIASES):
            return True
    return False


def match_columns(header):
    """返回 {列名: 下标}，先精确后模糊"""
    index = {}
    normalized = [norm(h).lower() for h in header]
    for col, aliases in ALIASES.items():
        lows = [a.lower() for a in aliases]
        pos = next((i for i, h in enumerate(normalized) if h in lows), -1)
        if pos < 0:
            pos = next((i for i, h in enumerate(normalized)
                        if h and any(a in h for a in lows if len(a) > 1) and not h.isdigit()), -1)
        if pos >= 0:
            index[col] = pos
    return index


def find_result_column(header):
    normalized = [norm(h).lower() for h in header]
    for i, h in enumerate(normalized):
        if any(a.lower() in h for a in RESULT_ALIASES):
            return i
    return -1


def parse_table(path):
    """读成 [(学号, 姓名, 手机号, QQ, 微信), ...]，并返回读取方式说明"""
    rows = [r for r in read_rows(path) if any(norm(c) for c in r)]
    if not rows:
        return [], "空表"

    if looks_like_header(rows[0]):
        index = match_columns(rows[0])
        mode = "表头：" + "、".join(
            ("%s=第%d列" % (c, index[c] + 1)) if c in index else ("%s=缺" % c)
            for c in OUT_COLUMNS)
        body = rows[1:]
    else:
        index = {col: i for i, col in enumerate(OUT_COLUMNS)}
        mode = "无表头，按位置：" + "、".join(OUT_COLUMNS)
        body = rows

    out = []
    for r in body:
        rec = []
        for col in OUT_COLUMNS:
            i = index.get(col, -1)
            rec.append(clean_cell(r[i]) if 0 <= i < len(r) else "")
        if any(rec):
            out.append(tuple(rec))
    return out, mode


# ---------------- 写各种格式 ----------------

def write_xlsx(path, records):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "队员名单"
    ws.append(OUT_COLUMNS)
    for c in range(1, len(OUT_COLUMNS) + 1):
        cell = ws.cell(row=1, column=c)
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center")
    for rec in records:
        ws.append(list(rec))
    for i, w in enumerate([16, 12, 16, 16, 20], start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    # 学号/手机号/QQ 按文本显示，避免被 Excel 变成科学计数法
    for row in ws.iter_rows(min_row=2, min_col=1, max_col=len(OUT_COLUMNS)):
        for cell in row:
            cell.number_format = "@"
    wb.save(path)


def write_csv(path, records):
    # utf-8-sig：带 BOM，Excel 直接双击打开中文不乱码
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(OUT_COLUMNS)
        w.writerows(records)


def write_json(path, records):
    data = [dict(zip(OUT_COLUMNS, rec)) for rec in records]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def write_any(path, records, fmt):
    fmt = (fmt or os.path.splitext(path)[1].lstrip(".")).lower()
    if fmt in ("xlsx", "xlsm"):
        write_xlsx(path, records)
    elif fmt == "csv":
        write_csv(path, records)
    elif fmt == "json":
        write_json(path, records)
    else:
        raise SystemExit("不支持的输出格式：%s（只支持 xlsx / csv / json）" % fmt)
    return fmt


# ---------------- 主流程 ----------------

def pick_chosen(roster_path, wanted):
    """从 roster 里挑出「结果 == wanted」的 (学号, 姓名)"""
    rows = [r for r in read_rows(roster_path) if any(norm(c) for c in r)]
    if not rows:
        raise SystemExit("名单文件是空的。")

    if looks_like_header(rows[0]):
        header = rows[0]
        idx = match_columns(header)
        i_sid = idx.get("学号", 0)
        i_name = idx.get("姓名", 1)
        i_res = find_result_column(header)
        body = rows[1:]
        mode = "表头：" + ("结果=第%d列" % (i_res + 1) if i_res >= 0 else "无结果列（全部按入选处理）")
    else:
        i_sid, i_name, i_res, body = 0, 1, -1, rows
        mode = "无表头，按位置：学号、姓名（全部按入选处理）"

    chosen = []
    for r in body:
        sid = clean_cell(r[i_sid]) if i_sid < len(r) else ""
        name = clean_cell(r[i_name]) if i_name < len(r) else ""
        res = clean_cell(r[i_res]) if 0 <= i_res < len(r) else wanted
        if i_res < 0 or res == wanted:
            chosen.append((sid, name))
    return chosen, mode


def index_records(records):
    by_sid, by_name = {}, {}
    for sid, name, phone, qq, wechat in records:
        if is_sid(sid) and sid not in by_sid:
            by_sid[sid] = (phone, qq, wechat)
        if name and name not in by_name:
            by_name[name] = (phone, qq, wechat)
    return by_sid, by_name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roster", required=True, help="决定谁入选的名单（含 学号/姓名/结果）")
    ap.add_argument("--source", required=True, help="含手机号/QQ/微信的原始表")
    ap.add_argument("--ref", default=None, help="主表查不到时的备用表")
    ap.add_argument("--out", required=True, help="输出文件，扩展名决定格式")
    ap.add_argument("--format", default=None, choices=["xlsx", "csv", "json"])
    ap.add_argument("--result", default="通过", help="roster 里算作入选的「结果」值，默认 通过")
    a = ap.parse_args()

    chosen, roster_mode = pick_chosen(a.roster, a.result)
    if not chosen:
        raise SystemExit("名单里没有「%s」的记录，检查 --result 参数。" % a.result)

    src_records, src_mode = parse_table(a.source)
    ref_sid = ref_name = {}
    ref_mode = ""
    if a.ref:
        ref_records, ref_mode = parse_table(a.ref)
        ref_sid, ref_name = index_records(ref_records)

    src_sid, src_name = index_records(src_records)

    out, warn = [], []
    for sid, name in chosen:
        phone = qq = wechat = ""
        for by_sid, by_name in ((src_sid, src_name), (ref_sid, ref_name)):
            hit = by_sid.get(sid) or by_name.get(name)
            if hit:
                phone = phone or hit[0]
                qq = qq or hit[1]
                wechat = wechat or hit[2]
        if not phone:
            warn.append("%s %s：缺手机号" % (sid, name))
        if not qq:
            warn.append("%s %s：缺QQ" % (sid, name))
        if not wechat:
            warn.append("%s %s：缺微信" % (sid, name))
        out.append((sid, name, phone, qq, wechat))

    fmt = write_any(a.out, out, a.format)

    print("已生成 %s（%s）" % (a.out, fmt))
    print("  列：%s" % " / ".join(OUT_COLUMNS))
    print("  %s：%d 人" % (a.result, len(out)))
    print("  名单读取：%s" % roster_mode)
    print("  主表读取：%s" % src_mode)
    if a.ref:
        print("  备用表读取：%s" % ref_mode)

    for label, pos in (("手机号", 2), ("QQ", 3), ("微信", 4)):
        n = sum(1 for r in out if r[pos])
        print("  %s 填充：%d/%d" % (label, n, len(out)))
    if warn:
        print("  缺失 %d 项，示例：" % len(warn))
        for w in warn[:5]:
            print("    - " + w)


if __name__ == "__main__":
    main()
