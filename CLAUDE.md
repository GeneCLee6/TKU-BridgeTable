# CLAUDE.md — TKU BridgeTable · 淡江牌桌

給 Claude Code 的專案說明。開始工作前先讀 `RULES.md` 與 `ARCHITECTURE.md`。

## 這是什麼

淡江橋藝社的線上牌桌：社員註冊（管理員核准）、開桌、四人即時打橋牌、保存牌局紀錄。這個 Worker 也是姊妹站淡江橋譜的後端：兩站共用帳號，橋譜的線上內容、版本紀錄與 AI 匯入在 `worker/book.ts`、`worker/importer.ts`（ARCHITECTURE.md §5.2）。牌桌樣式參照 BBO。React 19 + TypeScript（strict）+ styled-components + Vite；後端是 Cloudflare Worker + 一個 Durable Object（`Club`）。姊妹專案是 TKU BridgeBook（`C:\dev\TKU-BridgeBook`），外框設計與慣例相同。

## 先讀

| 情境 | 讀 |
| --- | --- |
| 改規則、通訊、可見性、儲存 | `ARCHITECTURE.md` |
| 改介面、顏色、牌桌元件 | `DESIGN.md` |
| 部署、管理員、邀請碼、人數上限、AI 金鑰 | `DEPLOY.md` |
| 帳號申請、權限、淡江橋譜的 API | `ARCHITECTURE.md` §5.2 |
| 機器人（TKB，淡江制度或 2/1）的叫牌與防守 | `ROBOT.md`；2/1（GIB 相容）的制度與來源：`docs/BBO GIB/` |
| 產品範圍與 Roadmap | `docs/PRD/00-prd.md`（總 PRD）、`docs/PRD/01-bbo-competitive-analysis.md`（BBO 競品分析） |
| **開工前** | `docs/NEXT.md`（現在的位置、工作方式、開工指令範本）、`docs/ROADMAP.md`（全部批次的順序，一批一個 PR）|
| 開工一個 task | `docs/PRD/README.md`（task 格式、一組 task 一個 PR）與該 task 所在的 epic（`docs/PRD/e*.md`） |

## 硬性規則

1. **規則只在伺服器判斷。** 前端只用 `BoardView.legalCalls`／`legalCards`；新增動作要在 `ClubService` 驗證權限並加 `tests/worker` 測試。
2. **不要把不該看的牌送到瀏覽器。** 可見性只在 `worker/views.ts`，改動時更新 `ARCHITECTURE.md` §4 與測試。
3. **`shared/` 保持純函式**，不 import React、DOM 或 `cloudflare:workers`。
4. **`ClubService` 與 `TableService` 不碰 Cloudflare API**，只透過 `Store`、`Connections` 與牌桌介面（`worker/tables.ts`）；Durable Object 的細節留在 `club.ts` 與 `table-object.ts`（一桌的邏輯在不碰 Cloudflare 的 `table-host.ts`）。
5. **顏色只來自 `styles/tokens.ts`**，介面文字只來自 `strings.ts`（繁中、簡中、英、越、日、韓六份都要加，`shared/messages.ts` 也一樣）；伺服器的錯誤只丟 `ClubError`／`GameError` 加 `shared/messages.ts` 的代碼。只用於樣式的 prop 加 `$` 前綴。
6. **機器人只能用它看得到的牌**（`shared/robot/play.ts` 的 `View`），不能讀 `state.hands` 裡別人的牌。機器人只有一個 TKB、沒有等級（之後有伺服器 DDS 才加 TKB Adv）；TKB 用淡江制度時叫牌以淡江橋譜為準，用 2/1 時照 `docs/BBO GIB/gib-2over1.md`（BBO GIB 公開的制度，不複製 BBO 的程式或原文）；改了要更新 `ROBOT.md`。
7. **不要直接推送到 `main`，也不要 force-push。** 功能走分支＋PR。合併一律用 `gh pr merge <號> --squash --delete-branch`，遠端與本地分支一起刪；分支在 worktree 裡的話先 `git worktree remove` 再刪分支。GitHub 已開「合併後自動刪除分支」，但關掉不合併的 PR 不會自動刪，要手動 `git push origin --delete <分支>`。
8. 程式碼、註解、commit 用英文；文件與介面用繁體中文（台灣用語）。

## 已知陷阱

- **`erasableSyntaxOnly`**：不能用建構子參數屬性（`constructor(private x)`）或 enum。
- **`getWebSockets()` 在 `webSocketClose` 裡仍包含正在關閉的 socket**，判斷使用者是否離線要排除它（見 `club.ts`）。
- **Durable Object 隨時可能被回收**：所有狀態改動都要寫回 `Store`；`load()` 在建構時透過 `blockConcurrencyWhile` 載入。
- **Vitest 不載入 Cloudflare 外掛**（`vite.config.ts` 依 `VITEST` 判斷）；`tests/worker` 用 `// @vitest-environment node`。
- **開發模式的 React StrictMode 會把 effect 跑兩次**：牌桌動畫（`TrickArea`、`DealAnimation`）第一次就記下起點、重量位置前先取消進行中的動畫，否則開發時牌會從錯的地方飛出來。
- **離開牌桌頁面就離開牌桌**：`TablePage` 卸載時若網址已不在 `/table/` 就送 `leaveTable`；牌桌頁裡會離開頁面的連結（側欄紀錄）要開新分頁。
- **本機四人測試**：同一個瀏覽器共用 cookie，要用不同的瀏覽器設定檔或無痕視窗；或直接放三個機器人。
- **機器人排程**：`ClubService` 的 `schedule` 在測試裡換成手動佇列（`tests/worker/service.test.ts` 的 `runRobots`）。
- **jsdom 的瀏覽器語言是英文**：`tests/setup.ts` 先把偏好設成中文，元件測試才能用中文名稱查詢。
- **註冊不再直接建立帳號**：只有第一個帳號會；測試要用 `tests/worker/service.test.ts` 的 `join()`（註冊＋核准）或 `founder()`。
- **`/api/book/*` 是淡江橋譜在用的介面**：型別在橋譜的 `src/lib/api.ts`，AI 匯入的扁平 schema 由橋譜的 `src/lib/importResult.ts` 解讀，改了要一起改橋譜。
- **紀錄頁讀的是 D1 的副本**（ARCHITECTURE.md §5.12）：改了 `summarize`、`BoardSummary` 或索引的表，要把 `worker/history-replica.ts` 的 `REPLICA_VERSION` 加一，副本才會重填；搜尋條件只改 `history-index.ts` 的 `where()`，兩邊共用。
- **免費方案每次請求只有 10 ms CPU**：AI 匯入的串流原封不動轉回瀏覽器（`asResponse()`），PDF 走 Files API，不要在 Worker 解析串流或做 base64。

## 指令

```bash
npm run dev        # http://localhost:5173（前端＋Worker＋Durable Object）
npm run build      # tsc -b + vite build
npm run lint       # oxlint
npm test           # vitest run
npm run deploy     # build + wrangler deploy
```
