#!/usr/bin/env python3
"""從臺灣證券交易所抓個股日成交資訊,輸出 kline-data.js 給 taiwan-stock-news.html 使用。

用法: python3 scripts/fetch_twse_kline.py [股票代號] [月數]
例如: python3 scripts/fetch_twse_kline.py 6213 6
只支援上市股票(上櫃股需另接櫃買中心資料)。均線由頁面用收盤價計算,未做除權息還原。
"""
import json, sys, time, datetime, urllib.request, pathlib

code = sys.argv[1] if len(sys.argv) > 1 else "6213"
months = int(sys.argv[2]) if len(sys.argv) > 2 else 6
URL = "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={d}&stockNo={c}"

def num(s):
    s = s.replace(",", "").strip()
    return None if s in ("", "--", "---") else float(s)

def month_starts(n):
    t = datetime.date.today().replace(day=1)
    out = []
    for _ in range(n):
        out.append(t)
        t = (t - datetime.timedelta(days=1)).replace(day=1)
    return out[::-1]

# 證交所 WAF 會把缺少 Accept 或 UA 太簡短(如 "Mozilla/5.0")的請求以 307(無 Location,
# 內容為「因為安全性考量,您所執行的頁面無法呈現」)擋掉,所以要帶瀏覽器等級的標頭。
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.twse.com.tw/zh/trading/historical/stock-day.html",
}

def fetch(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
                return json.load(r)
        except Exception as e:  # 307 被擋、連線重置等,退避後重試
            if i == tries - 1:
                raise
            print(f"重試 ({e})", file=sys.stderr)
            time.sleep(5 * (i + 1))

rows, name = [], ""
for m in month_starts(months):
    j = fetch(URL.format(d=m.strftime("%Y%m%d"), c=code))
    if j.get("stat") != "OK":
        print(f"{m:%Y-%m}: {j.get('stat')}", file=sys.stderr)
    else:
        name = j.get("title", name)
        for f in j["data"]:
            y, mo, d = f[0].split("/")
            o, h, l, c = (num(f[i]) for i in (3, 4, 5, 6))
            if None in (o, h, l, c):
                continue
            rows.append([f"{int(mo)}/{int(d)}", o, h, l, c, round(num(f[1]) / 1000), f"{int(y)+1911}-{mo}-{d}"])
    time.sleep(3)  # 證交所限流:約每 5 秒 3 次

if not rows:
    sys.exit("沒有取得任何資料,未寫入檔案")
out = pathlib.Path(__file__).resolve().parent.parent / "kline-data.js"
out.write_text("window.KLINE_REAL = " + json.dumps({"code": code, "title": name.strip(), "rows": rows}, ensure_ascii=False) + ";\n", encoding="utf-8")
print(f"寫入 {out}:{len(rows)} 筆,{rows[0][6]} ~ {rows[-1][6]}")
