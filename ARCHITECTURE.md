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
│  ├─ deal-source.ts       牌從哪裡來：每副重洗（random）或指定牌組（fixed）
│  ├─ dealer.ts            條件發牌：每家點力、各門張數、平均牌型、一方合計點力；先抽張數再發牌，抽不到會回報
│  ├─ deal-presets.ts      條件預設集：1NT 開叫、高花開叫、滿貫、競叫、阻擊（南家的角度）
│  ├─ auction.ts           叫品、合法叫品、叫牌結束、合約與莊家
│  ├─ game.ts              一副牌的狀態機：叫牌 → 出牌 → 結束；攤牌、撤回
│  ├─ scoring.ts           複式計分
│  ├─ imp.ts               WBF IMP 表（挑戰與隊制賽共用）
│  ├─ challenge-scoring.ts 挑戰的計分：IMP、總分、MP、Cross-IMP、沒打完的副、同分名次
│  ├─ history-query.ts     紀錄搜尋的條件型別、解析與網址字串
│  ├─ lin.ts               BBO LIN 匯出與 Handviewer 連結
│  ├─ messages.ts          錯誤代碼與六種語言的訊息
│  ├─ protocol.ts          HTTP／WebSocket 的訊息與畫面型別
│  └─ robot/               機器人：robots（兩種機器人與各自的叫牌）、hand（牌型分析）、
│                          play（坐莊、防守信號）、system/（制度引擎與 2/1 制度：規則書、GIB 的牌力、說明、推論，
│                          `ROBOT.md` §6）
├─ worker/
│  ├─ index.ts             Worker 入口：/api/* 與 /ws 轉給 Durable Object，其他交給靜態檔案
│  ├─ club.ts              Durable Object：HTTP 路由、WebSocket（hibernation）、儲存轉接
│  ├─ service.ts           ClubService：帳號、申請、session、牌桌、權限、牌局紀錄（可單獨測試）
│  ├─ book.ts              BookService：淡江橋譜的線上內容、版本、匯入草稿與憑證
│  ├─ importer.ts          淡江橋譜的 AI 匯入：Claude 的提示、回覆 schema、串流
│  ├─ views.ts             每位觀看者可見的牌桌畫面（可見性規則）
│  ├─ history-index.ts     紀錄的 SQL 索引：建表、寫入、搜尋（§5.3）
│  ├─ notifications.ts     通知中心（§5.4）
│  ├─ relations.ts         好友與封鎖名單（§5）
│  ├─ modes.ts             牌桌模式與三個掛勾（發新一副、一副結束、寫紀錄）
│  ├─ scheduler.ts         統一排程器：機器人、自動發牌、之後的計時都走同一個 alarm 佇列
│  ├─ auth.ts              PBKDF2 密碼雜湊、session cookie
│  └─ store.ts             儲存介面與測試用 MemoryStore
├─ src/                    React app
│  ├─ components/          牌、手牌、叫牌盒、叫牌過程、牌號、名牌、墩、面板、頁首、聊天
│  ├─ pages/               Login、Lobby、Table、History、Board、Account、Admin
│  ├─ state/               AuthContext、ClubContext（WebSocket）、PreferencesContext
│  ├─ lib/                 api（fetch）、cards（尺寸、名稱）、format、useMediaQuery、robotRules（2/1 機器人的規則，
│                          需要時才載入，`useRobotRules`）
│  ├─ styles/              tokens、GlobalStyle
│  └─ strings.ts           所有介面文字（zh、en）
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

- `tricksOf`、`turnOf`、`remainingCards`、`legalCards`、`tricksWon` 都由 `play` 推導，所以撤回只是把陣列從某一項起截掉，重播只是取 `play` 的前 n 張。
- 轉移函式（`makeCall`、`playCard`、`makeClaim`、`respondToClaim`、`undoFor`）是純函式，回傳新狀態或丟 `GameError`（中文訊息直接顯示給使用者）。
- **撤回**（`undoFor`，同 BBO）：撤回「自己」最近的一個叫品或一張牌，以及之後所有人的動作；出牌階段莊家的牌包括夢家的。首攻之後只能撤回牌；首攻之前可以撤回叫牌（叫牌重新開始）。所以只要自己叫過牌，撤回鍵就一直能按，不必搶在別人動作之前。
- **攤牌**：出牌階段任何時候都可以（一墩打到一半也行），夢家除外；墩數是「剩下的墩（包括這一墩）我方再拿幾墩」。
- 叫品用 ASCII：`1C`…`7N`、`P`、`X`、`XX`；牌是兩個字元：`SA`、`HT`（♥10）。

## 4. 可見性規則（`worker/views.ts`）

| 誰 | 看得到 |
| --- | --- |
| 入座者 | 自己的牌；首攻後的夢家；夢家在首攻後也看得到莊家的牌 |
| 攤牌之後（被拒絕也一樣） | 攤過的牌不會再蓋回去：莊家攤牌後，兩位防家看得到四家的牌（莊家仍只看自己和夢家）；防家攤牌後，他的牌所有人都看得到。記在 `BoardState.claimed` |
| 觀看者 | 四家（同 BBO kibitz） |
| 所有人，打完後 | 四家原始牌與所有 Alert 說明 |
| Alert 說明 | 叫牌者的同伴在打完前看不到；機器人的說明除外（`AuctionCall.robot`），所有人都看得到，同 BBO 的 GIB |

指定牌組（`Table.dealSource` 的 `fixed`）整份只存在伺服器的 `Table` 裡，發到哪一副才放進 `BoardState.hands`，之後照上表的規則送出；`Table` 本身從不整份送到瀏覽器。

**打完的牌局什麼時候公開**（AC-4.9，`recordVisible`）：紀錄可以帶 `revealAt`（挑戰、隊制賽還在進行時）。在那之前，只有打那一副的四位看得到；其他人在紀錄列表、搜尋、詳細頁、牌桌側欄的 `recent` 都看不到（之後的收藏、精選也要套用）。搜尋在 SQL 裡套同一條規則（`reveal_at IS NULL OR reveal_at <= 現在 OR 我打過`），而且不管搜尋什麼條件都會套用，前端無法關掉。

**封鎖與聊天**（AC-1.6，`chatFor`）：牌桌聊天照每位觀看者過濾，他封鎖的社員說的話不會送到他的瀏覽器；其他人照常看得到，解除封鎖後保留的訊息會再出現。大廳的 `friends`／`blocked` 只送社員自己的名單，別人封鎖或加了誰不會送出。

瀏覽器拿到的 `BoardView` 只包含它能看的牌，以及伺服器算好的 `legalCalls`／`legalCards`／`canUndo`／`canClaim`，畫面不需要自己判斷規則。攤牌被拒絕後，`rejectedClaim` 記下誰拒絕，直到下一個動作。

## 5. 通訊與儲存

**HTTP**：`POST /api/register`（第一個帳號直接登入，之後回 202 `{ pending }`）、`/api/login`、`/api/logout`、`/api/password/reset`（忘記密碼）、`/api/account/password`；`GET /api/me`（含 `permissions`，管理員另有 `applications` 待審核數）、`/api/history?scope=all&page=<n>&size=<10|20|50|100>`（回傳該頁與總數）、`/api/history/search?<條件>`（§5.3）、`/api/history/:id`。管理員：`GET/POST /api/admin/users`、`POST /api/admin/users/:id/password`、`POST /api/admin/users/:id/admin`、`POST /api/admin/users/:id/permissions`、`DELETE /api/admin/users/:id`、`GET /api/admin/applications`、`POST /api/admin/applications/:id/approve`、`DELETE /api/admin/applications/:id`、`GET/POST /api/admin/settings`、`DELETE /api/admin/tables/:id`。淡江橋譜的 `/api/book/*` 見 §5.2。session 放在 HttpOnly、SameSite=Lax 的 cookie（`tbt_session`）。錯誤回應帶 `code` 與 `params`（`shared/messages.ts`），瀏覽器依語言顯示。

**WebSocket** `/ws`（同網域，帶 cookie 驗證）：

- 瀏覽器 → 伺服器：`createTable`（可帶 `settings`）、`updateTableSettings`、`joinTable`、`sit`、`stand`、`leaveTable`、`kick`、`addRobot`、`removeRobot`、`call`、`play`、`claim`、`claimRespond`、`undoRequest`、`undoRespond`、`chat`、`readNotifications`（不給 `ids` 就是全部標為已讀）、`setFriend`、`setBlocked`。`kick`、`addRobot`、`removeRobot`、`updateTableSettings` 只有房主能用；房主離開或斷線時，桌上第一位在線的真人（先入座者、再觀看者）接手
- 伺服器 → 瀏覽器：`welcome`、`lobby`（牌桌列表與 `members`：每位社員是否在線、在哪一桌哪個座位，線上在前、各組裡自己的好友置頂；`friends`、`blocked` 是自己的名單）、`table`、`error`、`notifications`（連線時一次，之後內容有變才送：最新 30 則與未讀數）
- **只送有變的部分**：伺服器記住每位社員上次收到的大廳與牌桌（JSON），沒變就不送；牌桌的 `chat` 與 `recent`（本桌最近 30 副的摘要）只在改變時才附上，瀏覽器沿用手上那份（`TableWire`）。所以某桌出一張牌，大廳裡的人什麼都收不到，桌上的人只收到小小一份。新連線一律收完整資料
- **沒有「下一副」**：一副結束後伺服器設定 `dealAt`（打到最後一張多等 `LAST_TRICK_MS` 3.5 秒，再加 `DEAL_COUNTDOWN_MS` 3 秒倒數），時間到自動發牌；`table` 訊息附上伺服器時間 `now`，瀏覽器據此換算成自己的時鐘來倒數
- **牌桌設定**：`Table.settings`（`shared/protocol.ts` 的 `TableSettings`）：`visibility`（`public` 所有社員可入座／`invite` 只限受邀）與 `allowKibitz`（是否允許觀看）；舊資料沒有這欄就用 `DEFAULT_TABLE_SETTINGS`（公開、允許觀看）。伺服器用 `parseTableSettings` 檢查，只接受這兩欄，錯了丟 `badTableSettings`。大廳的 `TableSummary` 與 `TableView` 都帶設定；受邀名單與不允許觀看的限制在 `e2-t25`、`e2-t26` 才生效
- **牌桌模式**：`Table.mode`（現在只有 `casual`，舊資料沒有這欄也當 `casual`）與 `modeState`；`ClubService` 只在三個地方問模式（`worker/modes.ts` 的 `TableModeHooks`）：發新一副（`deal`，回傳 `null` 表示沒有下一副，最後一副留在桌上）、一副結束（`boardFinished`）、寫紀錄（`record`）。叫牌、出牌、入座與可見性在每種模式都一樣。牌從 `Table.dealSource` 來（`shared/deal-source.ts`；沒有就是每副重洗）
- **排程**：機器人的下一步與自動發牌都交給同一個排程器（`worker/scheduler.ts`），每桌每種工作一個 key（`robot:<桌>`、`deal:<桌>`），同一個 key 還在等就不重排。Durable Object 用 `AlarmQueue`：工作放在記憶體，只把最早的一個設成物件唯一的 storage alarm（`alarm()` → `ClubService.runDue()`），所以不會互相覆蓋 alarm，物件在兩步之間也能休眠；工作不寫進儲存，物件被回收後由 `load()` 依牌桌狀態重新排程。測試傳 `schedule` 換成手動佇列
- **心跳**：瀏覽器每 15 秒送 `ping`，由 `setWebSocketAutoResponse` 直接回 `pong`（不必喚醒物件）。40 秒沒收到任何訊息、分頁回到前景或網路恢復時，瀏覽器立刻重新連線；重連期間的動作暫存 8 秒內補送
- **好友與封鎖**（AC-1.6，`worker/relations.ts`）：好友是單向關注，不需對方同意、也不通知對方（同 BBO）；`setFriend`／`setBlocked` 帶對方的 id 與 `true`／`false`，不能對自己（`notSelf`）、不存在的帳號或機器人（`userGone`）。封鎖會同時取消關注，封鎖中不能加好友（`unblockFirst`）。封鎖的效果都在伺服器：被封鎖者的聊天對封鎖者隱藏（§4），封鎖者當房主時被封鎖者不能 `joinTable` 或 `sit` 進那一桌（`blockedByHost`；已經在桌上的不會被請走）。之後的私訊、挑戰與隊制賽邀請也要檢查 `blocks`（`e1-t27`、`e7-t05`）。帳號刪除時雙方名單裡的他都會刪掉
- 使用 Durable Object 的 hibernation API：沒人打牌時物件可以休眠，WebSocket 不會斷，醒來時從儲存重新載入。

**儲存**（Durable Object 的 key-value，SQLite 後端）：

| Key | 內容 |
| --- | --- |
| `user:<id>` | 帳號、密碼雜湊、是否管理員、橋譜權限、最後登入時間、自行重設密碼的時間 |
| `app:<id>` | 待審核的註冊申請：帳號名稱、密碼雜湊、自我介紹、從哪個網站申請 |
| `session:<token>` | userId、到期時間 |
| `table:<id>` | 牌桌：座位、觀看者、目前這副、聊天、撤回請求 |
| `board:<id>` | 一副牌的完整紀錄（原始四手牌、叫牌、出牌、結果） |
| `hist:<時間>-<id>` | 全社團的紀錄索引（摘要，補零的時間讓列表依時間排序） |
| `uhist:<userId>:<時間>-<id>` | 每位社員自己的紀錄索引 |
| `notif:<userId>:<時間>-<id>` | 通知（`worker/notifications.ts`）：種類、參數、時間、是否已讀；每人只留最新 500 則，帳號刪除時一起刪 |
| `friend:<userId>:<friendId>` | 社員關注的好友（單向），值是 `{ at }`；載入時全部讀進記憶體 |
| `block:<userId>:<otherId>` | 社員封鎖的對象，值是 `{ at }`；載入時全部讀進記憶體 |
| `meta:settings` | 管理員改過的人數上限與邀請碼（沒改過就用環境變數） |
| `meta:schema` | 資料版本（現在是 3）：1→2 把舊版 `board:<時間>-<id>` 搬到新索引；2→3 把所有 `board:` 回填進 SQL 紀錄索引（§5.3） |
| `meta:backfill` | 回填 SQL 索引時做到哪一個 `board:` key；做完就刪掉，物件中途被回收時從這裡接著做 |
| `book:entry:<slug>` | 淡江橋譜線上修改的特約（版本、誰在何時改；`convention: null` 表示隱藏），內容在 `bookpart:` |
| `book:rev:<slug>:<時間>-<id>` | 每次儲存、隱藏、還原的版本紀錄 |
| `book:draft:<時間>-<id>` | AI 匯入產生的草稿（只留最新 30 份） |
| `book:ticket:<token>` | 匯入上傳用的一次性憑證（10 分鐘） |
| `book:version` | 橋譜線上內容的版本號，`GET /api/book/content` 的 ETag |
| `bookpart:<key>:<n>` | 大內容的分段（Durable Object 單筆值上限 128 KiB，以 4 萬字一段儲存） |

每個動作處理完立即寫回，物件隨時被回收都不會遺失牌局。紀錄列表一次只讀到那一頁為止（每頁 10／20／50／100 筆摘要）。

**容量**：免費方案每個帳號 5 GB；一副牌的紀錄連同兩筆索引約 4 KB，大約可存一百萬副以上。

## 5.4 通知中心

`NotificationService`（`worker/notifications.ts`）是 `ClubService.notifications`；其他功能呼叫 `notify(userId, kind, params)`。伺服器只存種類（`NOTIFICATION_KINDS`）和參數，文字由瀏覽器依語言組出來、點了到哪一頁也由瀏覽器決定（`src/lib/notifications.ts`），所以加新種類時要一起加 `strings.ts` 六種語言與連結。某位社員的通知第一次用到時才從儲存讀出、之後留在記憶體；有變就推 `notifications` 給在線的他（同樣只送有變的部分）。頁首鈴鐺（`NotificationBell`）顯示未讀數與列表，點一則標為已讀並跳到對應頁。

現有的種類：`application`（有人申請註冊，通知每位管理員，連到管理頁）。挑戰邀請、受邀桌、私訊等之後各自加。PWA 推播是 `e1-t28`（M2）。

## 5.3 紀錄的 SQL 索引（決策紀錄，`e4-t10`）

**決定**：紀錄的篩選與搜尋用 Durable Object 自己的 SQLite（`ctx.storage.sql`），不用 D1、不另開服務。完整紀錄仍放在 KV 的 `board:<id>`；SQL 只放查詢需要的欄位，隨時可以從 `board:` 重建。列表（`/api/history`）與搜尋都從 SQL 讀；`hist:`／`uhist:` 的 KV 索引仍照寫（管理頁的每人副數用 `uhist:`），之後確定沒人用再拿掉。舊的 `meta:count:` 已不再使用。

**為什麼**：
- `Club` 本來就是 SQLite 後端（`wrangler.jsonc` 的 `new_sqlite_classes`），不用新增 binding 或付費方案；查詢跟牌局在同一個物件裡，寫入和讀取都不必跨網路。
- KV 索引只能依時間往前翻，做不到「4♠ 合約」「我和 X 是搭檔」這種條件；SQL 加上索引在一萬副時也很快（AC-4.8 的測試在 `e4-t23`）。
- E11 把紀錄搬到 D1（AC-11.4）時，這份 schema 原樣搬過去。

**介面**：`ClubService` 只透過 `Store.sql`（`worker/store.ts` 的 `Sql`：同步的 `exec`、`transaction`）碰 SQL；Durable Object 接到 `storage.sql.exec` 與 `storage.transactionSync`，測試用 Node 內建的 `node:sqlite`（`tests/worker/sqlite.ts`）。所有查詢一律用 `?` 參數，不拼字串。程式在 `worker/history-index.ts`。

**表**（載入時 `CREATE TABLE IF NOT EXISTS`，每次載入都跑也沒關係）：

| 表 | 欄位 | 索引 |
| --- | --- | --- |
| `boards_index` | `board_id`（主鍵）、`played_at`、`table_no`、`mode`（現在都是 `casual`）、`event_id`、`board_no`、`dealer`、`vul`、`level`、`strain`（四家 Pass 時兩者為 null）、`doubled`（0／1／2）、`declarer_seat`、`declarer_user`（機器人主打為 null）、`tricks`、`score_ns`、`claimed`、`reveal_at`（null＝已公開；挑戰與隊制賽在 `e4-t15` 用） | `(played_at, board_id)`、`(level, strain, played_at)`、`(declarer_user, played_at)` |
| `board_players` | `board_id`、`seat`（主鍵兩欄）、`side`（NS／EW）、`user_id`（機器人與空位為 null） | `(user_id, board_id)` |

「誰打的」查 `board_players.user_id`；「搭檔是誰」是同一副、同一個 `side`、不同 `seat`（`boardsPlayedBy`、`boardsPlayedWith`）。

**寫入**：每副打完，`saveRecord` 先在一個 transaction 裡寫 SQL（一列 `boards_index`＋四列 `board_players`，`INSERT OR REPLACE`，重寫同一副不會多出列），再寫 KV。SQL 失敗就什麼都不寫；SQL 寫好之後 KV 失敗，就把 SQL 的列和 `board:` 拿掉再丟出錯誤，不留半套。

**回填**（`meta:schema` 2→3）：載入時把既有的 `board:` 一次 100 副寫進 SQL，每批寫完把最後一個 key 存在 `meta:backfill`，物件被回收就從那裡接著做；同一副寫兩次結果一樣，所以重跑也安全。全部做完才把 `meta:schema` 設成 3。

**搜尋**（`e4-t14`）：`GET /api/history/search`，條件型別與檢查在 `shared/history-query.ts`（前後端共用；`historyQueryString` 寫、`parseHistoryQuery` 讀，不認得的參數或值回 `badHistoryQuery` 並指出哪個欄位）。條件全部選填、彼此是「而且」：

| 參數 | 意思 |
| --- | --- |
| `scope` | `mine`（預設，我打過的）／`all` |
| `level`、`strain` | 合約階數 1–7、花色 `C D H S N`，可只給一個 |
| `doubled` | `undoubled`、`X`、`XX`、`doubled`（X 或 XX） |
| `bracket` | `partial`、`game`（成局但不到滿貫）、`slam`（6 線）、`grand`、`passout` |
| `declarer`、`declarerSeat`、`declarerSide` | 莊家是誰、莊家方位、相對於我：`me`／`partner`／`opponents`（機器人主打也算） |
| `player`、`partner` | 某人有打（配 `scope=mine` 就是「我和他同桌」）、他是我的搭檔 |
| `from`、`to` | 台灣日期 `YYYY-MM-DD`，兩端都含 |
| `result` | `made`（含超墩）、`down`、`overtricks` |
| `vul`、`boardNo`、`table`、`mode` | 身價、牌號、桌號、模式 |
| `sort` | `date_desc`（預設）、`date_asc`、`score_desc`、`score_asc`、`tricks_desc`、`tricks_asc`（四家 Pass 一律排最後） |
| `page`、`size` | 頁碼（超過最後一頁就給最後一頁）、每頁 10／20／50／100 |

SQL 由 `worker/history-index.ts` 的 `searchBoards` 組：只有固定的 SQL 片段會拼進字串，所有值都用 `?` 參數。先數總數，再取那一頁的 id，摘要從 `board:<id>` 讀。

## 5.2 與淡江橋譜共用帳號

淡江橋譜（TKU BridgeBook，Vercel 上的靜態網站）沒有自己的後端，帳號與線上內容都在這個 Worker：

```
橋譜的瀏覽器 ──/api/*──► Vercel（vercel.json rewrite）──► 這個 Worker ──► Durable Object
             └─匯入上傳（帶一次性憑證，直接連 Worker，不經過 Vercel）──┘
```

- **同一批帳號、各自的登入**：橋譜的 `/api/*` 由 Vercel 轉發，`tbt_session` cookie（沒有 Domain 屬性）因此屬於橋譜自己的網域。兩站用同一組帳號密碼，但要各自登入一次。`/ws` 不經過橋譜。
- **申請與核准**：`ClubService.register` 第一個帳號直接建立（管理員），之後一律存成 `app:<id>`，`adminApprove` 才建立帳號（受人數上限限制）。申請中的名稱不能被別人註冊；用申請時的密碼登入會得到 `awaitingApproval`。
- **忘記密碼**：`resetForgottenPassword(username, inviteCode, password)`，管理員帳號不行（`adminNoSelfReset`）；重設後登出所有 session 並記下 `passwordResetAt`。
- **權限**：`StoredUser.permissions`：`bookEdit`（線上編輯）、`bookImport`（匯入檔案）；管理員兩者都有。`requirePermission` 在 `/api/book/*` 檢查。

**橋譜 API**（`worker/book.ts` 的 `BookService`，路由在 `club.ts` 的 `bookApi`）：

| 路由 | 權限 | 說明 |
| --- | --- | --- |
| `GET /api/book/content` | 不用登入 | 所有線上修改 `{ version, entries }`，帶 ETag |
| `PUT /api/book/conventions/:slug` | bookEdit | `{ convention, baseVersion, bundledUpdated?, note? }`；`baseVersion` 不是目前版本時回 409 `bookConflict` |
| `POST /api/book/conventions/:slug/reset` | bookEdit | 刪除線上版本，橋譜改回顯示內建的版本 |
| `POST /api/book/conventions/:slug/hide` | 管理員 | 從橋譜隱藏 |
| `GET /api/book/conventions/:slug/revisions[/:id]` | bookEdit | 版本紀錄（新的在前）與某一版的內容 |
| `POST /api/book/import/ticket` | bookImport | 一次性憑證與上傳網址 |
| `POST /api/book/import` | 憑證 | multipart：`ticket`、`meta`、`file`（PDF）或 `text`；回應是 Claude 的 SSE 串流，CORS `*` |
| `GET/POST /api/book/drafts`、`GET/DELETE /api/book/drafts/:id` | bookImport | 匯入草稿 |

伺服器只檢查特約的**形狀**（`checkConvention`：必填欄位、段落 id 唯一、區塊種類），不管內容；橋譜載入時也會再檢查一次，壞掉的內容不會讓網站掛掉。

**AI 匯入**（`worker/importer.ts`）：用官方 SDK 呼叫 `claude-opus-5-5`（`max_tokens` 128K、effort medium、結構化輸出、伺服器端 refusal fallback）。PDF 用 Files API 上傳（Worker 不必自己做 base64，免費方案每次請求的 CPU 只有 10 ms），文字直接放進 document 區塊。回應用 `asResponse()` 原封不動串流回瀏覽器，Worker 不解析。上傳不經過 Vercel，因為 Vercel 轉發外部請求最多等 120 秒。結構化輸出不支援遞迴 schema，所以回覆是扁平的（段落用 `parentId`、條列用 `level`），**由橋譜的 `src/lib/importResult.ts` 組回樹狀，兩邊要一起改**。

## 5.1 機器人

座位裡的 id 若是 `robot:<種類>:<座位>` 這種格式就是機器人：`robot:gib:N` 是 2/1 機器人（GIB 相容），`robot:tku:N` 是淡江機器人，舊資料的 `robot:N` 一律當淡江機器人（`shared/protocol.ts` 的 `robotId`、`robotKindOf`）。房主放機器人時選種類（`addRobot` 的 `kind`，沒寫就是淡江機器人），機器人照自己的種類叫牌（`shared/robot/robots.ts` 的 `robotCall`）；2/1 機器人的叫品除了繁中說明還存著叫品的意義（`AuctionCall.meaning`），瀏覽器依觀看者的語言顯示，規則檔需要時才載入。名牌與紀錄裡的機器人帶 `robotKind`，畫面依語言顯示名字（`strings.ts` 的 `playerName`）。每次狀態改變後，`ClubService.scheduleRobots` 檢查是否輪到機器人（叫牌、出牌，或回應攤牌／撤回），經排程器（§5）排一個短暫延遲（叫牌 0.8 秒、出牌 1.4 秒、一墩結束後 3 秒，配合牌 1.3 秒的滑動）再執行，執行完再排下一個；每張桌子同時最多一個機器人工作。機器人同意撤回；攤牌由對手方的機器人用雙明手分析判斷（`shared/robot/claim.ts`，見 `ROBOT.md` §3.1）。物件重新載入時也會重新排程。至少要有一位真人在座，機器人才會行動；最後一位真人離開，桌子就關閉。

**真人不當機器人的夢家**：叫牌結束時若莊家是機器人、夢家是真人，`swapForDeclarer` 把兩人的座位對調（同 BBO），真人坐到莊家的位子主打，機器人帶著它的種類坐到原本的位子當夢家；對調記在 `Table.swapped`。若撤回最後一個 Pass 讓叫牌重新開始，`unswap` 換回來；下一副發牌時清掉記錄（座位維持對調後的樣子）。叫牌與出牌規則見 `ROBOT.md`。

**機器人的大腦**（`shared/robot/brain.ts`）：`ClubService` 只透過 `RobotBrain`（`bid`、`play`、`acceptsClaim`）問機器人，預設是規則機器人 `ruleBrain`，測試或之後更強的大腦從 `ClubConfig.brain` 換進來。排程時只決定「哪個機器人、多久後動」（`robotMove`），輪到它時才問大腦（`decide`），所以每一步只想一次。現在的回答是同步的；`e6-t11` 改成非同步，2 秒沒回來或出錯就用規則機器人。

### 5.1.1 決策紀錄：機器人運算放哪裡（`e6-t09`，2026-10-24）

**背景**：免費方案每次請求只有 10 ms CPU。規則機器人與 3 萬局面的攤牌判斷塞得進去，DDS 與模擬塞不進去：整副牌的 DD 表用 WASM 版 DDS 平均要 0.4 秒（`e6-t12` 的量測，見下）。而且整個社團只有一個 Durable Object，它是單執行緒的，在裡面算 0.4 秒，所有牌桌都會跟著卡住。

| | A. Workers 付費方案 | B. Cloudflare Containers | C. 外部主機 |
| --- | --- | --- | --- |
| 做法 | 另一個 `robot` Worker 跑 WASM 版 DDS，`Club` 用 service binding 呼叫 | 容器跑原生 DDS（C++，可多執行緒），`Club` 經 Worker 呼叫 | VPS 等主機跑原生 DDS，對外開 API |
| 成本 | 每月 5 美元起；含每月 3,000 萬 CPU ms，一副 DD 表約 400 ms，社團用量遠低於額度 | 也要付費方案（5 美元），另依記憶體、CPU 計費，休眠時不計 | 主機約每月 5 美元起，另計流量 |
| 每次 CPU 上限 | 預設 30 秒，可調到 5 分鐘 | 不限 | 不限 |
| 延遲 | 同一個資料中心，幾乎沒有額外延遲 | 容器休眠後第一次呼叫要冷啟動（數秒） | 跨網路，數十到數百 ms |
| 速度 | WASM 單執行緒；量測見下 | 原生、多執行緒，最快（未量測） | 同 B |
| 維運 | 跟現在一樣用 `wrangler deploy`，沒有新東西要管 | 要維護 Docker 映像與 C++ 建置 | 另一台機器的更新、監控、金鑰、HTTPS |

**決定**：要在伺服器跑 DDS 時選 **A**。理由：一般牌局的 DD 表與單一局面每張牌的墩數都在 2 秒的思考上限內，額度遠超過社團用量，不用多管一套系統。WASM 的 DDS 在 Workers 不能執行時才編譯，要改成匯入預先編譯好的 `.wasm` 模組（`e6-t13`）。DDS 與 `bridge-dds` 都是 Apache-2.0，要附上授權聲明。

**付費：暫不付（社團決定，2026-10-24）**。現階段的做法：

1. **先把規則機器人做強**，不用 DDS：出牌時讀叫牌推論、數牌、坐莊計畫、防守推論（ROADMAP 新的 B4、B10）。等級 1–3 都不需要伺服器 DDS。
2. **DDS 只用在不花錢的地方**：殘局與攤牌判斷用 `dd.ts`（已經在做）；牌打完、四家公開以後，紀錄頁在**瀏覽器**裡用 WASM 版 DDS 算 DD 表與 par（`e6-t43`，B11）。機器人打牌時的思考不能放在瀏覽器，因為那需要別人的牌（`CLAUDE.md` 硬性規則 2）。
3. **之後再付**：有人要等級 4（橋士組，模擬出牌），或同時在線的人多到規則機器人不夠用時，再升級付費方案。升級只是在 Cloudflare 後台切換方案，不用搬家；`RobotBrain` 讓 DDS 大腦直接換進來（ROADMAP Phase P）。

**規模估算**（全台灣使用時參考，2026-10 的官方價格）：最壞的情況是 300 人同時在線、每人一桌配 3 個 GIB 式機器人，尖峰每天 4 小時，每月約 43 萬副。每次出牌模擬 50 副牌、每副機器人約用 10–20 秒 CPU：

| 項目 | 每月 |
| --- | --- |
| 月費（含 3,000 萬 CPU ms、1,000 萬次請求） | 5 美元 |
| 機器人 CPU（43–86 億 ms，超出部分每百萬 ms 0.02 美元） | 約 85–170 美元 |
| 牌桌的 Durable Object 時間（依在記憶體裡的時間計費，機器人每 1.4 秒動一次，物件不會休眠） | 每桌一個物件約 200 美元；幾十桌共用一個物件幾乎是 0 |
| **合計** | **約 100–380 美元** |

- 只在關鍵時刻模擬（首攻、飛牌方向、關鍵的跟牌），其他照規則出牌，CPU 可降到 1/5–1/10，約每月 20–40 美元。
- 付費方案用多少付多少，沒有更高一級的固定方案；Enterprise 是合約折扣與 SLA，不是額度。沒有全帳號的花費上限，要自己設每次請求的 CPU 上限與用量警示。
- 這個規模真正要先處理的是架構：每個 Durable Object 單執行緒，官方的軟上限約每秒 1,000 個請求，整個社團一個物件撐不住，要先做 E11 的拆分，而且是**一群桌子一個物件**，不要每桌一個（省 Durable Object 時間）。

**什麼時候重新考慮 B**：M2 的模擬出牌每一步要解幾十副抽樣的牌。WASM 解一副整牌的中位數是 11–46 ms，打到後面的墩不到 1 ms，所以前幾墩的模擬可能超過 2 秒。等評測平台（B7）量出來真的不夠，再把最重的部分搬到 B。

**`e6-t12` 的量測**（Intel i5-14500、Node 22，WASM 單執行緒；`bridge-dds` 1.4.0 ＝ DDS 2.9）：

| 項目 | 結果 | AC-6.4 目標 |
| --- | --- | --- |
| DD 表（整副 52 張、200 副） | 平均 417 ms、p50 266、p90 948、p99 3,701 ms | < 1 秒：九成的牌做得到 |
| 首攻時每張牌的墩數（無王／黑桃王） | p50 11／46 ms、p90 75／259 ms | < 20 ms：無王的一半做得到 |
| 每家剩 9 張、6 張時每張牌的墩數 | 平均 0.9 ms、0.3 ms | 達成 |
| `dd.ts` 解整副牌（500 萬節點上限） | 20 副有 18 副超過上限放棄，每副約 2 秒 | 做不到 |
| `dd.ts` 解每家 6–9 張 | 平均 2–63 ms，與 DDS 結果 60／60 一致 | — |
| 每家 5 張的殘局 | `dd.ts` 與 DDS 300／300 一致 | — |

結論：DDS 用 WASM 版（**自己寫 TypeScript 的 DDS 不划算**，`dd.ts` 在整副牌慢上百倍，留作後備與殘局）。AC-6.4 的「< 1 秒」與「< 20 ms」單靠 WASM 只有多數牌做得到，尾端要靠：逾時就用規則機器人（`e6-t11`）、同一副牌連續呼叫時重用 DDS 的轉置表、只在需要時才算整張 DD 表。原生 DDS 的量測留到真的考慮 B 時再做。

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
