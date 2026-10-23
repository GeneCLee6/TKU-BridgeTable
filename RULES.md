# RULES — 工程慣例

## 1. 分層與職責

| 位置 | 職責 | 禁止 |
| --- | --- | --- |
| `shared/` | 橋牌規則與通訊型別，純函式 | React、DOM、Cloudflare API、`Date.now()` 以外的副作用 |
| `worker/service.ts`、`views.ts` | 帳號、權限、牌桌流程、可見性 | Cloudflare 專屬 API（只透過 `Store` 與 `Connections` 介面） |
| `worker/club.ts`、`index.ts` | Durable Object 與 Worker 轉接 | 遊戲規則 |
| `src/state/` | 登入狀態、WebSocket、偏好設定 | 繪製畫面 |
| `src/components/` | 展示與互動 | 直接呼叫 API 或 WebSocket（由 props 傳入 callback） |
| `src/pages/` | 組合：取狀態、接路由 | 樣式細節以外的規則判斷 |

- **伺服器把關**：任何規則（輪次、合法叫品、跟花、誰能看哪些牌）都在伺服器判斷；畫面只使用伺服器給的 `legalCalls`／`legalCards`。不能只在前端擋。
- **DRY**：顏色與間距只在 `styles/tokens.ts`；介面文字只在 `strings.ts`；牌與叫品只透過 `PlayingCard`／`SuitSymbol`／`CallLabel` 繪製。
- **KISS**：不用狀態管理函式庫；伺服器推完整畫面。

## 2. 程式風格

- TypeScript strict；不使用 `any`；`erasableSyntaxOnly`（不用 enum、建構子參數屬性）。
- Prettier 設定見 `.prettierrc.json`（無分號、單引號、尾逗號、寬 100）。
- 只用於樣式的 prop 加 `$` 前綴（`$size`、`$vul`），避免傳到 DOM。
- import 寫出 `.ts`／`.tsx` 副檔名。
- 程式碼、註解、commit、分支名稱使用英文；文件與介面使用繁體中文（台灣用語）。伺服器回給使用者的錯誤訊息用中文。

## 3. 測試

- `tests/engine`：叫牌、計分、出牌、攤牌、撤回、LIN。改規則一定要加測試。
- `tests/worker`：`ClubService` 的帳號、入座、可見性、權限、紀錄（Node 環境，MemoryStore）。
- `tests/presentation`：元件以 Testing Library 依角色與名稱查詢；牌的名稱是中文（`黑桃K`、`紅心10`），花色按鈕名稱是 `黑桃`、`NT`。
- 提交前：`npm run lint && npm run build && npm test` 全部通過。

## 4. Commit 與分支

- Conventional Commits：`feat:`、`fix:`、`docs:`、`chore:`、`test:`、`refactor:`、`design:`，可加範圍，如 `feat(table): add claim dialog`。
- 主旨用英文、祈使句。
- 功能在分支上開發，以 PR 合併到 `main`；不要直接推送 `main`，不要 force-push。
- **一個 task 一個 PR**（`docs/PRD/README.md`）：分支名帶 task 編號（`feat/e4-t16-contract-filter`），PR 標題結尾加編號（`feat(records): filter by contract [e4-t16]`），PR 本文寫對應的 AC；在同一個 PR 把 epic 裡的 task 勾起來並寫上 PR 號。
