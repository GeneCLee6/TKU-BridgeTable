# CLAUDE.md — TKU BridgeTable · 淡江牌桌

給 Claude Code 的專案說明。開始工作前先讀 `RULES.md` 與 `ARCHITECTURE.md`。

## 這是什麼

淡江橋藝社的線上牌桌：社員註冊、開桌、四人即時打橋牌、保存牌局紀錄。牌桌樣式參照 BBO。React 19 + TypeScript（strict）+ styled-components + Vite；後端是 Cloudflare Worker + 一個 Durable Object（`Club`）。姊妹專案是 TKU BridgeBook（`C:\dev\TKU-BridgeBook`），外框設計與慣例相同。

## 先讀

| 情境 | 讀 |
| --- | --- |
| 改規則、通訊、可見性、儲存 | `ARCHITECTURE.md` |
| 改介面、顏色、牌桌元件 | `DESIGN.md` |
| 部署、管理員、邀請碼、人數上限 | `DEPLOY.md` |
| 機器人的叫牌與防守 | `ROBOT.md` |
| 產品範圍與 Roadmap | `PRD.md` |

## 硬性規則

1. **規則只在伺服器判斷。** 前端只用 `BoardView.legalCalls`／`legalCards`；新增動作要在 `ClubService` 驗證權限並加 `tests/worker` 測試。
2. **不要把不該看的牌送到瀏覽器。** 可見性只在 `worker/views.ts`，改動時更新 `ARCHITECTURE.md` §4 與測試。
3. **`shared/` 保持純函式**，不 import React、DOM 或 `cloudflare:workers`。
4. **`ClubService` 不碰 Cloudflare API**，只透過 `Store` 與 `Connections`。
5. **顏色只來自 `styles/tokens.ts`**，介面文字只來自 `strings.ts`（繁中、簡中、英、越、日、韓六份都要加，`shared/messages.ts` 也一樣）；伺服器的錯誤只丟 `ClubError`／`GameError` 加 `shared/messages.ts` 的代碼。只用於樣式的 prop 加 `$` 前綴。
6. **機器人只能用它看得到的牌**（`shared/robot/play.ts` 的 `View`），不能讀 `state.hands` 裡別人的牌。叫牌規則以淡江橋譜為準，改了要更新 `ROBOT.md`。
7. **不要直接推送到 `main`，也不要 force-push。** 功能走分支＋PR。
8. 程式碼、註解、commit 用英文；文件與介面用繁體中文（台灣用語）。

## 已知陷阱

- **`erasableSyntaxOnly`**：不能用建構子參數屬性（`constructor(private x)`）或 enum。
- **`getWebSockets()` 在 `webSocketClose` 裡仍包含正在關閉的 socket**，判斷使用者是否離線要排除它（見 `club.ts`）。
- **Durable Object 隨時可能被回收**：所有狀態改動都要寫回 `Store`；`load()` 在建構時透過 `blockConcurrencyWhile` 載入。
- **Vitest 不載入 Cloudflare 外掛**（`vite.config.ts` 依 `VITEST` 判斷）；`tests/worker` 用 `// @vitest-environment node`。
- **本機四人測試**：同一個瀏覽器共用 cookie，要用不同的瀏覽器設定檔或無痕視窗；或直接放三個機器人。
- **機器人排程**：`ClubService` 的 `schedule` 在測試裡換成手動佇列（`tests/worker/service.test.ts` 的 `runRobots`）。
- **jsdom 的瀏覽器語言是英文**：`tests/setup.ts` 先把偏好設成中文，元件測試才能用中文名稱查詢。

## 指令

```bash
npm run dev        # http://localhost:5173（前端＋Worker＋Durable Object）
npm run build      # tsc -b + vite build
npm run lint       # oxlint
npm test           # vitest run
npm run deploy     # build + wrangler deploy
```
