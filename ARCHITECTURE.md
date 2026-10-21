# ARCHITECTURE — TKU BridgeTable · 淡江牌桌

## 1. 總覽

```
瀏覽器（React）                         Cloudflare
┌──────────────────────┐  HTTP /api/*  ┌────────────────────────────────────────┐
│ AuthContext ─────────┼──────────────►│ Worker (worker/index.ts)               │
│ ClubContext ═════════╪══ WebSocket ══╪═► Durable Object "Club" (worker/club.ts)│
│  pages / components  │     /ws       │     └─ ClubService (worker/service.ts) │
│  shared/ 引擎（重播）│               │          ├─ shared/ 引擎（驗證規則）   │
└──────────────────────┘  其他路徑     │          └─ Store → DO storage         │
                        ◄──────────────┤ 靜態檔案（Vite 建置的 React app）      │
                                       └────────────────────────────────────────┘
```

- 整個社團是**一個 Durable Object**：所有帳號、牌桌、牌局紀錄與 WebSocket 都在同一個物件裡，每個動作依序處理，不需要鎖或分散協調。10 人的社團遠低於單一物件的負載。
- 伺服器是唯一的真相：瀏覽器送「我要叫 1♠」「我要出 ♥K」，伺服器用 `shared/game.ts` 驗證後更新狀態，再推送每個人**可以看到的**畫面。
- 推送策略刻意簡單：任何變動後，對每位線上使用者送一份完整的大廳與他所在的牌桌。資料量小（一張桌幾 KB），不需要差異更新。

## 2. 資料夾結構

```
TKU-BridgeTable/
├─ shared/                 前後端共用，純函式，不碰 DOM 也不碰 Cloudflare API
│  ├─ cards.ts             牌、花色、座位
│  ├─ board.ts             發牌、發牌者、身價循環、密碼學亂數
│  ├─ auction.ts           叫品、合法叫品、叫牌結束、合約與莊家
│  ├─ game.ts              一副牌的狀態機：叫牌 → 出牌 → 結束；攤牌、撤回
│  ├─ scoring.ts           複式計分
│  ├─ lin.ts               BBO LIN 匯出與 Handviewer 連結
│  └─ protocol.ts          HTTP／WebSocket 的訊息與畫面型別
├─ worker/
│  ├─ index.ts             Worker 入口：/api/* 與 /ws 轉給 Durable Object，其他交給靜態檔案
│  ├─ club.ts              Durable Object：HTTP 路由、WebSocket（hibernation）、儲存轉接
│  ├─ service.ts           ClubService：帳號、session、牌桌、權限、牌局紀錄（可單獨測試）
│  ├─ views.ts             每位觀看者可見的牌桌畫面（可見性規則）
│  ├─ auth.ts              PBKDF2 密碼雜湊、session cookie
│  └─ store.ts             儲存介面與測試用 MemoryStore
├─ src/                    React app
│  ├─ components/          牌、手牌、叫牌盒、叫牌過程、牌號、名牌、墩、面板、頁首、聊天
│  ├─ pages/               Login、Lobby、Table、History、Board
│  ├─ state/               AuthContext、ClubContext（WebSocket）、PreferencesContext
│  ├─ lib/                 api（fetch）、cards（尺寸、名稱）、format、useMediaQuery
│  ├─ styles/              tokens、GlobalStyle
│  └─ strings.ts           所有介面文字
├─ tests/                  engine／worker／presentation 三層測試
├─ wrangler.jsonc          Worker、Durable Object、靜態檔案設定
└─ *.md                    文件
```

## 3. 遊戲引擎（`shared/`）

`BoardState` 只存**原始資料**，其他一律推導：

```ts
interface BoardState {
  boardNo: number; dealer: Seat; vul: Vulnerability
  hands: Hands              // 原始 52 張，永不修改
  auction: AuctionCall[]    // { seat, call, alert? }
  contract: Contract | null // 叫牌結束時決定
  play: PlayedCard[]        // 依序出的牌
  phase: 'auction' | 'play' | 'finished'
  claim?: Claim
  result?: BoardResult      // { declarerTricks, scoreNS, claimed }
}
```

- `tricksOf`、`turnOf`、`remainingCards`、`legalCards`、`tricksWon` 都由 `play` 推導，所以撤回只是把陣列最後一項拿掉，重播只是取 `play` 的前 n 張。
- 轉移函式（`makeCall`、`playCard`、`makeClaim`、`respondToClaim`、`undoLast`）是純函式，回傳新狀態或丟 `GameError`（中文訊息直接顯示給使用者）。
- 叫品用 ASCII：`1C`…`7N`、`P`、`X`、`XX`；牌是兩個字元：`SA`、`HT`（♥10）。

## 4. 可見性規則（`worker/views.ts`）

| 誰 | 看得到 |
| --- | --- |
| 入座者 | 自己的牌；首攻後的夢家；有人攤牌且自己需要回應時，攤牌者的牌 |
| 觀看者 | 四家（同 BBO kibitz） |
| 所有人，打完後 | 四家原始牌與所有 Alert 說明 |
| Alert 說明 | 叫牌者的同伴在打完前看不到 |

瀏覽器拿到的 `BoardView` 只包含它能看的牌，以及伺服器算好的 `legalCalls`／`legalCards`，畫面不需要自己判斷規則。

## 5. 通訊與儲存

**HTTP**：`POST /api/register`、`/api/login`、`/api/logout`；`GET /api/me`、`/api/history?scope=all`、`/api/history/:id`。session 放在 HttpOnly、SameSite=Lax 的 cookie（`tbt_session`）。

**WebSocket** `/ws`（同網域，帶 cookie 驗證）：

- 瀏覽器 → 伺服器：`createTable`、`joinTable`、`sit`、`stand`、`leaveTable`、`freeSeat`、`call`、`play`、`claim`、`claimRespond`、`undoRequest`、`undoRespond`、`ready`、`chat`
- 伺服器 → 瀏覽器：`welcome`、`lobby`、`table`、`error`
- 使用 Durable Object 的 hibernation API：沒人打牌時物件可以休眠，WebSocket 不會斷，醒來時從儲存重新載入。

**儲存**（Durable Object 的 key-value，SQLite 後端）：

| Key | 內容 |
| --- | --- |
| `user:<id>` | 帳號、密碼雜湊 |
| `session:<token>` | userId、到期時間 |
| `table:<id>` | 牌桌：座位、觀看者、目前這副、聊天、準備狀態、撤回請求 |
| `board:<時間>-<id>` | 牌局紀錄（補零的時間讓列表自然依時間排序） |

每個動作處理完立即寫回，物件隨時被回收都不會遺失牌局。

## 6. 技術選擇

| 選擇 | 理由 |
| --- | --- |
| Cloudflare Workers + Durable Object | 即時多人需要有狀態的伺服器；Durable Object 同時提供 WebSocket、持久儲存與「單一執行緒」語意，免費方案即可，不會像免費的 Node 主機那樣休眠或遺失磁碟資料 |
| 單一物件 | 社團規模小；所有狀態一起，邏輯最簡單 |
| `ClubService` 與 Durable Object 分離 | 規則與權限在 Node 中用 MemoryStore 測試，不需要 Workers 測試環境 |
| 引擎放 `shared/` | 伺服器驗證、瀏覽器重播共用同一份規則 |
| `@cloudflare/vite-plugin` | `npm run dev` 一個指令同時跑前端與 Worker，行為與正式環境相同 |
| styled-components、React Router、lucide | 與 TKU BridgeBook 一致 |
| 不用狀態管理函式庫 | 伺服器推送完整畫面，前端只存「最新一份」 |
