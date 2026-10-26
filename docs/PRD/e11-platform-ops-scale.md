---
title: E11 — 平台、維運、安全與規模
date: 2026-10-23
status: in-progress
epic: E11
owner: GeneCLee6
milestones: [M0, M1, M2]
depends_on: []
---

## 背景

M0 跑在 Cloudflare 免費方案：一個 Worker 加一個 SQLite 後端的 Durable Object（`Club`）裝下所有帳號、牌桌、紀錄與 WebSocket；合併到 `main` 自動跑 CI 並部署（`ARCHITECTURE.md` §1、§6，`DEPLOY.md` §2）。這對 10 人的社團綽綽有餘。

接下來兩件事會改變平台需求：

1. **M1 的新功能**（挑戰、隊制賽、紀錄搜尋）讓資料與資訊隔離規則變複雜，需要日誌、備份、速率限制與一套集中的「誰能看到什麼」回歸測試。
2. **M2 的公開測試**（多社團、200 人、30 桌）超過單一 Durable Object 的舒適範圍，要把牌桌與比賽拆成獨立物件。

## 目標

- M1：可觀測（日誌、錯誤回報）、可還原（每日備份）、可防濫用（訊息驗證、速率限制）、PR 預覽與 staging、資訊隔離回歸測試。
- M2：拆分 Durable Object、紀錄搬到 D1、負載測試、儀表板與告警、安全審查、防作弊報表、功能旗標、隱私與條款。

## 非目標

- 換掉 Cloudflare：目前的架構（有狀態物件＋WebSocket＋免費方案）正好適合；除非 E6 的機器人運算需要，否則不引入其他雲。

## 需求

- **成本**：M1 維持免費方案可運作（機器人運算環境另計，見 E6 AC-6.5）；M2 的成本估算寫進拆分的決策紀錄。
- **規模目標**：M1 為 10–50 個帳號、同時 2–5 桌；M2 為 200 個帳號、同時 30 桌；M3 依商業化計畫另定。
- **公平**：所有比賽模式的資訊隔離有集中的回歸測試；可疑行為有報表。

## 驗收條件

- [x] AC-11.1 — Cloudflare Worker＋SQLite 後端 Durable Object（hibernation WebSocket），免費方案即可運作；合併到 `main` 後自動部署並確認網站在跑這個 commit。
- [x] AC-11.2 — CI：lint、型別檢查、測試、建置，失敗不部署；三層測試（engine、worker、presentation）。
- [x] AC-11.3 — 儲存：每個動作立即寫回，物件隨時被回收都不遺失；資料版本 `meta:schema` 與載入時自動搬移；大內容分段儲存。
- [ ] AC-11.4 — 規模：支援 200 個帳號、同時 30 桌（負載測試報告佐證）；牌桌與比賽拆成獨立 Durable Object，紀錄在 D1。
- [ ] AC-11.5 — 可觀測性：結構化日誌、前端錯誤回報、健康檢查；同時在線、桌數、機器人思考時間、重連率、錯誤率的儀表板與告警。
- [ ] AC-11.6 — 備份與匯出：每日備份到 R2、有還原演練紀錄；社員可匯出自己的資料。
- [ ] AC-11.7 — 安全：WebSocket 與 HTTP 輸入驗證與大小上限、速率限制、CSP 與安全標頭、session 列表與「登出其他裝置」；M2 完成一次安全審查。
- [ ] AC-11.8 — 公平與防作弊：挑戰、隊制賽、練習、雙人賽的可見性有集中回歸測試；同 IP／同裝置多帳號同場等可疑行為有管理員報表。
- [ ] AC-11.9 — 環境：每個 PR 有預覽部署、有 staging 環境、有功能旗標。
- [ ] AC-11.10 — 法遵：隱私權政策、使用條款，符合台灣個資法的資料刪除與匯出流程。

## Task 拆分

