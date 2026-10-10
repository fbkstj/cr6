#!/usr/bin/env python3
"""從臺灣證券交易所抓個股日成交資訊，存成 data/prices/<代號>.json。

用法：python3 stock-news/fetch_prices.py 6213 1303 --months 6
只支援上市股票（TWSE）；上櫃股（櫃買中心）尚未支援。
證交所會擋雲端主機的連線，請在自己的電腦上執行。
輸出格式：[{"d":"2026-10-08","o":開,"h":高,"l":低,"c":收,"v":量(張)}, ...]
"""
import argparse
import json
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path

URL = "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={ym}01&stockNo={code}"
OUT = Path(__file__).parent / "data" / "prices"


def num(s):
    s = s.replace(",", "").strip()
    return None if s in ("", "--") else float(s)


def month_rows(code, y, m):
    req = urllib.request.Request(URL.format(ym=f"{y}{m:02d}", code=code),
                                 headers={"User-Agent": "Mozilla/5.0"})
    data = json.load(urllib.request.urlopen(req, timeout=20))
    if data.get("stat") != "OK":
        return []
    rows = []
    for r in data["data"]:  # 日期,成交股數,成交金額,開,高,低,收,漲跌價差,成交筆數
        ry, rm, rd = r[0].split("/")
        o, h, l, c = (num(r[i]) for i in (3, 4, 5, 6))
        if None in (o, h, l, c):
            continue  # 當天無成交
        rows.append({"d": f"{int(ry) + 1911}-{rm}-{rd}", "o": o, "h": h, "l": l, "c": c,
                     "v": round(num(r[1]) / 1000)})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("codes", nargs="+")
    ap.add_argument("--months", type=int, default=6)
    a = ap.parse_args()
    today = date.today()
    OUT.mkdir(parents=True, exist_ok=True)
    for code in a.codes:
        rows = []
        for k in range(a.months - 1, -1, -1):
            idx = today.year * 12 + today.month - 1 - k
            try:
                rows += month_rows(code, idx // 12, idx % 12 + 1)
            except Exception as e:  # 網路或格式問題：略過該月並提醒
                print(f"{code} {idx // 12}-{idx % 12 + 1:02d} 失敗：{e}", file=sys.stderr)
            time.sleep(3)  # 證交所會限流，放慢一點
        if rows:
            (OUT / f"{code}.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
            print(f"{code}: {len(rows)} 筆 → {OUT / (code + '.json')}")
        else:
            print(f"{code}: 沒有資料（可能是上櫃股或被擋）", file=sys.stderr)


if __name__ == "__main__":
    main()
