# CLAUDE.md

# 專題製作評分：校內專題競賽影音評分系統

規格書是 `competition-video-development-prompt (2).pdf`。**換電腦或開新對話時，先讀 `進度紀錄.md`**，裡面有目前的階段、已確定的決定、規劃中的架構和待辦事項；每次有進展都要更新它。**開發依據是 `開發計畫書.md`**（與原規格 PDF 衝突時以它為準；改變設計要同步更新它的變更表與自我檢核紀錄）。

- 磁碟代號每台電腦不同（`H:`、`J:` 都出現過），不要寫死在腳本或文件裡。
- 在 Bash 工具執行 Python 時設 `PYTHONIOENCODING=utf-8`。
- 學生影片、帳號密碼、API 金鑰、GitHub token 不可放進公開 repo 或寫進檔案。
- 相關參考專案：`../重補修/`（Supabase＋Edge Function 的寫法、影片放 GitHub Pages 的做法），只讀取參考，不要修改它（已經有學生在線上使用）。

## 正式環境（2026-11-18 起上線）

- 本資料夾是公開 repo `fbkstj/cr6` 的本機副本，網站 https://fbkstj.github.io/cr6/ （Pages 目前從根目錄發布，網頁在 `docs/`）。推送等於公開發布，先問老師。
- Supabase 專案 **`ciovykuhvpelghrjlutp`**。**`mcewgfzeqhdpygfvbfij` 是重補修正式系統，評分系統的任何指令都不能對它執行**（兩者在網頁上同名，一律用代碼辨認）。
- 學校網路擋資料庫連接埠 5432／6543：`supabase db push` 會逾時，改用 `npx.cmd supabase db query --remote=ciovykuhvpelghrjlutp --yes --file <sql>`（走 HTTPS），套用後登記到 `supabase_migrations.schema_migrations`。`functions deploy` 不受影響。
- CLI 對雲端的變更要加 `--yes`；部署前要老師同意。
- 密碼一律由老師自己輸入：資料庫密碼、主辦人員密碼、評審臨時密碼都不經手、不寫檔。
- 已有正式資料後，不要對正式資料庫做測試性的寫入；測試用 `node test/devserver.mjs`（本機記憶體資料庫）。

## 開發與測試

- `node test/run.mjs`：core.js（記憶體資料庫）；`node test/check_sql.mjs`：migration（PGlite，需 `PGLITE_DIR`，見檔頭）；`python test/test_videos.py`：影片腳本。改程式後三個都要跑。
- 本機開發伺服器：`python test/make_demo_videos.py` → `node test/devserver.mjs`（或 `preview_start` 名稱「評分系統本機」），http://localhost:8790/ ，測試帳號 admin01／admin-pass-01、judge01～05／judge-pass-01～05（合成資料）。
- 資料庫的關鍵寫入都在 SQL 函式（`supabase/migrations/`），`test/memdb.mjs` 用 JS 照同樣規則實作；改規則時兩邊都要改。