格式見 [`README.md`](README.md#task-格式)。

**M0 · 已完成**

- [x] `e11-t01` Cloudflare Worker＋單一 Durable Object `Club`（SQLite 後端、hibernation API），`@cloudflare/vite-plugin` 一個指令跑前後端 · AC-11.1 · af451fa
- [x] `e11-t02` `Store` 介面與 MemoryStore、`ClubService` 與 Durable Object 分離；engine／worker／presentation 三層測試 · AC-11.2 · af451fa
- [x] `e11-t03` CI（lint、typecheck、test、build）· AC-11.2 · af451fa
- [x] `e11-t04` 合併後自動部署：`DEPLOY_SHA` 記錄合併的 commit、`APP_VERSION`、`wrangler deploy --message`、部署後確認網站版本 · AC-11.1 · #4
- [x] `e11-t05` 每個動作立即寫回 `Store`、`blockConcurrencyWhile` 載入 · AC-11.3 · af451fa
- [x] `e11-t06` `meta:schema` 資料版本與載入時自動搬移舊格式 · AC-11.3 · #1
- [x] `e11-t07` 大內容分段儲存（`bookpart:`，單筆 128 KiB 上限）· AC-11.3 · #11

**M1 · 可觀測、備份、防濫用、環境**

- [x] `e11-t08` 結構化日誌（動作、錯誤代碼、耗時）、`/api/health` · AC-11.5 · S
- [x] `e11-t09` 前端錯誤回報：`window.onerror`／未處理的 Promise → `/api/client-errors`（取樣、去除個資）· AC-11.5 · S
- [x] `e11-t10` WebSocket 訊息驗證：`shared/protocol.ts` 的型別守衛、訊息大小上限，不合法直接回 `error` · AC-11.7 · S
- [x] `e11-t11` 速率限制：每連線每秒動作數、聊天洪水、登入失敗次數 · AC-11.7 · S · ← e11-t10
- [ ] `e11-t12` 每日備份：Durable Object 匯出 JSON Lines 到 R2（保留 30 天）、還原指令、第一次還原演練紀錄 · AC-11.6 · M
- [x] `e11-t13` 資訊隔離回歸測試套件：`tests/worker/visibility/` 集中測試每種模式 × 每種角色看得到什麼（一般、挑戰、隊制賽、練習）· AC-11.8 · M · ← e7-t14, e8-t09
- [x] `e11-t14` PR 預覽部署：每個 PR 一個獨立的 Worker（不用 `wrangler versions upload`，它共用正式站的 Durable Object，見 DEPLOY.md §2.1）＋預覽網址留言在 PR、PR 關閉時刪除 · AC-11.9 · S
- [x] `e11-t15` staging 環境：獨立的 Worker 與 Durable Object、測試資料種子指令 · AC-11.9 · S

**M2 · 規模**

- [x] `e11-t16` 決策紀錄：拆分 Durable Object——`Directory`（帳號、session、好友、通知、大廳目錄）、`Table`（每桌一個）、`Event`（每個挑戰／隊制賽／比賽一個）；跨物件通訊、一致性、成本估算 · AC-11.4 · S
- [x] `e11-t17` 抽出 `TableObject`：牌桌狀態與 WebSocket 移到每桌一個物件，大廳摘要回報給 `Directory`；所有 `tests/worker` 通過 · AC-11.4 · M · ← e11-t16
- [x] `e11-t18` 抽出 `EventObject`：挑戰與隊制賽的狀態、排程與結算移到每個比賽一個物件 · AC-11.4 · M · ← e11-t17 · #140（挑戰；開關 `EVENT_OBJECTS` 預設關；隊制賽留給 H2c）
- [x] `e11-t19` session 驗證在 Worker 邊緣處理（簽章 token 或快取），不必每次打到 `Directory` · AC-11.4 · M · ← e11-t16
- [x] `e11-t20` 紀錄索引搬到 D1（沿用 E4 的 schema），寫入改為非同步佇列並可重送 · AC-11.4 · M · ← e11-t16, e4-t11
- [ ] `e11-t21` 負載測試：模擬 200 位使用者、30 桌的 WebSocket 機器人，報告延遲、CPU 與費用 · AC-11.4 · M · ← e11-t17
- [ ] `e11-t22` 儀表板與告警：同時在線、桌數、機器人思考時間、重連率、錯誤率 · AC-11.5 · M · ← e11-t08

**M2 · 安全、公平、法遵**

- [ ] `e11-t23` CSP 與安全標頭、session 列表與「登出其他裝置」· AC-11.7 · S
- [ ] `e11-t24` 安全審查（對照 OWASP ASVS Level 1），修正清單逐項開 task · AC-11.7 · M · ← e11-t23
- [ ] `e11-t25` 防作弊報表：同 IP／同裝置多帳號同場、挑戰與隊制賽中的異常模式，管理頁可查 · AC-11.8 · M · ← e7-t13, e8-t11
- [ ] `e11-t26` 功能旗標（全站／社團／使用者），新功能先對幹部開放 · AC-11.9 · S
- [ ] `e11-t27` 隱私權政策與使用條款頁；社員匯出自己的資料、刪除帳號時的資料處理流程（台灣個資法）· AC-11.10, AC-11.6 · M

## 風險與對策

- **拆分時出錯**：拆分前先完成 `e11-t13` 的可見性回歸測試與 `e11-t12` 的備份；每一步都保持 `tests/worker` 全過。
- **免費方案的 CPU 限制**：伺服器動作維持在 10 ms 內；重運算一律放機器人運算環境（E6）。

## 未決問題

- [ ] **Q:** M2 公開測試的預算上限？（影響 `e11-t16` 的拆分方式與是否升級付費方案）
      **A:** _(unanswered)_
