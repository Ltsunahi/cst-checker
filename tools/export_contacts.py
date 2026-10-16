#!/usr/bin/env python3
"""导出通过者的联系方式（姓名 / 学号 / 手机号 / 邮箱）为新的 Excel。

用法：
  python export_contacts.py --roster data\\面试结果.csv --source 二面合并表.xlsx
                            [--ref 一面通过名单.xlsx] [--out data\\通过名单.xlsx]
                            [--result 通过]

- roster：站点用的 学号,姓名,结果 表（决定谁算「通过」）
- source：含手机/邮箱的原始表（优先按学号匹配，匹配不到再按姓名）
- ref：source 里查不到时的备用表（比如手工补录、信息不全的人）

注意：产物含个人联系方式，不要提交到公开仓库。
"""
import argparse
import csv
import re
import sys

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

KEY_NAME = ("姓名", "人名", "名字")
KEY_SID = ("学号", "学籍号", "考生号")
KEY_PHONE = ("手机", "电话", "手机号", "联系方式")
KEY_MAIL = ("邮箱", "邮件", "email", "mail")


def norm(v):
    return re.sub(r"\s+", "", str(v if v is not None else "")).strip()


def pick(header, keys):
    for i, h in enumerate(header):
        if norm(h) in keys:
            return i
    for i, h in enumerate(header):
        h = norm(h).lower()
        if any(k.lower() in h for k in keys):
            return i
    return -1


def load_table(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        return [], []
    return [str(c) if c is not None else "" for c in rows[0]], rows[1:]


def index_table(path):
    """返回两个字典：按学号、按姓名，值为 (姓名, 学号, 手机, 邮箱)"""
    header, rows = load_table(path)
    i_name, i_sid = pick(header, KEY_NAME), pick(header, KEY_SID)
    i_phone, i_mail = pick(header, KEY_PHONE), pick(header, KEY_MAIL)
    if i_name < 0 or i_sid < 0:
        raise SystemExit("认不出列：%s" % header)

    by_sid, by_name = {}, {}
    for r in rows:
        name, sid = norm(r[i_name]), norm(r[i_sid])
        phone = norm(r[i_phone]) if i_phone >= 0 else ""
        mail = norm(r[i_mail]) if i_mail >= 0 else ""
        if not name and not sid:
            continue
        rec = (name, sid, phone, mail)
        if re.match(r"^\d{6,20}$", sid) and sid not in by_sid:
            by_sid[sid] = rec
        if name and name not in by_name:
            by_name[name] = rec
    return by_sid, by_name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roster", required=True)
    ap.add_argument("--source", required=True)
    ap.add_argument("--ref", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--result", default="通过")
    a = ap.parse_args()

    # 1. 谁是通过的
    with open(a.roster, encoding="utf-8-sig") as f:
        roster = [(norm(r["学号"]), norm(r["姓名"]), norm(r["结果"]))
                  for r in csv.DictReader(f)]
    chosen = [(s, n) for s, n, res in roster if res == a.result]
    if not chosen:
        raise SystemExit("名单里没有「%s」的记录，检查 --result 参数。" % a.result)

    # 2. 联系方式来源
    src_sid, src_name = index_table(a.source)
    ref_sid, ref_name = ({}, {})
    if a.ref:
        ref_sid, ref_name = index_table(a.ref)

    out_rows, warn = [], []
    for sid, name in chosen:
        phone = mail = ""
        real = sid

        for by_sid, by_name, tag in ((src_sid, src_name, "主表"), (ref_sid, ref_name, "备用表")):
            hit = by_sid.get(sid) or by_name.get(name)
            if hit:
                _n, _s, p, m = hit
                if p and not phone:
                    phone = p
                if m and not mail:
                    mail = m
                if _s and re.match(r"^\d{6,20}$", _s):
                    real = _s
                if phone and mail:
                    break

        if not phone:
            warn.append("%s %s：缺手机号" % (sid, name))
        if not mail:
            warn.append("%s %s：缺邮箱" % (sid, name))
        out_rows.append([name, real, phone, mail])

    # 3. 写 Excel
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "通过名单"
    heads = ["姓名", "学号", "手机号", "邮箱"]
    ws.append(heads)
    for c in range(1, len(heads) + 1):
        cell = ws.cell(row=1, column=c)
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center")
    for row in out_rows:
        ws.append(row)

    widths = [12, 16, 16, 32]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"

    wb.save(a.out)

    print("已生成 %s" % a.out)
    print("  %s：%d 人" % (a.result, len(out_rows)))
    if warn:
        print("  有 %d 项缺失：" % len(warn))
        for w in warn:
            print("    - " + w)
    else:
        print("  手机号、邮箱均完整")


if __name__ == "__main__":
    main()
