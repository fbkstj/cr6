# CLAUDE.md

# 專題製作評分：校內專題競賽影音評分系統

規格書是 `competition-video-development-prompt (2).pdf`。**換電腦或開新對話時，先讀 `進度紀錄.md`**，裡面有目前的階段、已確定的決定、規劃中的架構和待辦事項；每次有進展都要更新它。**開發依據是 `開發計畫書.md`**（與原規格 PDF 衝突時以它為準；改變設計要同步更新它的變更表與自我檢核紀錄）。

- 磁碟代號每台電腦不同（`H:`、`J:` 都出現過），不要寫死在腳本或文件裡。
- 在 Bash 工具執行 Python 時設 `PYTHONIOENCODING=utf-8`。
- 學生影片、帳號密碼、API 金鑰、GitHub token 不可放進公開 repo 或寫進檔案。
- 相關參考專案：`../重補修/`（Supabase＋Edge Function 的寫法、影片放 GitHub Pages 的做法），只讀取參考，不要修改它（已經有學生在線上使用）。
