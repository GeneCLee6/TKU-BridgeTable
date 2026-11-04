# ARCHITECTURE — TKU BridgeTable · 淡江牌桌

## 1. 總覽

```
瀏覽器（React）                           Cloudflare
┌──────────────────────┐  HTTP /api/*    ┌──────────────────────────────────────────────┐
│ AuthContext ─────────┼────────────────►│ Worker (worker/index.ts → routing.ts)        │
│ ClubContext ═════════╪═ WebSocket /ws ═╪═► Durable Object "Club" (worker/club.ts)     │
│   （兩條連線）       │                 │     └─ ClubService：帳號、大廳與牌桌目錄、紀錄│
│                ══════╪═ /ws/table/<id>═╪═► 每桌一個 "TableObject"（table-object.ts） │
│  pages / components  │                 │     └─ TableHost → TableService：一桌的一切  │
│  shared/ 引擎（重播）│                 │   兩者之間是 Durable Object RPC（§5.10）      │
└──────────────────────┘  其他路徑       │                                              │
                        ◄────────────────┤ 靜態檔案（Vite 建置的 React app）            │
                                         └──────────────────────────────────────────────┘
```

- 社團是**一個 Durable Object**（`Club`）：帳號、大廳與牌桌目錄、牌局紀錄、挑戰、隊制賽、淡江橋譜。**每張牌桌是自己的 Durable Object**（`TableObject`，§5.10）：座位、叫牌出牌、機器人、聊天與這一桌的 WebSocket。每個物件裡的動作依序處理；社團只在大廳看得到的事情變了才被牌桌叫醒。開關 `TABLE_OBJECTS=off` 可以把牌桌搬回社團的物件（`DEPLOY.md` §4.3）。
- **每個社團一個 Durable Object**（多租戶決策，`e12-t02`，2026-10-30 社長決定；淡江橋館 `e10-t10`）：社團 id 對應物件名稱在 `shared/clubs.ts`（目前只有淡江 `tku`，物件名稱維持原本的 `club`，正式站資料不搬）。社團之間的資料天生隔離，key **不加** `club:<id>:` 前綴。請求用 header `X-Club-Id` 說是哪個社團（WebSocket 不能帶 header，用 `?club=`），沒帶就是淡江，所以舊頁面與舊版本照舊；不認得的社團 404 `unknownClub`（`worker/routing.ts`）。`/api/me` 的 `clubId` 是帳號所屬的社團（物件的名稱決定），淡江橋館拿來帶在之後的請求上。
- **社團物件之外的東西也分社團**（`e12-t03`，2026-11-04；見下面「多社團的隔離」）。淡江的名稱與路徑一律維持原樣，正式站不必搬任何資料。

### 多社團的隔離（`e12-t03`）

社團物件裡的資料（帳號、session、紀錄、分享連結、通知、推播訂閱、論壇、比賽、積分、次數限制、指標）本來就各是各的；跨社團會碰到的只有物件**之外**的共用資源，每一樣都帶社團：

| 共用的東西 | 怎麼分 | 淡江 |
| --- | --- | --- |
| 有哪些社團 | `shared/clubs.ts` 的 `knownClubs`：淡江加上 Worker 變數 `CLUBS`（逗號分隔的 id，格式 `CLUB_ID_PATTERN`）；其他社團的物件名稱是 `club:<id>`。社團物件從**自己的名稱**讀出自己是哪個社團（`clubOfClubObject`），所以 `CLUBS` 拿掉之後被 alarm 叫醒的物件也不會把自己當成淡江 | 物件名稱 `club` |
| `TableObject` | 名稱 `tableObjectName(社團, 桌 id)`＝`<社團>/<桌 id>`；只有 `worker/clubs.ts` 組名稱，所以社團只叫得到自己的桌。牌桌從自己的名稱讀出社團（`clubOfScopedName`），只回報那個社團（`ownClub`；社團不再服務時回報失敗、留在 outbox，不會跑到別的社團）。`/ws/table/<id>` 由 Worker 轉過去時帶 `X-TBT-Club`（`TABLE_CLUB_HEADER`），牌桌只收自己社團的連線 | 名稱就是桌 id，同以前 |
| `EventObject` | `eventObjectName`＝`<社團>/challenge:<id>`、`<社團>/match:<id>`、`<社團>/pairs:<id>`；同樣只回報名稱裡的社團 | `challenge:<id>` 等，同以前 |
| 邊緣通行證 `tbt_pass` | 簽章內容加上社團（`pass3:<社團>:…`）：社員 id 只在社團內唯一，別的社團的通行證一律當成沒有，交給那個社團判斷 | 部署後舊的 `pass2` 通行證失效，社團下一次回答就換新的 |
| D1 紀錄副本 | 每列都有 `club_id`，而且是每個主鍵的第一欄（`board_id` 只在社團內唯一）；每個社團只寫、只刪、只標記自己的列，`index_meta` 的 `ready` 也是每社團一列；所有讀取都經過 `history-index.ts` 的 `where()` 加 `b.club_id = ?`（子查詢的 `board_players` 也對上同一個社團）。`REPLICA_VERSION` 3：舊表（沒有 `club_id`）在第一次重填時刪掉重建（`replicaSchema`，只刪沒有這一欄的表） | 重填後全部是 `tku`；欄位預設值也是 `tku`，退回舊版 Worker 時照樣讀寫 |
| R2 `FILES`（圖片、電子書）與 `BACKUPS` | `worker/buckets.ts` 的 `scopedBucket`：key 一律加上 `clubStoragePrefix`＝`clubs/<id>/`，列表時再拿掉；社團碰不到前綴以外的 key。檔案網址用社團自己的 `file:secret` 簽，其他社團的網址加 `&club=<id>`（`<img>` 不能帶 header），簽章內容也包含社團 | 前綴是空的：`daily/…`、`post/…`、`ebook/…` 原封不動，網址與簽章跟以前一樣 |
| 每日備份（cron） | `everyClubStub`：每個服務中的社團各備份到自己的前綴、各自計算保留 30 天 | `daily/<日期>.jsonl` |
| 日誌 | 社團、牌桌、比賽物件的每一行都帶 `club`（`worker/log.ts` 的 `clubLog`） | `club: "tku"` |
| 環境變數 | `INVITE_CODE` 只給淡江（其他社團的邀請碼由它自己的管理員設）；Google／LINE 登入只給淡江（其他社團的回呼網址已帶社團，見下面「社團網址與登入範圍」）；`MAX_USERS` 是每個社團各自的上限 | 照舊 |

不分社團、刻意共用的：`pass_revocations`（session id 是 128 位元隨機值，又只在簽給同一社團的通行證上查）、VAPID、Turnstile、`SEEN_SALT`、`EDGE_AUTH_SECRET`；平台經營者的權杖 `BOOK_SEED_TOKEN`、`BOOK_EXPORT_TOKEN`、`TWO_FACTOR_RESET_TOKEN` 對請求所指的社團有效（只有能操作 Cloudflare 帳號的人有）。隔離測試在 `tests/worker/club-isolation.test.ts`（兩個社團 `tku`、`ntu` 共用一個 D1、一個 bucket、一個物件命名空間）。

**還沒做**：新社團第一個註冊的人直接成為管理員（同淡江剛開站時），所以正式站在平台審核（`e12-t05`、`e12-t06`）之前不要設 `CLUBS`；R2 免費額度的用量提醒是每社團各算的，整個 bucket 的總量要平台後台再看。

### 社團網址與登入範圍（`e12-t04`，2026-11-04 社長決定）

- **網址**：淡江維持原本的網址（`/`、`/table/<id>`、`/history/<id>`…），其他社團在 `/c/<id>/…`（`/c/ntu/`、`/c/ntu/table/<id>`）；`/c/tku/…` 換成原本的網址（頁面載入時 `history.replaceState`，`src/main.tsx`）。網址的規則都在 `shared/clubs.ts`：`clubPath(社團, 路徑)`、`clubOfPath(路徑)`。
- **前端從網址知道社團**（`src/lib/club.ts`）：載入時讀一次，React Router 用 `basename="/c/<id>"`，所以 app 裡每個 `<Link>`、`navigate()`、通知中心的連結都留在同一個社團，不用逐一改。每個 `fetch` 帶 `X-Club-Id`（`clubHeaders`，`request`、下載、錯誤回報），WebSocket、`<img>` 的頭像與下載連結帶 `?club=`（`withClub`）。淡江的請求什麼都不加，跟以前一模一樣。社團不存在時 `/api/me` 回 `unknownClub`，頁面顯示「找不到這個社團」。各社團的 localStorage 草稿分開（`clubStorageKey`：論壇草稿）。
- **登入範圍**：每個社團的登入 cookie 名稱不同，淡江沿用原名（`tbt_session`、`tbt_pass`、`tbt_google`、`tbt_line`），其他社團是 `<原名>_<id>`（`clubCookieName`）；社團只讀自己名稱的 cookie，同一個瀏覽器可以同時登入兩個社團。`tbt_device` 全站一個。理由與另一個做法（`Path=/c/<id>/`）的比較在 docs/SECURITY.md「社團與 cookie」。
- **連結帶社團**：分享連結（`BoardShareDialog`，`appPath`）、Email 驗證與重設密碼的連結（`ClubService.sendVerification`／`requestEmailReset` 用 `clubPath`）、推播的網址（`pushMessage`／`testPushMessage` 的 `clubId`，`PushService` 的 `clubId`）、OAuth 的導回（`Club.inClub`：導回的路徑一律在那個社團的網址下），都開在對的社團。通知中心本來就是 app 裡的相對路徑（`notificationLink`），跟著 `basename`。淡江橋館的連結（`BOOK_SITE`）不變。
- **Google／LINE**：目前只給淡江（環境變數），維持。其他社團將來開的時候，回呼網址是 `/api/auth/<provider>/callback?club=<id>`（`callbackPath`；提供者的轉址不能帶 header，所以社團放在網址裡，要照這個網址到 Google Cloud／LINE Developers 登錄），流程 cookie 是 `tbt_<provider>_<id>`，回來後導到 `/c/<id>/…`。步驟見 DEPLOY.md §4.19。
- **跨社團的私訊與邀請**：社長 2026-11-04 決定不同社團的人要先是好友才能私訊或邀請（挑戰、受邀桌、隊制賽）；跨社團的好友還沒有，所以**現在跨社團的私訊與邀請都不可能**：每個社團只認得自己的社員，對別的社團的 id 一律 `userGone`（`ClubService.otherMember`；`tests/worker/club-urls.test.ts`）。跨社團好友做了再開。

### 跨社團大廳（`e12-t07`，2026-11-04）

最小而安全的做法：**別的社團的人只能觀看**，不能入座、不能聊天；跨社團入座（需要訪客身分）留到之後。

- **社團選擇加入**：功能旗標 `publicLobby`（`shared/features.ts`，全站預設 `off`），社團的管理員在管理頁的「功能旗標」打開（可以只開給幹部或指定社員）。有旗標的社員看得到頁首的「其他社團」（`/clubs`），也可以把自己開的牌桌設成「開放其他社團觀看」。
- **每桌選擇開放**：牌桌設定的 `openToClubs`（`TableSettings`，預設沒有）。只有**一般桌、公開、允許觀看**的牌桌才會給別的社團看（`shared/public-lobby.ts` 的 `openToOtherClubs`），而且房主現在還要有旗標（社團關掉旗標，牌桌立刻不再列出、也看不到）。沒旗標的人送 `openToClubs: true` 回 `publicLobbyOff`；練習、挑戰、隊制賽、雙人賽桌不能開放。牌桌標題列有一個圖示讓坐在桌上的人知道別的社團可能在看。
- **怎麼看**：Worker 自己回答 `GET /api/public/lobby`（其他每個社團的開放牌桌，含社團名稱 `clubName`）與 `GET /api/public/tables/<社團>/<桌 id>`（`worker/routing.ts` 的 `publicApi`）。先用觀看者**自己社團**的 cookie（通行證或 session）確認身分，再問自己的社團他有沒有旗標（`Club.publicViewer`）；然後用 Durable Object RPC 問對方社團（`Club.publicTables`、`Club.guestTable`），瀏覽器碰不到這些方法。對方社團再問那一桌（`TableApi.guestView`，兩種 `TABLE_OBJECTS` 模式都一樣）。觀看頁 `/clubs/<社團>/<桌 id>` 每 3 秒問一次（`GUEST_POLL_MS`，分頁隱藏時暫停），畫面同 Vugraph（牌圖＋叫牌）。自己社團的牌桌不經過這裡（回 `tableGone`），在自己的大廳看。
- **看得到什麼**（§4）：同任何觀看者：四家的牌與叫牌、出牌；座位只有名字、是不是機器人、在不在線（`guestSeats`），**沒有社員 id**（id 只在社團內有意義）、沒有聊天、旁觀者名單、最近的牌局、邀請與申請。訪客不在牌桌的旁觀者名單裡，沒有任何會改變牌桌的路由。
- **量**：大廳一次問每個服務中的社團一次（社團少時沒問題）；觀看一桌每 3 秒一次 Worker 請求加兩次 RPC，同 Vugraph。社團多了以後再改成快取或推播。
- **挑戰與隊制賽可以各自一個 Durable Object**（`EventObject`，H2b 挑戰、H2c 隊制賽，§5.12）：開關 `EVENT_OBJECTS=on` 才用，**預設關**（挑戰與隊制賽照舊在社團的物件裡）；正式站什麼時候開由社長決定（`DEPLOY.md` §4.6）。
- **不必經過社團的請求由 Worker 自己回答**（§5.12）：紀錄列表與搜尋從 D1 的副本讀（社團寫好紀錄後經 outbox 複製過去），牌桌連線用簽章的邊緣通行證確認是誰；通行證或副本不能用時一律照舊交給社團。開關 `HISTORY_D1=off`、`EDGE_AUTH=off`（`DEPLOY.md` §4.5）。
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
│  ├─ practice.ts          練習桌的設定與檢查（預設集、四家條件、牌組、TKB 制度、Just Declare、只叫牌、顯示四家）、快速亂數、存的設定（§5.11）
│  ├─ practice-sets/       練習牌組：每個 *.json 一組（import.meta.glob 自動列出），index.ts 讀取與檢查，只有 Worker import（§5.11）
│  ├─ pbn.ts               PBN 的一手牌與整副牌（`AKQ2.K73.9.AJ852`、`N:… … … …`）讀寫
│  ├─ book-topics.ts       叫牌提示卡：目前叫牌對到淡江橋譜的哪幾頁（§5.11）；網址在 book-site.ts
│  ├─ deal-set.ts          挑戰的固定牌組 DealSet：產生、檢查、PBN 存取、轉成 fixed 的 DealSource（§5.5）
│  ├─ auction.ts           叫品、合法叫品、叫牌結束、合約與莊家
│  ├─ game.ts              一副牌的狀態機：叫牌 → 出牌 → 結束；攤牌、撤回
│  ├─ scoring.ts           複式計分
│  ├─ imp.ts               WBF IMP 表（挑戰與隊制賽共用）
│  ├─ vp.ts                WBF 連續 VP 表：IMP 差 → VP（隊制賽，之後 E9 的多隊賽，§5.8）
│  ├─ challenge-scoring.ts 挑戰的計分：IMP、總分、MP、Cross-IMP、IMP 對 datum、沒打完的副、同分名次
│  ├─ challenge-stats.ts   挑戰戰績：勝率、平均 IMP、對每位的 head-to-head（§5.5 M2）
│  ├─ challenge-comments.ts 每副討論串的型別與上限（§5.5 M2）
│  ├─ movement.ts          雙人賽的移位：Mitchell（3–10 桌、輪空、跳桌）與個人賽的移位（8／12／16／20 人，§5.25），純函式（§5.22）
│  ├─ pairs.ts             雙人賽的設定、MP 計分（Neuberg 調整、南北東西分開排名）與頁面的型別（§5.22）
│  ├─ tournament.ts        比賽公告與報名：設定的檢查、報名（單人、搭檔、整隊）、從名單配成雙人賽的對或隊制賽的隊、頁面型別（§5.24）
│  ├─ team-event.ts        多隊賽：循環賽程、瑞士制配對與輪空、VP 排名與同分規則、頁面型別（§5.26，e9-t14）
│  ├─ challenge.ts         挑戰的狀態、設定、預設值與期限（§5.5）
│  ├─ team-match.ts        隊制賽的狀態、兩室八個座位與隊伍對應、設定與預設值、畫面型別（§5.8）
│  ├─ team-scoring.ts      隊制賽的計分：每副兩室分差 → IMP 或 BAM、Avg／Avg+／Avg- 裁定、總分（§5.8）
│  ├─ ruling-scoring.ts    紀錄上的裁定怎麼計分：指定分數、Avg／Avg+／Avg- 的 MP 與 IMP 值（§5.16，`e2-t36`）
│  ├─ referee.ts           比賽的裁判工具：紀錄的型別、請求的檢查、生效中的處罰、延後開賽、隊制賽扣分後的總分（§5.23，`e9-t17`）
│  ├─ history-query.ts     紀錄搜尋的條件型別、解析與網址字串
│  ├─ favorites.ts         收藏的筆記與標籤規則（§5.3）
│  ├─ lin.ts               BBO LIN 匯出與 Handviewer 連結
│  ├─ messages.ts          錯誤代碼與六種語言的訊息
│  ├─ integrity.ts         防作弊報表：型別、門檻、從登入紀錄配對帳號、線索強度（§5.17）
│  ├─ protocol.ts          HTTP／WebSocket 的訊息與畫面型別
│  ├─ clubs.ts             社團 id 與物件名稱、請求的社團（X-Club-Id／?club=，沒帶是淡江）、牌桌與比賽物件的名稱、R2 前綴、社團網址 /c/<id>/ 與 cookie 名稱（§1）
│  ├─ public-lobby.ts      跨社團大廳：哪些桌給別的社團看、訪客看到的型別（§1）
│  ├─ message-guard.ts     WebSocket 訊息的大小上限與型別守衛（§5.6）
│  ├─ scrub.ts             錯誤回報去除個資（§5.6）
│  └─ robot/               機器人：robots（兩種機器人與各自的叫牌）、hand（牌型分析）、
│                          play（坐莊、防守信號）、system/（制度引擎與 2/1 制度：規則書、GIB 的牌力、說明、推論，
│                          `ROBOT.md` §6）
├─ worker/
│  ├─ index.ts             Worker 入口：綁上 Durable Object 交給 routing.ts
│  ├─ routing.ts           Worker 的路由（不碰 Cloudflare API）：/api/* 與 /ws 給社團，/ws/table/<id> 確認身分（通行證或問社團）後加 X-TBT-User 給那一桌，紀錄列表與搜尋可從 D1 回答（§5.12），其他給靜態檔案
│  ├─ edge-auth.ts         邊緣通行證：簽發、驗證、cookie、撤銷清單（D1 的 pass_revocations，§5.12）
│  ├─ body.ts              HTTP 本文邊讀邊算大小（e11-t32）
│  ├─ history-replica.ts   紀錄索引的 D1 副本：ReplicaSync（outbox、填副本、開關）、寫入與搜尋的 SQL（§5.12）
│  ├─ d1.ts                把 D1 binding 包成 ReplicaDb（唯一碰 D1 的程式）
│  ├─ clubs.ts             社團、牌桌、比賽物件的 stub（名稱帶社團，§1）
│  ├─ buckets.ts           R2 bucket 裡社團自己的前綴（scopedBucket，§1）
│  ├─ club.ts              社團的 Durable Object：HTTP 路由、WebSocket（hibernation）、儲存轉接、牌桌回報的 RPC
│  ├─ table-object.ts      每桌一個的 Durable Object：儲存、alarm、這一桌的 WebSocket、社團的 stub（只是接線，§5.10）
│  ├─ table-host.ts        TableHost：一個 TableObject 做的事（RPC 包裝錯誤、桌的連線只收在桌上的人、訊息驗證與速率限制、搬移），可在 Node 測試
│  ├─ events.ts            社團與挑戰之間的介面（EventApi、EventLink、EventRpc、RemoteEvents）與社團自己的 event_homes、challenge_settled（§5.12 H2b）
│  ├─ match-events.ts      社團與隊制賽之間的介面（MatchApi、MatchRpc、RemoteMatches）與社團自己的 match_homes、match_settled（§5.12 H2c）
│  ├─ match-event.ts       MatchEvent：一場隊制賽的寫入（每個 MatchStep 在比賽本身再檢查一次規則，最後一副在這裡結束比賽；不碰 Cloudflare）；LocalMatches＝隊制賽在社團的物件裡
│  ├─ event-service.ts     ChallengeEvent：一場挑戰的規則、期限工作與結算（不碰 Cloudflare）；LocalEvents＝挑戰在社團的物件裡
│  ├─ event-host.ts        EventHost：一個 EventObject 做的事（RPC 包裝、變更編號、回報與重送、搬移），可在 Node 測試
│  ├─ event-object.ts      每場挑戰、隊制賽或雙人賽一個的 Durable Object：儲存、SQLite、alarm、社團的 stub（只是接線，EVENT_OBJECTS=on 才用）
│  ├─ integrity.ts         防作弊報表的資料：登入紀錄（`seen:`，IP 只存加鹽雜湊）、從紀錄索引查同桌與同場比賽（§5.17）
│  ├─ service.ts           ClubService：帳號、申請、session、牌桌目錄、權限、牌局紀錄（可單獨測試）
│  ├─ table-service.ts     TableService：一張牌桌的一切（座位、叫牌出牌、機器人、發牌、代打、聊天、畫面），LocalTables（§5.10）
│  ├─ tables.ts            社團與牌桌之間的介面：TableEntry（牌桌目錄）、TableApi、ClubLink、RPC 的 Wire 與 RemoteTables（§5.10）
│  ├─ errors.ts            ClubError
│  ├─ book.ts              BookService：淡江橋譜的線上內容、版本、匯入草稿與憑證
│  ├─ profiles.ts          ProfileService：淡江橋譜的制度集、版本、上限與 club 保護
│  ├─ teams.ts             TeamService：淡江橋譜的隊伍與搭檔（建立、隊長、隊員、封存、邀請、接受、結束），各自開制度集；制度集的成員權限
│  ├─ roles.ts             每條 HTTP 路由要的角色（管理員／編輯者／個別權限）
│  ├─ importer.ts          淡江橋譜的 AI 匯入：Claude 的提示、回覆 schema、串流
│  ├─ views.ts             每位觀看者可見的牌桌畫面（可見性規則）
│  ├─ history-index.ts     紀錄的 SQL 索引：建表、寫入、搜尋（§5.3）；D1 副本共用同一段 SQL
│  ├─ favorites.ts         收藏的 SQL 讀寫（§5.3）
│  ├─ practice-presets.ts  社員存的練習設定（存成我的設定，§5.11）
│  ├─ practice-review.ts   叫牌練習的檢討：每一口 TKB 會叫什麼、四家 TKB 從頭叫（只給那一家的牌，§5.11）
│  ├─ notifications.ts     通知中心（§5.4）
│  ├─ push.ts              PWA 推播（e1-t28）：社員的裝置與推播偏好、批次送出、刪掉失效的訂閱（§5.4）
│  ├─ web-push.ts          Web Push（e1-t28）：RFC 8291 加密、RFC 8292 VAPID JWT、只准瀏覽器的推播服務（WebCrypto，§5.4）
│  ├─ relations.ts         好友與封鎖名單（§5）
│  ├─ direct-messages.ts   私訊的 SQL 表與 DirectMessageStore（§5.7）
│  ├─ forum.ts             論壇（淡江橋館與牌桌共用）：SQL 五張表與 ForumService（§5.19）
│  ├─ forum-notices.ts     討論區的通知：被回覆、被提到、公告、被置頂（橋館 e11-t08）
│  ├─ forum-schedule.ts    論壇排程中的貼文：交給社團的排程器，時間到了發布並通知（e13-t12）
│  ├─ post-images.ts       論壇圖片（e13-t13）：只放自己上傳的、只替看得到貼文的人簽網址、刪貼文連圖一起刪（§5.14）
│  ├─ log.ts               結構化日誌（§5.6）
│  ├─ rate-limit.ts        速率限制（§5.6）
│  ├─ metrics.ts           指標與告警，`/api/health` 與管理頁「系統狀態」（§5.13）
│  ├─ client-errors.ts     瀏覽器錯誤回報的檢查（§5.6）
│  ├─ book-telemetry.ts    淡江橋館的錯誤回報與匿名使用統計：SQL 四張表與 BookTelemetry（§5.15）
│  ├─ challenges.ts        挑戰的 SQL 表與 ChallengeStore（§5.5）
│  ├─ challenge-flow.ts    挑戰的狀態轉移（建立、回覆、取消、截止）：純函式，ClubService 寫回（§5.5）
│  ├─ challenge-extras.ts  挑戰的每副討論串（challenge_comments 表）與戰績（§5.5 M2）
│  ├─ team-matches.ts      隊制賽的 SQL 表與 TeamMatchStore（§5.8）
│  ├─ team-match-flow.ts   隊制賽的步驟（建立、改設定、取消、座位與隊長、開始、每室的結果與結束）：純函式（§5.8）
│  ├─ team-match-service.ts 隊制賽社團那一半：動作（HTTP 與 socket）的檢查、通知、畫面與推送，寫入一律經 MatchStep（§5.8、§5.12 H2c）
│  ├─ modes.ts             牌桌模式（casual、challenge、practice、team、pairs）與三個掛勾（發新一副、寫紀錄、一副結束）
│  ├─ team-mode.ts         隊制賽一室的牌桌：team 模式的掛勾、開桌時的快照、紀錄先不公開（§5.8）
│  ├─ pairs-flow.ts        一場雙人賽的狀態與步驟（報名、退出、取消、開始、每副的結果、下一輪）：純函式（§5.22）
│  ├─ pairs-events.ts      社團與雙人賽之間的介面（PairsApi、PairsRpc、LocalPairs、RemotePairs，§5.22）
│  ├─ pairs-service.ts     雙人賽社團那一半：只有社團能做的檢查、每一輪開桌與換桌、頁面（§5.22）
│  ├─ pairs-mode.ts        雙人賽一輪一桌的牌桌：pairs 模式的掛勾、開桌時的快照、紀錄先不公開（§5.22）
│  ├─ tournaments.ts       比賽公告與報名（e9-t16）：公告、報名與確認、退出、開賽前提醒、用名單建立雙人賽或隊制賽、結果公告（§5.24）
│  ├─ team-events.ts       多隊賽（e9-t14）：從比賽公告建立、出賽名單、裁判開下一輪（每組配對一場入座好的隊制賽）、結束時記積分（§5.26）
│  ├─ referee.ts           RefereeLog：每場比賽的裁判紀錄（`referee:<種類>:<id>`），每一筆也寫進稽核紀錄（§5.23）
│  ├─ audit.ts             稽核紀錄（`audit:`）：淡江橋館的內容變更與比賽的裁判工具，誰、何時、做了什麼
│  ├─ scheduler.ts         統一排程器：機器人、自動發牌、挑戰的提醒與截止都走同一個 alarm 佇列
│  ├─ auth.ts              PBKDF2 密碼雜湊（100,000 次，舊的登入時升級；密碼一律存半形，舊的全形密碼仍可登入，docs/SECURITY.md）、session cookie、忘記密碼的一次性代碼
│  ├─ password-policy.ts   新密碼的規則（e11-t29）：至少 12 字、不含帳號名稱、不在 common-passwords.ts 的外洩清單（docs/SECURITY.md V2.1）
│  ├─ totp.ts              兩步驟登入（e11-t31）：TOTP（RFC 6238，WebCrypto）、base32、otpauth 連結、備用碼
│  ├─ oauth.ts             Google 與 LINE 登入共用（e1-t31、e1-t32）：PKCE、state、nonce、哪個網站、flow cookie、流程的儲存（§5.2）
│  ├─ google.ts            Google 登入（e1-t31）：授權網址、換 token、檢查 ID token
│  ├─ line.ts              LINE 登入（e1-t32）：授權網址、換 token、驗 HS256 簽章、檢查 ID token
│  └─ store.ts             儲存介面與測試用 MemoryStore
├─ src/                    React app
│  ├─ components/          牌、手牌、叫牌盒、叫牌過程、牌號、名牌、墩、面板、頁首、聊天
│  ├─ pages/               Login、Lobby、Table、History、Favorites、Board、Challenges、Challenge、Account、Admin
│  ├─ state/               AuthContext、ClubContext（社團與牌桌兩條 WebSocket，`lib/liveSocket.ts` 保持連線）、PreferencesContext；頁面屬於哪個社團在 `lib/club.ts`（§1）
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
  auction: AuctionCall[]    // { seat, call, alert?, robot?, meaning?, inferred? }
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
| 替別的座位叫牌的人（座位控制權，`e10-t15`） | 加上他控制的每個座位的牌（`Table.controllers`，`seatsActedBy` 算出他「替哪幾家叫」，`boardView` 的 `acts`）；輪到其中任何一家時 `legalCalls` 給他（就是 `turn` 那一家），叫牌盒提示用那一家算、不把他控制的機器人當成機器人。那個座位上坐的人（練習桌是 TKB）不會因此多看到什麼，也不能替它叫；觀看者照常（四家）。叫品的 Alert：他自己替兩家叫的，兩家的說明他都看得到。目前只有只叫牌的練習桌會設控制權 |
| 攤牌之後（被拒絕也一樣） | 攤過的牌不會再蓋回去：莊家攤牌後，兩位防家看得到四家的牌（莊家仍只看自己和夢家）；防家攤牌後，他的牌所有人都看得到。記在 `BoardState.claimed` |
| 觀看者 | 四家（同 BBO kibitz）；練習桌的觀看者也一樣（§5.11） |
| 其他社團的訪客（跨社團大廳，`e12-t07`） | 只限一般、公開、允許觀看、開放其他社團的牌桌：同觀看者（四家），座位只有名字（沒有社員 id），沒有聊天、旁觀者、最近牌局、邀請與申請（`guestTableView`，§1「跨社團大廳」） |
| 不允許觀看的桌上沒有座位的人（站起來或被請離座的玩家，`e2-t26`） | 只看得到所有人都看得到的：首攻後的夢家、防家攤過的牌；打完後四家（`boardView` 的 `kibitz: false`） |
| 所有人，打完後 | 四家原始牌與所有 Alert 說明 |
| Alert 說明 | 叫牌者的同伴在打完前看不到；機器人的說明除外（`AuctionCall.robot`），所有人都看得到，同 BBO 的 GIB |
| 叫品的推論意義 | 真人的叫品帶引擎依那一方制度讀出的意義（`AuctionCall.meaning`＋`inferred`：機器人同伴的制度，沒有就用淡江制度），所有人都看得到，同伴也是：只由公開的叫牌過程與制度算出，等於制度卡（`e5-t22`）|
| 叫牌盒提示 | 輪到自己叫、桌上有機器人時，`BoardView.callMeanings` 帶每個合法叫品在機器人制度裡的意義（同伴是機器人用同伴的，否則用對手機器人的）；伺服器用引擎的 `explain` 只依叫牌過程算出，不看任何一手牌（`views.ts` 的 `callMeaningsFor`，`e5-t22`）|
| 叫牌練習的檢討（`e10-t07`） | 只叫牌的練習桌**這一副結束後**（四家已公開）才有 `TablePractice.review`：每一口 TKB 拿那一家的牌在那時會叫什麼（`steps`）、四家 TKB 從頭叫的過程與合約（`robot`）。它是從四家的牌算出來的，叫牌中送出就等於洩漏別家的牌，所以叫牌中、重叫、下一副時一律沒有（`practiceView`）；問機器人時只給那一家的牌（`practice-review.ts` 的 `askedState`）|
| 叫牌提示卡 | 每個看的人都有 `BoardView.bookTopics`：淡江橋譜裡跟目前叫牌有關的頁面，從叫牌過程與淡江制度的規則算出，不看任何一手牌；看的人的同伴是 2/1 的 TKB 時不送（`e10-t06`）|

**誰看得到哪一桌**（四種進入方式，§5「牌桌設定」，判斷在 `worker/views.ts` 的 `tableListed`／`mayEnter`）：大廳與成員列表的「在哪一桌」只列出觀看者看得到的桌：挑戰桌誰都不列；**隱藏**的桌只列給房主、受邀者與已經在桌上的人，其他人連桌號都看不到（成員列表的 `tableNumber` 是 `null`），`joinTable`／`sit`／`requestJoin` 都拿到 `tableGone`，跟不存在的桌一樣；公開、申請加入、拒絕所有人的桌列給所有人。**加入申請**只送給房主（`TableView.requests`），房主封鎖的人送出的申請房主看不到（`muted`），申請者也看不出差別；`TableSummary.requested` 只告訴觀看者自己有沒有申請在等。受邀名單同樣只送給房主（`TableView.invited`）。

**大廳分成「共用」與「自己的」兩份**（H3b，§5.13，判斷在 `worker/views.ts` 的 `listedForEveryone`）：共用的一份（`LobbyShared`：全部社員與在不在線、列給所有人的桌與座位、進行中的隊制賽）序列化一次、所有人收到同一個字串，所以裡面**不能有任何依人不同的資訊**：只放列給所有人的桌（不是挑戰、隊制賽、隱藏的桌），社員的「在哪一桌哪個座位」也只在那種桌時才填，在隱藏桌的人在共用的一份裡是 `null`。依人不同的都在只送給本人的一份（`LobbyMine`）：自己在哪一桌、好友、封鎖、每張共用桌能不能直接進（`welcome`，看房主有沒有封鎖他、受邀與同意名單）、自己有沒有申請在等（`requested`）、列給他但不是列給所有人的桌（他是房主、受邀或在桌上的隱藏桌，整張 `TableSummary`）與那些桌上的人在哪個座位（`places`）。瀏覽器把兩份合起來（`composeLobby`）就是原本的 `LobbyView`，看得到的跟之前一模一樣。受邀、同意、申請名單本身不在任何一份裡。回歸測試在 `tests/worker/visibility/visibility.test.ts` 的「the lobby in two parts」：每個版本的共用訊息對每個人完全相同、不含隱藏桌與任何依人的欄位，每位社員合起來的大廳等於伺服器給他的 `lobbyView`。

指定牌組（`Table.dealSource` 的 `fixed`）整份只存在伺服器的 `Table` 裡，發到哪一副才放進 `BoardState.hands`，之後照上表的規則送出；`Table` 本身從不整份送到瀏覽器。

**挑戰**（§5.5）：挑戰的牌組（`DealSet`）只存在伺服器，參與者的挑戰牌桌發到哪一副才放進 `BoardState`。別人的結果（每一副的 traveller、總排名）只給**打完全部副數**的參與者，或挑戰結束後；還沒打完全部的人，連自己打過的那幾副也看不到別人的結果，因為知道自己領先或落後會影響後面的打法（社長，2026-10-24）；非參與者在結束前什麼都看不到（`e7-t14`，規則見下面的「讀挑戰」）。挑戰牌桌（C4）只是一般的牌桌：整組牌在伺服器的 `Table.dealSource`，`boardView` 只看得到正在打的那一副，所以看得到的牌和一般牌桌完全一樣；大廳不列出挑戰牌桌，別人 `joinTable`／`sit` 拿到 `tableGone`，不能觀看。挑戰牌局的紀錄寫入時 `revealAt` ＝截止時間，挑戰一結束（完成、過期、取消）就提前到結束的那一刻，之後所有人都看得到（`recordVisible`）；在那之前只有打的人看得到，另外**打完全部副數的參與者**也能打開別人的紀錄（traveller 與重播，`challengeBoardVisible`，只在 `/api/history/:id`；搜尋仍只列自己打的）。

讀挑戰（`challengeView`，`GET /api/challenges`、`/api/challenges/:id`）：牌組永遠不送。

| 誰 | 挑戰進行中 | 挑戰結束後 |
| --- | --- | --- |
| 參與者（受邀、接受、拒絕都算） | 設定、狀態、每個人的回覆與打了幾副；**沒打完全部的人只有這些**，打過的副也看不到別人的結果 | 同左，再加下面全部 |
| 打完全部的參與者 | 再加每一副的 traveller（每個人的合約、莊家、墩數、南北分數、牌局 id；單一挑戰另帶首攻）、目前排名（只排已經打完的人）與人 × 副矩陣 | 最終排名與矩陣（`finished` 才有排名；`expired`、`cancelled` 沒有） |
| 非參與者 | 404 | `ranking = club` 且 `finished`：排名（名次與總成績，不含每副分數、traveller）；否則 404 |

`GET /api/challenges` 的列表不帶 traveller（給大廳用），單一挑戰才帶。單一挑戰的 traveller 另帶每一列的首攻（結果頁用，2026-10-25）：索引沒有首攻，`ClubService.challengeDetail` 先用 `challengeView` 算出這個人看得到哪幾列，**只讀那幾列**的紀錄，把首攻放進 `EventBoard.lead` 再交給 `challengeView` 重算一次，所以首攻跟著同一條規則出去，還沒打完的人與非參與者一副紀錄都不會被讀。這些判斷都在 `worker/views.ts`（`challengeView`、`challengeBoardVisible`），測試在 `tests/worker/challenge-settlement.test.ts` 與 `challenge-options.test.ts`（首攻）。

**每副討論串**（`e7-t27`，`GET`／`POST /api/challenges/:id/boards/:seq/comments`、`DELETE …/comments/:id`）：讀的人**就是**看得到那一副 traveller 的人（`worker/views.ts` 的 `challengeThreadAccess`，跟 `challengeView` 給 traveller 的條件相同）：挑戰進行中只有打完全部副數的參與者，結束後每位參與者；還沒打完的人連有沒有人留言都不知道（回 `challengeGone` 404，跟不存在一樣），非參與者永遠看不到，`ranking = club` 也一樣（社團只看得到排名）。寫的人只有打完全部副數的參與者（含「已知牌」的發起者），沒打完的人在結束後只能讀（`challengeCommentFinishFirst`）。刪除：寫的人自己，或看得到這一串的管理員。測試在 `tests/worker/challenge-extras.test.ts`（兩種 `EVENT_OBJECTS` 模式都跑）。

**挑戰戰績**（`e7-t29`，`GET /api/challenges/stats`）：只回答**本人**的戰績，沒有讀別人戰績的 API。只用已經 `finished` 的挑戰（結束後每位參與者本來就看得到全部），只比打完全部副數的人，所以不會比 traveller 多透露什麼。

**雙人搭檔挑戰**（`e7-t28`，§5.5 M2）：規則和上表一樣，只是「打完全部副數」以搭檔為單位：搭檔的每一副結果寫給兩個人（同一個牌局 id、同一個分數），所以兩人同時打完、同時看得到 traveller、排名與討論串，`challengeBoardVisible` 也讓兩人都能打開別組的紀錄；沒打完的搭檔兩人都看不到別人的結果。排名與 traveller 把搭檔合成一列（掛在先受邀的那位，帶 `partnerId`），不多給任何東西。搭檔的牌桌是一般的挑戰牌桌：兩位真人坐南北、東西是機器人，`boardView` 照一般規則（各看自己的牌，夢家攤開後照常），大廳不列、不能觀看；只有這兩人進得了（`admits`、`resume`），別人一樣 `tableGone`。測試在 `tests/worker/challenge-partners.test.ts`（兩種 `EVENT_OBJECTS` 模式都跑）。

**隊制賽**（§5.8，`teamMatchView`，`GET /api/matches`、`/api/matches/:id`、socket 的 `match`）：牌組永遠不送；準備中的比賽只給房主與有座位（受邀或已入座）的人，被移出、拒絕或離開後就看不到（推送 `match: null`）；畫面另附每位座位上的社員在不在線（`online`，和大廳的社員列表同一份資訊）與房主能不能開始（`ready`）；比賽中另附兩室牌桌的 id（`tables`，參賽者回到自己那一桌、其他人觀看用；能不能進去由牌桌決定）；比賽中的牌桌只是兩張一般牌桌，看得到的牌和一般牌桌一樣，額外的限制在牌桌層（F4 的 `e8-t09`，見下）。比賽的畫面推給參賽者，比賽中也推給兩桌上的每一個人（入座與觀看），牌桌上方的比分條就是用它（`e8-t10`）。

| 誰 | 準備中（`setup`） | 比賽中（`playing`） | 結束（`finished`／`abandoned`） | 取消（`cancelled`） |
| --- | --- | --- | --- | --- |
| 房主、被邀請或已入座的人（「參賽者」） | 設定、8 個座位與狀態 | 同左，加**兩室都打完（或已裁定）**的每一副：兩室的南北分數、牌局 id、合約、莊家墩數、首攻、裁定與理由、各隊得分與總分；只打完一室的那一副不顯示；座位標「機器人代打中」（`substitute`）、暫停中（`pausedAt`）、分段時第幾段與段與段之間（`segment`、`breakAt`，`e8-t21`；段與段之間換的座位立刻看得到）。**只有房主**另有兩室各在第幾副、何時超時（`rooms`，裁定用，`e8-t15`） | 全部 | 設定與座位 |
| 其他社員 | 404 | 同參賽者（觀看者本來就能看兩桌） | 全部 | 404 |

牌桌層（`e8-t09`，F4 已實作，測試在 `tests/worker/team-match-play.test.ts` 與 `table-objects.test.ts` 的「a team match in two table objects」，E11 的 `e11-t13` 從這裡擴充）：
- **另一室**：參賽者（比賽中有座位的社員，兩室都算，隊友也一樣；F5 起含替補上場的人與被替補下場的人，`TeamTableState.players` 只增不減；分段比賽在下一段開始時換成新的座位，中場換到另一室的人只能進新的那一室，被替補下場的人仍兩室都不能進，`e8-t21`）不能 `joinTable`／`sit` 另一室的牌桌，錯誤 `matchOtherRoom`。**自己那一室也不能觀看**（`matchNoWatching`）：機器人代打中的參賽者 `joinTable` 自己那一室就是回到座位（`e8-t14`），不會變成看得到四家的觀看者；被替補下場的人兩室都不能看。社團先用目錄與比賽的座位檢查一次（`checkNotInMatch`），牌桌再用自己的快照檢查一次（`TeamTableState.players`，`TableService.otherRoom`），所以繞過社團直接呼叫牌桌也進不去；桌的連線（§5.10）只收在桌上的人，另一室的參賽者連過去會被 4004 關掉。
- **別桌**：比賽中的參賽者不能開桌、坐到或觀看別桌、快速入座、開始挑戰（`inMatch`）；離開牌桌頁面（`leaveTable`）不會離座，座位一直留到比賽結束（斷線照 F1 的代打）。
- **座位**：比賽桌的座位由比賽決定：`sit`、`stand`、`kick`、`addRobot`、`removeRobot`、`replaceWithRobot`、`updateTableSettings` 都是 `matchTableFixed`；不能撤回（`matchNoUndo`，`BoardView.canUndo` 一律 false）。
- **大廳**：比賽桌不列在大廳的牌桌（`tables`），也不算在社員列表的「在哪一桌」；改列在 `LobbyView.matches`（進行中的比賽、兩室的桌 id），`/matches` 頁的「進行中的比賽」從這裡來。
- **觀看**：非參賽者可以觀看兩室（同 BBO Vugraph，看得到四家，和一般牌桌的觀看者一樣）。觀看者說的話標 `kibitz`，只送給觀看者；入座的參賽者的瀏覽器根本收不到（`chatFor` 的 `player`，在伺服器過濾）。參賽者說的話只在本桌，觀看者也看得到。
- **紀錄**：比賽牌局的紀錄帶 `mode: 'team'`、`eventId`＝比賽 id、`room`，`revealAt` 先是 `HELD_BACK`（JavaScript 日期的最大值，`worker/team-mode.ts`）：**某一副兩室都打完就公開那一副**（兩室各一筆紀錄一起改，`revealBoards`），比賽結束時其餘的一起公開（`revealEvent`）；在那之前只有打那一副的四位看得到（`recordVisible`）：紀錄列表、搜尋、詳細頁、牌桌側欄的 `recent`、個人檔案的最近牌局、收藏都一樣。比賽牌局沒有 traveller（`/api/history/:id/traveller` 回 `null`），兩室比較在比賽頁。
- **比分**：只算兩室都打完（或已裁定）的副（`teamMatchView`），所以快的一室看不到慢的一室在同一副的結果，連「這一副已經計分」都看不到。兩室的進度（第幾副、何時超時）只給房主（`rooms`），因為裁定要用；其他參賽者看不到另一室打到哪裡。
- **替補**（`e8-t16`）：正在觀看這場比賽任一室的社員不能替補上場（`matchWatching`），他已經看過兩室的牌；比賽中開過觀賽頁的人也一樣（`match_watchers`，見下）。
- **觀賽頁（Vugraph，`e8-t18`）**：`GET /api/matches/:id/vugraph` → `{ vugraph: MatchVugraph }`：比賽畫面（比分同 `teamMatchView`）、比賽中兩室各自的座位與桌上這一副（`TableApi.vugraph` → `vugraphBoard`：和牌桌的觀看者一樣看得到四家，沒有叫牌盒與提示卡），以及觀看者聊天。**參賽者在準備中與比賽中一律 `matchNoWatching`**：社團先看比賽的座位與房主（`isMatchPlayer`），每一室的牌桌再用自己的 `TeamTableState.players`（兩室、只增不減）檢查一次，所以被替補下場的人也拿不到；看不到比賽的人是 `matchGone`。比賽結束後所有看得到比賽的人都能開（沒有牌桌了，只剩比分與聊天）。比賽中每次開這一頁都記下這位社員（`match_watchers`），之後他不能替補上場。
- **觀看者聊天（Vugraph）**：`POST /api/matches/:id/vugraph/chat { text }`，檢查同上，只在比賽中；去頭尾空白、最多 300 字（`VUGRAPH_CHAT_MAX`），速率限制同牌桌聊天（`chatTooFast`）。存在 `match_chat`（每場留最近 100 句），**只從觀賽頁送出**：參賽者打不開觀賽頁，所以他們的瀏覽器根本收不到；照看的人的封鎖名單過濾（`vugraphChat`，同 `chatFor`）。刪帳號時刪掉他說過的話。
- **觀看延遲（`e8-t19`）**：房主在準備時可開「觀看者落後一墩」（`TeamMatchSettings.delay`，預設關，開桌時寫進 `TeamTableState.delay`）。開了之後，打牌階段的觀看者只拿到**最後打完那一墩之前**的墩（`laggedBoard`：`play` 只留 `4 ×（完成墩數 − 1）` 張；正在打的那一墩與剛打完的那一墩都不送，等待中的攤牌也不送），每一手的牌是那時候手上的牌；`TableView.waiting`（現在輪到誰）也不送。觀賽頁（`vugraphBoard`）與坐在牌桌上的觀看者（`TableService.tableView`，`mySeat` 是 null 時）都一樣，**在伺服器裁掉**，之後打的牌不會出現在觀看者的瀏覽器。叫牌不延遲；一副打完就整副送出（結果本來就是這一室的）；比賽結束後不再延遲。入座的參賽者照常。
- **中止**（`e8-t16`）：正在打的那一副直接收起、不留紀錄，其餘已打完的副一起公開（`revealEvent`）。裁定（`e8-t15`）讓那一副「完成」：已打完那一室的紀錄立刻公開，正在打它的那一室收起來、不留紀錄。

**雙人賽**（§5.22，`pairsView`、`pairsSummary`，`GET /api/pairs`、`/api/pairs/:id`）：牌組永遠不送；有 `pairs` 旗標的社員都看得到列表與每一場（取消的只給裁判）。即時成績（每對的 MP、百分比、名次）所有人都看得到。**每副成績（traveller）**：比賽進行中，參賽者只看得到**自己這一對已經打過的副**，所以不會在打之前知道那一副在別桌的結果；沒有參賽的裁判（與沒有參賽的管理員，`e9-t17`）看得到全部（裁定用），其他人一副都看不到；結束後全部公開。紀錄的 id 只跟著自己的那一列（結束前別桌的紀錄還沒公開）。牌桌層：每一輪的牌桌只是一般牌桌（`mode: 'pairs'`），大廳不列、不能觀看（`allowKibitz: false`），比賽中的參賽者不能進同一場的其他桌（`matchNoWatching`，牌桌再用自己的 `PairsTableState.players` 檢查一次），也不能開桌、坐到或觀看別桌、開始挑戰（`inPairs`，社團的 `checkNotInMatch`）；座位與設定由移位決定（`pairsTableFixed`）、不能撤回（`pairsNoUndo`）。紀錄帶 `mode: 'pairs'`、`eventId`，`revealAt` 是 `HELD_BACK`，**比賽結束時才一起公開**（`revealEvent`）：同一副在 Mitchell 裡是不同輪在不同桌打的，所以在那之前只有打那一副的四位看得到。測試在 `tests/worker/pairs-event.test.ts`（兩種 `EVENT_OBJECTS` 模式都跑）。**個人賽**（§5.25）是同一個 `pairsView`：每個參賽者是一個「單位」，traveller 的每一列多帶那一桌四個座位的參賽者（`seats`），「自己打過的副」是自己坐過的桌，所以一樣是打完那一副才看得到別桌的結果；結束前紀錄一樣 `HELD_BACK`（同一輪每一桌打同一副，所以在那之前只有自己那一桌的四位看得到），測試在 `tests/worker/pairs-individual.test.ts`。

**多隊賽**（§5.26，`teamEventView`，`GET /api/team-events/:id`）：有 `tournaments` 旗標的社員、參賽隊伍的人、裁判與管理員看得到（取消的只給裁判與管理員），其他人 `teamEventGone`。隊伍、配對、每場目前的 IMP（同隊制賽頁給局外人的，只算兩室都打完的副）、VP、排名公開；**下一輪的出賽名單**只給自己隊、裁判與管理員。每一場比賽本身照「隊制賽」與「牌桌層」的規則（它們就是一般的隊制賽）。測試在 `tests/worker/team-events.test.ts`（兩種 `EVENT_OBJECTS` 模式都跑）。

**多隊賽一輪的各場打同一組牌**（§5.26，社長 2026-11-03）：一輪的牌在開那一輪時發一次（`teamevdeal:<多隊賽>:<輪>`，只在伺服器，從不送到瀏覽器），那一輪每一場都用它。所以**一副要等這一輪的每一場都打完（兩室都打完或裁定）或不會再打（完賽、中止、取消）才對「那一場以外的人」公開**（`shared/team-event.ts` 的 `roundBoardShown`；`TeamEventService.shownIn`）。在那之前：隊制賽頁給局外人的那一副不出現、比分也不算它（`teamMatchView` 的 `EventDirecting.shown`，那一場的參賽者與裁判照常看得到兩室都打完的副）；多隊賽頁每場的 IMP 給那兩隊以外的人只算已公開的副（`shownImps`）；**各副比較**（`TeamEventRoundView.boards`，`roundComparison`：每一場的兩室合約、結果、南北分數、各隊得的 IMP、每一室對基準分的 IMP）只列已公開的副，對所有看得到多隊賽的人都一樣；兩室的紀錄（`revealAt`）也等到那時才公開（`ClubService.revealRound`，那一輪全部結束時一次公開全部）。同一輪另一場的隊伍的人（含沒上場的隊員），在自己隊這一輪的比賽結束前**不能觀看**這一輪的其他場（牌桌與 Vugraph 頁都回 `teamEventNoWatching`，`TeamEventService.watchBarred`）；裁判與管理員可以。完賽的比賽的 VP 與排名照常馬上算（只是總分，不透露哪一副怎麼打）。更早、各場各發一組牌的輪（`sameDeals` 沒有）照舊。測試在 `tests/worker/team-event-director.test.ts`（兩種模式）。

**資訊隔離回歸測試**（`e11-t13`，AC-11.8）：`tests/worker/visibility/visibility.test.ts` 集中測一般、練習、挑戰、隊制賽四種牌桌 × 每種角色（入座、觀看、不允許觀看時沒有座位的人、另一室的參賽者、局外人）：每一則送到瀏覽器的 `table` 訊息都檢查有沒有不該看到的牌（`noHiddenCards`），還沒公開的牌局在紀錄、紀錄列表、搜尋（我的與全部）、個人檔案、收藏、traveller、精選都拿不到（`exposure`），公開之後每處都拿得到。新增可見性規則或新的地方會送出牌局時，加在這裡；CI 的 `npm test` 會跑。

單副的 traveller（C7，`GET /api/history/:id/traveller`，`challengeTraveller`）：就是 `challengeView` 給這個人的那一副 traveller，不多給——打完全部副數的參與者、或挑戰結束後的參與者才拿得到，其他人（還沒打完的、非參與者）一律 `null`；伺服器再從那幾副的紀錄補上莊家是誰與首攻，以及排名矩陣裡那一副的分數。並排重播（`/history/:id/vs/:other`）兩邊都走 `/api/history/:id`，所以照樣由 `recordVisible`／`challengeBoardVisible` 把關。

**打完的牌局什麼時候公開**（AC-4.9，`recordVisible`）：紀錄可以帶 `revealAt`（挑戰、隊制賽還在進行時）。在那之前，只有打那一副的四位看得到；其他人在紀錄列表、搜尋、詳細頁、牌桌側欄的 `recent`、收藏、精選都看不到。**收藏**（§5.3）：只能收藏 `recordVisible` 看得到的牌——還沒公開的挑戰／隊制賽牌局只有打的四位能收藏，別人收藏或查詢都拿到跟不存在一樣的 `boardGone`（404），連「打完全部副數、可以看 traveller」的參與者也要等公開；「我的收藏」列表走同一個 `searchBoards`，照樣套用 `reveal_at` 的規則。筆記與標籤只有收藏的人自己讀得到：每個查詢都以自己的 id 為條件，沒有讀別人收藏的 API。**精選**（§5.9）：只有已經公開的牌（沒有 `revealAt` 或已經過了）才能設為精選——打過那副的策展人拿到 `featuredNotRevealed`，沒打過的拿到 `boardGone`，不透露那副牌存在；精選的列表與單副讀取也再套一次 `recordVisible`。**分享到論壇**（`e13-t07`，§5.19）：貼文的 `record` 區塊只存紀錄 id；發文與編輯時伺服器檢查新加的每一副（`ClubService.checkShareable`）：只有已經公開的牌（沒有 `revealAt` 或已經過了）能分享，打過那副的人拿到 `recordNotShareable`（409），看不到的人拿到 `boardGone`，不透露那副牌存在。貼文裡的牌圖由瀏覽器走 `/api/history/:id` 讀，所以每個讀者照樣由 `recordVisible`／`challengeBoardVisible` 把關；貼文本身不帶任何一張牌。搜尋在 SQL 裡套同一條規則（`reveal_at IS NULL OR reveal_at <= 現在 OR 我打過`），而且不管搜尋什麼條件都會套用，前端無法關掉。Worker 從 D1 副本回答的紀錄列表與搜尋（§5.12）跑的是同一段 SQL，規則一樣；資訊隔離套件比對兩邊的回答完全相同。

**匯出與公開分享連結**（`e4-t36`～`t38`，§5.3 的「匯出與分享」）：PBN 與整場 LIN 只給看得到的牌：紀錄頁的整批 PBN（`GET /api/history/export.pbn?<條件>`）跑的是同一個 `searchBoards`（同一個 `where()`），還沒公開的牌只有打的人匯出得到，點名不公開打過的牌局的社員當玩家或主打時一副都沒有（同搜尋）；整場 LIN（`GET /api/history/:id/session.lin`）先要看得到那一副（`ClubService.record`），同一場的其他副也一副一副用 `record` 過濾，看不到的就不放進檔案。**公開分享連結**（`sharedBoardView`）是唯一一個不用登入就讀得到牌的地方：
- **誰能產生、撤銷**：打那一副的人（四個座位上的社員）與管理員（`BoardShares.manageable`）；看得到牌但沒打的社員拿到 `shareNotPlayer`（403），看不到的拿到 `boardGone`（404），不透露那副牌存在。每副最多一個連結（`board_shares` 的 `board_id` 唯一），誰再按都拿到同一個；任何一位打的人或管理員都能撤銷（撤銷後立即失效，再產生是新的 token）。還沒公開的挑戰／隊制賽／雙人賽牌（`revealAt` 還沒到）打的人拿到 `shareHeldBack`（409）；公開之後才能產生。產生的人刪帳號時，他產生的連結一起刪。
- **公開頁看到什麼**（`GET /api/share/:token`，`/share/<token>`）：只有那一副打完的牌（沒有 `result` 或還沒公開一律當作不存在，每次讀都重算）：原始四手牌、叫牌與 Alert 說明（機器人的說明是它的簡短解釋，同 BBO 的 GIB）、打牌過程、合約、結果與分數、日期，座位上的名字（見下）。**不送**：任何 id（紀錄、桌、比賽、社員的 id）、桌號、模式、主人、裁定與理由、代打、動作事件與時間、引擎對叫品的推論（`meaning`、`inferred`）與淡江橋館的原文（`book`：淡江制度只給社員）。**名字**（社長 2026-11-02 決定）：只有產生連結的那位社員（`board_shares.created_by`）顯示帳號名稱，其他三位真人一律是 `null`，頁面寫「社員」；機器人照常顯示。產生的人設定了「不公開打過的牌局」（`hideProfileBoards`）也是「社員」；管理員替沒打過的牌產生的連結，四位真人都是「社員」。之後別的打的人再按「產生連結」拿到的是同一個連結，名字仍是原本產生的那位。都在讀的時候算（`sharedBoardView` 的 `sharedBy`、`hides`），所以設定改了立刻生效。連結不會過期，只能撤銷（社長 2026-11-02）。隱私權政策有一段「公開分享連結」說明這些（`strings.ts` 的 `legal`，六種語言）。頁面沒有任何連到別副或紀錄頁的連結。
- **猜 token**：token 是 128 位元的亂數（32 個十六進位字元）；每個網路位址（`CF-Connecting-IP`）查詢一次扣一個 token bucket（一次 30 個、之後每 2 秒一個），查錯（不存在、已撤銷、牌已不能看）15 分鐘內 10 次就整個擋 15 分鐘（`slowDown`，429），回應也帶 `X-Robots-Tag: noindex`。
測試在 `tests/worker/record-export.test.ts`；`tests/worker/visibility/visibility.test.ts` 的 `exposure` 也檢查還沒公開的牌在 PBN 與整場 LIN 都拿不到。

**練習桌**（§5.11，`practiceView`）：牌照上表（社員只看到自己的牌，打完四家公開）；`TableView.practice` 只有社員自己選的設定與發了幾副，不含任何牌。**顯示四家**（`e10-t16`）：練習桌的主人（有座位）開了 `showHands`，`boardView` 另外帶 `shown`（四家）：只給他、只是看得到，叫牌盒與提示照舊（不是 `acts`）；觀看者照上表，沒有座位的人、別桌的人都不受影響，送不送牌由伺服器決定（`TableService.shownTo`）。**牌組**（`deal: 'set'`）：牌組的牌（`PracticeTableState.problems`）跟挑戰的牌組一樣只在伺服器，`practiceView` 只送正在打的那一副是第幾題、分類、精選的標題，**叫牌結束後**才送教學重點（`note`，叫牌前送會洩漏該怎麼叫）；收藏與精選的牌只能是看得到**而且已經公開**的（`revealAt` 已過或沒有）：還沒公開的挑戰、隊制賽牌，連打過的人也拿到 `boardGone`。練習牌組的 JSON 只有 Worker import，瀏覽器的 bundle 裡沒有（測試檢查 `src/` 沒有 import 它）。Just Declare 練習的叫牌是機器人叫的，跟所有機器人的叫品一樣公開。練習的紀錄所有人仍看得到（`recordVisible` 不變），只是「全部社員」的列表預設不列（§5.11）。

**封鎖與聊天**（AC-1.6，`chatFor`）：牌桌聊天照每位觀看者過濾，他封鎖的社員說的話不會送到他的瀏覽器；其他人照常看得到，解除封鎖後保留的訊息會再出現。大廳的 `friends`／`blocked` 只在社員自己的那一份（`LobbyMine`），別人封鎖或加了誰不會送出。

**私訊**（AC-1.7，§5.7）：一則私訊只送給它的兩位成員（雙方所有分頁的 `direct`），對話列表 `directs` 只送自己的；`GET /api/messages/:userId` 只讀「自己與對方」這一對的訊息，SQL 以兩人 id 組成的 `pair` 查詢，拿不到別人之間的對話。被對方封鎖的人只會收到「不能傳私訊給他」（`cannotMessage`），不會知道被封鎖。

**個人檔案**（AC-1.5，`memberProfileView`，`GET /api/members/:id`）：別人只拿得到 id、帳號名稱、頭像版本與四個欄位（顯示名稱、自評等級、常用制度、自我介紹），一個一個挑出來，帳號的其他東西（密碼雜湊、管理員、權限、登入時間、好友上線提示）不會送出；`recent` 是這位社員最近 10 副**看的人看得到**的牌（走紀錄搜尋，同一條 `revealAt` 規則）。**隱私設定**（`e13-t08`）：社員在「我的帳號」可以讓個人頁不公開「最近的牌」與「論壇貼文」（`/api/account/preferences` 的 `profileBoards`、`profilePosts`，`Me.profilePrivacy`）；不公開時別人拿到的 `recent` 是空的、`GET /api/forum/feed?author=<他>` 回空的一頁，回應另帶 `hidden: { boards, posts }` 讓頁面寫「這位社員不公開」；本人一律看得到。**不公開「最近的牌」也擋紀錄的玩家搜尋**（社長 2026-11-02 決定）：別的社員在紀錄搜尋（`/api/history/search`、`/api/history/days`、「我的收藏」）用 `player=<他>` 或 `declarer=<他>` 找，一副都找不到（總數 0、每天的副數是空的），跟他沒打過牌一樣，不另外說「他不公開」；**本人與管理員照常找得到**。牌本身不藏：那幾副照樣是同桌其他人的紀錄，在全部的列表、用其他條件（合約、日期、別的玩家）搜尋、詳細頁都看得到，只是不能「以他為條件」找出來。同桌的人也一樣（用自己找得到，用他找不到）。`partner=` 不擋：那是「我和誰搭檔」，結果都是看的人自己打過的牌。條件只寫在 `history-index.ts` 的 `where()`（多一個 `hidden` 參數：這次搜尋點名的玩家裡，對這位看的人不公開的；`ClubService.hiddenPlayers` 算，管理員是空的），社團的索引與 D1 副本共用；D1 不知道誰不公開，所以搜尋點名**別人**當玩家或主打時（`namesOthers`），Worker 不從副本回答、交給社團（跟收藏的標籤一樣），索引與摘要都沒改，`REPLICA_VERSION` 不用加。論壇板面照常。自己的個人檔案在 `/api/me` 的 `profile`。頭像：上傳過的社員，`PublicUser.avatar`（大廳的 `members`、`online`、座位）、`/api/me` 與個人檔案卡帶版本號，瀏覽器用 `/api/avatar/:id?v=<版本>` 載入（兩站同一個網址，橋館經 Vercel 轉發）；沒有上傳或載入失敗時是瀏覽器依 id 與名字畫的預設頭像（`e1-t18`）。頭像所有登入的社員都看得到，跟名字一樣。

**動作事件紀錄**（`e2-t32`，§5.16）：每一副的 `events`（叫品、出牌、攤牌與回覆、撤回，含伺服器時間）只存在伺服器的 `Table.events`，打牌中**從不**送到瀏覽器（`tableView` 不帶，測試在 `tests/worker/director.test.ts`）；打完後跟著紀錄（`BoardRecord.events`）走 `/api/history/:id`，所以照樣由 `recordVisible`／`challengeBoardVisible` 把關。裡面的每一張牌都是桌上四家當時看過的（打出、撤回的牌），不比紀錄本身多透露什麼。**叫裁判**（`e2-t34`）：`TableView.directorCall` 只有叫的人與時間，給桌上所有人；房主與管理員在有人叫裁判時可以進入不允許觀看或沒受邀的桌**觀看**（`TableService.join` 的 `director`），看得到的跟一般觀看者一樣（四家），但比賽的參賽者不會因此看到另一室或自己那一室。**裁定**（`e2-t35`）：`BoardRecord.ruling` 的理由只在紀錄裡，列表的 `BoardSummary.ruling` 只帶種類、哪一方與分數。裁定接進計分（`e2-t36`）後，挑戰的成績表（`ChallengeTravellerEntry.ruling`、牌局頁的 `TravellerEntry.ruling`）與隊制賽兩室的結果（`MatchRoomView.ruling`）也只帶這三項（不帶理由與裁判），跟著原本的可見規則：成績表只給看得到它的人、隊制賽只在兩室都完成後；排名的 `ChallengeStandingView.ruled` 只是被裁定的副號。

**裁判紀錄**（`e9-t17`，§5.23）：比賽頁的 `referee`（`RefereeNote`：做了什麼、理由、裁判、時間）跟著比賽頁給看得到那場比賽的人（雙人賽 `pairsView`、隊制賽 `teamMatchView`、挑戰 `challengeView` 只在看得到排名時）；**調整分數的那一筆跟著那一副的成績走**：雙人賽要看得到那一副的 traveller、隊制賽要那一副已經顯示，否則還沒打那一副的人會從理由或分數知道結果。處罰（`PairStanding.penalty`、`TeamMatchView.penalties`、`ChallengeStandingView.penalty`）跟著成績。雙人賽裡**不在任何一對的管理員**跟裁判一樣看得到全部 traveller（也能裁定）。測試在 `tests/worker/pairs-referee.test.ts`。

瀏覽器拿到的 `BoardView` 只包含它能看的牌，以及伺服器算好的 `legalCalls`／`legalCards`／`canUndo`／`canClaim`，畫面不需要自己判斷規則。攤牌被拒絕後，`rejectedClaim` 記下誰拒絕，直到下一個動作。

## 5. 通訊與儲存

**HTTP**：`GET /api/challenges`（我參與的挑戰，新的在前）、`/api/challenges/:id`、`POST /api/challenges`（建立）、`POST /api/challenges/:id/answer`、`/cancel`（§5.5）、`GET /api/matches`（我主辦或有座位的隊制賽，新的在前；已取消的不列，`/matches` 頁收到 `match` 推送是取消或 `null` 時先拿掉、再重讀列表，連結 `/api/matches/:id` 仍打得開）、`/api/matches/:id`、`POST /api/matches`（建立）、`POST /api/matches/:id/settings`、`/cancel`、`/invite`、`/answer`、`/move`、`/leave`、`/clear`、`/robot`、`/start`，比賽中的 `/rule`、`/pause`、`/abandon`、`/replace`、`/sitin`（§5.8）、`GET /api/rankings?month=|year=|season=`、`/api/rankings/ledger?user=`、`POST /api/rankings/rules`、`/api/rankings/adjust`（後兩個只給管理員）、`GET /api/ratings/:userId`、`POST /api/ratings/visibility`（社團積分與實力評分，§5.21）、`GET /api/practice/sets`（練習牌組，不含牌）、`GET /api/practice/presets`、`POST /api/practice/presets`、`DELETE /api/practice/presets/:id`（存的練習設定，§5.11）、`GET /api/featured`（全部精選，新的在前）、`GET /api/featured/:boardId`（那副的精選或 `null`）、`POST /api/featured/:boardId`（設為精選或編輯，要 `boardCurate`）、`DELETE /api/featured/:boardId`（取消精選，§5.9）、`POST /api/register`（第一個帳號直接登入，之後回 202 `{ pending }`；同一個網路的次數限制與 Turnstile 見 §5.2，`e1-t33`）、`GET /api/register/options`（`{ turnstileSiteKey }`，不用登入）、`/api/login`、`/api/logout`、`/api/password/reset/request`（忘記密碼第一步：`{ username, inviteCode }`，通知管理員，`e1-t36`）、`/api/password/reset`（第二步：`{ username, code, password }`，用管理員給的一次性代碼設新密碼，錯的代碼與登入共用失敗次數限制）、`/api/account/password`（改密碼後其他裝置的 session 全部登出，這個裝置保留）、`/api/account/preferences`（欄位都選填、至少一個：`friendOnlineNotice` 好友上線提示開關，`e1-t24`；`bookAdoptedNotice` 採用特約的發布通知開關（橋館 F4，關掉後只停「隊伍／搭檔制度集採用該特約」這個原因的 `bookPublished`，關注、送審者、覆寫段落變更、建議統一照常；`/api/me` 一律帶）；`bookProfile` 淡江橋館讀的制度集 id，空字串或 `club` 回到社團預設，只檢查格式、不查是否存在，橋譜 `e1-t16`；`/api/me` 的 `bookProfile` 同步回傳；`robotSpeed` 機器人出牌速度 `veryFast`／`fast`／`slower`，其他值 `unknownCommand`，`/api/me` 一律帶，§5.1；`profileBoards`、`profilePosts` 個人頁公開「最近的牌」與「論壇貼文」與否，`true`／`false`，`/api/me` 的 `profilePrivacy` 一律帶，`e13-t08`）、`PATCH /api/account/profile`（自己的個人檔案，`shared/profile.ts` 的 `parseProfile` 檢查：只收四個欄位、長度上限、等級只能是 `PROFILE_LEVELS`，空的欄位清掉）、`PUT /api/account/avatar`（自己的頭像，`e1-t34`：本文是瀏覽器裁好、縮成 256×256 的圖片原始位元組，最多 `AVATAR_MAX_BYTES` 64 KB，超過回 413 `avatarTooLarge`；只看檔頭的 magic bytes 判斷是 WebP／JPEG／PNG，不是就 415 `avatarBadFormat`，Worker 不解碼圖片；每人突發 5 次、之後每分鐘 1 次，與刪除共用，`slowDown`）、`DELETE /api/account/avatar`（回到字首預設頭像）、`GET /api/account/sessions`（登入中的裝置，`e11-t23`：`SessionInfo[]`，這個裝置在前；每個 session 有自己的 `id`，從不送出 token；裝置名稱是登入時 User-Agent 摘要的「瀏覽器 · 系統」，最近使用時間一小時最多寫一次）、`DELETE /api/account/sessions/:id`（登出另一個裝置；不能是這個裝置 `notSelf`，不是自己的或已失效 404 `sessionGone`）、`POST /api/account/sessions/others`（登出其他裝置，回 `{ ended }`；有登出就關掉這個人的 `/ws`（4001），這個裝置會自己重連）、`GET /api/account/export`（自己的資料 JSON 下載，`e11-t27`：帳號與設定（不含密碼雜湊）、session 列表、好友與封鎖、通知、私訊、練習設定、收藏與筆記、打過的牌的摘要；`Content-Disposition: attachment`）、`POST /api/account/delete { password }`（刪除自己的帳號，同管理員刪帳號的 `removeMember`；密碼錯 `wrongPassword`，社團唯一的管理員 `lastAdminLeaving`；回應清掉 cookie）、`GET /api/avatar/:userId?v=<版本>`（要登入；`ETag: "avatar-<版本>"`，`v` 是目前版本時 `Cache-Control: private, max-age=31536000, immutable`，否則 `private, no-cache`，`If-None-Match` 相同回 304；沒有頭像回 404 `noAvatar`）；`GET /api/members/:id`（別人的個人檔案卡，§4；`{ member, hidden }`，`hidden` 是他不公開的部分，`e13-t08`）；`GET /api/messages/:userId?before=<id>`（與某位社員的私訊，一頁 30 則，§5.7）；`GET /api/me`（含 `permissions`，管理員另有 `applications` 待審核數）、`/api/history?scope=all&page=<n>&size=<10|20|50|100>`（回傳該頁與總數）、`/api/history/search?<條件>`（§5.3）、`/api/history/days?<條件>`（每天幾副，§5.3）、`/api/history/:id`。維運：`GET /api/health`、`POST /api/client-errors`（§5.6，都不需登入）。管理員：`GET/POST /api/admin/users`、`POST /api/admin/users/:id/password`、`POST /api/admin/users/:id/password-reset`（核准忘記密碼，回 `{ code, expiresAt }`，代碼只出現這一次）、`DELETE /api/admin/users/:id/password-reset`（拒絕）、`POST /api/admin/users/:id/admin`、`POST /api/admin/users/:id/permissions`、`POST /api/admin/members`（`{ changes: MemberChange[] }`：管理頁社員區一次存好幾位的身分與權限，`ClubService.adminUpdateMembers` 全部先檢查、全部成功或全部不存，規則同單筆：不能拿掉自己的管理員、至少留一位管理員）、`DELETE /api/admin/users/:id`、`GET /api/admin/applications`、`POST /api/admin/applications/:id/approve`、`DELETE /api/admin/applications/:id`、`GET/POST /api/admin/settings`、`GET/POST /api/admin/features`（功能旗標，`e11-t26`，`shared/features.ts`：`{ flag, state, usernames }`，`state` 是 `off`／`officers`／`on` 或 `null`＝照全站預設；存在 `meta:features`；每個人的 `Me.features` 由伺服器算好）、`DELETE /api/admin/tables/:id`。淡江橋譜的 `/api/book/*` 見 §5.2。session 放在 HttpOnly、SameSite=Lax 的 cookie（`tbt_session`）。錯誤回應帶 `code` 與 `params`（`shared/messages.ts`），瀏覽器依語言顯示。

**WebSocket** `/ws`（同網域，帶 cookie 驗證）與在桌上時的第二條 `/ws/table/<桌 id>`（§5.10）：牌桌的動作（`TABLE_ACTIONS`：`stand`、`kick`、`addRobot`、`removeRobot`、`replaceWithRobot`、`call`、`play`、`claim`、`claimRespond`、`undoRequest`、`undoRespond`、`chat`、`redeal`）在桌的連線打開時走那一條，那一桌直接推 `table`；其他動作、與桌的連線還沒接上時的牌桌動作走 `/ws`（社團轉給那一桌）。桌的連線只收在桌上的人（入座、觀看、停著的挑戰桌的主人），其他人與離開的人用 4004（`TABLE_SOCKET_REFUSED`）關掉，瀏覽器不再重試那一桌：

- 瀏覽器 → 伺服器：`createTable`（可帶 `settings`、`invitees`）、`updateTableSettings`（可帶 `invitees`）、`requestJoin`、`answerRequest`（申請加入，見下）、`quickSeat`、`createPractice`（§5.11，可帶 `access`）、`joinTable`、`sit`、`stand`、`leaveTable`、`kick`、`addRobot`、`removeRobot`、`replaceWithRobot`、`call`、`play`、`claim`、`claimRespond`、`undoRequest`、`undoRespond`、`chat`、`redeal`（只有練習桌）、`rebid`（只有只叫牌的練習桌）、`showHands`（只有練習桌的主人，§5.11）、`readNotifications`（不給 `ids` 就是全部標為已讀）、`setFriend`、`setBlocked`、`createChallenge`、`answerChallenge`、`cancelChallenge`、`playChallenge`（§5.5）、`sendDirect`、`readDirect`（§5.7）、`matchInvite`、`matchAnswer`、`matchMove`、`matchLeave`、`matchClear`、`matchRobot`、`startMatch`、`matchRule`、`matchPause`、`matchAbandon`、`matchReplace`、`matchSitIn`（§5.8）、`lobbySync`（瀏覽器的大廳缺了一版，要社團重送整份，H3b）。`kick`、`addRobot`、`removeRobot`、`replaceWithRobot`、`updateTableSettings`、`answerRequest` 只有房主能用；房主離開或斷線時，桌上第一位在線的真人（先入座者、再觀看者）接手
- 伺服器 → 瀏覽器：`welcome`、大廳三種（H3b，§5.13）：`lobbyShared`（大家共用的一份整份：牌桌列表與 `members`，每位社員是否在線、在哪一桌哪個座位；連線時、`lobbySync` 後、社團重啟後）、`lobbyDelta`（共用那份的差異，帶 `base`→`rev`）、`lobbyMine`（自己的一份：在哪一桌、`friends`、`blocked`、能不能進每張桌、自己的隱藏桌；有變才送）；排序（線上在前、各組裡自己的好友置頂）在瀏覽器做（`shared/lobby.ts` 的 `composeLobby`）、`table`、`error`、`notifications`（連線時一次，之後內容有變才送：最新 30 則與未讀數）、`directs`（自己的對話列表與私訊未讀數，同樣只送有變的）、`direct`（一則新私訊，只給它的兩位成員）、`match`（隊制賽有變時推給這場比賽在線的人：`{ matchId, match }`，看不到了是 `null`，§5.8）
- **只送有變的部分**：伺服器記住每位社員上次收到的大廳與牌桌（JSON），沒變就不送；牌桌的 `chat` 與 `recent`（本桌最近 30 副的摘要）只在改變時才附上，瀏覽器沿用手上那份（`TableWire`）。所以某桌出一張牌，大廳裡的人什麼都收不到，桌上的人只收到小小一份。新連線一律收完整資料
- **沒有「下一副」**：一副結束後伺服器設定 `dealAt`（打到最後一張多等 `LAST_TRICK_MS` 3.5 秒，再加 `DEAL_COUNTDOWN_MS` 3 秒倒數），時間到自動發牌；`table` 訊息附上伺服器時間 `now`，瀏覽器據此換算成自己的時鐘來倒數
- **牌桌設定**：`Table.settings`（`shared/protocol.ts` 的 `TableSettings`）：`access`（誰可以加入，四種之一，見下）、`allowKibitz`（是否允許觀看）與 `boardMinutes`（每副時間上限，`BOARD_TIME_LIMITS` 0／5／7／10／15 分鐘，0 是不限）；預設 `DEFAULT_TABLE_SETTINGS`（公開、允許觀看、不限時）。伺服器用 `parseTableSettings` 檢查，只接受這三欄，錯了丟 `badTableSettings`（改版前載入的頁面送舊的 `visibility` 也照下面的對照接受）。挑戰牌桌固定是隱藏、不允許觀看、不限時，不能改；隊制賽的兩桌固定公開、可觀看（照比賽的規則：只列在大廳的「隊制賽」，參賽者不能看另一室，§5.8），都不受房主設定影響
- **四種進入方式**（社長 2026-10-25，`TABLE_ACCESS`；規則只在伺服器：`worker/views.ts` 的 `tableListed`、`mayEnter`、`refusal`，`ClubService.checkWelcome` 先用目錄檢查，`TableService` 再用自己的狀態檢查一次，錯誤代碼相同）。房主與已經在桌上的人（改設定之前就在的）一律不受影響，站起來、換座位照常：

  | `access` | 大廳 | 誰可以入座或觀看 | 其他人拿到 |
  | --- | --- | --- | --- |
  | `public` 公開 | 列出 | 所有社員；房主封鎖的人回 `blockedByHost`（同 C1） | — |
  | `request` 申請加入 | 列出，卡片標「申請加入」 | 受邀者，與送出申請、房主同意的人（`Table.approved`，這一桌開著就一直有效） | `requestFirst` |
  | `hidden` 隱藏 | **不列**（只列給房主、受邀者、桌上的人） | 受邀者（從 `tableInvited` 通知或連結進來） | `tableGone`（看起來跟不存在一樣） |
  | `closed` 拒絕所有人 | 列出，卡片標「已關閉」 | 沒有新的人；受邀、同意過的也不行 | `tableClosed` |

  拒絕所有人的桌**照樣列在大廳**：成員列表本來就看得到誰在第幾桌，藏起來反而對不上；列出來並標「已關閉」，找朋友的人知道他在哪、也知道現在進不去。`allowKibitz` **保留成獨立的開關**：進入方式決定「誰」能來，`allowKibitz` 決定來的人能不能只看不坐；兩者正交（例如申請加入＋不允許觀看＝同意之後只能入座），合併會變成八種選項。練習桌只有觀看，`allowKibitz` 固定允許（§5.11）
- **申請加入**（`request`）：社員在大廳卡片或牌桌頁按「申請加入」→ `requestJoin { tableId }`（`GUARDS` 檢查欄位；每人突發 3 次、之後每 30 秒 1 次，`requestTooFast`，只在 socket 入口）。伺服器把 `{ userId, at }` 記進 `Table.requests`，同一人重複申請不會多一筆；`TABLE_REQUEST_MS`（10 分鐘）沒回覆就失效，可以再申請。公開的桌或已經能進的人申請什麼都不做；拒絕所有人的桌回 `tableClosed`，隱藏的桌回 `tableGone`。房主在牌桌上馬上看到（`TableView.requests`，只給房主，牌桌上方的「加入申請」面板，同意／拒絕）；房主不在線時另外收到 `tableRequest` 通知。房主回覆 `answerRequest { userId, accept }`（只有房主，`hostOnly`；沒有這筆申請或已經失效 `requestGone`）：同意就加進 `Table.approved`，申請者收到 `tableRequestApproved`，大廳卡片變成可以入座、觀看；拒絕的話申請者收到 `tableRequestDeclined`，`TABLE_REQUEST_COOLDOWN_MS`（10 分鐘）內不能再申請這一桌（`requestCooldown`，記在 `Table.declined`）。**封鎖**：房主封鎖的人照樣能送出申請、看到「已送出申請」，但這筆申請標 `muted`，房主看不到、也不通知，十分鐘後自然失效；他直接 `joinTable`／`sit` 拿到的也是 `requestFirst`，跟任何沒被同意的人一樣，看不出被封鎖。房主改成別的進入方式時，等待中的申請全部清掉；已同意的名單保留
- **邀請名單**（`e2-t25`）：`createTable`／`updateTableSettings` 可帶 `invitees`（社員 id，最多 `LIMITS.tableInvitesMax` 30 位，給了就取代 `Table.invited`），新加入名單的人收到 `tableInvited` 通知。隱藏的桌只有名單上的人能進，申請加入的桌名單上的人不必申請；公開、拒絕所有人時名單留著不用（設定視窗只在申請加入與隱藏時顯示名單，`takesInvitees`）。不能邀請自己（`notSelf`）、不存在的帳號（`userGone`）、自己封鎖的人（`unblockToInvite`），對方封鎖了房主時只回中性的 `cannotInvite`（同挑戰，房主看不出被封鎖）。名單只送給房主（`TableView.invited`）
- **舊資料**：改版前存的設定是 `visibility`（`public`／`invite`），讀取時一律經過 `tableSettingsFrom` 轉換：`public` → 公開，`invite`（列在大廳、只限受邀）→ **隱藏**，受邀名單原封不動，所以原本受邀的人照樣能進；缺的欄位用預設值。牌桌自己（`TableService.load`）載入時就換成新格式，下一次存檔寫回；社團的目錄（`tabledir:`）載入時經 `upgradeEntry` 換成新格式並補上 `approved`、`requests`，下一次回報寫回。測試在 `tests/worker/table-rules.test.ts`（牌桌在社團裡）與 `tests/worker/table-objects.test.ts`（每桌一個物件）
- **不允許觀看**（`e2-t26`）：`joinTable` 回 `noKibitzing`，只能 `sit`；桌上沒有座位的人（站起來、被請離座）照 §4 只看得到公開的牌
- **計時**（`e2-t27`、`e2-t28`）：發牌時記 `Table.boardStartedAt`，有時間上限時 `TableView.boardEndsAt`＝發牌時間＋上限（伺服器時鐘，瀏覽器用 `now` 換算），輪到的人名牌上倒數，時間到變紅「超時」；**時間到不強制結束**；隊制賽由房主裁定（`e8-t15`，§5.8）。`TableView.waiting` 是桌子在等哪一位真人（叫牌或出牌的控制者；攤牌、撤回待回覆時不算）與從什麼時候開始（`Table.turnSince`，每個動作、入座、換人都重算）。等超過 `SLOW_TURN_MS`（60 秒）名牌閃爍、本人再聽到一次提示音，房主可以 `replaceWithRobot`（伺服器檢查真的在等他且滿 60 秒，否則 `notSlow`）：他留在桌上沒有座位，座位換成 TKB
- **大廳排序與快速入座**（`e2-t29`、`e2-t30`，`shared/lobby.ts`）：缺人的桌在前，缺越少越前面（最快能開打），滿的桌在後，同組照桌號；大廳卡片標「缺 N 家」。`quickSeat` 選第一張缺人、可以直接入座（`mayEnter`：公開，或受邀、已同意；房主沒封鎖他；不選練習桌、拒絕所有人的桌）的桌，坐第一個空位（南、北、東、西）；都滿就開新桌（預設設定）。已經坐在別桌的人會換過去
- **斷線代打**（`e2-t31`）：一般牌桌上入座的真人斷線（最後一個 socket 關閉）滿 `SUBSTITUTE_MS`（3 分鐘），排程器的 `substitute:<社員>` 工作讓 TKB 坐進他的座位（同伴是機器人就用同伴的制度），`Table.substitutes` 記座位 → 本人，名牌顯示「代打 某某」（`SeatOccupant.substituteFor`）；只在桌上還有別的入座真人在線時才代打。本人重新連線（`connected`）立刻換回原座位（機器人換座位時記號跟著走）；別人坐進代打的座位、房主移走它，代打就結束。這一副有代打過，紀錄的 `BoardRecord.substitutes` 記座位與本人，單副紀錄頁的明細列出「北 · 代打 某某」（`RecordSubstitutes`）。斷線時間在記憶體（`offlineSince`），物件被回收後 `load()` 把離線的入座者從現在重新起算
- **牌桌模式**：`Table.mode`（`casual`、挑戰的 `challenge` 或練習的 `practice`（§5.11），舊資料沒有這欄也當 `casual`）與 `modeState`；`ClubService` 只在三個地方問模式（`worker/modes.ts` 的 `TableModeHooks`，都拿到 `ModeContext`：社團的亂數、現在時間、`ChallengeStore`）：發新一副（`deal`，回傳牌號與四手牌，`null` 表示沒有下一副，最後一副留在桌上）、寫紀錄（`record`）、一副結束（`boardFinished`，在紀錄存好之後，所以拿得到牌局 id）。叫牌、出牌、入座與可見性在每種模式都一樣。牌從 `Table.dealSource` 來（`shared/deal-source.ts`；沒有就是每副重洗）
- **排程**：機器人的下一步與自動發牌都交給同一個排程器（`worker/scheduler.ts`），每桌每種工作一個 key（`robot:<桌>`、`deal:<桌>`），每個進行中的挑戰一個 `challenge:<挑戰>`（§5.5），每位斷線的入座者一個 `substitute:<桌>:<社員>`（代打；雙人搭檔挑戰桌改成 `partnerAway:<桌>:<社員>`，§5.5），一副的紀錄社團還沒收下時每桌一個 `outbox:<桌>`（§5.10），沒搬完的舊牌桌一個 `migrate:tables`，論壇每篇排程中的貼文一個 `forum:<貼文>:<時間>`（§5.19「公告與新聞的編輯流程」），同一個 key 還在等就不重排。Durable Object 用 `AlarmQueue`：工作放在記憶體，只把最早的一個設成物件唯一的 storage alarm（`alarm()` → `runDue()`），所以不會互相覆蓋 alarm，物件在兩步之間也能休眠；工作不寫進儲存，物件被回收後由 `load()` 依狀態重新排程。**每個 `TableObject` 有自己的佇列與 alarm**（牌桌的工作），社團的只剩挑戰、每週挑戰與搬移（§5.10）；`EVENT_OBJECTS=on` 時挑戰的 `challenge:<挑戰>` 也在那一場自己的 `EventObject`，社團只剩每週挑戰與搬移（`migrate:events`，§5.12 H2b）。測試傳 `schedule` 換成手動佇列
- **心跳**：兩條連線都一樣（`src/lib/liveSocket.ts`）：瀏覽器每 15 秒送 `ping`，由 `setWebSocketAutoResponse` 直接回 `pong`（不必喚醒物件）。40 秒沒收到任何訊息、分頁回到前景或網路恢復時，瀏覽器立刻重新連線；重連期間的動作暫存 8 秒內補送（社團的連線補送全部，桌的連線只補牌桌動作）
- **好友與封鎖**（AC-1.6，`worker/relations.ts`）：2026-10-27 起介面曾隱藏，社長 2026-11-03 核准重新開放（docs/ROADMAP.md L3）：功能旗標 `friends`（`shared/features.ts`）全站預設 `on`，`FRIENDS_ENABLED` 跟著是 `true`。社團仍可在管理頁把它關掉或只開給幹部；沒有這個旗標的社員，社員列表、個人檔案卡與個人檔案頁不顯示加好友（星星）、「只看好友」與封鎖按鈕（只剩私訊；之前封鎖過的人仍有「解除封鎖」可以按），「我的帳號」沒有好友上線提示的開關、推播設定沒有「好友上線」那一組，伺服器不送他 `friendOnline`，大廳也不把好友置頂。名單、指令（`setFriend`／`setBlocked`）、儲存與封鎖的檢查不看旗標，一直都在。好友是單向關注，不需對方同意、也不通知對方（同 BBO）；`setFriend`／`setBlocked` 帶對方的 id 與 `true`／`false`，不能對自己（`notSelf`）、不存在的帳號或機器人（`userGone`）。封鎖會同時取消關注，封鎖中不能加好友（`unblockFirst`）、不能邀請他（挑戰與受邀桌回 `unblockToInvite`）。封鎖的效果都在伺服器：被封鎖者的聊天對封鎖者隱藏（§4），封鎖者當房主時被封鎖者不能 `joinTable` 或 `sit` 進那一桌（公開的桌回 `blockedByHost`，其他進入方式回跟任何沒被放行的人一樣的錯誤，申請也只是房主看不到，見「申請加入」；已經在桌上的不會被請走）。私訊（`e1-t27`，§5.7）、挑戰邀請（`e7-t05`，含搭檔挑戰）、受邀桌（`e2-t25`）、隊制賽邀請（§5.8）、比賽報名的搭檔與隊友（§5.24，`tournamentBadPartner`；個人賽和已報名的任何人有封鎖關係就不能報名，`individualBlocked`）與雙人賽的搭檔（§5.22）也檢查 `blocks`；討論區的 `forumMention`／`forumReply` 不通知封鎖了作者的人（社團新聞與幹部的處理照常通知，`worker/forum-notices.ts`）。挑戰與受邀桌仍可邀請任何社員，不必是好友（社長 2026-10-27，2026-11-03 重新開放好友時維持）；跨社團：社長 2026-11-04 決定不同社團的人要先是好友才能私訊或邀請，跨社團好友還沒有，所以現在跨社團的私訊與邀請都不可能（§1「社團網址與登入範圍」）。帳號刪除時雙方名單裡的他都會刪掉，個人資料匯出包含自己的好友與封鎖名單，每日備份也包含（DEPLOY.md §4.4）
- 使用 Durable Object 的 hibernation API：沒人打牌時物件可以休眠，WebSocket 不會斷，醒來時從儲存重新載入。

**儲存**（Durable Object 的 key-value，SQLite 後端）：

| Key | 內容 |
| --- | --- |
| `user:<id>` | 帳號、密碼雜湊、是否管理員、橋譜權限、最後登入時間、自行重設密碼的時間、關掉好友上線提示（`friendOnlineNotice: false`）、關掉採用特約的發布通知（`bookAdoptedNotice: false`）、頭像版本（`avatar`，上傳時的時間，每次一定變大） |
| `avatar:<userId>` | 上傳的頭像（`e1-t34`）：`{ version, type, bytes }`，瀏覽器裁好的 256×256 WebP（不支援就 JPEG），最多 64 KB，遠低於單筆值的上限；帳號刪除時一起刪，和 `user:` 一起在每日備份裡。不放 R2：每個環境（正式站、staging、PR preview）不必先建 bucket 就能部署，一個社團幾百人、每人幾十 KB 也只有幾 MB |
| `file:meta:<key>`、`file:ticket:<pass>`、`file:day:<userId>`、`file:secret` | 討論區與文章的圖片（淡江橋譜 `e11-t02`，§5.14）：圖片在 R2 `bridgebook-files`，這裡只存上傳者、型別、大小、有沒有縮圖；一次性上傳憑證（10 分鐘）；當天（台灣日期）拿過幾張憑證；簽網址的隨機金鑰。`file:meta:` 與 `file:secret` 在每日備份裡 |
| `app:<id>` | 待審核的註冊申請：帳號名稱、密碼雜湊、自我介紹、從哪個網站申請；用 Google 申請的還有 Google 的 `sub`、Email 與顯示名稱（`e1-t31`）；用 LINE 申請的是 LINE 的 `sub` 與 LINE 名字（`e1-t32`） |
| `google:<id>`、`line:<id>` | Google／LINE 登入進行中的流程（§5.2，`e1-t31`、`e1-t32`，`worker/oauth.ts` 的 `OAuthFlows`，每個登入方式各自的前綴與上限）：去 Google 的途中（PKCE verifier、nonce，10 分鐘）、等兩步驟驗證碼（5 分鐘）或等申請表（30 分鐘）；用一次就刪、過期的在下一次新增時清掉，最多 500 筆，不在備份裡 |
| `session:<token>` | userId、到期時間、`id`（列表用，不是 token）、建立與最近使用時間、裝置名稱（`worker/sessions.ts`） |
| `meta:registrations` | 申請加入的次數（§5.2，`e1-t33`，`worker/register-limit.ts`）：`{ <位址雜湊>: { count, since } }`，雜湊以 `SEEN_SALT` 加鹽、不存 IP；一小時的視窗結束就清掉；沒設 `SEEN_SALT` 時不寫（只在記憶體）；不在備份裡 |
| `seen:<userId>` | 防作弊報表（§5.17，`worker/integrity.ts`）：登入與連線時的網路雜湊（以 Worker secret `SEEN_SALT` 加鹽的 SHA-256，不存 IP；鹽不在儲存裡）、瀏覽器 id（cookie `tbt_device`）與名稱、第一次與最近一次；每人最多 16 筆、90 天；帳號刪除時一起刪，不在備份裡 |
| `tabledir:<id>` | 牌桌目錄（`TableEntry`，§5.10）：大廳與跨桌動作只讀它；牌桌在自己的 `TableObject` 時才有 |
| `table:<id>` | 只在牌桌留在社團的物件時（H1a、測試、`TABLE_OBJECTS=off`）：座位、觀看者、目前這副、聊天、撤回請求；它顯示的社員名字（`names`）、各人的封鎖名單（`blocks`，聊天用）、還沒交給社團的牌局紀錄（`outbox`）；挑戰桌的 `modeState` 帶挑戰的快照（§5.10）。由 `TableService` 讀寫。每桌一個物件時同樣的內容在那個物件的 `table`（另有 `closed`：這一桌關了；`frozen`：已交回社團，等 `release`） |
| `board:<id>` | 一副牌的完整紀錄（原始四手牌、叫牌、出牌、結果） |
| `hist:<時間>-<id>` | 全社團的紀錄索引（摘要，補零的時間讓列表依時間排序） |
| `uhist:<userId>:<時間>-<id>` | 每位社員自己的紀錄索引 |
| `featured:<boardId>` | 精選牌局（§5.9）：標題、分類、講解、逐墩講解、誰先設的與時間、那副牌設精選時的摘要（`BoardSummary`）；帳號刪除時保留，設的人顯示「—」 |
| `practicePresets:<userId>` | 社員存的練習設定（`e10-t16`，§5.11）：`SavedPractice[]`（id、名稱、設定、時間），新的在前，最多 20 組；帳號刪除時一起刪 |
| `notif:<userId>:<時間>-<id>` | 通知（`worker/notifications.ts`）：種類、參數、時間、是否已讀；每人只留最新 500 則，帳號刪除時一起刪 |
| `push:<userId>` | PWA 推播（`e1-t28`，`worker/push.ts`）：每台裝置的訂閱（推播服務的網址、`p256dh`、`auth`、語言、裝置名稱、開啟時間；最多 10 台）與改過的推播種類（只存跟預設不同的）；被登出所有裝置時清掉裝置、帳號刪除時整筆刪；不在備份裡 |
| `friend:<userId>:<friendId>` | 社員關注的好友（單向），值是 `{ at }`；載入時全部讀進記憶體 |
| `block:<userId>:<otherId>` | 社員封鎖的對象，值是 `{ at }`；載入時全部讀進記憶體 |
| SQL `challenges`、`challenge_players`、`challenge_results` | 挑戰的正本（不是索引），見 §5.5；`EVENT_OBJECTS=on` 時，住在自己 `EventObject` 的挑戰正本在那個物件，這裡是社團的副本（§5.12 H2b） |
| SQL `event_homes` | 哪些挑戰住在自己的 `EventObject`，與社團寫進副本的最後一個變更編號（`rev`，-1＝物件還沒確認收下）；沒有這一列的挑戰住在社團（§5.12 H2b） |
| SQL `challenge_settled` | 社團對每場挑戰已經做過的事：結束（收桌、公開牌、通知結果）、提醒；H2b 建表時把已經結束或已提醒的挑戰都標成做過 |
| `meta:events` | 挑戰住哪裡的版本：1＝社團、2＝每場開著的挑戰都在自己的 `EventObject`（§5.12 H2b）；沒開過開關就沒有這個 key |
| SQL `matches`、`match_seats`、`match_boards` | 隊制賽的正本（不是索引），見 §5.8；`EVENT_OBJECTS=on` 時，住在自己 `EventObject` 的隊制賽正本在那個物件，這裡是社團的副本（§5.12 H2c） |
| SQL `match_chat`、`match_watchers` | Vugraph 的觀眾聊天與看過的人（§5.8）：只在社團，不是比賽狀態，不搬進比賽的物件 |
| SQL `match_homes` | 哪些隊制賽住在自己的 `EventObject`，與社團寫進副本的最後一個變更編號（`rev`，-1＝物件還沒確認收下）；沒有這一列的住在社團（§5.12 H2c） |
| SQL `match_settled` | 社團是否已經收尾一場結束的隊制賽（通知完賽、告訴牌桌、公開所有牌）；H2c 建表時把已經結束（完賽、放棄、取消）的比賽都標成做過 |
| `meta:matches` | 隊制賽住哪裡的版本：1＝社團、2＝每場開著的隊制賽都在自己的 `EventObject`（§5.12 H2c）；沒開過開關就沒有這個 key |
| SQL `direct_messages`、`direct_threads` | 私訊的正本，見 §5.7 |
| SQL `forum_boards`、`forum_posts`、`forum_comments`、`forum_reactions`、`forum_reports` | 淡江橋館討論區的正本（`worker/forum.ts`，橋館 E11），見 §5.7 後的「論壇 Worker」 |
| SQL `book_errors`、`book_metrics`、`book_visitors`、`book_telemetry_settings` | 淡江橋館的錯誤回報與匿名使用統計（`worker/book-telemetry.ts`，橋館 e10-t06、e10-t07），見 §5.15；不在每日備份裡 |
| `meta:settings` | 管理員改過的人數上限與邀請碼（沒改過就用環境變數） |
| `meta:weekly` | 每週社團挑戰的排程、誰存的、上一場的時間與 id（`worker/weekly-challenge.ts`，§5.5） |
| `meta:daily` | 每日賽的設定、誰存的、上一場的 00:00、每一天的挑戰 id（`worker/daily-event.ts`，§5.18） |
| `tourn:<id>` | 一場比賽公告：設定、狀態、報名名單（每組的人與確認了沒有）、建立的比賽 id、提醒過的開賽時間（`worker/tournaments.ts`，§5.24） |
| `teamev:<id>` | 一場多隊賽：設定、賽制與輪數、隊伍與下一輪的出賽名單、每一輪的配對（比賽 id）與輪空、狀態（`worker/team-events.ts`，§5.26） |
| `meta:points` | 社團積分規則與賽季（`PointsRules`，`worker/rankings.ts`，§5.21）；帳本與 rating 在 SQLite 的 `ranked_events`、`points_entries`、`points_adjustments`、`ratings`、`rating_history` |
| `meta:schema` | 資料版本（現在是 4）：1→2 把舊版 `board:<時間>-<id>` 搬到新索引；2→3 把所有 `board:` 回填進 SQL 紀錄索引（§5.3）；3→4 把每個 `table:` 搬進自己的 `TableObject`、改存 `tabledir:`（§5.10）；`TABLE_OBJECTS=off` 時搬回來、回到 3 |
| `replq:<boardId>` | 還沒複製到 D1 的牌局（outbox，§5.12）：值是排進來的時間＋序號，寫進 D1 後刪掉（期間又被改的留著） |
| `meta:replica` | D1 副本的狀態（§5.12）：`off`／`filling`（做到哪一個 `board:` key）／`ready`，與填它時的 `REPLICA_VERSION` |
| D1 `boards_index`、`board_players`、`board_summaries`、`index_meta` | 不在 Durable Object 裡：紀錄索引在 D1 的副本，加上每副的摘要與 `ready`（§5.12）；每列帶 `club_id`（§1「多社團的隔離」）；可以隨時從 `board:` 重建 |
| `meta:backfill` | 回填 SQL 索引時做到哪一個 `board:` key；做完就刪掉，物件中途被回收時從這裡接著做 |
| `book:entry:<slug>` | 淡江橋譜線上修改的特約（版本、誰在何時改；`convention: null` 表示隱藏），內容在 `bookpart:` |
| `book:rev:<slug>:<時間>-<id>` | 每次發布、隱藏、還原的版本紀錄 |
| `book:wip:<slug>` | 特約的草稿（橋館 e8-t02，每個特約一份、編輯者共用；`draft`／`in-review`），內容在 `bookpart:`；讀者拿不到 |
| `bookfollow:<slug>:<userId>` | 社員關注的特約（橋館 e8-t10，值是 `true`）：發布時收到 `bookPublished` 通知（`worker/book-notices.ts`）；在每日備份的 `book*` 裡 |
| `audit:<時間>-<id>` | 審計紀錄（橋館 e8-t09，`worker/audit.ts`）：誰、動作、對象、版本；不刪 |
| `book:builtin:<slug>` | 橋館的內建特約（L0，2026-10-29 起）：`{ slug, parts, meta }`，`meta` 是 manifest 用的 `ConventionMeta`，內容在 `bookpart:`。**內容不在這個 repo**：由橋館（private repo）的 `scripts/seed-builtin.ts` 寫入（`PUT /api/book/builtin`） |
| `book:builtinInfo` | 內建特約的版本號、目錄順序（`slugs`）、搜尋索引的分段數、最後一次寫入的人與時間 |
| `book:builtinIndex` | 只有分段（`bookpart:book:builtinIndex:<n>`）：橋館建好的內建特約搜尋索引，原樣保存 |
| `book:category:<id>` | 淡江橋譜線上編輯過的分類（`{ id, label, description, order }`）；沒有任何一筆時橋譜用它內建的分類 |
| `book:categoryInfo` | 分類的版本號（`baseVersion` 用）與最後修改的人、時間 |
| `book:profile:<id>` | 淡江橋譜的制度集（`ProfileSummary` 加上內容的分段數；`adopted`、`overrides`、`notes` 在 `bookpart:`）；`club` 沒存過時視為空的、版本 0 |
| `book:profilerev:<id>:<版本，8 位數>` | 制度集每次儲存的完整內容（在 `bookpart:`）；刪掉制度集時一起刪 |
| `book:cardsnap:<制度集 id>:<版型>:<n，6 位數>` | 橋館的制度卡版本（e3-t09）：`CardSnapshotMeta` 加分段數；填好的卡（橋館的 `FilledCard`，原樣保存）在 `bookpart:<key>`，Word 檔（base64）在 `bookpart:<key>#docx`；刪掉制度集時一起刪 |
| `team:<id>` | 淡江橋譜的隊伍（`ClubTeam`：名稱、隊長、隊員、制度集 id、封存） |
| `pair:<id>` | 淡江橋譜的搭檔（`Partnership`：兩人 `[邀請者, 受邀者]`、所屬隊伍、制度集 id（接受前是空字串）、狀態 `pending`／`active`／`ended`）；婉拒或收回的邀請直接刪掉 |
| `userteam:<userId>:<teamId>`、`userpair:<userId>:<pairId>` | 某人在哪些隊伍、有哪些搭檔（值是 `true`） |
| `book:quizfix:<題目 id>` | 淡江橋館幹部的修題（橋館 e6-t06，`worker/quiz.ts`）：自動題的停用、改答案或選項（附修正時的原文 `basis`），或手動出的題；誰、何時 |
| `quizlog:<userId>:<時間>-<id>` | 社員在淡江橋館練習的成績（橋館 e6-t04）：每次練習的制度集與每題對錯，每人最新 100 次；帳號刪除時一起刪，不在每日備份裡 |
| `book:path:<路徑 id>` | 淡江橋館幹部改過的學習路徑（橋館 e4-t08、e4-t12，`worker/learning.ts`、`shared/learning.ts`）：課次、每課讀哪些特約或段落、題目、檢核清單；誰、何時。刪掉就回到橋館內建的路徑 |
| `pathprogress:<userId>:<路徑 id>` | 社員在淡江橋館學習路徑完成的課次（橋館 e4-t11）；沒有完成的課就不存；帳號刪除時一起刪，不在每日備份裡 |
| `reading:<userId>` | 社員在淡江橋館文章與電子書讀到哪裡（`ReadingPlace[]`，新的在前，最多 30 筆；橋館 e5-t14）；帳號刪除時一起刪，不在每日備份裡 |
| `book:draft:<時間>-<id>` | AI 匯入產生的草稿（只留最新 30 份） |
| `book:ticket:<token>` | 匯入上傳用的一次性憑證（10 分鐘） |
| `book:version` | 橋譜線上內容的版本號，`GET /api/book/content` 與 `/api/book/manifest` 的 ETag；分類改了也會加一 |
| `article:entry:<slug>` | 淡江橋館叢書的文章（橋館 e5-t04，`worker/articles.ts`）：版本、誰在何時發布；`article: null` 表示隱藏；內容在 `bookpart:article:entry:<slug>:<n>` |
| `ebook:<id>` | 淡江橋館叢書的電子書（橋館 e5-t09，`worker/ebooks.ts`，§5.14）：書名、作者、系列、年代、授權、PDF 的檔案 key（`ebook/<hex>.pdf`）、封面（圖片 key）、大小、誰上傳與修改。在每日備份裡；PDF 本身只在 R2 |
| `file:usage` | 上傳檔案（圖片＋PDF）在 R2 用了多少位元組、是否已通知管理員快滿了（橋館 e5-t15，§5.14）；不在備份裡，不見了就從 `file:meta:` 重算 |
| `article:rev:<slug>:<時間>-<id>` | 文章每次發布、隱藏的版本紀錄（內容在 `bookpart:`） |
| `article:wip:<slug>` | 文章的草稿（橋館 e5-t07，一篇一份，同特約的 `book:wip:`）：狀態（草稿／送審中）、從哪一版開始、第幾次存、退回的原因；內容在 `bookpart:article:wip:<slug>:<n>`。送審通知審核者（`articleReviewRequested`），退回、發布通知送審的人（`articleReturned`、`articlePublished`；橋館 J4，`worker/book-notices.ts`，點了開橋館的文章編輯頁或文章） |
| `article:version` | 文章的版本號，每次發布或隱藏加一 |
| `article:series` | 叢書的系列（橋館 e5-t06）：`{ version, series: ArticleSeries[], updatedAt, updatedBy }`；沒有時橋館用內建系列 |
| `bookpart:<key>:<n>` | 大內容的分段（Durable Object 單筆值上限 128 KiB，以 4 萬字一段儲存） |

**備份**（`worker/backup.ts`，淡江橋譜 e10-t08、e11-t12）：cron trigger（每天台灣 03:00）呼叫 `Club.backup()`，把 `BACKUP_PREFIXES` 開頭的 key 匯出成一份 JSON Lines 存到 R2 bucket `tku-bridge-backups`（binding `BACKUPS`）的 `daily/<台灣日期>.jsonl`（淡江；其他社團在 `clubs/<id>/daily/…`，各自列表、各自保留，§1「多社團的隔離」），保留 30 天；`GET/POST /api/admin/backups`、`POST /api/admin/backups/restore`（預設預演，真的還原要 `confirm`）。範圍：淡江橋譜的 `book*`、`profile*`、`article*`、`team:`、`pair:`、`userteam:`、`userpair:`，加上帳號 `user:`、`app:`、`avatar:`（同一次匯出，頭像版本與圖片一定對得上），以及好友與封鎖 `friend:`、`block:`（2026-11-04 起；還原時只寫回兩邊都是備份裡帳號的關係）；加上討論區的五張 SQL 表（`BACKUP_TABLES`：`forum_boards`、`forum_posts`、`forum_comments`、`forum_reactions`、`forum_reports`，2026-10-30 起，格式第 3 版：key 之後每列一行 `{"t":表,"r":列}`，有 rowid 的表照 rowid 順序寫、照順序寫回）；`session:`、`meta:settings`、私訊、牌局紀錄與紀錄索引的 SQL 表、橋館錯誤回報與使用統計的 `book_*` 表（§5.15）不在裡面，還原也不動它們。討論區的圖片本來就在 R2，備份只有它們的 `file:meta:`。格式第 2 版把位元組寫成 `{"$bytes":"<base64>"}`（`encodeValue`／`decodeValue`），第 1 版（只有橋譜）照樣讀、只還原它自己的 `prefixes`；第 1、2 版沒有表，還原時不動討論區。還原表時先檢查每張表與每個欄位現在都有（欄位名稱只用資料庫自己的），再在一個 transaction 裡清空、寫回；之後 `Club` 再跑一次 `ForumService.createTables()`（補內建看板與搜尋用的 `body_text`）。還原後 `Club` 換一個新的 `BookService`（與 `ArticleService`），記憶體裡的快取不會留下；有帳號時再呼叫 `ClubService.reloadAccounts()`：重讀帳號與申請、重讀好友與封鎖（`Relations.reload`，不是社員的一併刪掉）、備份之後才有的帳號照刪除帳號的方式清掉、刪掉全部 `session:`、斷開所有連線，大家重新登入。步驟見 DEPLOY.md §4.4。

每個動作處理完立即寫回，物件隨時被回收都不會遺失牌局。紀錄列表一次只讀到那一頁為止（每頁 10／20／50／100 筆摘要）。

**容量**：免費方案每個帳號 5 GB；一副牌的紀錄連同兩筆索引約 4 KB，大約可存一百萬副以上。

### 5.6 可觀測性與輸入防護（`e11-t08`～`e11-t11`）

- **結構化日誌**（`worker/log.ts`）：每個事件一行 JSON，Workers Logs（`wrangler.jsonc` 的 `observability`）依欄位索引。`action`：WebSocket 動作的種類、userId、耗時（ms，含廣播）、失敗時的錯誤代碼；`rejected`：沒進到處理函式的訊息（格式、大小、速率）；`http`：每個請求的方法、路徑（不含 query）、狀態、耗時、錯誤代碼；`loginLocked`；`clientError`；`crash`（不是 `ClubError`／`GameError` 的例外，層級 error）；`replica`：D1 副本某一步失敗或填完（§5.12）；`edge`：Worker 從 D1 回答的紀錄頁（耗時），或為什麼交給社團（`fallback`）。**不記密碼、token、cookie、聊天內容。** `ClubService` 只拿到 `ClubConfig.log` 這個函式，不碰 Cloudflare API；測試傳陣列收集
- **健康檢查** `GET /api/health`（不需登入）：`{ ok, now, tables, online, events?, playing, robots, metrics, alerts }`（型別 `HealthStatus`，`shared/protocol.ts`），只有數量；回得來表示 Worker 與 Durable Object 都載入了。`metrics` 與 `alerts` 是最近一小時的指標與告警（§5.13）
- **前端錯誤回報**（`src/lib/errorReport.ts`）：`window` 的 `error` 與 `unhandledrejection` → `POST /api/client-errors`（`sendBeacon`，不需登入）。瀏覽器送之前去除個資（`shared/scrub.ts`：URL 的 query 與 fragment、e-mail、6 位以上的數字；只送路徑不送網址參數；不帶 userId），同一個錯誤只送一次、每頁最多 5 則、取樣比例 `REPORT_SAMPLE_RATE`（社團小，目前 100%）。伺服器（`worker/client-errors.ts`）只留已知欄位、截斷長度、再去除一次個資，全社團每秒最多約 1 則（突發 20 則）寫進日誌，不存資料庫。淡江橋館的錯誤回報另走 `POST /api/book/errors`，會存最新 100 列給編輯者看（§5.15）
- **訊息驗證**（`shared/message-guard.ts` 的 `parseClientMessage`）：WebSocket 訊息在 `ClubService.handleRaw` 入口檢查：最多 `MESSAGE_MAX_CHARS`（8,192 字元，二進位訊息只解碼到超過上限為止）、是 JSON 物件、`type` 是 1–40 個英文字母、已知種類的欄位型別對（型別守衛）。不合法就回 `error`（`messageTooLarge`／`badMessage`），不會進到處理函式。**沒有列在守衛裡的新種類只做形狀檢查**，所以新動作不必先改守衛；值的檢查（座位、範圍、權限）仍在各處理函式。HTTP 的 JSON 本文上限 2 MiB，超過回 413 `messageTooLarge`。**所有本文都邊讀邊算**（`worker/body.ts`，`e11-t32`）：`Content-Length` 超過就不讀，沒有或說謊的（chunked）讀到超過的那一塊就停；頭像、圖片、錯誤回報、AI 匯入的表單（PDF 上限＋1 MB）都一樣
- **速率限制**（`worker/rate-limit.ts`，記在記憶體，物件被回收就重算）：每位社員（所有分頁合計）的訊息 token bucket，突發 30、每秒 10（重連時補送的動作要過得去），超過回 `slowDown` 並丟掉；聊天另外突發 5、每 2 秒 1 句，超過回 `chatTooFast`；私訊另外突發 10、每分鐘 20 則，超過回 `directTooFast`；密碼錯誤以「來源 IP（`CF-Connecting-IP`）＋帳號」計 5 次、單一 IP 計 20 次，15 分鐘內再登入回 429 `tooManyLogins`（連密碼對了也一樣），密碼對了就清掉該帳號的次數。不鎖整個帳號，避免陌生人從別處把社員鎖在外面。速率只在 socket 入口（`handleRaw`）檢查，`handle` 本身不限，測試與機器人照常。**桌的連線**（§5.10）在 `TableHost.message` 做同樣的大小與型別檢查，只收牌桌動作（其他回 `unknownCommand`），動作與聊天的 bucket 另外算（每個 `TableObject` 自己記；所以同一人在社團與桌上的額度是分開的）

### 5.7 私訊（`e1-t25`～`e1-t27`）

- **儲存**（`worker/direct-messages.ts`，Durable Object 的 SQLite，不經記憶體快取）：`direct_messages`（`id` 整數遞增、`pair`＝兩人 id 排序後以 `:` 相連、寄件者、收件者、內文、時間），每一對只留最新 `DIRECT_KEPT` 1,000 則；`direct_threads` 每人每個對話一列（對方、最新一則的 id、讀到哪一則），對話列表與未讀數各一個查詢。帳號刪除時他的訊息與雙方的對話列一起刪，對方收到新的 `directs`
- **送出**：`sendDirect { to, text }`。伺服器去頭尾空白（空的就忽略）；不能給自己（`notSelf`）、機器人或不存在的帳號（`userGone`）；最多 `LIMITS.directMax` 500 字（`directTooLong`）；自己封鎖對方要先解除（`unblockToMessage`），被對方封鎖回 `cannotMessage`；每位社員突發 10、每分鐘 20 則（`directTooFast`，只在 socket 入口）。存好後把 `direct` 送給兩人在線的分頁，再各送一次 `directs`
- **讀取**：連線時送 `directs`（最新 50 個對話，每個帶對方、最新一則與未讀數，另有全部未讀數）；`GET /api/messages/:userId?before=<id>` 從最新往回一頁 30 則（舊的在前，`more` 表示還有更早的）。打開對話就送 `readDirect { userId }`，把對方寄來的都標為已讀
- **介面**：側欄（大廳、牌桌）的「訊息」分頁（`DirectMessages`）：對話列表與單一對話，分頁按鈕上有未讀數；社員分頁每一列的信封直接開啟與他的對話（個人檔案卡做好後也從那裡開）。私訊不另外進通知中心，未讀數就在「訊息」分頁上
- **好友上線提示**（`e1-t24`）：只給有 `friends` 旗標的社員。某位社員第一個分頁連上時，關注他、沒關掉提示、也沒被他封鎖的社員：**在線**的由通知中心送 `friendOnline`；不在線的不留通知（回來時看到「某某上線了」已經過時），只在他在推播設定開了「好友上線」（預設關，`PUSH_OFF_BY_DEFAULT`）時推播一則（一小時後失效）；同一個人 30 分鐘（`FRIEND_ONLINE_QUIET_MS`）內只提示一次，手機斷線重連不會一直跳。開關在「我的帳號」，存在伺服器的 `user:<id>`（`POST /api/account/preferences`）

### 5.9 精選牌局（`e4-t28`～`e4-t31`）

- **權限**：`boardCurate`（§5.2 的 `permissions`），管理員在管理頁開給社員；管理員本來就有。
- **資料**（`shared/featured.ts`、`worker/featured.ts` 的 `FeaturedService`，`ClubService.featured`）：一副牌最多一筆精選，存在 `featured:<boardId>`：標題（≤ 60 字）、分類（`bidding` 叫牌、`declarer` 坐莊、`defence` 防守、`other` 其他）、講解（≤ 4000 字）、逐墩講解（第 1–13 墩各 ≤ 1000 字，空的不存）、第一次設精選的人與時間、最後編輯時間，以及那副牌的摘要（列表不必讀紀錄）。輸入由 `parseFeaturedInput` 檢查，錯誤 `badFeatured { field }`。全部精選在第一次用到時讀進記憶體。
- **規則**：只有公開的牌才能設（§4）；別的策展人可以編輯或取消，編輯保留原本設的人；第一次設精選時通知打那副的社員（`boardFeatured`，§5.4）。寫入算一次動作（速率限制，§5.6）。
- **介面**：頁首「精選牌局」→ `/featured`（`FeaturedPage`）：「全部」與四個分類的分頁、卡片（標題、合約與結果、分類、桌號與牌號、誰精選與日期），點了到 `/history/:id`。單副紀錄頁的 `FeaturedPanel`：標題、分類、講解；重播到第 N 墩時顯示那一墩的講解（`useTrickReplay` 的 `trick`），另有「第 N 墩」按鈕直接跳過去；有 `boardCurate` 的人在這裡設為精選、編輯（每一墩一個欄位）、取消。牌桌裡的紀錄對話框不顯示。

## 5.10 拆分 Durable Object：每桌一個 `TableObject`（決策紀錄，`e11-t16`，2026-10-25）

社長要先找一小群人做「很多人、很多桌同時打」的測試（H1–H3），所以先把牌桌從社團的物件拆出來。這一節是 H1 的設計；H2（`EventObject`、邊緣 session、紀錄索引搬 D1）照這裡的做法延伸，決策在 §5.12。

**為什麼要拆**：現在整個社團是一個 Durable Object（§1），所有事情依序處理。社團小的時候這是優點，桌數多了就是瓶頸：
- 一個物件同時只跑一件事。一桌三個機器人每秒出好幾張牌，每一張都要排在別桌的叫牌、大廳、私訊後面。
- 排程器（§5「排程」）在同一次 alarm 裡把**所有到期的工作**並排跑完：30 桌的機器人同時到期，就是一次喚醒裡跑 30 次機器人思考。免費方案每次呼叫的 CPU 很少（CLAUDE.md「已知陷阱」），一次跑太多會被中止，而且一桌出錯會拖到別桌。
- 廣播每次都替每位在線的人算一次大廳**和**他的牌桌；牌桌畫面（`boardView`）是最貴的那一份。

**拆成什麼**（全台灣規模的完整版是 E11 的 `Directory`／`Table`／`Event` 三種；H1 只拆 `Table`）：

| 物件 | 幾個 | 負責 | 程式 |
| --- | --- | --- | --- |
| `Club`（就是 `Directory`，類別名稱不改，免得 Durable Object 要搬資料） | 一個 | 帳號、申請、session、好友與封鎖、通知、私訊、大廳（**牌桌目錄**）、紀錄與索引、收藏、精選、挑戰與每週挑戰、隊制賽、淡江橋譜 | `worker/club.ts`、`ClubService`（`worker/service.ts`） |
| `TableObject` | 每桌一個（`idFromName(<桌 id>)`；淡江以外的社團是 `<社團>/<桌 id>`，§1） | 這一桌的一切：座位與觀看者、叫牌出牌與撤回攤牌、機器人、自動發牌、時間上限與太久提醒、斷線代打、聊天、這桌最近 30 副、每位觀看者的牌桌畫面與「只送有變的」、這一桌的 WebSocket | `worker/table-object.ts`、`TableService`（`worker/table-service.ts`） |
| `EventObject`（H2b、H2c，`e11-t18`） | 每場挑戰一個（`idFromName('challenge:<id>')`）、每場隊制賽一個（`idFromName('match:<id>')`），淡江以外的社團前面加 `<社團>/`（§1），`EVENT_OBJECTS=on` 才用 | 挑戰的狀態、期限工作與結算；隊制賽的狀態與結算（每室的結果、最後一副結束比賽） | `worker/event-object.ts`、`EventHost`、`ChallengeEvent`、`MatchEvent`（§5.12「H2b」「H2c」） |

**誰負責什麼規則**：跨桌的規則留在 `Club`，因為只有它知道每個人在哪裡：一人同時只在一桌、開桌與桌號、加入與入座前的封鎖與受邀檢查（`checkWelcome`）、快速入座、受邀名單的檢查與通知、開始／繼續挑戰。只跟一桌有關的規則在 `TableService`：座位有沒有人、這一副打到一半不能換座位、房主才能做的事、所有叫牌出牌（`shared/game.ts`）、機器人（只看自己的 `View`，§5.1）、可見性（仍然只在 `worker/views.ts`，§4）。`Club` 先用目錄做一次檢查（錯誤和現在一樣，在離開舊桌**之前**丟），`TableService` 再用自己的狀態做最後的檢查，兩邊的錯誤代碼相同。

**兩者怎麼溝通**：Durable Object 的 JS RPC（stub 上直接呼叫方法；相容日期 2026-09-01 已支援）。方法只收、只回結構化可複製的資料。
- `Club` → 桌（`TableApi`，`worker/tables.ts`）：`open`（開桌或搬進來）、`join`（觀看）、`sit`、`leave`、`configure`（房主改設定與受邀名單）、`request`（申請加入，帶 `muted`）、`answerRequest`（房主同意或拒絕）、`resume`（回到停著的挑戰桌）、`reclaim`（斷線代打的人回來）、`presence`（社團連線的上下線）、`blocked`（某人的封鎖名單變了，聊天跟著變）、`forget`（帳號刪除）、`challengeEnded`、`matchEnded`（隊制賽結束，F4；中止時收起正在打的那一副）、`matchUpdate`（比賽中房主的改動：參賽者名單、替補、代打、裁定、暫停／繼續，F5）、`close`（管理員關桌、挑戰收桌）、`act`（舊的瀏覽器或桌的連線還沒接上時，從社團的連線轉過來的牌桌動作）。都回傳這一桌最新的目錄資料（`TableEntry`），桌子關了是 `null`。
- 桌 → `Club`（`ClubLink`）：`changed(entry)`（大廳看得到的東西變了）、`closed(id)`、`boardFinished(record, event)`（一副打完：`Club` 寫 `board:`、`hist:`、`uhist:`、SQL 索引；挑戰的話寫 `challenge_results` 並檢查挑戰是否結束）。
- **錯誤**：RPC 只保留錯誤訊息、不保留類別，所以 `TableObject` 把 `ClubError`／`GameError` 包成 `{ error: { code, params, status } }` 回傳，`Club` 那一側還原成 `ClubError`。瀏覽器看到的錯誤代碼不變。
- 桌子需要知道的社員資料**跟著動作傳過去**，不回頭問 `Club`：坐下或觀看的人的名字與他封鎖的人（`Person`）、受邀者的名字；挑戰桌開桌時帶挑戰的快照（截止時間、牌組每一副的牌號與 Just Declare 的叫牌、已經打完哪幾副、機器人的制度）。存在 `Table.names`、`Table.blocks`、`ChallengeTableState`，只有伺服器看得到。
- **測試**：`ClubService` 與 `TableService` 都不碰 Cloudflare API。正式環境用 `DurableTables`（stub），測試與 H1a 用 `LocalTables`（同一個程序裡的 `TableService`，共用測試的 `FakeConnections` 與手動排程佇列），所以 `tests/worker` 照樣在 Node 裡跑、照樣用 `runRobots`。

**大廳怎麼知道每桌的狀態**：`Club` 在記憶體裡有一份**牌桌目錄**（`TableEntry`：桌號、房主、模式、設定、受邀名單、同意的名單與等待中的申請、座位、觀看者、代打、打了幾副、桌上的牌號、這一副是否進行中、挑戰桌屬於誰），大廳、成員列表的「在哪一桌」、快速入座、受邀檢查都只讀目錄。桌子在**大廳看得到的欄位變了**才回報（入座、離座、發新一副、打完一副、改設定），出一張牌、叫一個品不回報，所以 `Club` 不會被每張牌喚醒。每份回報帶遞增的 `rev`（`max(上一個＋1, 現在的毫秒)`，物件被回收後也不會變小），晚到的舊回報直接丟掉。`Club` 把目錄存在 `tabledir:<id>`，物件被回收後不必叫醒每一桌就能列出大廳。

**WebSocket 怎麼走**：
- `/ws` → `Club`：大廳、通知、私訊、隊制賽，以及會跨桌的動作（`createTable`、`joinTable`、`sit`、`leaveTable`、`quickSeat`、`updateTableSettings`、`playChallenge`）。
- `/ws/table/<id>` → `TableObject`：Worker 先用 cookie 問 `Club` 這是誰（`userForToken`，每次連線一次，不是每則訊息），再把請求加上 `X-TBT-User` 轉給那一桌；Durable Object 不能從外部直接連，所以這個標頭只有 Worker 給得了。桌子只接受在桌上的人（入座、觀看、停著的挑戰桌的主人），否則用 4004 關掉。牌桌的動作（叫牌、出牌、攤牌、撤回、聊天、站起、房主的請離座與機器人）走這條，桌子直接推 `table` 給在桌上的人。
- 瀏覽器（`ClubContext`）看大廳的 `myTableId` 決定要不要開第二條連線、連哪一桌；換桌就關掉舊的開新的。桌的連線還沒接上時，牌桌動作先從 `/ws` 送，`Club` 轉給那一桌（`act`），所以部署當下還開著的舊頁面也能繼續打。
- **上線**：桌上的「在線」看的是**桌的連線**。桌的最後一條連線關掉：觀看者離開、房主交給在線的人、入座者開始算斷線代打（同現在，只是改由那一桌自己判斷）。

**Hibernation**：兩種物件都用 hibernation API 與 `setWebSocketAutoResponse('ping','pong')`；連線的 attachment 記社員 id。沒有人在打的桌子整個睡著不花錢；只剩機器人的桌子（真人都走了）會關掉，和現在一樣。

**排程：每桌自己的 alarm**：每個 `TableObject` 有自己的 `AlarmQueue`（`robot:<桌>`、`deal:<桌>`、`substitute:<桌>:<社員>`），用自己唯一的 storage alarm，所以一次喚醒只跑**這一桌**到期的工作。`Club` 的佇列只剩挑戰（`challenge:<id>`）與每週挑戰（`weekly:…`）。工作照樣不存：`TableObject` 載入時依自己的狀態重排。

**搬移舊資料**（`meta:schema` 3 → 4）：部署後 `Club` 第一次載入時，把每個 `table:<id>` 補上新欄位（名字、封鎖名單、挑戰快照；挑戰已經不在的桌子標成已結束），呼叫那一桌的 `open`，成功後寫 `tabledir:<id>`、刪掉 `table:<id>`；全部搬完才把 `meta:schema` 寫成 4。中途失敗的桌子留在 `table:`，下次載入再搬（`open` 重做一次沒有影響）。部署會換掉 Durable Object 的程式，所有連線本來就會斷，瀏覽器自動重連（§5「心跳」）。`wrangler.jsonc` 加一個 binding 與 migration `v2`（`new_sqlite_classes: ["TableObject"]`，免費方案只能用 SQLite 後端），見 `DEPLOY.md`。

**失敗時**：
- **桌子的 RPC 失敗**（物件重啟、網路）：`Club` 回 `serverError`，目錄不變，使用者重試即可；`open` 失敗的新桌不寫目錄。
- **回報掉了**（`changed` 沒送到）：目錄會暫時是舊的；`Club` 每次呼叫那一桌都拿回最新的 `TableEntry` 蓋過去，桌子每次回報也帶完整的一份，下一次就修正。目錄說某人在 A 桌、A 桌卻說不在時，以桌子的回答為準（`leave` 回傳的 entry）。
- **一副打完時 `Club` 沒收到**（`boardFinished` 失敗）：桌子把紀錄放進自己的 `outbox:`，下一次 alarm 重送，`Club` 用牌局 id 判斷重複（SQL 索引本來就可以重寫；`challenge_results` 改成重複就略過）。所以一副牌最多晚一點進紀錄，不會不見或算兩次。
- **同一人同時兩個動作**（兩個分頁）：`Club` 對跨桌動作依社員排隊（同一人一次一個），避免在等 A 桌回覆時又坐進 B 桌。
- **挑戰已經結束、`challengeEnded` 沒送到**：桌子自己也看截止時間，過了就不再發牌、不收動作；`Club` 收到結果時再用挑戰的實際狀態檢查一次，不算數就不寫。
- **使用者連到不在的桌子**：`TableObject` 沒有狀態就回 404，不建任何資料。

**CPU 與費用（免費方案）**：每次呼叫的 CPU 上限沒變，但現在一次呼叫只做一桌的事：一個機器人動作、一則動作加這一桌四到八個人的畫面。`Club` 只在大廳看得到的事情變了才被叫醒，而且不再算牌桌畫面。請求數會多一點：每副多兩三個跨物件 RPC（打完一副的紀錄、目錄回報），以一副約 50–60 個機器人動作（每個一次 alarm）來說多不到一成。實際數字在 `e11-t21` 的負載測試（200 人、30 桌）量。

**隊制賽（F4）會怎麼用這個結構**：一場比賽的開室與閉室是**兩個獨立的 `TableObject`**（模式 `team`，`modeState` 記比賽 id、房間、`seq`，開桌時帶比賽的快照：共用的 `DealSet`、座位、截止或時間上限），兩桌各自推進、各自排程，一桌的機器人不會拖慢另一桌。開始比賽時 `Club`（H2 之後是那場比賽的 `EventObject`）用 `Promise.all` 同時 `open` 兩桌，其中一桌失敗就把另一桌也 `close`、比賽留在 `setup`。每副打完由那一桌 `boardFinished(record, { kind: 'team', matchId, room, seq })` 回報，比分只在 `Club` 用兩室都完成的副計算（§5.8），所以快的一桌看不到慢的一桌的結果。房間隔離靠桌的連線：參賽者只能連自己那一桌（`TableObject` 只接受在桌上的人），觀看者兩桌都能觀看（各開一條桌的連線，或之後的 Vugraph 頁）。比賽層的代打、替補走 `TableApi` 新增的方法，不讓桌子直接改比賽的資料。

**拆成兩個 PR**（ROADMAP 規則 2）：
- **H1a**（`e11-t16`）：這份決策紀錄；`TableService` 從 `ClubService` 抽出來，`Club` 只透過 `TableApi`／`ClubLink` 與牌桌溝通、只讀牌桌目錄；全部仍在同一個物件裡（`LocalTables`），`table:<id>` 照舊，行為不變，不必改部署。
- **H1b**（`e11-t17`，已實作）：`TableObject`、`DurableTables`（實作叫 `RemoteTables`）、`/ws/table/<id>`、瀏覽器的第二條連線、搬移舊資料、`wrangler.jsonc` 的 migration、`DEPLOY.md`。

**H1a 的實作**（2026-10-25）：
- `worker/tables.ts`（`TableEntry`、`Person`、`TableApi`、`ClubLink`）、`worker/table-service.ts`（`TableService`、`LocalTables`）。`ClubService.tables` 是 `LocalTables`：每桌一個 `TableService`，共用社團的儲存（仍是 `table:<id>`）、連線與排程器。`ClubService` 不再讀 `Table`，只讀目錄；`lobbyView`、`health().tables` 都從目錄算。
- 挑戰模式的三個掛勾只讀桌上的快照（`worker/modes.ts` 的 `challengeSnapshot`、`nextTableSeq`、`challengeTableOpen`）；`boardFinished` 回傳要寫給挑戰的結果（`EventReport`），由社團用挑戰的實際狀態再檢查一次後寫進 `challenge_results`（同一副第二次直接略過）。`started_at` 改在社團開挑戰桌時寫（開桌就發第一副，時間相同）。
- 一副打完先放進 `Table.outbox`、跟著牌桌存好，再交給社團（`ClubLink.boardFinished`）。社團寫紀錄失敗時，這個動作不再回錯誤：牌桌照常往下打，30 秒後由 `outbox:<桌>` 工作重送（`tests/worker/service.test.ts` 的「never keeps half a board」改成驗證不會只存一半、恢復後重送成功）。
- 社團載入時把舊的 `table:` 補上名字、封鎖名單與挑戰快照（`upgradeTable`，挑戰已經不在的標成已結束），有變才寫回（`tests/worker/challenge-table.test.ts`）。
- 代打的排程 key 改成 `substitute:<桌>:<社員>`，換桌後舊桌的工作不會擋住新桌。
- 一個會動到好幾桌的社團動作（`handle`、刪除帳號、關桌、斷線、載入）進行中，牌桌的回報只更新目錄，動作結束時才送一次大廳（`batch`），所以瀏覽器收到的訊息跟拆分前一樣。
- `tests/worker/table-service.test.ts`：單獨一桌只在大廳看得到的事變了才回報、`rev` 遞增、紀錄交不出去時留在 `outbox` 重送、最後一人離開就關桌、聊天依各人的封鎖名單。

**H1b 的實作**（`e11-t17`，2026-10-25，**狀態：已實作，待部署**）：
- **分層**：`worker/table-object.ts`（`TableObject`，只有 Cloudflare 的接線：儲存、alarm、hibernation WebSocket、社團的 stub）→ `worker/table-host.ts`（`TableHost`：一個物件做的事，不碰 Cloudflare API，在 Node 測）→ `TableService`。社團那一側是 `RemoteTables`（`worker/tables.ts`，決策紀錄裡叫 `DurableTables`）：每個 `TableApi` 呼叫變成 stub 的 RPC，答案是 `Wire`（`{ ok }`、`{ error: { code, params, status } }` 還原成 `ClubError`、`{ gone }`＝物件沒有這一桌，社團順便把它從目錄拿掉）。桌 → 社團是 `Club` 的 RPC 方法 `tableChanged`、`tableClosed`、`tableBoardFinished`（轉給 `ClubService.link`）；Worker 問 session 是 `Club.socketUser`。`TableObject` 對社團只用一個 stub，回報照順序到。
- **`ClubService` 兩種模式**：給了 `tableObjects`（正式環境）就是每桌一個物件，目錄寫進 `tabledir:<id>`（`applyEntry`／`tableClosed`），載入時只讀目錄、不叫醒任何一桌；社團的連線上下線不再轉給牌桌（`presence`），由桌自己的連線判斷。沒給（大部分測試）就是 H1a 的 `LocalTables`。`tablesInClub`（`TABLE_OBJECTS=off`）是切回去的開關。
- **桌自己的連線**（`TableHost`）：`connected` 不在桌上就用 4004 關掉，在的話 `presence(true)` 送完整畫面；最後一條關掉 `presence(false)`（觀看者離開、房主交接、入座者開始算代打）；每次社團呼叫或動作之後，已經不在桌上的人的連線關掉。物件從休眠醒來（`load` → `restore`）不回報社團，免得每次喚醒都叫醒社團。
- **搬移**（`ClubService.moveTablesOut`、`bringTablesBack`）：見上面「搬移舊資料」。`adopt` 對已經有這一桌的物件不覆蓋（物件的比較新），對已經關掉的（`closed`）回 `null`；失敗的桌 60 秒後再搬（`migrate:tables`），全部搬完才寫 `meta:schema` 4。反方向：`handOver` 先讓物件停住（`frozen`，不存、不推、不回報，機器人的工作也存不了），社團存成 `table:`（自己已經有就不蓋），再 `release` 清掉物件、刪 `tabledir:`。部署步驟、檢查與切回去在 `DEPLOY.md` §4.3。
- **每人排隊**：`ClubService.handle` 與挑戰的 HTTP 動作依社員排隊（`inLane`），等某一桌回答時同一人的下一個動作先等；沒有在處理的就立刻開始（測試與單一物件時行為不變）。
- **瀏覽器**：`ClubContext` 看大廳的 `myTableId` 開第二條連線（`src/lib/liveSocket.ts`，兩條連線共用心跳與重連），換桌關舊的；牌桌動作先走桌的連線，沒開就走社團的。
- **測試**（Node，不需要 workerd）：`tests/worker/table-objects.test.ts`（每個物件是一個 `TableHost`，經 `RemoteTables` 與 structured clone：開桌、打完一副進紀錄、物件被回收後接著打、錯誤代碼跨 RPC、物件沒有這一桌時目錄跟著拿掉、每人排隊、桌的連線只收在桌上的人、訊息驗證與速率限制、上下線看桌的連線、搬出去／失敗重試／中途回收重做／已關的桌、切回去再切出去、交回後不再動）；`tests/worker/routing.test.ts`（Worker 的路由與 `X-TBT-User` 不能偽造）；`tests/presentation/club-sockets.test.tsx`（第二條連線、動作走哪一條、4004 不重試）。**需要 workerd 的只有接線本身**（`table-object.ts`、`index.ts` 與真正的 RPC），用 `npm run dev` 或 PR 預覽手動檢查（PR 的「怎麼檢查」）。
- **還沒做**：舊頁面（部署前就開著的分頁）只有 `/ws`，動作照樣轉給牌桌，但收不到牌桌畫面，要重新整理（`DEPLOY.md` §4.3）；負載數字等 `e11-t21`。

## 5.11 練習桌與叫牌提示卡（`e10-t03`～`e10-t06`）

- **開桌**：大廳的「和機器人練習」卡片或工具列的「練習」→ `PracticeDialog` → `createPractice { settings, access? }`（`access` 是誰可以觀看，四種進入方式之一，預設隱藏；不認得回 `badTableSettings`）。設定（`shared/practice.ts` 的 `PracticeSettings`，伺服器用 `parsePracticeSettings` 檢查，錯了丟 `badPracticeSettings { field }`）：`deal`（`random` 隨機、`deal-presets.ts` 的五種預設、或 `custom` 帶 `conditions`：任一家的點力、各門張數、平均牌型與一方的合計點力，`conditionsProblem` 不過就拒絕）、`robotKind`（TKB 淡江制度或 2/1，淡江制度要 `tkuSystem`，沒寫就是開桌者的預設，§5.1.2；機器人沒有等級，社長 2026-10-24 決定）、`justDeclare`。條件在 `PRACTICE_MAX_ATTEMPTS`（5,000 次）內抽不到時回 `dealTooStrict`，在離開原本的牌桌**之前**就回。
- **牌桌**：`mode: 'practice'`，`modeState` 是 `PracticeTableState`（設定加上 `dealt` 已發幾副）。社員坐南，北東西是三個同制度的 TKB；座位、機器人、練習條件都不能改，別人也不能入座（`shared/protocol.ts` 的 `fixedSeats`；`sit` 回 `practiceTableFixed`，看不到這一桌的人回 `tableGone`）。開桌時從大廳的號碼裡拿一個桌號（列在大廳時要有號碼；紀錄仍記桌號 0）。社員離開（離開牌桌頁）桌子就關掉，觀看的人跟著離開；社員斷線時房主不交給觀看者。大廳的 `myTableMode` 讓「回到練習桌」的橫幅認得出來（只給坐著的社員）。
- **誰可以觀看**（四種進入方式，§5「牌桌設定」）：練習桌也用 `access`，只是「加入」只有觀看。**預設隱藏**：練習是自己的事，不該一開就出現在大廳讓人圍觀；想讓教練或朋友看就從牌桌的設定按鈕（只問進入方式與邀請名單，`TableSettingsDialog` 的 `practice`）邀請他們，或改成公開、申請加入。`updateTableSettings` 在練習桌只接受 `access`（與 `invitees`），帶 `allowKibitz`、`boardMinutes` 回 `practiceTableFixed`；`allowKibitz` 固定允許、不限時。觀看者看到的跟一般牌桌的觀看者一樣（四家，§4），不能叫牌、出牌、重發；大廳卡片標「練習桌」（`TableSummary.practice`）。
- **發牌**（`worker/modes.ts` 的 `practice`）：有條件時每副都由南家發牌（牌號 3、7、11、15…，局況輪流），隨機時照一般牌桌輪流。條件發牌用 `quickRandom`（每副用 CSPRNG 取一次種子的 mulberry32）：CSPRNG 每次嘗試約 1 ms，條件發牌要很多次嘗試，免費方案的 CPU 不夠；快速版每次約 10 µs，最難的滿貫牌平均約 350 次。
- **隨時重發**（`redeal`，牌桌動作，只有練習桌的主人、要有座位）：這一副不管打到哪裡直接丟掉（不留紀錄、`boardsPlayed` 不變），立刻發下一副；這次抽不到時牌留著、回 `dealTooStrict`；不是練習桌回 `practiceOnly`。
- **撤回不限**：練習桌的撤回跟一般牌桌一樣（機器人一律同意），沒有次數限制；挑戰桌才不能撤回。
- **叫牌練習室（一）：只叫牌、一人控制多家**（`e10-t15`，ROADMAP U2a）：`PracticeSettings.biddingOnly` 與 `seats`（社員替哪幾家叫，一定有南；南以外只在 `biddingOnly` 時可以，現在沒有人同時打好幾手牌；`biddingOnly` 不能和 `justDeclare` 一起，錯了是 `badPracticeSettings { field: 'biddingOnly' | 'seats' }`）。
  - **座位控制權（通用）**：`Table.controllers: Partial<Record<Seat, userId>>`，「替這個座位叫牌的人」，沒列的座位就是坐在那裡的人（`views.ts` 的 `actorOf`）。座位上仍是原本的佔位者（練習桌是 TKB），所以座位、`fixedSeats`、代打、`swapForDeclarer`、大廳顯示都不用改；機器人輪到一個被控制的座位就不動（`robotMove` 的 `robotActs`），但撤回與攤牌照樣由坐著的機器人回答。之所以不把社員的 id 同時放進好幾個座位：`seatOf`、代打、入座離座、紀錄的 `players` 都假設一個人一個座位，改那個模型會動到每一種牌桌；控制權另外一張表，之後搭檔非同步叫牌（`e10-t08`，搭檔控制北）與教學桌（`e10-t10`，老師控制任一家）只要設這張表。
  - **伺服器驗證**：`call` 可以帶 `seat`（`TableService.callingSeat`）：要是 `actorOf` 為這位社員的座位，否則 `notYourSeat`；不帶就是自己的座位；輪到誰由 `makeCall` 判斷（`notYourCall`）。撤回（`undoSeat`）在叫牌中撤回他替任何一家叫的最後一口；他自己不能同意自己替別家叫的撤回（`undoByOpponent`）。社員被刪除時他控制的座位還給佔位者。
  - **叫完就結束**：叫牌結束（有合約）時 `endBidding` 把這一副設成 `finished`、沒有 `result`、不打牌（`biddingEnded`）；四家 Pass 時照常有 0 分的 `result`。兩種都**不做紀錄**（不進 outbox、不進 `recent`、`boardsPlayed` 不變，所以也不進 D1 副本），也不自動發下一副（`dealsByItself`，沒有 `dealAt`）。社員按「下一副」（`redeal`）或「重叫這一副」（`rebid`：同一副牌從頭再叫，不是只叫牌的練習桌回 `biddingOnlyRebid`，只有主人可以）。
  - **畫面**：`TableView.acts`（他替哪幾家叫，多於自己的座位時才送）、`SeatOccupant.controlledBy`（座位牌上的「amy 叫」）；叫牌盒上方「現在替 北 叫」，送出時帶 `seat: board.turn`；結束時中間是「叫牌結束」與合約（`ResultPanel` 沒有 `result` 時）；右下角「重叫這一副」「下一副」。
- **叫牌練習室（二）：四家的條件、顯示四家、存設定、牌組**（`e10-t16`，ROADMAP U2b）：
  - **每家的條件**：`deal: 'custom'` 的 `conditions.seats` 四家都可以設；每家（`dealer.ts` 的 `SeatConditions`）可以有點力、各門張數、平均牌型，另加 `shapes`（牌型，長的在前，`5332`、`4441`，任一個都可以）、`longest`（最長一門的張數，`[5, 13]` 是任一門五張以上）、`shortest`（最短一門，`[0, 1]` 是有單缺），或 `hand`（**整手牌** 13 張：照給，其他家發剩下的牌，同一家的其他條件也要符合）。對話框的牌型快捷（不限、平均、5-3-3-2、4-4-3-2、4-4-4-1、有單缺、任一門 5+／6+）只是這幾個欄位的組合（`src/lib/practiceForm.ts`）；整手牌可以打字（PBN 一手的寫法 `AKQ2.K73.9.AJ852`，`shared/pbn.ts`）或一張一張點，別家已指定的牌不能點。
  - **矛盾與抽不到分開說**：`conditionsProblem` 多檢查牌型（沒有任何一種牌型同時符合，例如平均又有缺門、5-3-3-2 又要六張）、指定的牌（不是 13 張不同的牌、不符合自己那家的條件、同一張給了兩家）、四家與兩方的點力加起來湊不到剛好 40 點；`parsePracticeSettings` 回 `{ field: 'conditions', problem }`，伺服器丟 `dealConflict { where }`（`S.shape`、`hcp`、`NS.hcp`、`hands`…）。條件不矛盾但 `PRACTICE_MAX_ATTEMPTS` 內抽不到仍是 `dealTooStrict`。對話框在送出前就用同一個 `conditionsProblem` 說出哪裡矛盾（只是顯示，伺服器再檢查一次）。發牌器有指定的手牌時，先扣掉那些牌，再照原本的方法（先抽各家各門張數、再發牌）發剩下的，所以其他家仍是均勻的。
  - **顯示四家**：`PracticeSettings.showHands`（開桌時可以先開），牌桌上主人用 `showHands { show }`（牌桌動作，`TABLE_ACTIONS`；不是練習桌 `practiceOnly`、不是主人 `hostOnly`）切換，存在 `PracticeTableState.showHands`。伺服器在 `boardView` 帶 `shown`（§4），畫面上只因為這樣才看得到的手牌標「顯示中」（`TablePage` 的 `ShownTag`），右下角「顯示四家／隱藏他家」。
  - **存成我的設定**：`practicePresets:<userId>` 一份清單（`worker/practice-presets.ts`，新的在前），每人最多 `PRACTICE_PRESETS_MAX` 20 組，名稱 1–30 字（`badPresetName`），同名覆蓋、超過回 `practicePresetsFull { max }`；設定照開桌的規則檢查（`parsePracticeSettings`），牌組只存選擇（哪一組、哪幾副的 id），不存牌。`GET /api/practice/presets`、`POST /api/practice/presets { name, settings }`（共用社員的動作速率限制）、`DELETE /api/practice/presets/:id`（`presetGone`），都回整份清單；只讀寫自己的。帳號刪除時一起刪。
  - **牌組**：`deal: 'set'` 帶 `set`：`{ source: 'practice', id }`（社團的練習牌組）或 `{ source: 'favorites' | 'featured', ids }`（自己的收藏或精選，最多 `PRACTICE_SET_BOARDS_MAX` 50 副）。開桌時 `ClubService.practiceProblems` 讀出牌放進 `PracticeTableState.problems`（找不到牌組 `practiceSetGone`；不是自己的收藏、沒被精選、看不到或還沒公開的牌一律 `boardGone`，§4），之後**依序出題**、發完一輪從頭（`modes.ts` 的 `practice.deal`），每副的牌號照那副的發牌人與局況（練習牌組用 `boardNoFor`，紀錄用原本的牌號）。牌組不能和 Just Declare 一起（`field: 'justDeclare'`）。精選的分類、標題與講解、練習牌組的分類與教學重點跟著題目，`TableView.practice.problem`（第幾題／共幾題，叫牌結束後才有 `note`），結果面板顯示「教學重點」。
  - **練習牌組的檔案**：`shared/practice-sets/*.json`，一個檔一組（檔名就是 id），格式是陣列 `{ id, dealer, vulnerability: 'None'|'NS'|'EW'|'All', hands: 'N:<北> <東> <南> <西>', category, note }`。`index.ts` 用 Vite 的 `import.meta.glob` 找檔案，所以新增一個 JSON 就會列出來，不必改程式（Worker 由 Vite 的 Cloudflare 外掛建置、Vitest 也走 Vite，兩邊都支援；選它而不是在 index 一個個註冊，是因為出題的人只要放檔案）。格式不對的檔案不列出，記在 `PRACTICE_SET_ERRORS`，測試要求它是空的。`GET /api/practice/sets` 只回 id、副數與分類，不含牌；名稱來自 `strings.ts` 的 `practiceSetNames`（沒有就顯示 id）。
- **叫牌練習室（三）：檢討**（`e10-t07`，ROADMAP U2c）：只叫牌的練習桌叫完一副，結果面板多一個「檢討」，打開 `PracticeReview` 對話框：四家牌、逐步對照、TKB 會叫到哪裡、DD 表與 par、牌組的教學重點。
  - **伺服器算、叫完才送**：叫牌結束（`endBidding`，四家 Pass 也算）時清掉舊的檢討，之後由 `TableService.scheduleReview` 用機器人排程（`robot` 類的工作，`review:<桌>`）分兩次算：先算每一口 TKB 會叫什麼（`reviewSteps`：對叫牌過程的每一口問 `RobotBrain.bid`，只給那一家的牌與那一口之前的叫牌，`askedState`），存好送出；下一個工作再讓四家 TKB 從頭叫同一副（`robotBidding`，每一家同樣只看自己的牌）。制度用桌子的 `robotKind`（淡江或 2/1）。結果存在 `PracticeTableState.review`，`practiceView` 只在這一副 `finished` 時送；重叫（`rebid`）、下一副（`dealBoard`）就丟掉。物件被回收時工作不會保存，`restore` → `scheduleRobots` 會把還缺的部分再排一次；機器人想太久或失敗時由規則機器人回答（同牌桌）。
  - **為什麼分兩次、在排程裡**：免費方案每次請求只有 10 ms CPU。在忙碌的開發機上量（200 副隨機牌，叫牌過程平均 9.5 口）：每一口建議＋四家 TKB 從頭叫合計中位數約 3 ms、p95 約 7 ms、最多約 15–19 ms（淡江與 2/1 差不多）。放在叫最後一口的請求裡會跟那一口的處理加在一起，偶爾超過；拆成兩個排程工作，每次最多大約一個叫牌過程的量，也不拖慢叫最後一口的回應。
  - **瀏覽器只顯示**：逐步對照把實際叫品與 TKB 的叫品並列，不同的標「不同」；點一口顯示兩邊的制度解釋（實際叫品的 `meaning`／`inferred`、TKB 的 `meaning`，用 `describe` 依觀看者的語言寫出點力與張數）。DD 表用紀錄頁的 `DoubleDummyPanel`（瀏覽器端 DDS，四家此時已公開）；兩個合約的 DD 墩數、南北分數與 IMP 差（`src/lib/practiceReview.ts`，`duplicateScore`＋`imps`）在瀏覽器算，只是顯示。還沒送到的部分顯示「計算中…」。
- **Just Declare 練習**（`e10-t05`）：每副先由四個 TKB 叫完（`challenge-deals.ts` 的 `robotAuction`，同 Just Declare 挑戰），南北沒當莊就重發，最多 `JUST_DECLARE_TRIES` 次；真的抽不到時先打一副有合約的（防守），再不行就讓社員自己叫。同伴當莊時社員換到莊家位（同一般牌桌的 `swapForDeclarer`）。
- **紀錄**：`BoardRecord.mode = 'practice'`、桌號 0（列表顯示「練習」，`strings.ts` 的 `boardPlace`）。SQL 搜尋 `scope=all` 沒指定 `mode` 時排除練習（`history-index.ts` 的 `where`），所以「全部社員」、個人檔案卡的最近牌局都看不到；「我的」照常列出，篩選「練習」（`HISTORY_MODES`）兩邊都找得到。練習的牌不能設精選（`practiceNotFeatured`）、不能「用這副牌挑戰」（`practiceNoChallenge`）。
- **畫面**：`TableView.practice`（`worker/views.ts` 的 `practiceView`：只有社員自己的設定與 `dealt`，不含任何牌）；牌桌標題 `PracticeBanner`，右下角「重發」「結束練習」。
- **叫牌提示卡**（`e10-t06`，AC-10.4）：牌桌側欄的「特約」分頁（`BookHints`）。伺服器在 `BoardView.bookTopics` 送來（`worker/views.ts`，只看叫牌過程；看的人的同伴是 2/1 的 TKB 時不送），瀏覽器只顯示，不跑引擎（硬性規則 1）。`shared/book-topics.ts` 的 `bookTopics` 依目前的叫牌列出淡江橋譜的頁面：我方開叫的那一頁（1♣、1♦、高花、1NT、2♣ 與阻擊、2♦、2NT），對方先開叫時是競叫那一頁，再加上目前為止與下一口可能用到的約定叫（社團規則的 `Spec.name`，經 `CONVENTION_PAGES` 對到橋譜的 slug），連到 `https://tku-bridge-hall.vercel.app/c/<slug>`（新分頁）。規則還沒有自己的 `bookSlug`（`e5-t45`）之前先用約定叫名稱對照，之後改讀規則上的。只看淡江制度；同伴是 2/1 的 TKB 時只說明橋譜寫的是社團制度。名稱的文字（`describe.ts`）只在分頁打開時才載入（`useRobotRules`）。同一個叫牌過程的引擎意義在 `views.ts` 記住最近 256 個（每個看的人、每次更新都問一樣的），叫牌盒提示（`callMeanings`）也共用。

## 5.12 H2：紀錄索引搬到 D1、邊緣 session 驗證、`EventObject`（決策紀錄，`e11-t18`～`e11-t20`，2026-10-26）

H1 把牌桌拆出去之後（§5.10），社團的物件（`Club`）仍然是**唯一一個所有人都要經過的地方**。社長要「很多人、很多桌同時打」先順，所以 H2 的問題是：還有什麼會叫醒、塞住 `Club`？哪些可以不經過它？

**現況（H1 之後）量到的**：
- **每一個 HTTP 請求都進 `Club`**，包括紀錄列表與搜尋。牌桌的第二條連線（`/ws/table/<id>`）每次連上、斷線重連，Worker 都要先問 `Club` 這是誰（`socketUser`）。
- **紀錄搜尋在 `Club` 的執行緒裡跑**。一萬副時一頁要 0.7–10 ms CPU（`tests/worker/edge-cost.test.ts`、`history-perf.test.ts`：「全部、最新」0.7 ms，「我的」2.3 ms，「搭檔是某人」6 ms，搭檔＋同桌＋排序 9.7 ms）。免費方案一次呼叫只有 10 ms CPU；這段時間大廳、私訊、別人的跨桌動作都在排隊。
- 挑戰的期限、結算與隊制賽的狀態也在 `Club` 裡（`EventObject` 拿走的部分，見下面 H2b、H2c）。

### 什麼搬到哪

| 東西 | H1 之後 | H2 之後 | 正本 |
| --- | --- | --- | --- |
| 紀錄索引（`boards_index`、`board_players`） | `Club` 的 SQLite | `Club` 的 SQLite（**寫入端**：挑戰、隊制賽、收藏的 join 用）＋ **D1 的副本**（**讀取端**：紀錄頁） | `Club` 的 `board:` 紀錄；兩份索引都能從它重建 |
| 每副的摘要（`BoardSummary`） | 讀那一頁時從 `board:` 算 | D1 另存一份（`board_summaries`） | 同上 |
| `GET /api/history`、`GET /api/history/search`、`GET /api/history/days` | `Club` | **Worker 直接從 D1 回答**（有效的通行證、副本完整、條件不含 `tag`）；其他情況照舊給 `Club` | — |
| 收藏、單副紀錄、traveller、個人檔案卡的最近牌局 | `Club` | `Club`（不變） | — |
| session | `Club` 的 `session:<token>` | 不變；另外發 10 分鐘的**簽章通行證**（cookie `tbt_pass`） | `Club` |
| 牌桌連線是誰 | Worker 問 `Club` | Worker 看通行證；沒有、過期或不對才問 `Club` | — |
| 挑戰的狀態、排程、結算 | `Club` 的 SQL | 每場一個 `EventObject`（**H2b**，開關 `EVENT_OBJECTS=on`，預設關）；`Club` 留一份副本給所有讀取 | 那一場的 `EventObject` |
| 隊制賽的狀態與結算 | `Club` 的 SQL | 每場一個 `EventObject`（**H2c**，同一個開關，預設關）；`Club` 留一份副本給所有讀取（比分仍在讀的時候由 `scoreTeamMatch` 算） | 那一場的 `EventObject` |

**為什麼 D1 是「副本」而不是整個搬過去**：
- 挑戰與隊制賽在 `Club` 的 transaction 裡**同步**讀寫索引（`eventBoards`、`revealEvent`、`revealBoards`），收藏搜尋 join `favorites`。全部改成跨網路、非同步的 D1，會把 D1 的延遲與失敗帶進結算與公開牌局的流程，風險比收穫大。
- 副本隨時能從 `board:` 重建，所以搬移、退回都不會掉資料：D1 壞了，最壞情況是紀錄頁改回由 `Club` 回答（跟現在一樣）。
- 代價：每副多寫一份索引（D1 的額度，見「免費方案」）。H2b 把挑戰、隊制賽搬進 `EventObject`、改用它們自己的結果表之後，再決定 `Club` 自己的索引能不能拿掉（每副省下約 20 列的 Durable Object 寫入）。

### 一致性：outbox，跟 H1 的 `outbox:<桌>` 同一個做法

- **先存好才送**：所有寫 `board:` 的地方都經過 `ClubService.writeRecord`（打完一副、挑戰結束或隊制賽兩室打完時改 `revealAt`）。它最後一步把 `replq:<牌局 id>` 寫進 `Club` 自己的儲存（值是時間＋序號）。寫紀錄失敗時這一步不會發生，所以沒存好的紀錄不會被複製。
- **送**（`worker/history-replica.ts` 的 `ReplicaSync`）：`replica:flush` 工作（1 秒後，同一秒打完的幾副合成一批）一次取 20 副，**從 `board:` 重新讀出最新的紀錄**組 SQL，在一個 D1 `batch`（一次來回、一個 transaction）裡寫入：索引列與摘要 `INSERT OR REPLACE`、四列座位先刪再寫；紀錄已經不在的副從 D1 刪掉。**重做幾次結果都一樣**（idempotent），所以 outbox 只記「哪一副要同步」，不必管順序。
- **寫完才刪**，而且只刪「值沒變」的：寫的時候同一副又被改（例如挑戰剛好結束），新的那筆留著，下一批再寫。
- **D1 失敗**（斷線、超過每日額度）：留在 outbox，30 秒後重試，每次加倍，最多 10 分鐘一次；日誌 `event: replica, ok: false`。物件被回收：outbox 在儲存裡，`load()` 看到還有就重新排工作。D1 的表不見了（資料庫被換掉）：自動從頭重填。
- **讀到舊資料的時間**：通常 1–2 秒（1 秒的合併＋一次 D1 寫入）。打完一副立刻打開紀錄頁，最多晚這麼久看到；牌桌側欄的紀錄來自那一桌，不受影響。
- **可見性不變**：D1 跑的是同一段 SQL（`history-index.ts` 的 `searchStatements`，同一個 `where()`），還沒公開的牌（`reveal_at`）兩邊一樣只給打那一副的人（AC-4.9）。資訊隔離套件（`tests/worker/visibility/`）的每個情境都比對 D1 與 `Club` 的回答**完全相同**。

### 搬移正式站的資料（可中斷、可重來）

- 部署後 `Club` 第一次載入，若有 `HISTORY` binding 而 `meta:replica` 還不是 `ready`：先在 D1 建表（`CREATE TABLE IF NOT EXISTS`，欄位與 `Club` 的相同、另加 `club_id` 在每個主鍵最前面，另加 `board_summaries` 與 `index_meta`；`e12-t03` 起先讀 `sqlite_master`，沒有 `club_id` 的舊表刪掉重建）並把這個社團的 `index_meta.ready` 設成 `0`；然後每次 alarm 寫 20 副 `board:`（一步 1 秒，做到哪一個 key 存在 `meta:replica`，物件被回收就從那裡接著做）；全部寫完才把 `ready` 設成 `1`。填的期間打完的副照樣進 outbox，不會漏。
- **Worker 每次讀 D1 都在同一個 batch 先看 `ready`**，不是 `1`（或表還不存在）就交給 `Club`。所以填到一半的副本永遠不會被讀到，也不需要部署順序上的配合。
- 時間：一萬副 500 步，約 8–10 分鐘；正式站目前遠少於此。每步 11 個 statement，遠低於免費方案每次呼叫 50 個查詢。
- `REPLICA_VERSION`：D1 的表或摘要的內容改了就加一，每個 `Club` 下次載入自動重填（期間 Worker 讀 `Club`）。

### 開關（退回）

- **`HISTORY_D1=off`**：Worker 不讀 D1；`Club` 不再寫 outbox、清掉 outbox、把 D1 的 `ready` 設成 `0`（D1 連不上就一直重試，直到設好）。拿掉這個值再部署，`Club` 從頭重填，填完才讓 Worker 讀。正本一直在 `Club`，怎麼切都不會掉紀錄。
- **`EDGE_AUTH=off`**（或根本沒設 `EDGE_AUTH_SECRET`）：不發通行證，Worker 什麼都問 `Club`，跟 H1 一樣。沒有通行證時 D1 也不會被讀（Worker 不知道是誰）。
- 兩個開關互不影響，都是 `wrangler deploy --var <名稱>:off`（`DEPLOY.md` §4.5）。

### 邊緣通行證（`worker/edge-auth.ts`，`e11-t19`）

- **格式**：`<社員 id>.<session id>.<到期時間，36 進位>.<HMAC-SHA-256，base64url>`，用 secret `EDGE_AUTH_SECRET` 簽，有效 `EDGE_PASS_MS`（10 分鐘）。簽的內容另含社團（`pass3:<社團>:…`，`e12-t03`）：Worker 只用請求所指的社團驗，別的社團的通行證當成沒有。session id 是 session 自己的 `id`（登入中的裝置列表用的那個），不是 token；`e11-t28` 之前沒有 session id 的舊通行證一律不認，社團下一次回答時換新的。cookie `tbt_pass` 與 session 一樣 HttpOnly、SameSite=Lax、Path=/。只有 WebCrypto，Worker、Durable Object、Node 測試同一份程式。
- **誰發**：`Club`。登入、註冊（第一個帳號）時跟 session 一起發；之後任何 `/api/*` 的回答，若瀏覽器沒有通行證或已經用掉一半，就附上新的（`Club.edgePass`）；session 已經失效就清掉；登出時清掉。只要有在用網站（打開頁面就會呼叫 `/api/me`），通行證就一直有效。
- **誰看**：Worker（`worker/routing.ts`）。驗證是一次 HMAC，**再查 D1 的 `pass_revocations` 那個 session 有沒有結束**（`passRevoked`，`e11-t28`）；不合法、過期、被改過、換了 secret、session 已結束、D1 查不到或沒有 D1（PR 預覽），一律當作沒有，改問 `Club`，結果跟現在一樣。通行證裡**只有社員 id**，沒有管理員與權限，所以需要權限的 API（管理、橋譜、精選）一律照舊進 `Club`。
- **撤銷（`e11-t28`，2026-10-30）**：登出、登出某個裝置、登出其他裝置、改密碼、忘記密碼重設、管理員重設密碼、刪除帳號、還原備份時，`ClubService` 把結束的 session id 寫進 D1 的 `pass_revocations`（`revocationWrites`：一個 batch，先 `CREATE TABLE IF NOT EXISTS`、清掉已經不可能有有效通行證的列，保留 `REVOKED_FOR_MS`＝通行證效期加兩分鐘），**Worker 下一個請求就不認那張通行證**；同時關掉這個人的 `/ws` 與所在那一桌的連線（`TableApi.signOut`，4001），還登入著的裝置會自己重連。表不存在＝從來沒有撤銷過（第一次撤銷才建），不必在載入時碰 D1。寫 D1 失敗：記日誌、一分鐘後再試一次；D1 壞了時 Worker 的讀取通常也失敗，一樣改問 `Club`。`pass_revocations` 不受 `HISTORY_D1=off` 影響（只要有 `HISTORY` binding 就寫、就查）。代價：Worker 每次靠通行證回答前多一次 D1 讀取（一列、走主鍵），不經過 `Club`。
- **為什麼不用快取**：`workers.dev` 網域上 Cache API 不作用；KV 免費方案每天只能寫 1,000 次而且最終一致（登出後最多約 60 秒還有效），不比簽章好；把 session 也複製到 D1 則每個請求多一次 D1 讀取。

### 買到什麼（量的）

| | 之前 | 之後 |
| --- | --- | --- |
| 一頁紀錄（一萬副，`edge-cost.test.ts`） | `Club` 0.7–10 ms CPU，期間別的動作排隊 | Worker 約 0.25 ms CPU（驗通行證＋組回答），SQL 在 D1、不算 Worker 的 CPU；**`Club` 完全不醒** |
| 牌桌連線連上、斷線重連 | 叫醒 `Club` 一次 | 通行證有效時 0 次 |
| 打完一副 | `Club` 寫 KV 與 SQL 索引 | 同上，多一筆 outbox；1 秒後一次 D1 batch（20 副 11 個 statement） |

**沒有改變的**：大廳廣播、跨桌動作（開桌、入座、離桌）、`/ws` 的訊息、私訊、通知仍然在 `Club`。H3（`e11-t21` 負載測試 200 人 30 桌）要量的就是這些；預期下一個瓶頸是**大廳廣播**（大廳看得到的事變了，就替每位在線的人各算一份大廳，200 人就是 200 份）。

### 免費方案

- **Workers**：每天 10 萬次請求；每次呼叫 10 ms CPU、最多 50 個 D1 查詢（一批 20 副約 11 個，讀一頁 3 個）。
- **D1 免費額度**（以 Cloudflare 公布的為準）：每天讀 500 萬列、寫 10 萬列，全部 5 GB（每個資料庫 500 MB），最多 10 個資料庫。新的一副約寫 14 列（含索引；重寫約兩倍），一天約 7,000 副才到上限；一萬副約 10 MB。讀：「全部」列表要數總數，一萬副時一頁約掃 1–2 萬列，所以每天約 250–500 次「全部」翻頁；「我的」走索引，少得多。Durable Object 的 SQLite 免費額度算法相同（也是每天 500 萬／10 萬），這些讀取原本就算在 `Club`，現在改算在 D1。
- **超過額度時**：D1 讀取失敗 → Worker 交給 `Club`（日誌 `event: edge, fallback: error`）；寫入失敗 → 留在 outbox，額度恢復後補上。期間紀錄頁仍可能從 D1 讀到少了最新幾副的列表；真的擔心就 `HISTORY_D1=off`。

### 每個環境的資料庫

- 正式站：`tku-bridge-history`；staging：`tku-bridge-history-staging`。**binding 不會繼承**，`wrangler.jsonc` 的 `env.staging` 有自己的 `d1_databases`，id 不同，staging 永遠碰不到正式站的資料庫。
- PR 預覽：**沒有 D1**。一個資料庫會被所有預覽共用，各預覽的社團紀錄會混在一起；預覽的紀錄頁由 `Club` 回答。預覽每次部署產生一個隨機的 `EDGE_AUTH_SECRET`（`.github/workflows/preview.yml`），所以通行證與「桌的連線不問 `Club`」在預覽可以測。
- 本機（`npm run dev`）：`wrangler.jsonc` 的 D1 binding 在本機是一個本機資料庫；`.dev.vars` 設 `EDGE_AUTH_SECRET` 才會發通行證。

### H2b：每場挑戰一個 `EventObject`（決策紀錄，`e11-t18`，2026-10-26，**狀態：已實作，開關預設關**）

**為什麼**：挑戰的期限工作（提醒、截止）與結算（每週挑戰截止時幾十人的名次、結果通知）都排在 `Club` 唯一的佇列與執行緒裡。拆出去之後，一場挑戰的工作只叫醒那一場的物件；`Club` 只在挑戰的狀態真的變了才被叫醒一次，寫副本、做「社團才做得到的事」。以 30 桌的社團來說它比 H2a 次要；J 階段（很多場比賽同時）才真的需要。

**什麼搬、什麼留**：

| | 在哪裡 | 說明 |
| --- | --- | --- |
| 一場挑戰的狀態（`challenges`／`challenge_players`／`challenge_results` 的那幾列） | 那一場的 `EventObject`（自己的 SQLite，**同一個** `ChallengeStore`） | 正本 |
| 狀態怎麼變（回覆、取消、開始打、一副的結果、帳號刪除、提前結束、截止） | `ChallengeEvent`（`worker/event-service.ts`，呼叫 `challenge-flow.ts` 的純函式） | 不碰 Cloudflare；開關關時在 `Club` 裡跑同一份程式（`LocalEvents`） |
| 期限工作（`challenge:<id>`：12 小時前提醒、截止結算） | 那一場物件自己的 `AlarmQueue` 與 storage alarm | 物件載入時依狀態重排 |
| 建立前的檢查（是不是社員、封鎖、人數、牌組、「用這副牌挑戰」讀紀錄） | `Club` | 只有 `Club` 有帳號與紀錄 |
| 通知（邀請、回覆、取消、提醒、結果） | `Club` | 物件只說狀態，不送通知 |
| 開關牌桌、公開牌（`revealAt`、`boards_index.reveal_at`） | `Club` | 只有 `Club` 有牌桌目錄與紀錄 |
| 每場挑戰的**副本**（同樣三個表） | `Club` | 列表、挑戰頁、traveller、可見性（`challengeView`、`challengeBoardVisible`、`challengeTraveller` 仍在 `worker/views.ts`）、挑戰桌的快照、重賽，全部讀副本，跟以前一樣同步 |
| 紀錄 `board:` 與索引 | `Club` | 不變 |

副本用跟正本**同一個 schema**（不是另做一份 `eventdir:` 目錄），所以 `Club` 所有讀挑戰的程式一行都沒改；寫入則一律經過 `EventApi`。`event_homes` 記哪些挑戰住在自己的物件，沒有那一列的就住在社團（開關關、還沒搬、或搬回來的）。

**兩者之間的訊息**（`worker/events.ts`，Durable Object RPC，只傳結構化可複製的資料）：
- `Club` → 一場（`EventApi`）：`adopt`（新挑戰、搬出去；已經有就保留物件的）、`answer`、`cancel`、`started`（第一副發牌）、`result`（一副的結果）、`forget`（帳號刪除）。每個都回傳那一場現在的樣子（`EventSnapshot`：整場挑戰＋變更編號 `rev`），**拒絕的時候也帶**，所以 `Club` 的副本落後時（上一次的回答丟了）會跟著拒絕一起補上。錯誤以代碼傳回、在 `Club` 還原成 `ClubError`（瀏覽器看到的代碼不變）。
- 一場 → `Club`（`EventLink.changed`，`Club` 的 RPC 方法 `eventChanged`）：工作自己改了狀態（提醒時間到、截止）。
- `rev` 跟 `TableEntry` 一樣是 `max(上一個＋1, 現在的毫秒)`，物件被回收後也不會變小；`Club` 只寫比 `event_homes.rev` 新的，晚到或重複的回報直接丟掉。

**一致性**：
- **物件這一側（outbox）**：每次變更先存 `unreported`，工作造成的變更立刻回報；`Club` 呼叫造成的變更已經在回答裡，但 5 秒後**再回報一次**（萬一回答在路上丟了），失敗就 30 秒後重試、每次加倍、最多 10 分鐘。回報成功、而且這段時間沒有新的變更才清掉。物件被回收：`load()` 看到 `unreported` 就再送。
- **`Club` 這一側（做過就記下來）**：結束後要做的事（收桌、公開牌、`finished` 時通知每位接受的人看結果）與提醒，都是**從挑戰的狀態推出來**、做之前先記在 `challenge_settled`，所以不管回報來幾次、晚多久、哪一條路先到，都只做一次。建表時把已經結束或已經提醒的舊挑戰都標成做過，部署當下不會重發通知。
- **結算的重送**：一副打完時牌桌把紀錄交給 `Club`（H1 的 `boardFinished`），`Club` 寫好紀錄後把結果交給那一場（`result`）。那一場的物件連不上時錯誤傳回牌桌，**沿用牌桌的 `outbox:<桌>`** 30 秒後整副重送（寫紀錄本來就可以重做，結果重複就略過），不另做 `evout:`。結果算不算看的是牌桌打完的時間（`playedAt`），不是送到的時間，所以晚送到的結果照算；截止已經結算過的就不算（跟沒打一樣，同以前）。
- **物件說它沒有這場挑戰**（第一次 `adopt` 失敗，或 `Club` 寫好副本後、呼叫前被回收）：`RemoteEvents` 拿 `Club` 的副本給它 `adopt`，再呼叫一次。所以新挑戰的順序是：先在同一個 transaction 寫副本與 `event_homes`（`rev` = -1），再 `adopt`；`adopt` 失敗不算建立失敗（邀請照發），之後第一次呼叫或 60 秒後的 `migrate:events` 會補。
- **帳號刪除**時某一場的物件連不上：記 log，那一場留著這個名字直到結束（帳號本身照樣刪除）。

**搬移（`meta:events` 1 → 2，可中斷、可重來）**：開關打開後 `Club` 載入時，每場**還開著**的挑戰先標成住在物件（`event_homes`，`rev` -1：從此 `Club` 都去物件找它，它在 `Club` 佇列裡的舊工作什麼都不做），再讓物件 `adopt` 副本、把回答寫回副本。失敗的 60 秒後再搬（`migrate:events`），中途被回收就再做一次（物件已經有的保留）。全部確認了才寫 `meta:events` = 2。**已經結束的挑戰不搬**：它們不會再變，留在 `Club`。

**開關（退回）**：`EVENT_OBJECTS=on` 才用物件，**其他值或沒設（預設）都是關**。關的時候 `Club` 載入時把每場住在物件的挑戰搬回來：物件先 `handOver`（停住：不再改、不跑工作、不回報），`Club` 用它寫副本、刪 `event_homes` 那一列、在自己的佇列排工作，再 `release` 清掉物件；`release` 失敗也沒關係（物件停著，下次 `adopt` 時清掉）。搬不回來的那一場繼續在物件裡、照常從物件存取，稍後再試；全部搬完 `meta:events` 回到 1。從搬回來的物件晚到的回報直接丟掉。正式站合併當下沒有這個變數，所以行為跟以前一樣（只多建兩個空表、`challenge_settled` 補上舊挑戰）。staging 與 PR 預覽在 `wrangler.jsonc` 設成 `on`。步驟在 `DEPLOY.md` §4.6。

**隊制賽為什麼當時不在這一批**（後來在 H2c 照這裡寫的做法做了，見下一節）：隊制賽沒有自己的期限工作（每副的時間上限是牌桌的，已經在 `TableObject`），比分在讀的時候才由 `scoreTeamMatch` 算，所以搬出去幾乎省不到 `Club` 的時間；而它的每一個動作都要 `Club` 的資料：誰在線（能不能開始）、封鎖與是否社員（邀請、替補）、牌桌目錄（裁定看兩室到哪裡）、「同時只在一場比賽」與「一人只主辦一場」（要跨比賽查）、推送給每位參賽者與觀看者（`Club` 的連線）。搬過去等於每個動作都要先把這些算好跟著傳過去。做法照這一批：`TeamMatchService` 分成 `Club` 那一半（上面那些檢查、通知、畫面與推送，讀副本）與比賽那一半（`team-match-flow.ts` 的純函式＋寫入，`ChallengeEvent` 的同類），同一個 `EventObject` 類別依 id 前綴（`match:<id>`）分派、同樣的 `rev`／outbox／`settled`、兩室的牌桌仍由 `Club` 開；比分只在比賽物件裡用兩室都完成的副計算（§5.8 不變）。

**實作與測試**：
- 分層照 H1b：`worker/event-object.ts`（只有接線：儲存、`ctx.storage.sql`、alarm、社團的 stub）→ `worker/event-host.ts`（`EventHost`，Node 可測）→ `ChallengeEvent`。`Club` 那一側是 `RemoteEvents`（`worker/events.ts`）；`ClubService` 只拿到 `ClubConfig.eventObjects`／`eventObjectsOn`，不碰 Cloudflare API（CLAUDE.md 規則 4）。`wrangler.jsonc` 加 `EVENT` binding（三個環境各一份）與 migration `v3`（`new_sqlite_classes: ["EventObject"]`，只新增類別，可以安全部署）。`/api/health` 多一個 `events: { objects, unconfirmed }`。
- **兩種模式都跑既有的測試**：`vite.config.ts` 有兩個 Vitest project，`default` 跑全部，`event-objects` 用 `TBT_EVENT_OBJECTS=on` 再跑一次所有挑戰、每週挑戰、隊制賽、TKB 權限與資訊隔離（`tests/worker/visibility/`）的測試。測試用 `tests/worker/event-mode.ts` 的 `clubService(...)` 建社團：開的時候每場挑戰是一個 `EventHost`（自己的儲存與記憶體 SQLite，經 structured clone），工作進同一個手動佇列；同一個 store 上重建社團時物件也一起被回收重載。
- `tests/worker/event-objects.test.ts`：副本與物件一致、拒絕的代碼與跟著補上的副本、截止在物件裡結算而結果只通知一次、物件被回收後工作重排而提醒不重發、回報送不到時重試、物件一開始沒收下時用副本補、物件連不上時一副的結果由牌桌的 outbox 重送且只算一次、開關關時什麼都不搬、搬出去（已結束的留下）、搬移失敗重試與重做、搬回來再搬出去、搬不回來時繼續用物件與搬回後丟掉晚到的回報、舊挑戰的 `challenge_settled` 補值不重發通知。
- 需要 workerd 才能測的只有接線（`event-object.ts`、`club.ts` 的 `eventChanged`、真正的 RPC）：在 staging（已預設開）照 `DEPLOY.md` §4.6 的檢查做一次。
- **還沒做**：`Club` 自己的紀錄索引還不能拿掉（挑戰頁的 traveller 仍 join 它）；一場挑戰每次回報整場（幾十人沒問題，全台灣規模的每週挑戰要改成只送變的部分）；負載數字等 `e11-t21`。

### H2c：每場隊制賽一個 `EventObject`（決策紀錄，`e11-t18`，2026-11-02，**狀態：已實作，開關預設關**）

照上面 H2b 寫的做法，跟挑戰用**同一個類別、同一個開關**（`EVENT_OBJECTS=on`）。正式站開不開仍由社長決定（`DEPLOY.md` §4.6），這一批沒開。

**什麼搬、什麼留**：

| | 在哪裡 | 說明 |
| --- | --- | --- |
| 一場隊制賽的狀態（`matches`／`match_seats`／`match_boards` 的那幾列） | 那一場的 `EventObject`（`idFromName('match:<id>')`，自己的 SQLite，**同一個** `TeamMatchStore`） | 正本 |
| 狀態怎麼變（改設定、取消、座位與隊長、開始、每室的結果、裁定、暫停、放棄、替補、下一段、帳號刪除） | `MatchEvent`（`worker/match-event.ts`）：每個 `MatchStep` 在比賽本身再跑一次 `team-match-flow.ts` 的純函式再寫入 | 不碰 Cloudflare；開關關時在 `Club` 裡跑同一份程式（`LocalMatches`） |
| 結算 | 同上：一室的結果寫一次（重送的略過），**最後一副（結果或裁定）在同一個 transaction 把比賽改成完賽**；段落最後一副設中場 | 以前是 `Club` 的 `finish()` 另外改 |
| 要 `Club` 的資料才能做的檢查：誰在線（能不能開始）、封鎖與是否社員（邀請、替補）、牌桌目錄（裁定看兩室到哪裡，跟著 `rule` 一起傳過去）、「同時只在一場比賽」與「一人只主辦一場」（跨比賽查） | `Club`（`TeamMatchService`，讀副本） | `Club` 先用副本跑同一個純函式（錯誤的先後跟以前一樣），過了才送 `MatchStep` |
| 通知、畫面、推送、開關牌桌、公開牌、紀錄與索引 | `Club` | 物件只說狀態 |
| Vugraph 的觀眾聊天、看過的人（`match_chat`、`match_watchers`） | `Club` | 不是比賽狀態；替補檢查「看過的人不能進來」只在 `Club` |
| 每場隊制賽的**副本**（同樣三個表） | `Club` | 列表、準備室、比分、大廳、`playingIdOf`、可見性，全部讀副本，一行沒改 |

**訊息**（`worker/match-events.ts`，同 H2b）：`Club` → 一場：`adoptMatch`（新比賽、搬出去）與 `stepMatch(step)`，都回傳整場比賽＋`rev`（拒絕也帶）。物件說沒有這場比賽時 `RemoteMatches` 拿副本給它 `adoptMatch` 再送一次。一場 → `Club`：`matchChanged`（`EventLink`，`Club` 的 RPC 方法）。隊制賽沒有自己的期限工作（每副時間上限在牌桌），所以物件只在 `Club` 呼叫時才變；`Club` 呼叫造成的變更照 H2b 5 秒後**再回報一次**（萬一回答丟了），失敗就重試。`rev` 與「只寫比較新的」同 H2b。

**一致性**：
- **收尾從狀態推出來**（`ClubService.settleMatch`）：每次寫入、回報、搬移後，兩室都打完（或裁定過）的副都公開（`revealBoards` 只動還沒公開的）；比賽完賽或放棄時，先記在 `match_settled` 再做：完賽通知每位參賽者、告訴兩室的牌桌、公開所有牌（`matchTablesEnded`）。回報重複、晚到都只做一次。取消、開始、座位等的通知照舊在動作裡發。
- **一副的結果送不到**：物件連不上時錯誤傳回牌桌，沿用牌桌的 `outbox:<桌>` 整副重送；物件裡同一室同一副只寫一次，`Club` 用寫入前後的副本判斷這次有沒有寫進去。`Club` 的副本可能落後，所以**結果不先用副本擋**，一律交給比賽決定。
- **開始時物件沒收下**：兩室的牌桌關掉、比賽留在準備中、回錯誤給主辦人（副本已經是「進行中」的話不關，代表其實收下了、只是回答丟了）。
- **帳號刪除**：每場開著的比賽各送一個 `forget`；連不上的那場記 log，留著這個名字（帳號照樣刪除）。觀眾聊天在 `Club` 直接刪。

**搬移與退回**（`meta:matches`，同 H2b 的 `meta:events`）：開關打開後 `Club` 載入時，每場**開著的**（準備中、進行中）隊制賽先記在 `match_homes`（`rev` -1），再讓物件 `adoptMatch` 副本；失敗的 60 秒後跟挑戰一起再搬（同一個 `migrate:events` 工作）。已經結束的不搬。開關關掉時 `handOverMatch` → 寫回社團、刪 `match_homes` → `release`；搬不回來的那場繼續從物件存取，稍後再試，晚到的回報丟掉。Logs：`{"event":"eventsMoved","kind":"matches",...}`。

**舊資料**：開關打開前已經存在的隊制賽——開著的照上面搬出去（進行中的也可以：兩室的牌桌不動，下一副的結果直接送到物件）；已經結束的留在 `Club`，`match_settled` 建表時把完賽、放棄、取消的都標成收尾過，不會重發通知或重告訴牌桌。正式站合併當下沒有開關，所以只多建 `match_homes`（空）與 `match_settled`，行為不變。

**測試**：
- 既有的隊制賽測試（`tests/worker/team-match*.test.ts`、`tku-system`、`visibility/`）在 `event-objects` project 用 `TBT_EVENT_OBJECTS=on` 再跑一次，這次每場隊制賽真的在自己的 `EventHost`（`tests/worker/event-mode.ts`，key 是 `match:<id>`）。
- `tests/worker/match-event-objects.test.ts`：副本與物件一致、拒絕的代碼、結果與完賽在物件、重送只算一次與只通知一次、物件連不上時結果失敗再重送、回答丟了靠再回報補上、晚到的舊回報不覆蓋、物件被回收、物件沒有這場時用副本補、開關關時不搬、搬出去（結束的留下）、搬移失敗重試、搬回再搬出、搬不回時照常用物件、舊比賽的 `match_settled` 補值。
- 需要 workerd 的只有接線（`event-object.ts` 的三個方法、`Club.matchChanged`）：PR 預覽與 staging 已經是開的。
- **還沒做**：正式站開 `EVENT_OBJECTS`；每次回報整場比賽（八個座位、最多 32 副，沒問題）。

### 實作與測試（H2a，`e11-t19`、`e11-t20`）

- `worker/edge-auth.ts`（通行證）、`worker/history-replica.ts`（`ReplicaSync`、`replicaWrites`、`searchReplica`、`ReplicaDb` 介面）、`worker/d1.ts`（唯一碰 D1 的程式，把 binding 包成 `ReplicaDb`）、`worker/routing.ts`（Worker 自己回答的部分）、`worker/history-index.ts`（`indexRow`、`searchStatements`、`listQuery` 讓兩邊共用同一段 SQL）。`ClubService` 只拿到 `ClubConfig.historyReplica`（`ReplicaDb`），不碰 Cloudflare API（CLAUDE.md 規則 4）。
- 測試在 Node：`tests/worker/d1.ts` 是 D1 的替身（記憶體 SQLite，每個 batch 一個 transaction，可以讓它失敗、會數 batch 與 statement、超過 100 個參數就丟錯）。`history-replica.test.ts`（填副本、物件被回收接著填、outbox、重寫與刪除、D1 失敗重試、寫的時候又被改、開關、表不見與版本）、`routing.test.ts`（通行證、Worker 從 D1 回答、各種交給 `Club` 的情況、桌的連線不問 `Club`）、`edge-cost.test.ts`（上面的數字）、`tests/worker/visibility/`（D1 與 `Club` 的回答完全相同）。
- 需要 workerd 才能測的只有接線（`d1.ts`、`club.ts` 的 `edgePass`、`index.ts`）：在 staging 照 `DEPLOY.md` §4.5 的檢查做一次。

## 5.13 指標、系統狀態與負載測試（`e11-t21`、`e11-t22`，2026-10-26）

**指標從既有的結構化日誌數**（`worker/metrics.ts`，不碰 Cloudflare API）：`ClubService` 的 `log` 先交給 `Metrics.observe` 再寫出去，所以 `action`（次數、耗時分桶、有錯誤代碼的算「被拒」）、`rejected`、`crash`、`http`（`Club.fetch` 的那一行改經 `ClubService.logEntry`，5xx 算伺服器錯誤）不必另外埋點。另外數三件事：
- **連線與重連**：`connected` 時如果這個人上一條連線在 60 秒內（`RECONNECT_WINDOW_MS`）才斷，算一次重連；同時記最高在線人數。
- **機器人思考時間**：`TableService.runRobot` 量 `think` 前後的 `performance.now()`，交給 `TableConfig.onThink`。
- **牌桌物件自己的數字**（桌的連線上的動作、被拒、bug、機器人思考）：`TableHost` 用 `TableCounters` 累積，**跟著下一副的 `boardFinished` 一起送給社團**（`ClubLink.boardFinished` 多一個選填的 `stats`），沒送到就放回去下次再送；不多任何 RPC。牌桌物件被回收時沒送出去的會掉，最多一副的量。

切成 5 分鐘一格、保留一小時。**社團的物件只要閒幾秒就會休眠（連線還開著也一樣）**，記憶體裡的數字會跟著不見，所以最多每分鐘把整份寫回 `meta:metrics` 一次（一列；只在有事的時候寫，一天最多 1,440 列），`load()` 時讀回來、同一格相加。不記任何人的 id：重連判斷用的「誰剛斷線」只在記憶體、60 秒後就清。

**告警**（`alertsOf`，量夠才判斷，避免一兩次就亮）：伺服器錯誤率（`crash`＋5xx）÷（動作＋請求）超過 1%（至少 50 次）、重連率超過 20%（至少 20 次連線）、動作 p95 超過 1 秒（至少 50 次）、機器人平均思考超過 0.5 秒（至少 20 步）。`/api/health` 的 `alerts` 列出亮的，管理頁「系統狀態」用紅底顯示。

**時間的限制**：Workers 裡 `Date.now()` 與 `performance.now()` 只在 I/O 之後才前進，所以這裡的耗時是「等」（RPC、儲存），不是 CPU；規則機器人的思考在正式環境會量成 0（之後有遠端的 TKB Adv 才有意義）。**每次呼叫的 CPU 在 Workers Logs 的 `$workers.cpuTimeMs`**（`DEPLOY.md` §4.7）。本機的 CPU 量法見 `docs/LOAD.md`。

**系統狀態頁**（`src/components/SystemStatus.tsx`，管理頁最後一個區塊）：讀 `/api/health`，開著時每 30 秒（分頁看得見才讀）更新一次，一次是一個 Worker 請求＋一個社團請求。外部監控（例如 UptimeRobot 免費方案）可以直接監看同一個網址的 `"alerts":[]`，要不要接由社長決定（`DEPLOY.md` §4.7）。

**沒有用的**：Workers Analytics Engine（要新增 binding，查詢要另一把 API token）、Cloudflare Notifications 的自訂告警（免費方案沒有依日誌告警）。Workers Logs 已經開著（`observability`），免費方案每天 20 萬筆、保留 3 天，足夠事後查。

**負載測試**（`scripts/load/`、`tests/worker/load-cpu.test.ts`）的方法、數字與瓶頸在 `docs/LOAD.md`。第一個撐不住的是**大廳廣播**（每次大廳有變，社團替每位在線的人算一次整份大廳）：200 人在線時一次約 1 秒，H3 先把每位觀看者共用的部分改成每次廣播只算一次（`ClubService.lobbyBasis`），降到約 0.2 秒；剩下的是每人一份約 35 KB 的 JSON。

**H3b：共用一份、只送差異、合併廣播**（2026-10-26）：
- **兩份**（可見性見 §4）：`LobbyShared` 是所有人一樣的；每次廣播社團把每位社員、每張共用桌各序列化一次（約 230 個小字串），跟上一版逐項比對，有變的組成 `LobbyDelta`（`members`／`gone`／`tables`／`closed`／`matches`，整筆換掉或刪掉），**序列化一次、同一個字串送給每一位**（`Connections.send` 多一個選填的 `data`）；沒有變就不送。整份（`lobbyShared`）只在有人需要時用各項的 JSON 拼起來，同一版只拼一次。`LobbyMine` 每人算一次、跟上次送的比，有變才送，通常幾百位元組。
- **版本**：`epoch` 是這次社團物件醒來的時間，`rev` 從 1 起算；差異帶 `base`。瀏覽器（`receiveLobby`）：`base` 等於手上的版本就套用；舊的或重複的丟掉；跳號或來自新的 `epoch` 就先留著、送一次 `lobbySync`，社團回整份，留著的差異接得上的接著套。新連線（含重連）一律先拿整份；社團被回收再醒來（連線還開著）時 `epoch` 變了，第一次廣播就給每個人整份。
- **排序**交給瀏覽器（`composeLobby`：桌子照 `lobbyOrder`、社員線上在前、好友置頂（有 `friends` 旗標時）、再照名字），「只看好友」本來就在瀏覽器。
- **合併廣播**（`ClubConfig.later`，Durable Object 用 `setTimeout`）：大廳最多每 `LOBBY_GAP_MS`（100 ms）送一次。上一次送出已經超過 100 ms 就立刻送（平常沒有延遲）；之內的變化只記下來，到 100 ms 時一起送一次。同時湧進的入座、觀看、離桌就不必每個都等一次完整的廣播。測試多半不給 `later`，每次變化立刻送，跟以前一樣。
- **日誌取樣**（`worker/log.ts` 的 `sampleActions`）：`action` 每 10 筆寫 1 筆到 Workers Logs（帶 `sample: 10`，查詢時乘回來），有錯誤代碼或超過 200 ms（`ACTION_SLOW_MS`）的一律寫；其他種類照舊。指標在取樣**之前**數（`ClubService` 與 `TableHost` 的 `log` 先交給 `Metrics`／`TableCounters`），系統狀態頁的次數不受影響。
- 數字（前後對照）在 `docs/LOAD.md` §3、§6。

## 5.14 圖片檔案（R2，淡江橋譜 `e11-t02`，2026-10-28）

討論區貼文（E11）與文章（E5）的圖片放 R2 bucket `bridgebook-files`（binding `FILES`），程式 `worker/files.ts`（`FileService`，不碰 Cloudflare API，bucket 是小介面 `FileBucket`），型別與上限 `shared/files.ts`。

- **瀏覽器做影像處理**：縮到長邊 ≤ 2048 px、縮圖長邊 480 px；Worker 只看大小與檔頭（`sniffFile`：JPEG／PNG／WebP，貼文另可 GIF），不解碼圖片（免費方案 10 ms CPU）。
- **一次性憑證直傳**：`POST /api/files/ticket { purpose: 'post' | 'article', type, size }` → `{ key, uploadUrl, thumbUrl, expires }`（10 分鐘，計入每人每天 30 張）；`PUT uploadUrl`（≤ 2 MB，型別要和憑證一致）、`PUT thumbUrl`（≤ 256 KB，要在原圖之後）；兩個都傳了或過期就作廢。上傳路由不看 session cookie、有 CORS，所以頁面也可以直接傳到 Worker 的網址。
- **簽名短效網址**：`GET /api/files/<key>?e=<到期>&s=<HMAC>`（淡江以外的社團另加 `&club=<id>`，簽章也含社團；R2 的 key 在 `clubs/<id>/` 底下，§1「多社團的隔離」），不用登入（`<img>` 跨站不帶 cookie），到期時間進位到整點再加一小時，同一小時內的網址相同、瀏覽器快取得到；`POST /api/files/urls { keys }` 重簽。金鑰是第一次用時產生的隨機值（`file:secret`），不需要另設 secret。PRD 寫的 `/_file/:key` 改放在 `/api/files/` 底下，兩站的 `/api/*` 本來就轉給 Worker。
- **刪除**：`DELETE /api/files/<key>`，上傳者、討論區幹部（`forumModerate`，橋館 G8）或管理員。帳號刪除見下面「論壇的圖片」。
- **論壇的圖片**（牌桌 `e13-t13`，2026-11-03，`worker/post-images.ts`）：牌桌的發文編輯器也能插圖（`PostImageButton`、`src/lib/postImage.ts`）：照片在瀏覽器用 canvas 縮到長邊 2048 px、寫成 WebP（不支援就 JPEG），所以拍攝地點等 EXIF 不會上傳；**GIF 原樣上傳**（才會動，≤ 2 MB，只限 `purpose: 'post'`，叢書文章仍是三種，橋館的文章編輯器不必改），縮圖一律是靜態的。SVG 一律不收。決定：
  - **誰的**：新增或編輯貼文時，新加的 `image` 區塊要是作者自己上傳的檔案（`file:meta:` 的 `owner`），否則 403 `forumImageNotYours`；本來就在貼文裡的不再檢查。所以一張圖只屬於一位作者。
  - **誰看得到**：`POST /api/files/urls` 對 `post/` 的 key 只替上傳者、或看得到用這張圖的貼文的人簽（`ForumService.imagesInUse`，條件與貼文的 `visibleTo` 相同；草稿與排程（`e13-t12`）不在列表裡，草稿的圖只有作者（上傳者）拿得到，排程中的另外給幹部，才能在「草稿與排程」預覽）；文章與電子書照舊。幹部隱藏貼文後，作者與幹部以外的人拿不到新網址；**已經發出的網址不撤銷**，最多到期（進位到整點再加一小時，最長約兩小時）就失效：網址是無狀態的 HMAC，撤銷要每次請求查資料，不划算。
  - **跟著貼文走**：刪貼文（作者、幹部、處理檢舉的「移除」）或編輯時拿掉圖片，沒有其他貼文用的就從 R2 刪掉（回應之後做，失敗只記 log）。上傳了沒發的圖片留著，直到上傳者刪帳號。
  - **刪帳號**：`ClubService` 的 `onMemberRemoved` 先刪他的論壇草稿與排程中的貼文（`ForumService.forgetUnpublished`，社長 2026-11-03），再呼叫 `FileService.forget`：沒有任何貼文用的 `post/` 圖片刪掉（所以草稿與排程裡的圖片也一起刪）、當天的計數刪掉；還在貼文裡的跟貼文保留（貼文本來就保留）；文章圖片與電子書是叢書的，不刪。匯出（`GET /api/account/export`）多一個 `files`：自己上傳的檔案清單。
  - **回應標頭**：`Content-Type` 是上傳時從檔頭判斷的型別、`X-Content-Type-Options: nosniff`、`Content-Disposition: inline`、`Content-Security-Policy: default-src 'none'`、`Cache-Control: private, max-age=<到期>, immutable`。網頁 CSP 不用改（`img-src 'self'`，圖片走同源 `/api/files/`）。
  - **速率**：沿用每人每天 30 張憑證（台灣日期）與全部 10 GB 的上限；每篇最多 6 張（`FORUM_LIMITS.imagesMax`，編輯器送出前就擋）。
- **沒有 bucket 時**：`FILES` 沒綁就全部回 503 `filesOff`，所以 binding 先註解掉也能部署（DEPLOY.md §4.8）。
- **電子書 PDF**（淡江橋館 `e5-t09`～`e5-t11`，2026-10-29，`shared/ebooks.ts`、`worker/ebooks.ts`）：同一個 bucket、同一套憑證與簽名網址。`POST /api/book/ebooks/ticket { size }`（`bookReview`）→ 一般的 `FileTicket`，key 是 `ebook/<hex>.pdf`；`PUT uploadUrl` ≤ 50 MB、檔頭要是 `%PDF-`、沒有縮圖（傳完憑證就作廢）；上傳路由依憑證決定讀多少（`uploadMax`）。PDF 也是讀進記憶體再寫 R2（50 MB 在 Durable Object 的 128 MB 內）。書的紀錄 `POST /api/book/ebooks`、`PUT`／`DELETE /api/book/ebooks/:id`（`bookReview`，必填授權 `own`／`permitted`／`members-only`；換 PDF 或下架會一併刪掉舊 PDF；稽核 `ebook:save`／`ebook:remove`）。讀取 `GET /api/book/ebooks[/:id]` 不用登入，但未登入時 `members-only` 的書不在列表、單本回 404，所以連結與 PDF 網址都拿不到；PDF 的網址 15 分鐘（進位到 5 分鐘）就失效。簽名網址的回應加 `Access-Control-Allow-Origin: *`（簽名就是檢查），橋館的 PDF 閱讀器直接向 Worker 抓，不經 Vercel 轉址。
- **用量提醒**（橋館 `e5-t15`）：`file:usage` 隨上傳與刪除增減；越過 8 GB（`STORAGE_LIMITS.warnBytes`）時通知每位管理員一次（`filesNearlyFull { gb }`，連到橋館的電子書頁），降回 8 GB 以下再越過才會再通知；會超過 10 GB 的憑證回 507 `fileStorageFull`。編輯者在 `GET /api/book/ebooks` 的回應多一個 `usage`。
- **頭像不搬到 R2**：仍是 `avatar:<userId>`（256×256、≤ 64 KB，見 §5 的表），兩站都讀 `GET /api/avatar/:id?v=`。`GET /api/club/members` 多回 `displayName`、`avatar`，橋譜用來畫別人的頭像（`e11-t01`、`e11-t03`）。
- **顯示名稱上名牌**（`e11-t19`）：大廳的社員與大廳牌桌的座位（`PublicUser.displayName`）帶個人檔案的顯示名稱，改名時重送大廳；牌桌自己的座位與牌局紀錄仍只有帳號名稱，牌桌頁用 `withMemberProfile`（`shared/lobby.ts`）從大廳補上頭像與顯示名稱。`playerName` 有顯示名稱就用它，社員分頁的提示仍附帳號名稱。
- **論壇型別**（`e11-t05`）：`shared/forum.ts` 的 `Board`、`Post`、`PostBlock`、`Comment`、`Reaction`、`Report` 與上限，橋館 `src/lib/forum.ts` 是逐字複本（橋館的型別對拍檢查）；Worker 模組 `worker/forum.ts` 是 `e11-t06`。
- **論壇 Worker**（`e11-t06`、`e11-t07`，`worker/forum.ts` 的 `ForumService`）：Durable Object 的 SQLite，五張表 `forum_boards`（內建四板在建表時補上，`INSERT OR IGNORE`，所以管理員改的名稱與排序會保留；內建的不能刪，有貼文的板也不能刪）、`forum_posts`（區塊與 `mentions` 存 JSON；`pinned_at` 是置頂時間，新置頂的在前，就是 `Board.pinnedPostIds`；`comment_count` 跟留言一起維護）、`forum_comments`（巢狀一層：回覆別人的回覆，`parent_id` 一律是最上層那則）、`forum_reactions`（主鍵 target＋id＋社員，每人每則一種，換表情是覆寫）、`forum_reports`（檢舉，`e11-t09`）。不經記憶體快取；五張表都在每日備份裡（§5 備份，2026-10-30 起；私訊不在）。區塊逐一檢查、只留該種類有的欄位：牌不重複、四家牌每家 ≤ 13 張、叫牌過程輪到誰與合不合規則（`legalCalls`）、圖片要是 `post/` 的檔案 key；文字（段落、提示、條列）合計 ≤ `FORUM_LIMITS.postTextMax`，留言 ≤ `commentTextMax`、只能有 `paragraph`／`auction`／`hand`。`@` 提到（`mentionsIn`）認帳號名稱（不分大小寫）與顯示名稱，最長的先配；名稱以英數結尾時後面不能接英數，中文不受限；e-mail 裡的 `@` 不算；結果存在 `Post.mentions`／`Comment.mentions`。速率：每人發文加留言每分鐘 ≤ 5（`TokenBuckets`，回 429 `slowDown`；編輯不算、被拒的不算）。幹部（`moderatesForum`，roles.ts）是有 `forumModerate` 權限的社員與管理員（`e11-t09`）：只有幹部能在 `postPolicy: 'officers'` 的板（公告）發文、置頂、鎖定、刪除別人的貼文與留言；鎖定的貼文只有幹部能留言。作者才能編輯自己的貼文與留言；刪貼文連同留言與反應，刪最上層留言連同它的回覆。路由見 §5.2 的表（`/api/forum/*`）。帳號刪除時不刪已發布的貼文；草稿與排程中的貼文一起刪（2026-11-03，見 §5.19「公告與新聞的編輯流程」）。
- **論壇通知**（`e11-t08`，`worker/forum-notices.ts`，AC-11.5）：走通知中心，四種 `forumMention`（新貼文或留言用 `@` 提到；編輯後新提到的人）、`forumReply`（貼文被留言通知作者；回覆通知那則最上層留言的作者）、`forumAnnouncement`（`postPolicy: 'officers'` 的板有新貼文，通知全部社員）、`forumPinned`（貼文被置頂通知作者），參數 `{ postId, title, username }`（`title` 是標題，沒有就是前 40 字，`postExcerpt`）＋留言的 `commentId`。同一則每人只收一種（提到＞回覆＞公告），自己做的不通知、已不是社員的不通知；鈴鐺連到貼文 `/forum/p/<id>`（有留言時 `#comment-<id>`，貼文頁讀完後捲到那則留言）：有 `forum` 旗標的社員連牌桌自己的論壇（K3 `e13-t09`），沒有的連橋館。寄送失敗只記 log，貼文照樣存。
- **檢舉與審計**（`e11-t09`，AC-11.6）：社員檢舉別人的貼文或留言（`POST /api/forum/reports`，原因 ≤ 300 字；同一則在處理前再檢舉只更新原因；每人同時最多 20 則未處理，409 `forumReportLimit`）。幹部看清單（`GET /api/forum/reports?status=open|all`，新→舊最多 100 則，附貼文 id、作者與摘要；已刪除的沒有 `postId`），處理（`POST /api/forum/reports/:id` `{ action: 'dismiss' | 'remove' }`）：駁回保留內容，移除就刪掉那則（貼文連留言、最上層留言連回覆）；同一則的其他未處理檢舉一起關閉。任何人刪掉貼文或留言時，關於它的未處理檢舉都關成 `removed`。幹部的動作寫審計（`audit:`，`worker/audit.ts`）：`forum:pin`／`unpin`、`forum:lock`／`unlock`、`forum:removePost`／`removeComment`（刪別人的；`note` 是誰的、摘要與檢舉原因）、`forum:dismiss`、`forum:board`／`boardDelete`（管理員增改刪板面），`target` 是貼文或板面的代號；橋館管理頁的審計紀錄看得到。板面代號不能用 `new`、`p`、`manage`、`reports`（橋館討論區的網址）。

## 5.15 淡江橋館的錯誤回報與匿名使用統計（橋館 `e10-t06`、`e10-t07`，2026-10-30）

橋館的設計方向：存在社團 Durable Object 的 SQLite（`worker/book-telemetry.ts` 的 `BookTelemetry`，只透過 `Sql` 介面），不引入第三方服務。型別在 `shared/protocol.ts` 的 `BookClientError`、`BookAnalytics*`，橋館 `src/lib/api.ts` 逐字複製。路由見 §5.2 的表。

- **兩個寫入路由都不用登入，也不讀登入身分**：`club.ts` 在查 session 之前就處理 `POST /api/book/errors` 與 `/events`，所以存下來的東西和社員帳號無關。全社團各一個 token bucket（錯誤同 `/api/client-errors` 的突發 20、每秒 1；使用事件突發 100 批、每秒 10 批），超過就丟掉、照樣回 204，不讓瀏覽器重送。
- **錯誤回報**（`book_errors`）：只留已知欄位，用 `client-errors.ts` 的上限截斷（訊息 500、堆疊 2,000、來源與頁面 200、版本 40 字）、再用 `shared/scrub.ts` 去除一次個資（網址的 query 與 fragment、e-mail、6 位以上數字）；`page` 只留路徑。同樣的 `kind`＋`message`＋`source`＋`page` 合成一列（`count` 加一、`at` 與堆疊、版本換成最新的），只留 `at` 最新的 100 列。每則也照舊寫進日誌（`clientError`，多 `site: 'book'`）。
- **使用統計只存彙總**：
  - `book_metrics(day, type, key, count)`：UTC 日期、種類、鍵、次數。`page` 的鍵是路徑（去掉 query 與 hash、≤ 200 字、去除個資）；在特約頁時另記 `convention`＝slug；`search` 是讀者停下來的搜尋詞（去頭尾空白後 ≤ 50 字，存成小寫、空白合併）；`profile` 是切換到的制度集種類（`club`／`team`／`pair`／`personal`，**不存制度集 id**）；`quiz` 是 `<slug>:<true|false>`。保留 **180 天**。
  - `book_visitors(week, visitor)`：`visitor` 是瀏覽器每個 ISO 週自己產生的亂數，只用來算每週不重複人數（週一 UTC 為一週）；保留 **13 週**（本週＋前 12 週，剛好是圖表要的）。
  - **不存**：社員 id、帳號名稱、制度集 id、IP、User-Agent、完整網址、單一事件的時間或順序；`book_metrics` 和訪客 id 之間沒有連結，所以看不出誰讀了什麼。
  - 清理：寫入時，每天（UTC）第一次寫入順便刪掉超過保留期的列，不另設排程。
- **開關**：`book_telemetry_settings` 的 `analytics`，預設開；管理員用 `PUT /api/book/analytics/settings` 關掉後，`POST /api/book/events` 整批丟掉（已存的彙總留著，照保留期過期）。錯誤回報不受這個開關影響。
- **查詢**（`GET /api/book/analytics`，編輯者與管理員）：最近 12 週（含本週，舊→新，沒資料的週補 0）的不重複訪客與頁面數；最近 28 天（含今天，UTC）的熱門特約、熱門搜尋（各前 20）、切換制度集次數、練習作答與答對數。
- **不在每日備份裡**（`BACKUP_TABLES` 只列討論區的表）：都是可以重新累積的統計，還原時也不清空、不覆寫這四張表，所以開關的設定在還原後照舊。

## 5.16 動作事件紀錄、叫裁判與裁定（`e2-t32`～`e2-t35`，2026-10-30）

- **事件紀錄**（`shared/board-events.ts` 的 `BoardEvent`）：發牌時 `Table.events` 從一筆 `deal` 開始；`applyAction` 每接受一個叫品、出牌、攤牌、攤牌的同意／拒絕就追加一筆（`at` 是伺服器時間，機器人的動作也一樣），撤回被同意時追加一筆 `undo`（記下撤回後剩幾個叫品、幾張牌），**不刪任何一筆**（append-only）。這一副打完，`recordBoard` 把整串連同 `startedAt`、`hostId` 寫進 `BoardRecord`；收起不留紀錄的副（`putAway`）連事件一起丟。一副大約 70 筆、3 KB，跟著牌桌每次 `save()` 寫回 `Store`，CPU 只多一次小 JSON 序列化。舊紀錄沒有 `events`。
- **依時間重播**（`e2-t33`）：`actionTimes` 重跑事件（`undo` 截掉被撤回的時間）得到最後留下的每個叫品與每張牌的時間，對不上紀錄（舊紀錄、Just Declare 的叫牌）就是 `null`，重播不顯示「照實際速度」。`realGaps` 算每張牌前要等多久（第一張從最後一個叫品算），最短 `REAL_GAP_MIN_MS`、最長 `REAL_GAP_MAX_MS`（30 秒，有人離開座位時不用真的等）。計算全在瀏覽器。
- **叫裁判**（`e2-t34`）：社團訊息 `callDirector`（只有入座者；挑戰桌、練習桌是 `directorNotHere`）：牌桌記 `directorCall`、`TableEntry` 也帶著，社團通知房主（不是自己時）與所有管理員（`directorCalled`，點了到 `/table/:id`）。房主與管理員在有人叫裁判時 `joinTable` 走 `join(person, true)`：不管存取模式與「允許觀看」，以觀看者身分進桌（隊制賽的參賽者除外）。`clearDirector`：房主、管理員或叫的人。
- **裁定**（`e2-t35`）：`POST /api/history/:id/ruling` `{ ruling }`：紀錄上的房主（`BoardRecord.hostId`，舊紀錄沒有就只有管理員）或管理員；`avg`、`avgPlus`／`avgMinus`（＋`side` 給哪一方）、`score`（＋`scoreNS`，10 的倍數、絕對值 ≤ 7600），理由同隊制賽（1–200 字）；`ruling: null` 撤銷。紀錄的 `board.result` 保留實際打出的結果，`ruling` 另外記；`writeRecord` 重寫紀錄、兩份摘要並排進 D1 副本。`BoardSummary.ruling` 讓紀錄列表標「裁定」，所以 `REPLICA_VERSION` 改成 2。裁定**接進計分**見下一點（`e2-t36`）；比賽的計分調整、處罰與其他裁判工具是 `e9-t17`（§5.23），從 `e9-t17` 起每一次裁定（給、改、撤銷）也寫進那場比賽的裁判紀錄與稽核紀錄。
- **裁定接進計分**（`e2-t36`）：`indexRecord` 把紀錄的裁定（只有種類、哪一方、分數）寫進社團 SQLite 的 `board_rulings`（不複製到 D1，所以 `REPLICA_VERSION` 不變；`BoardSummary` 也沒改），`ruleBoard` 改完紀錄就重新 `indexRecord`，撤銷就刪掉那一列；隊制賽的副會推送新的比分給參賽者與觀看者。`eventBoards` 一起讀出裁定，挑戰的排名（`challengeStandings`，大廳的挑戰列表也一樣）與隊制賽的比分（`boardScores` → `scoreTeamMatch`）每次顯示時用它重算，不回寫任何結果，所以撤銷後自然回到實際結果。定義在 `shared/ruling-scoring.ts`（Laws of Duplicate Bridge 2017）：
  - **指定分數**（`score`，Law 12C1）：當作那一副打出這個南北分數，大家照常和它比。
  - **Avg／Avg+／Avg-**（人為調整分，Law 12C2）：MP 是 50%／60%／40%（Law 12C2(a)；「Avg+ 取 60% 與該場平均較高者」不採用），IMP 是 0／+3／−3（Law 86A）。拿到人為調整分的那一個結果**不和任何人比**，其他人只和沒有人為調整分的結果比（只剩自己就是 50% 或 0 IMP）。挑戰的參賽者坐南，裁定給 NS 就是給他，給 EW 就是反過來（Avg+ EW＝他 Avg-）。挑戰的 `total`（總分）沒有通行的定義，採用：Avg＝其他人在這一副的平均分（四捨五入到 10），Avg±＝再 ±100 分（約等於 IMP 的 ±3）。對戰表（`headToHead`）用指定分數比，有人為調整分的那一副不比。
  - **隊制賽**：某一室的指定分數取代那一室的南北分數；某一室的 Avg 類給那一室那一方的隊（開室 NS＝A、閉室 NS＝B），照房主裁定的同一張表（IMP ±3、BAM 0.6／0.4），另一室的結果不比；兩室都有 Avg 類時 IMP 相加、BAM 取平均。**房主用 `matchRule` 裁過的副以房主的裁定為準**，那一副兩室紀錄上的裁定只顯示在紀錄頁、不計分，所以不會重複計。
  - 介面：挑戰結果頁與牌局頁成績表的南北分數下標「裁定 Avg+ NS」（`RulingTag`），排名列標「裁定：第 n 副」；隊制賽結果頁那一副標「裁定」，那一室的分數下標裁定。
  - `e2-t36` 上線前下的裁定不在 `board_rulings` 裡，要重新送一次才會計分。

## 5.17 防作弊報表（`e11-t25`，2026-11-01）

AC-11.8 的後半：「同 IP／同裝置多帳號同場等可疑行為有管理員報表」。只做社團內部（不跨社團、不跨站）。

- **蒐集什麼**（`worker/integrity.ts` 的 `Sightings`）：社員**登入**（`/api/login`、第一個帳號的 `/api/register`）與**每次連上社團的 WebSocket**（`/ws`）時，`Club` 呼叫 `ClubService.noteSighting`，記在 `seen:<userId>`：
  - **網路**：`CF-Connecting-IP` 加鹽做 SHA-256，取前 16 個十六進位字。鹽是 **Worker secret `SEEN_SALT`**（`wrangler secret put SEEN_SALT`，DEPLOY.md §3；`Club` 從 `env` 讀，經 `ClubConfig.seenSalt` 交給 `ClubService`，`ClubService` 不碰 Cloudflare API），**不在社團的儲存裡**，所以單拿到儲存（或備份）的人無法窮舉 IPv4 還原。**IP 位址本身不寫進儲存**；同一個位址在同一個 secret 下永遠是同一個雜湊，所以比得出來。
    - **沒設 `SEEN_SALT`**（或少於 16 字，`SEEN_SALT_MIN`，當作沒設）：**不記網路**（`net` 存空字串），只記瀏覽器，所以只會出現「同一個瀏覽器」的線索、沒有「共用網路」；報表帶 `networkOff: true`，管理頁在報表上方說明要設 secret；社團物件每次醒來第一次遇到有位址的登入時記一筆日誌 `seenSaltMissing`。
    - **換 secret** 之後新舊雜湊不相容：舊的網路紀錄不會和新的配對，最多 90 天後自然清掉。不同環境（正式站、staging、預覽）各自的 secret 也互不相容。
    - PR #242 原本把隨機鹽存在社團儲存的 `meta:seenSalt`，社長 2026-11-02 決定改用 Worker secret；那個版本沒有上過正式站，只有 PR 預覽可能存過 `meta:seenSalt` 與用它算的雜湊：程式不再讀它，舊雜湊直接作廢（預覽站在 PR 關閉時整個刪除）。
  - **瀏覽器**：cookie `tbt_device`（`worker/auth.ts` 的 `deviceCookie`：HttpOnly、SameSite=Lax、1 年、隨機 12 bytes），登入時沒有就發一個；已經登入的瀏覽器在下一次 `/api/me` 拿到。它**不是登入憑證**，誰用這個瀏覽器登入都一樣；兩個帳號出現同一個 id＝同一個瀏覽器。格式不對的值（不是我們發的）不記。
  - 加上 `deviceLabel` 的瀏覽器與系統名稱（跟「登入中的裝置」一樣），給報表顯示。
  - 每人最多 16 筆（`INTEGRITY_LIMITS.perMember`），90 天以上的丟掉；同一個網路＋瀏覽器一小時內只寫一次（`SIGHTING_STEP_MS`），所以重連只多一次讀取。記錄失敗不影響登入或連線。
- **報表**（`GET /api/admin/integrity?days=7|30|90`，預設 30；`ClubService.adminIntegrityReport` 先 `requireAdmin`，`Club` 的路由也只給管理員）：
  1. `findLinks`（`shared/integrity.ts`，純函式）：期間內，兩個現存帳號用過**同一個瀏覽器**，或用過**同一個小網路**（用過的社員 ≤ 4 人，`INTEGRITY_LIMITS.sharedNetwork`）就成一組。超過 4 人的網路（社辦、校園、行動網路的 NAT）**不配對**，只列在「共用網路」並顯示人數與雜湊的前 6 碼。
  2. 依「同瀏覽器 → 網路數 → 最近」排序，最多看 40 組（`INTEGRITY_LIMITS.pairs`，其餘只報數量 `more`）。每組在 `Club` 的 SQLite 紀錄索引（`board_players`、`boards_index`，§5.3）查兩次（都走 `players_by_user`）：期間內**同桌**的副數（搭檔、對手）與最近 5 副的 id；**同一場挑戰或隊制賽**（`mode IN ('challenge','team')`、同一個 `event_id`），以及誰的牌全部在對方打完之後才打（`after`：挑戰的場外資訊風險；隊制賽兩室同時打就是 `null`）。
  3. 線索強度（`integrityLevel`）：**強**＝同瀏覽器且一起打過；**中**＝同瀏覽器，或小網路且一起打過；**弱**＝只有小網路。
- **成本**：一份報表＝列出 `seen:`（每位社員一筆）＋最多 80 次有索引的小查詢，在 `Club` 裡跑；只有管理員按「產生報表」才跑，管理頁打開時不跑。不用 D1 副本，所以 `REPLICA_VERSION` 不變；`summarize`、`BoardSummary` 沒改。
- **可見性**：報表只有帳號名稱、瀏覽器名稱、網路雜湊的前 6 碼、次數與牌局／比賽的連結，**沒有任何一手牌**；點紀錄連結照舊走 `recordVisible`（還沒公開的挑戰牌，管理員一樣看不到）。`worker/views.ts` 不變。報表不通知任何人、不自動處理。
- **個資**：`seen:` 在「下載我的資料」裡（`signIns`），帳號刪除時一起刪（`dropMember`），不在每日備份裡。隱私權政策（`legal.privacy`）寫了蒐集什麼、保留多久與這個 cookie。
- **社長決定**（2026-11-02）：上線；網路雜湊的鹽改用 Worker secret `SEEN_SALT`（上面「網路」）。其他維持保守的預設：只有管理員看得到（幹部不行）、只在管理員按下時產生、出現「強」的線索也不主動通知、超過 4 人算共用網路、最多看 40 組、保留 90 天。

## 5.18 比賽共同模型與每日賽（決策紀錄，`e9-t01`～`e9-t03`，2026-11-02）

### 共同模型：`Event → Rounds → Tables → Boards`（`e9-t01`）

E9 之後的比賽（雙人賽、多隊賽、個人賽）都用同一個模型描述；現有的挑戰（§5.5）與隊制賽（§5.8）是它的特例，**不改它們的資料表**，只是用這個詞彙說明它們，新的比賽照它加。

| 層 | 意思 | 挑戰（含每週、每日） | 隊制賽 | 雙人賽（`e9-t09`～`e9-t13`） | 多隊賽（`e9-t14`） | 個人賽（`e9-t15`） |
| --- | --- | --- | --- | --- | --- | --- |
| **Event** | 一場比賽：設定、參賽者、狀態、計分方式、期限 | `challenges` 一列（`Challenge`） | `matches` 一列（`TeamMatch`） | 一場雙人賽 | 一場多隊賽 | 一場個人賽 |
| **Round** | 同時打的一段；輪與輪之間換對手或換桌 | 只有 1 輪 | 1 輪；分段（`segmentBoards`）是同一輪裡的段，中場可換人 | 多輪，Mitchell／Howell 移位（之後的 `shared/movement.ts`，`e9-t09`）決定每輪誰在哪桌打哪幾副 | 每輪一次配對（循環或瑞士制），一輪就是一場隊制賽 | 多輪，每輪換搭檔 |
| **Table** | 一張牌桌（四個座位） | 每個參賽者自己一桌（坐南，其他三家是 TKB），各自什麼時候打都可以 | 2 桌：開室、閉室（`room`） | 每輪 N 桌同時開打（`mode=pairs`） | 每場 2 桌 | 每輪 N 桌 |
| **Board** | 一副牌在一桌打出的結果 | 牌組（`DealSet`）在每人桌上各打一次；`challenge_results`（人 × 副）指向 `board:<id>` 紀錄 | 同一副在兩室各打一次（`match_boards`） | 同一副在多桌各打一次（traveller） | 同隊制賽 | 同雙人賽 |

- **計分在 Event 層**：同一副在不同桌的結果互相比（`shared/challenge-scoring.ts` 的 MP、Cross-IMP、總分；`shared/team-scoring.ts` 的 IMP／BAM；`shared/vp.ts` 的 VP），裁定照 §5.16 一起算。雙人賽不同副打的次數不同時用 Neuberg 調整（`e9-t12`）。
- **一副牌的紀錄一律是 `BoardRecord`**（`board:<id>`，§5.3），Event 只記「誰、哪一副、哪一筆紀錄、南北分數」，重播、traveller、裁定都從紀錄來；比賽進行中用 `revealAt` 擋住還沒打的人（§4）。
- **Event 住在哪**：`EVENT_OBJECTS=on` 時每場挑戰一個 `EventObject`（§5.12 H2b），隊制賽在 H2c 搬進去；新的比賽也是一場一個物件，`Club` 只留目錄與「社團才做得到的事」（通知、帳號、副本）。
- **新比賽要加的**：Round 與 Table 的對應（移位或配對）是新的、純函式放 `shared/`；開桌重用牌桌模式（`worker/modes.ts`）；Board 與計分重用上面那些。積分（`e9-t04`～`e9-t06`）以 Event 為單位結算，每筆記來源 Event 的 id。

### 每日賽（`e9-t02`、`e9-t03`）

**每日賽就是一場挑戰**（`settings.daily = true`），走挑戰的整套流程：牌組、牌桌、結算、排名、可見性、結果頁（`/challenges/:id`）、兩種 `EVENT_OBJECTS` 路徑都一樣，所以不碰 `EventObject` 與隊制賽的程式。排程照每週挑戰（`e7-t23`）的做法另寫一份。

- **設定**（`shared/daily-event.ts`、`worker/daily-event.ts`）：管理員在 `/daily` 開關、選機器人的制度。`POST /api/admin/daily-event`（`ClubService.adminSetDailyEvent`，錯了回 `badChallengeSettings { field }`），存在 KV 的 `meta:daily`（`DailyState`：設定、存的人、存的時間、上一場的 00:00、每一天的 `{ day, challengeId }`）。副數（8）、計分（MP）、天數（1）、`ranking = club` 是 AC-9.1 定的，不給改。
- **開關用社團設定，不用功能旗標**（`shared/features.ts`）：每日賽是全社一起的活動（不是某些人先試用的功能），而且要跟著存「誰建立、用哪種機器人」，跟每週挑戰的排程一樣是社團設定。**預設關**：社團人少，每天一場可能沒人打。
- **工作**：`daily:<存的時間>`（`JobKind` 的 `daily`），排在「存檔之後、上一場之後」的第一個台灣時間 00:00（`nextDailyRun`、`dailySlotAfter`），存檔不會立刻開一場（開啟後從下一個 00:00 開始）。到時先寫 `lastRunAt` 再建立，失敗也不會開兩場；物件睡過好幾天只開今天這一場。挑戰的 `createdAt` 寫成那天的 00:00（不是工作真的跑的時間），所以截止一定是隔天 00:00。
- **建立**（`createDailyEvent`）：跟每週挑戰一樣邀請全社、發起者是存設定的管理員（不是管理員了就用最早的管理員）、全社只有他一人時不開、只有兩人時 MP 改 IMP。差別：**不發任何通知**（不發建立通知、不發截止前提醒、接受也不通知發起者；只有打完的人在結束時收到結果通知），**不出現在挑戰大廳**（`challengeList` 排除；不然每人每天多一張卡），不能再戰（`dailyNoRematch`）。00:00 之後才加入的社員不在今天這一場，明天開始。
- **頁面**（`GET /api/daily` → `DailyEventView`，`src/pages/DailyPage.tsx`）：今天的賽（狀態、截止、自己打了幾副、「開打／繼續打」、目前名次）、昨天的排名、之前的歷史列表（最多 30 天，每天打完的人數，連到那一天的結果頁）。今天、昨天的挑戰都經 `challengeFor`（§4 的 `challengeView`），所以**今天的名次只有自己打完 8 副才看得到**，昨天的（結束了、`ranking = club`）全社都看得到。「開打」對還是「受邀」的人先送接受再送 `playChallenge`。挑戰頁的頁首在每日賽開著時（或管理員）多一個「每日賽」按鈕；挑戰結果頁的「返回」對每日賽回 `/daily`。
- **積分與 rating** 見 §5.21。**還沒做**：全台灣規模時「邀請全社」要改成「點開打才加入」（`EventObject` 加一個加入的動作，等 H2c 合併後再做），挑戰的回報也要改成只送變的部分（§5.12）。

## 5.19 論壇（決策紀錄，`e13-t01`，2026-11-02，K1）

E13 要的「牌桌論壇」開工前先對照了淡江橋館：**論壇的後端已經在這個 Worker 裡**，是橋館 E11 做的，當初就寫成讓牌桌的 E13 接手（橋館 AC-11.8）。所以 K1 不重做 schema 與 API，只寫這份設計、補牌桌缺的頁面。

### 對照結果：已經有的、缺的

| 部分 | 現況 | 在哪 |
| --- | --- | --- |
| 型別與上限 | 有 | `shared/forum.ts`（`Board`、`Post`、`PostBlock`、`Comment`、`Reactions`、`Report`、`FORUM_LIMITS`）；橋館 `src/lib/forum.ts` 是逐字複本、型別對拍 |
| 資料表與 API | 有（橋館 e11-t06、e11-t07、e11-t09、e11-t10） | `worker/forum.ts` 的 `ForumService`，路由 `/api/forum/*`（§5.2 的表），權限 `roles.ts` 的 `forumRouteNeed`／`moderatesForum` |
| 通知 | 有（橋館 e11-t08） | `worker/forum-notices.ts`：被提到、被回覆、公告、被置頂 |
| 備份 | 有 | 五張表在每日備份裡（§5 備份，格式第 3 版） |
| 單元測試 | 有 | `tests/worker/forum.test.ts`、`tests/worker/forum-notices.test.ts`、`tests/engine/forum.test.ts` |
| 橋館的頁面 | 有、已上線 | 橋館 `src/forum/*`：討論區首頁、板面、貼文、發文編輯器、反應、檢舉、管理、搜尋、我的貼文 |
| **牌桌的頁面** | **缺** → K1 補 | `src/pages/ForumPages.tsx`、`src/components/ForumBlocks.tsx`、`src/lib/forum.ts` |

`e13-t02`（schema、`worker/forum.ts`、單元測試）因此實質上已完成；K1 只在牌桌加功能旗標與頁面。

### 決策：牌桌與橋館共用同一份資料與同一套 API

牌桌的論壇與橋館的討論區是**同一個論壇**：同一個 `ForumService`、同一份資料表、同一套 `/api/forum/*`，兩站各自畫自己的頁面。理由：

1. **同一批人、同一套帳號**（§5.2）。分成兩份，社員要在兩個地方找討論，通知也會各來一份。
2. **後端本來就是為 E13 寫的**：型別在 `shared/`、模組不依賴橋譜、不碰 Cloudflare（只透過 `Sql`），牌桌直接用，不必搬。
3. **貼文是結構化區塊、不是 HTML**：資料一樣，兩站用各自的元件畫（牌桌用自己的花色顏色與 `AuctionBox`），不必為了樣式分資料。
4. **權限、速率限制、檢舉、審計、備份只做一次**，不會兩邊規則不一致。

代價：改 `shared/forum.ts` 或 API 要一起改橋館（`src/lib/forum.ts` 與 `src/lib/forumApi.ts`，對拍會抓到型別不一致）；牌桌之後加的區塊種類（K2 的牌局區塊等）橋館也要能畫，所以新的區塊種類要先在 `shared/forum.ts` 定好、兩站同時上。

### 儲存：先留在 Durable Object 的 SQLite，不搬 D1

E13 的 PRD 原本寫「貼文與留言進 D1」。現況是社團 Durable Object（`Club`）的 SQLite，五張表 `forum_boards`、`forum_posts`、`forum_comments`、`forum_reactions`、`forum_reports`（欄位與規則見 §5.14 後的「論壇 Worker」）。K1 **不搬**：

- 量小：只有社團內部的社員，一頁 20 則、每人每分鐘最多 5 則發文加留言；DO 的 SQLite 綽綽有餘。
- 一致：發文、通知、審計在同一個物件裡，不必處理跨資料庫的一致性。
- 已在每日備份裡，還原流程也寫好了。
- PRD 的風險「與牌桌搶資源」不成立：論壇的請求走 `Club` 的 HTTP，不進每桌的 `TableObject`（§5.10），也不經 WebSocket。

**什麼時候搬 D1**：多社團或全台灣公開（Phase N、全台灣橋手清單），或全文搜尋要用 FTS5（K4 `e13-t11`）時。做法比照 §5.12（紀錄索引）：DO 仍是正本、D1 是副本或用 outbox 搬；`ForumService` 只透過 `Sql` 介面，搬時換實作即可。

### 資料模型（摘要）

- **板面**：內建四個（`BUILTIN_BOARDS`：社團公告、牌局討論、制度問答、閒聊），管理員可改名、排序、新增（最多 20 個）；`postPolicy: 'officers'` 的板（公告）只有幹部能發文。PRD 的四個板面（公告、討論、叫牌問題、新聞）對應：公告＝社團公告（也是新聞與活動）、討論＝牌局討論、叫牌問題＝制度問答，另有閒聊。
- **貼文**：標題（≤ 80 字）＋區塊（≤ 20 個）。區塊種類 `paragraph`、`rules`、`note`、`hand`、`deal`、`auction`、`image`、`ref`（橋館的制度）、`record`（牌桌的一副紀錄，只存 id）。伺服器逐一檢查：牌不重複、每家 ≤ 13 張、叫牌合規則（`legalCalls`）、圖片是 `post/` 的檔案、文字合計 ≤ 5000 字。
- **留言**：一層巢狀（回覆別人的回覆掛在同一則最上層留言下），只能有 `paragraph`、`auction`、`hand`，文字 ≤ 1000 字。
- **反應**：五種（👍♠♥♦♣），每人每則一種。置頂、鎖定在貼文上。
- **標籤**（2026-11-02 加）：每篇最多 5 個、每個最多 20 字，自由輸入、伺服器正規化；見下面「標籤、隱藏的通知、隱私擋玩家搜尋」。

### 可見性與權限（全部在伺服器）

- 只有登入的社員能讀寫（`forumRouteNeed` 都是 `member` 以上）；未登入的人看不到論壇（PRD 未決問題「公開論壇是否允許未登入閱讀」維持不開放）。
- 作者才能編輯自己的貼文與留言；刪除是作者或幹部（`forumModerate`，管理員也有）；置頂、鎖定、處理檢舉只有幹部；鎖定的貼文只有幹部能留言。牌桌頁面上的按鈕只是依同樣規則顯示，伺服器會再檢查一次。
- **貼文不會帶出不該看的牌**：`record` 區塊只存紀錄 id，點了走 `/history/:id`，可見性照 §4；「挑戰未結束的牌不能分享」在 K3（`e13-t07`）分享時由伺服器檢查。
- 不存 HTML，前端不用 `innerHTML`，文字當文字畫；圖片走同源的 `/api/files/`，CSP 不變。

### 功能旗標 `forum`（預設關）

`shared/features.ts` 的 `forum`，預設 `off`。**只管牌桌的頁面與頁首的「論壇」連結**：旗標沒開的社員看不到連結，`/forum/*` 會轉回大廳。`/api/forum/*` 不看這個旗標，因為橋館的社員已經在用同一套 API；論壇的權限照上面的角色判斷。上線步驟：管理頁「功能旗標」先開給幹部（`officers`），沒問題再全開。

### 牌桌的頁面（`e13-t03`）

網址與橋館相同，同一則貼文在兩站的路徑一樣：

| 網址 | 頁面 | 內容 |
| --- | --- | --- |
| `/forum` | `ForumHomePage` | 板面（名稱、說明、公告板標「只有幹部能發文」），下面是所有板面的最新貼文，新→舊，一頁 20 則（`GET /api/forum/feed?page=`） |
| `/forum/:boardId` | `ForumBoardPage` | 一個板面：第 1 頁先列置頂（新置頂的在前），其他新→舊，一頁 20 則（`GET /api/forum/boards/:id/posts?page=`）；頁碼在網址的 `?page=` |
| `/forum/p/:postId` | `ForumPostPage` | 貼文與全部留言（`GET /api/forum/posts/:id`）；社員寫留言、回覆（文字，可附一段叫牌過程）、刪自己的留言（幹部可刪任何人的）；作者看到「編輯」，作者與幹部看到「刪除貼文」；鎖定的貼文不顯示留言框 |
| `/forum/new?board=` | `ForumNewPostPage` | 發文（K2）：選板面（公告板只列給幹部）、標題、內容；草稿存在這台裝置（`tku-bridgetable:forumDraft`），發布後清除（`POST /api/forum/boards/:id/posts`） |
| `/forum/p/:postId/edit` | `ForumEditPostPage` | 作者編輯自己的貼文（K2）：板面不能換（`PATCH /api/forum/posts/:id`） |

- 作者名稱用大廳的社員列表（`lobby.members`，顯示名稱優先）；已不是社員的顯示「已離開的社員」。
- 區塊由 `ForumBlocks` 畫：段落、提示、條列照文字（花色符號上色，`SuitText`）；一手牌用文字牌型；**四手牌用紀錄頁的 `RecordDiagram`**（K2，`ForumDeal`：`shared/forum-editor.ts` 的 `dealRecord` 把 `ForumDeal` 轉成沒有牌號、沒有玩家的紀錄，`anonymous` 讓四家顯示方位而不是名字，`BoardInfo` 不寫牌號）；叫牌過程用紀錄頁的 `AuctionBox`；圖片（`e13-t13`）用 `POST /api/files/urls` 拿簽名網址直接顯示、點了開原圖，拿不到的（刪了或貼文被隱藏）顯示「圖片已刪除」；橋館制度、牌桌紀錄是連結。
- **發文在牌桌站內**（K2）：頁面上的「發文」開牌桌的 `/forum/new`。通知鈴鐺的論壇通知：有 `forum` 旗標的社員連牌桌的貼文，沒有的照舊連橋館（K3 `e13-t09`）。
- 檢舉、隱藏、搜尋在 K4 做了（見下面「檢舉、隱藏與搜尋」）；反應還沒排批次。編輯與刪除貼文在 K2 做了。

### 發文編輯器（K2：`e13-t04`、`e13-t05`、`e13-t06`）

**不改格式、不改後端**：編輯器送出的就是 `shared/forum.ts` 既有的區塊（`paragraph`、`rules`、`note`、`deal`、`auction`），跟橋館的發文框寫的一樣，兩站都能顯示；`worker/forum.ts` 的檢查照舊。純邏輯在 `shared/forum-editor.ts`（`tests/engine/forum-editor.test.ts`），元件測試在 `tests/presentation/forum-editor.test.tsx`。

- **文字是 Markdown 子集**（`parseMarkdown`，反過來是 `toMarkdown`，讀回來不變）：空一行分段（相鄰的段落併成一個 `paragraph`，免得超過 20 個區塊）；`- `／`* ` 條列、`1. ` 編號（兩格縮排一層，最多三層）→ `rules`；`> ` → `note`，第一行 `> [!WARNING]` 是警告；`!s !h !d !c` → ♠♥♦♣（前面緊接拉丁字母時不換）；行首 `\` 是普通文字。**沒有**粗體、斜體、連結、HTML：兩站都把文字當文字畫。
- **四手牌編輯器**（`DealEditor`）：選一家，點 52 張牌給它；點自己的牌收回、點別家的牌搬過來；一家滿 13 張就不能再給，並自動換順時針下一家沒滿的；三家滿了可以「其餘給第四家」。發牌與身價用下拉選單。規則同伺服器：**每張牌只在一家、每家最多 13 張、至少一張**；**允許部分牌例**（兩手牌、殘局），畫面寫出還有幾張沒分配。
- **叫牌過程輸入**（`AuctionEditor`）：沿用牌桌的叫牌盒 `BiddingBox`（含 Alert 說明與鍵盤），只開放 `shared/auction.ts` 的 `legalCalls` 允許的叫品，所以送出的一定合法；可收回一個、清除、換發牌者（叫品順序不變、座位跟著轉）。叫牌可以只寫到一半（叫牌問題）；結束時顯示合約與莊家。叫牌盒聽整個視窗的鍵盤，所以一頁同時只開一個。
- **發文編輯器**（`PostEditor`）：一篇貼文是一串「片段」（`EditorPiece`）：文字、四手牌、叫牌過程、圖片（`e13-t13`：先上傳，可寫替代文字與說明），可上移、下移、移除；四手牌與叫牌一次只展開一個編輯，其他顯示成貼文的樣子。編輯橋館寫的貼文時，牌桌不編的區塊（單手牌、制度引用、牌桌紀錄）原樣保留、只能移動或移除。送出前列出伺服器會擋的問題（`postProblems`：空的、超過 20 個區塊或 5000 字、標題超過 80 字、超過 6 張圖片、四手牌或叫牌不合規則）。
- **留言可以附叫牌過程**（PRD「留言也可嵌入叫牌過程」）：留言框的「加叫牌過程」，送出 `paragraph`＋`auction`。
- **莊位與首攻**：PRD 的 `e13-t05` 寫了莊位與首攻，但 `ForumDeal` 只有四家牌、發牌與身價；莊家可以從同一篇的叫牌過程看出來。要存首攻得在 `ForumDeal` 加欄位，而橋館的型別對拍（`parity/table-types.ts`）是 `Same`，要兩站一起改，K2 先不做。

### 檢舉、隱藏與搜尋（K4：`e13-t10`、`e13-t11`）

開工前先對照了橋館：**檢舉（e11-t09）、速率限制（每人每分鐘發文加留言 ≤ 5）、搜尋（e11-t10）的後端都已經有**，橋館的討論區也有頁面。K4 只補兩個後端缺口（隱藏、搜尋限定板面），其他是牌桌的頁面。

| 部分 | 現況 | K4 做的 |
| --- | --- | --- |
| 檢舉 | 有（`POST /api/forum/reports`，每人未處理 ≤ 20） | 貼文頁每篇貼文、每則留言（不是自己的）有「檢舉」，填原因送出 |
| 處理檢舉 | 有（`GET`／`POST /api/forum/reports…`，駁回或刪除） | 幹部的 `/forum/reports`：待處理／全部、檢舉人、原因、作者與摘要、連到貼文（留言連到 `#comment-<id>`）；不處理、刪除內容、隱藏（只有貼文） |
| **隱藏** | **沒有** | 新增（下面） |
| 速率限制 | 有（`TokenBuckets`，429 `slowDown`）；檢舉靠「每人未處理 ≤ 20」 | 不改 |
| 搜尋 | 有（標題與文字區塊，`LIKE`） | 加 `&board=` 限定板面；牌桌的 `/forum/search` |
| 標籤 | 資料模型沒有標籤 | K4 不做；社長 2026-11-02 決定加，見下面「標籤、隱藏的通知、隱私擋玩家搜尋」 |

**隱藏貼文**（AC-13.1「管理員可隱藏」、AC-13.6）：

- `POST /api/forum/posts/:id/hide { hidden }`（幹部，`forumRouteNeed` 跟置頂、鎖定同一條），存在 `forum_posts.hidden_at`、`hidden_by`。**資料表的變更是加欄位**：`createTables` 照 `body_text` 的做法用 `PRAGMA table_info` 檢查、沒有就 `ALTER TABLE … ADD COLUMN`（新建的表直接有），舊備份還原後也會補（還原是 `DELETE FROM` 再插回，欄位還在）。
- 隱藏的貼文**只有作者與幹部看得到**（`Post.hidden` 為 true，頁面標「已隱藏」）；其他社員在板面、首頁、所有貼文、搜尋都看不到，直接開網址、留言、按反應、檢舉都是 404 `postGone`（跟刪掉一樣，不透露它還在）。過濾在伺服器（`visibleTo`、`seenPostRow`），`boardPage`／`feed`／`search`／`latest`／`thread` 多一個 `viewer` 參數，沒給就當看不到隱藏的。
- 隱藏時這篇的**未處理檢舉一起關成 `removed`**（跟刪除一樣，`ReportStatus` 不加新值，橋館的檢舉頁照樣看得懂）。取消隱藏不會重開檢舉。
- 審計 `forum:hide`／`forum:unhide`（`note` 是作者與摘要）。
- 只做貼文；留言不隱藏（不當的留言直接刪，留言沒有「讓作者改」的需要）。

**搜尋為什麼還是 `LIKE`、不用 FTS5**：

- **中文斷詞**：FTS5 預設的 `unicode61` 把連在一起的漢字當成**一個詞**（整句沒有空格），搜「首攻」找不到「這副牌首攻什麼」；`trigram` 斷詞可以找子字串，但**少於 3 個字的查詢找不到**，而橋牌最常搜的正是兩個字（叫牌、首攻、賭倍、蓋叫）。兩個字還是要退回 `LIKE`，等於維護兩套。
- **量**：一個社團的貼文幾千篇，`LIKE '%詞%'` 掃 `title` 與 `body_text` 在 Durable Object 裡不到 1 ms；而且搜尋跑在 `Club` 物件裡，不佔 Worker 每次請求 10 ms CPU 的額度。
- **一致**：跟橋館已上線的搜尋同一套規則（每個詞都要有、英文不分大小寫、`%` `_` 當普通字），兩站結果一樣。
- **什麼時候換**：搬 D1、全台灣公開、貼文到幾萬篇時，改成 `trigram` FTS5 加「少於 3 字退回 `LIKE`」；`ForumService.search` 是唯一要改的地方。

**牌桌的頁面**：

| 網址 | 頁面 | 內容 |
| --- | --- | --- |
| `/forum/search?q=&board=&tag=&page=` | `ForumSearchPage` | 搜尋框、板面下拉（全部板面或一個）、標籤下拉（全部或一個；只選標籤不打字＝那個標籤的全部貼文），結果用貼文列表、分頁；條件在網址上，可以分享 |
| `/forum/reports` | `ForumReportsPage` | 只有幹部（其他人轉回 `/forum`）；論壇首頁的「檢舉處理」連結也只給幹部看 |

元件測試在 `tests/presentation/forum-moderation.test.tsx`，伺服器在 `tests/worker/forum.test.ts`（隱藏、可見性、舊表補欄位、搜尋限定板面）。

**橋館要跟著改的**（不改也不會壞，只是看不到新功能）：

1. `src/lib/forum.ts`（型別複本）：`Post` 加 `hidden?: boolean`；`parity/table-types.ts` 的對拍會抓到。
2. `src/lib/api.ts` 的 `AuditAction` 加 `forum:hide`、`forum:unhide`，`reviewStrings.ts` 加「隱藏貼文」「取消隱藏」，審計紀錄才顯示得出名稱。
3. 想要的話：討論區的貼文頁加幹部的「隱藏」、檢舉頁加「隱藏」、搜尋頁加板面篩選（`forumApi.search` 帶 `board`）。
4. 橋館的幹部現在就看得到隱藏的貼文（列表照常出現），但沒有「已隱藏」標記，直到做了第 1 點。

### 標籤、隱藏的通知、隱私擋玩家搜尋（社長 2026-11-02 決定，三項都做）

K3、K4 留下的三個待決，社長都說「要」。

**1. 貼文標籤**（AC-13.7「依標籤篩選」）：

- **自由輸入，不是固定清單**：PRD 沒有規定標籤要由誰定，板面已經分大類，標籤是作者自己補的細分（「2/1」「首攻」「擠牌」）；固定清單要有人維護，社團小、先不要。為了不讓同一個標籤長出好幾種寫法，**伺服器正規化**（`shared/forum.ts` 的 `normalizeTag`，兩站與 Worker 共用）：NFKC（全形英數變半形）、英文轉小寫、去掉開頭的 `#` 與前後空白、連續空白變一個、分隔字元（`,` `，` `、` `;` `；`）與控制字元拿掉；重複的去掉。編輯器另外把「常用標籤」列出來一鍵加（`GET /api/forum/tags`）。
- **上限**：每篇最多 5 個（`FORUM_LIMITS.tagsMax`），每個最多 20 字（`tagMax`，算 code point），超過回 400 `badContent`；建議清單最多 30 個（`tagsShown`）。
- **資料**：`forum_posts.tags`，JSON 陣列（沒有標籤是 NULL），照 K4 的 `hidden_at` 用 `PRAGMA table_info` 檢查、沒有就 `ALTER TABLE … ADD COLUMN`。篩選是對 `"標籤"`（含引號）的 `LIKE`（`%` `_` `!` 跳脫），跟 `mentions` 的做法一樣，所以「首攻」不會配到「首攻王」；一個社團幾千篇，掃一遍不到 1 ms。建議清單用 SQLite 的 `json_each` 加 `GROUP BY`。備份是 `SELECT *`，新欄位自動跟著走。
- **API**（型別在 `shared/forum.ts`，都是選填，橋館不改也不會壞）：`Post.tags?`、`PostInput.tags?`；`GET /api/forum/boards/:id/posts`、`/feed`、`/search` 都可以加 `&tag=`（板面的置頂貼文也照標籤篩）；`/search` 有 `tag` 時 `q` 可以空（＝那個標籤的全部貼文）；`GET /api/forum/tags` 回 `{ tags: [{ tag, count }] }`，用的貼文多的在前。**編輯時沒帶 `tags` 就保留原本的標籤**，`[]` 才是全部拿掉——還沒有標籤欄位的舊版橋館編輯貼文時不會把標籤清掉。
- **隱藏的貼文照 K4 的規則**：標籤篩選、建議清單的計數都走同一個 `visibleTo`，別人用標籤也找不到幹部隱藏的貼文，它的標籤也不算進建議清單；作者與幹部照常。
- **牌桌的頁面**：發文編輯器在標題下面有「標籤（選填）」：打字按 Enter 或逗號加入、離開欄位也會加入，貼上 `a, b, c` 一次加多個，滿 5 個欄位停用；加入的標籤可以點掉；下面是「常用標籤」（沒加的、最多 12 個）。貼文列表每篇標題下列標籤（`#首攻`，列表的一列本身是連結，所以這裡不是連結）；貼文頁的標籤是連結，連到 `/forum?tag=`。論壇首頁在板面下面列出常用標籤（「首攻 · 3」），點了列表只剩那個標籤的貼文、上面有「標籤：首攻 ×」可以清掉；板面頁 `/forum/:boardId?tag=` 一樣；換頁時保留標籤。搜尋頁多一個標籤下拉。

**2. 隱藏與取消隱藏時通知作者**：

- 新通知種類 `forumHidden`、`forumUnhidden`（`shared/protocol.ts` 的 `NOTIFICATION_KINDS`），`worker/forum-notices.ts` 的 `hidden(actor, post)`，在 `club.ts` 隱藏狀態真的改變時、寫完審計之後送（跟其他論壇通知一樣走 `tell`，送失敗不影響已存的隱藏）。
- 參數只有 `{ postId, title }`，**不帶是哪位幹部**：幹部做的是社團的決定，名字不必送到作者的瀏覽器（避免私下爭執）；誰做的記在審計紀錄（`forum:hide`／`forum:unhide`）。幹部隱藏自己的貼文、作者已經離開社團時不送。
- 文字六種語言（「幹部隱藏了你的貼文「…」，其他社員暫時看不到」「幹部取消隱藏你的貼文「…」，大家又看得到了」），點了開那篇貼文（作者看得到自己被隱藏的貼文；有 `forum` 旗標連牌桌、沒有連橋館，同 `e13-t09`）。

**3. 隱私也擋紀錄的玩家搜尋**：規則寫在 §4「個人檔案」。「我的帳號」隱私設定的說明文字改成寫明這件事（六種語言）。

**測試**：`tests/worker/forum.test.ts`（正規化、上限、編輯保留、三種篩選與置頂、`LIKE` 跳脫、建議清單與隱藏、舊表補欄位、路由）、`forum-notices.test.ts`（隱藏通知、不帶幹部名字、不通知自己與離開的人、連結）、`history-search.test.ts`（`where()` 的 `hidden`、`namesOthers`）、`forum-share.test.ts`（`ClubService.search`／`historyDays`：別人找不到、本人與管理員找得到、同桌的人用自己找得到、全部列表照常、改回公開又找得到）、`routing.test.ts`（點名別人時交給社團、找自己照樣從 D1）；元件測試 `tests/presentation/forum*.test.tsx`（編輯器加標籤、常用標籤、上限；首頁與板面的標籤篩選與換頁；貼文頁的標籤連結；只用標籤搜尋）。

**橋館要跟著改的**（另一個 PR，牌桌合併並部署之後再合併）：`src/lib/forum.ts` 的型別複本加 `Post.tags`、`PostInput.tags`、`ForumTags`、`FORUM_LIMITS` 的三個值與 `normalizeTag`／`splitTags`，以及 K4 留下的 `Post.hidden` 與「已隱藏」標記、`AuditAction` 的 `forum:hide`／`forum:unhide`；發文框加標籤、貼文顯示標籤、討論區依標籤篩選。

### 公告與新聞的編輯流程（`e13-t12`，2026-11-03）

AC-13.4 的「公告、新聞」沿用 K1 的對照：**公告與新聞都在「社團公告」板（`news`，`postPolicy: 'officers'`）**，不另開板面。開工前對照了橋館：橋館沒有伺服器上的草稿或排程（發文框只把草稿存在那台裝置），首頁用 `GET /api/forum/latest`（社團公告置頂在前，加上最新討論）。這次只在共用的 `ForumService` 加草稿與排程、牌桌加頁面，`latest` 的格式不變。

**狀態**：一篇貼文三種狀態，存在 `forum_posts` 的兩個新欄位（`createTables` 照 `tags` 的做法用 `PRAGMA table_info` 檢查、沒有就 `ALTER TABLE … ADD COLUMN`，舊貼文都是「已發布」；備份是 `SELECT *`，新欄位跟著走）：

| 狀態 | 欄位 | 誰看得到 | `Post` |
| --- | --- | --- | --- |
| 已發布 | `draft = 0`、`publish_at IS NULL` | 照原本的規則（隱藏的只有作者與幹部） | 跟以前一樣 |
| 草稿 | `draft = 1` | **只有作者**，管理員也看不到（還沒寫完的東西是作者自己的） | `draft: true` |
| 排程中 | `publish_at` = 發布時間（ms） | 作者與幹部（幹部要知道社團接下來會發什麼公告，免得重複） | `publishAt` |

- **不在任何列表**：板面、所有貼文、個人頁、搜尋、標籤計數、首頁都只算已發布的（`visibleTo` 多一個 `PUBLISHED` 條件，所有列表本來就走它）。直接開網址：看不到的人得到 404 `postGone`（跟刪掉一樣）。留言、反應、檢舉、置頂、隱藏都要等發布：看得到的人得到 409 `postNotPublished`（`outPostRow`）。
- **時間**：還沒發布的貼文 `createdAt` 是「上次儲存」，編輯不標「已編輯」；發布的那一刻 `createdAt` 改成發布時間，所以排在最新、像剛發的。發布之後不能改回草稿或排程（400 `badContent`）。
- **誰能做**：草稿是任何能在那個板發文的人（社團公告板就只有幹部）；**排程只有幹部**（`forumModerate`，管理員也有；403 `forumScheduleOfficersOnly`），時間要在現在之後、最多 90 天（`FORUM_LIMITS.scheduleDaysMax`，400 `forumScheduleTime`）。每人草稿加排程最多 20 篇（`draftsMax`，409 `forumDraftLimit`）。發文的速率限制照舊算建立的那一次。
- **API**（都是選填，橋館不送也不會壞）：`PostInput.draft`、`PostInput.publishAt`。建立時 `draft: true` 是草稿、`publishAt` 是排程、都沒有就立刻發布；**編輯時沒帶就維持原狀**，所以橋館（不知道草稿）編輯一篇草稿不會不小心把它發出去；`draft: false` 或 `publishAt: null` 是「立即發布」。`GET /api/forum/drafts` 回 `{ posts }`：自己的草稿與排程，幹部再加上所有人的排程；排程的在前（近的先），草稿在後（最近存的先）。
- **排程發布**（`worker/forum-schedule.ts` 的 `ForumSchedule`）：時間存在貼文那一列，工作交給社團**唯一的排程器**（§5「排程」，`JobKind` 的 `forum`，經 `ClubService.scheduleAt`），key 是 `forum:<貼文>:<時間>`。改了時間就是新的 key，舊的工作醒來發現時間不同就什麼都不做；刪掉、改回草稿、已經發布的也一樣（`publishScheduled` 只認「還在等這個時間」的那一列）。工作照樣不存：`Club` 建構時在 `load()` 之後、還原備份之後都會把所有排程中的貼文重排一次，物件睡過了時間就一醒來立刻發布。
- **發布時再檢查一次**：時間到時作者要還是社員、還是幹部（`ClubService.memberMe`）；不是的話這篇**改回作者的草稿**、不通知任何人，作者回來還找得到。
- **刪帳號**（社長 2026-11-03）：作者的草稿與排程中的貼文一起刪（`ForumService.forgetUnpublished`，`Club` 的 `onMemberRemoved` 在刪圖片之前做），它們的圖片接著由 `FileService.forget` 刪掉（§5.14）；排程工作醒來找不到那一列就什麼都不做。已發布的貼文照舊保留。docs/SECURITY.md §5、隱私權政策都寫了。
- **通知跟一般貼文一樣**：發布的那一刻送 `forum-notices.ts` 的 `posted`（社團公告板：每位社員 `forumAnnouncement`；被 `@` 到的人 `forumMention`），作者算發文的人。存草稿、排程、編輯草稿都不通知；草稿或排程「立即發布」時也是 `posted`，不是 `edited`。
- **頁面**：
  - 發文編輯器（`ForumEditorPage.tsx`，改動盡量小）：還沒發布的貼文多一個「存成草稿」；幹部多一個「排程發布」（`components/ForumRelease.tsx`，勾選後填 `datetime-local`，瀏覽器的本地時間，預設一到兩小時後的整點），送出鍵變成「排程」；編輯草稿或排程時主按鈕是「立即發布」。已經發布的貼文只有「儲存」。存成草稿後這台裝置的草稿清掉（伺服器有了）。
  - 貼文頁：標「草稿」或「排程中」，寫明誰看得到、什麼時候發布；沒有留言區、檢舉與隱藏。
  - `/forum/drafts`（`ForumDraftsPage`）「草稿與排程」：用貼文列表，每篇寫「上次儲存 …」或「… 發布」；論壇首頁有連結。
  - **首頁（大廳）**：`components/LobbyNews.tsx` 在牌桌列表上面放兩欄「社團公告」（社團公告板最新 3 篇，置頂的在前）與「最新討論」（其他板最新 3 篇），跟橋館首頁同一個 `GET /api/forum/latest`；只給有 `forum` 旗標的社員，讀不到就不顯示。草稿、排程、被隱藏的都不會出現（伺服器過濾）。
- **測試**：`tests/worker/forum-schedule.test.ts`（草稿與排程的可見性、列表與標籤、留言等要等發布、上限、權限與時間、改時間、改回草稿、立即發布、舊表補欄位、路由；`ForumSchedule` 用真的 `AlarmQueue`：到時發布並通知、醒來重排與補發、改時間不重複發、作者不再是幹部或社員就改回草稿）；元件測試 `tests/presentation/forum-news.test.tsx`（存草稿、幹部排程、立即發布、已發布只能儲存、本地時間換算、貼文頁、草稿頁、大廳的公告）。

**橋館要跟著改的**（不改也不會壞）：

1. `src/lib/forum.ts` 的型別複本：`Post.draft?`、`Post.publishAt?`、`PostInput.draft?`、`PostInput.publishAt?`、`ForumUnpublished`、`FORUM_LIMITS.draftsMax`、`scheduleDaysMax`；`parity/table-types.ts` 的對拍會抓到。
2. 錯誤代碼 `postNotPublished`、`forumScheduleOfficersOnly`、`forumScheduleTime`、`forumDraftLimit`（`shared/messages.ts`）的文字。
3. 想要的話：發文框加「存成草稿」與幹部的「排程發布」、「草稿與排程」頁（`GET /api/forum/drafts`）。在那之前，橋館的社員從牌桌存的草稿只在牌桌看得到；橋館打開草稿的網址（作者本人）照樣能編輯，不會把它發出去。

### 之後

- **K2**（做完）：四手牌編輯器（`e13-t05`）、叫牌過程輸入（`e13-t06`）、發文編輯器（`e13-t04`）；牌圖改用 `RecordDiagram`。見下面「發文編輯器」。
- **K3**（做完）：從紀錄分享（`e13-t07`）、個人頁的貼文與隱私設定（`e13-t08`）、通知改連牌桌（`e13-t09`）。見下面「分享、個人頁、通知」。
- **K4**（做完）：檢舉、隱藏與管理頁（`e13-t10`）、搜尋限定板面（`e13-t11`，評估後不用 FTS5）。見上面「檢舉、隱藏與搜尋」。
- **K4 之後的三項**（做完，社長 2026-11-02）：貼文標籤（AC-13.7）、隱藏時通知作者、隱私擋紀錄的玩家搜尋。見上面「標籤、隱藏的通知、隱私擋玩家搜尋」。
- **O3 `e13-t12`**（做完，2026-11-03）：草稿、排程發布、大廳的社團公告（AC-13.4）。見上面「公告與新聞的編輯流程」。

### 分享、個人頁、通知（K3：`e13-t07`、`e13-t08`、`e13-t09`）

**不改格式**：分享用的是 `shared/forum.ts` 既有的 `record` 區塊（`{ kind: 'record', tableRecordId }`，只存 id），`ForumDeal`、`MemberProfile`、`Post` 的型別都沒動，橋館的型別對拍不受影響；`worker/forum.ts` 沒改。

- **從紀錄分享**（`e13-t07`，AC-13.3）：紀錄頁（`BoardRecordView` 的完整版）有「分享到論壇」，開 `/forum/new?record=<id>`：發文編輯器把那副加進草稿（已經有就不重複），板面預設牌局討論（`deals`），網址有 `board=` 時照它。挑戰或比賽還沒結束的牌（`revealAt` 還沒到）按鈕是停用的、滑過去說明原因。**伺服器檢查**：`club.ts` 在 `createPost`／`updatePost` 之前用 `worker/forum-share.ts` 的 `addedRecordIds` 找出本文**新加的** `record` 區塊，每一副呼叫 `ClubService.checkShareable`（規則見 §4「分享到論壇」）；編輯時原本就有的不再檢查（橋館以前寫的貼文照舊能編輯）。橋館的發文框也能手打紀錄 id，同一個檢查一樣擋。
- **貼文裡的牌**：`ForumBlocks` 的 `record` 區塊（`ForumRecord`）走 `/api/history/:id` 讀紀錄，畫紀錄頁的 `RecordDiagram`（四家、玩家名字，`step={0}` 只有起手的牌）、合約與結果、「重播這副牌」連到 `/history/<id>`（紀錄頁本來就有逐墩重播）。讀不到（看不到、已刪除）就只有「看這副牌的紀錄」的連結，跟紀錄頁一樣由伺服器決定。橋館照舊顯示連結。
- **個人頁**（`e13-t08`，AC-13.5）：`/members/:userId` 原本就有頭像、簡介（四個欄位）、實力評分與最近的牌；K3 加上「論壇貼文」（有 `forum` 旗標時；`GET /api/forum/feed?author=<id>`，一頁 20 則，新→舊，用論壇的 `PostRows`／`ForumPager`）與**隱私設定**：「我的帳號」的「個人頁的隱私」可以讓別人看不到「最近的牌」與「論壇貼文」（規則見 §4「個人檔案」）。存在帳號上（`hideProfileBoards`、`hideProfilePosts`，預設都公開），不放在 `Profile` 裡：橋館的「我的帳號」用 `PATCH /api/account/profile` 整份覆寫四個欄位，放進去會被橋館存檔時清掉。
- **通知**（`e13-t09`，AC-13.6 的通知部分）：回覆與被提到的通知本來就有（橋館 e11-t08，`worker/forum-notices.ts`）；K3 只改鈴鐺連到哪裡：`notificationLink(n, { forum })`，有 `forum` 旗標的社員連牌桌的 `/forum/p/<id>#comment-<id>`，`ForumPostPage` 讀完貼文後把那則留言捲到畫面中間；沒有旗標的照舊連橋館。

## 5.20 Email 綁定與 Email 重設密碼（決策紀錄，`e1-t29`、`e1-t30`，2026-11-02，H5a）

社員可以在「我的帳號」綁定一個 Email，驗證過後，忘記密碼時用 Email 收重設連結，不必等管理員核准。管理員核准的忘記密碼（`e1-t36`）照舊保留，沒有驗證 Email 的帳號只能走那條路。

### 寄信服務：Resend

| | Resend | Cloudflare Email Service（Email Sending） |
| --- | --- | --- |
| 免費額度 | 每月 3,000 封、每天 100 封、1 個網域 | 2025-09 才宣布、還在測試；依當時的公告，寄給任意收件人要 Workers 付費方案（免費方案能用的是 Email Routing 的 `send_email`，**只能寄給帳號裡驗證過的收件地址**，不能寄給社員）。正式版的價格出來後再評估 |
| Worker 整合 | 一次 `fetch`（`POST https://api.resend.com/emails`），金鑰是 Worker secret | 原生 binding，不用金鑰 |
| 10 ms CPU | 一次 `fetch` 加一個小 JSON，CPU 幾乎是零；而且是在社團的 Durable Object 裡送，不是 Worker 的 10 ms 請求 | 同樣幾乎是零 |
| 網域 | 寄件網域要在 Resend 加 DNS 紀錄（SPF、DKIM），網域不必在 Cloudflare | 寄件網域要在 Cloudflare |
| 鎖定 | 換服務只改 `worker/mail.ts` | 同左 |

我們在免費方案，Cloudflare 的服務寄不到社員信箱，所以選 **Resend**。社團一天寄的信（驗證與重設）遠低於每天 100 封；之後真要換成 Cloudflare Email Service，只要在 `worker/mail.ts` 加一個實作 `Mailer` 的 binding 版本，`ClubService` 不用改。

### 怎麼運作

- **開關**：`RESEND_API_KEY`（secret）和 `MAIL_FROM`（寄件人）**兩個都設**才有 `Mailer`（`mailerFrom`）；少一個就關：`Me.email` 不送，「我的帳號」沒有 Email 卡片、登入頁沒有「用 Email 重設」，所有 Email 的 API 回 `emailOff`（503）。這跟功能旗標（`shared/features.ts`）一樣是「沒開就看不到」，但看的是部署設定而不是社團的選擇，因為沒有寄信服務時打開也沒用。PR 預覽不設，所以預覽站沒有 Email。
- **`ClubService` 不碰 Cloudflare 或 Resend**：它只拿到 `ClubConfig.mailer`（`send({ to, subject, text })`）；`club.ts` 用 Worker 的設定做出 Resend 版本。測試換成把信收進陣列的假 `Mailer`。
- **綁定**（`POST /api/account/email { address, password }`）：要輸入密碼（session 被別人拿到時，不能把重設信改寄到他的信箱）。寄一封驗證信，連結是 `/email/verify#<權杖>`，24 小時內有效、只能用一次。驗證前原本驗證過的 Email 照舊有效；空的 address 加密碼是移除。
- **驗證**（`POST /api/email/verify { token }`）：不用登入，連結本身就是證明（常在手機上開）。另一個帳號已經驗證過同一個 Email 就拒絕（`emailTaken`）——只有能讀那個信箱的人才會知道，所以不算洩漏。
- **Email 重設**（`POST /api/email/reset/request { account }`）：帳號名稱或驗證過的 Email 都可以。有驗證過的 Email 才寄 `/email/reset#<權杖>`，30 分鐘內有效、只能用一次；**不論帳號或 Email 存不存在、有沒有寄出，回答都一樣**（`{ ok: true }`），寄信失敗也只寫日誌（`mailFailed`）。`POST /api/email/reset { token, password }` 設新密碼（新密碼規則照 `checkNewPassword`），登出所有裝置（session、通行證、連線），管理員給的重設代碼也一起失效。管理員帳號也可以用（`e1-t36` 不讓管理員用邀請碼，是因為邀請碼太弱；驗證過的 Email 不是）。
- **權杖**：32 bytes 隨機（256 bit），**只存 SHA-256**（`StoredUser.emailPending.tokenHash`、`emailReset.tokenHash`），原文只在信裡。放在網址的 `#` 後面，瀏覽器不會送給伺服器，也不會進 Cloudflare 的請求紀錄；頁面讀到後立刻從網址列拿掉。打開頁面不會用掉連結，要按按鈕（信箱的連結掃描器先點過也沒關係）。改密碼、重新驗證或移除 Email 時，寄出的重設連結都失效。
- **速率限制**（`worker/rate-limit.ts`）：每個帳號的信（驗證加重設）一次 3 封、之後每 10 分鐘 1 封，驗證超過回 `slowDown`、重設超過**不說**（說了就洩漏帳號有 Email）；同一個 IP 的重設申請一次 5 次、之後每 2 分鐘 1 次（`slowDown`，只看 IP 不洩漏帳號）；錯的重設連結跟登入共用同一個 IP 的失敗次數（`tooManyLogins`）。
- **個資**：Email 存在 `user:<id>` 裡，匯出（`GET /api/account/export`）有 `email`、`emailVerifiedAt` 與等待驗證的地址，沒有任何權杖雜湊；刪帳號時跟著 `user:<id>` 刪除。其他社員與管理頁都看不到 Email。隱私權政策加了一段（六種語言，`LEGAL_UPDATED` 2026-11-02）。
- **信的文字**在 `shared/messages.ts`（`mailVerifySubject`、`mailVerifyBody`、`mailResetSubject`、`mailResetBody`，六種語言），語言照頁面送來的 `lang`，沒有就繁中；純文字，不寄 HTML。
- **多社團**（`e12-t04`）：信裡的連結帶社團（其他社團是 `/c/<id>/email/verify#…`），頁面從網址知道社團、呼叫 API 時帶 `X-Club-Id`，所以連結在哪個裝置打開都到對的社團。

## 5.21 社團積分與實力評分（決策紀錄，`e9-t04`～`e9-t08`，2026-11-02，J2）

AC-9.2（社團積分：依名次給分、月榜年榜、規則可設定、每筆可追溯）與 AC-9.3（rating、機器人是固定對手強度、個人頁走勢、可不公開）。比賽以 §5.18 的 Event 為單位結算：一場比賽結束時記一次，之後怎麼重複聽到都不再記。

### 什麼比賽算

| 比賽 | 積分種類 | 每一方 | 何時記 |
| --- | --- | --- | --- |
| 每日賽（`settings.daily`） | `daily` | 打完 8 副、有名次的人 | 挑戰 `finished`（`settleChallenge`） |
| 每週社團挑戰（`settings.weekly`） | `weekly` | 同上 | 同上 |
| 其他挑戰 | `challenge` | 同上 | 同上 |
| 隊制賽 | `match` | 一隊（座位上的社員；機器人只算進 rating） | 比賽 `finished`（`settleMatch`）；`abandoned`、`cancelled` 不算 |
| 雙人賽（J3） | `pairs` | 一對 | J3 結算時呼叫 `ClubService.rankings.record(...)` |
| 個人賽（`e9-t15`，§5.25） | `individual` | 一個人 | 同雙人賽（同一個收尾） |
| 多隊賽（`e9-t14`，§5.26） | `teams` | 一隊（上場過的社員） | 最後一輪結束（`TeamEventService.sync`）；多隊賽裡的每一場隊制賽不另記 `match` |

- **只有打完全部副數、有名次的人**（跟挑戰的排名一樣，§5.5）。只有一人打完（排名是總分、沒人可比）不給分、不算 rating。
- **「用這副牌挑戰」的發起者（`knownDeals`）不算**：他的成績是之前打的，這場不是真的參賽。
- 時間點：挑戰記在結束時，但不晚於「截止前 1 ms」，所以 10/31 的每日賽打到 11/1 00:00 截止仍算 10 月；隊制賽記在 `endedAt`。

### 積分規則（`shared/points.ts`，`e9-t04`）

每一方拿 `參加分 + 每贏過一方的分數 × 贏過的方數`，一方的每個社員都拿整份；同名次贏過的方數一樣（1、2、2、4 名：第 2 名的兩人都贏過 1 方）。排名的方數少於「最少方數」就整場不給分。分數到小數第一位。管理員在 `/rankings` 頁改（`POST /api/rankings/rules`，存在 KV 的 `meta:points`）；**改規則只影響之後結束的比賽**，已經記下的不重算（要改用更正）。

**預設（保守，待社長確認）**：

| 種類 | 給分 | 參加分 | 每贏過一方 | 最少方數 |
| --- | --- | --- | --- | --- |
| 每日賽 | 是 | 1 | 1 | 2 |
| 每週社團挑戰 | 是 | 2 | 2 | 2 |
| 挑戰 | 是 | 0 | 1 | 3（兩個人互挑不給分，避免刷分） |
| 隊制賽 | 是 | 2 | 4 | 2 |
| 雙人賽 | 是 | 2 | 1 | 3 |
| 個人賽 | 是 | 2 | 0.5 | 4（每人一方，方數是同樣桌數雙人賽的兩倍，所以每贏過一方減半） |
| 多隊賽 | 是 | 2 | 2 | 3 |

「依參加人數加權」就是「贏過的方數」：人越多、贏過的人越多，分數越高（PRD 風險「積分讓人只打簡單的」）。

### 積分帳本（`worker/rankings.ts`，`e9-t05`）

**存在 `Club` 物件的 SQLite**，跟它的來源（`challenges`、`matches`）放一起，跟論壇（§5.19）一樣先不搬 D1：一場比賽的結算在同一個 transaction 裡寫完，榜單的查詢是一個 `GROUP BY`（一年幾千列）。之後全台灣規模再看要不要像紀錄一樣做 D1 副本（§5.12）。

| 表 | 內容 |
| --- | --- |
| `ranked_events` | 已經記過的比賽（`event_id` 主鍵）：**冪等**的依據；`rule` 是記帳當時那一種比賽的規則（JSON，重算用，2026-11-03 加的欄位，之前記的是空的） |
| `points_entries` | 每人每場一列（主鍵 `event_id, user_id`）：種類、時間、名次、方數、規則給的分數 |
| `points_adjustments` | 管理員的更正與裁判調整後的重算：差額、原因、誰、何時、`auto`（1 是重算寫的）；**不改原本那列**，所以每一分都追得到 |
| `ratings` | 每人目前的 rating、RD、σ、場數、最後一場的時間、是否不公開 |
| `rating_history` | 每人每場之後的 rating 與 RD（走勢圖） |

- **冪等**：`RankingStore.record` 先看 `ranked_events`，記過就什麼都不做；積分與 rating 同一個 transaction。`settleChallenge` 在記下「已結束」之前就先記積分，所以中途失敗、重新結算也不會漏記或重複。記帳出錯只寫日誌（`recordPoints`），不擋結算。
- **旗標關著也照記**：開放之後看得到 J2 之後的每一場。J2 之前結束的比賽不補記。
- **更正**（`POST /api/rankings/adjust { eventId, userId, points, reason }`，只有管理員，原因必填、最多 200 字）：設定更正後的分數，存差額；明細顯示規則給的分數與每一筆更正。
- 刪除帳號（`removeMember`）刪掉他的積分與 rating；別人在那些比賽的名次與分數不變。匯出（`/api/account/export`）多 `points`、`rating`（docs/SECURITY.md §4）。

### 月榜、年榜、賽季（`e9-t06`）

- `GET /api/rankings?month=YYYY-MM`（預設本月）、`?year=YYYY`、`?season=<id>`；期間一律用台灣時間（月初 00:00 到下個月初 00:00）。同分同名次。
- **賽季**：管理員在積分規則下面設（名稱、開始、結束日，兩端都含，最多 20 個）；沒設時年榜就是日曆年。學年制（例如 9 月到隔年 1 月）就設賽季。
- 明細：`GET /api/rankings/ledger?user=<id>&<期間>`，每一筆連到來源比賽（挑戰頁、隊制賽頁；每日賽顯示那一天）。社員可以看任何人的明細（榜單本來就公開給全社）。

### 實力評分（`shared/rating.ts`，`e9-t07`、`e9-t08`）

- **Glicko-2**，照 Glickman 的文件（"Example of the Glicko-2 system"）；測試用文件裡的例子（1500／200／0.06 對三個對手 → 1464.06／151.52／0.05999）。
- **初始值**：1500、RD 350、σ 0.06；τ = 0.5。RD 大於 110 顯示「暫定」。
- **一場比賽就是一個評分期**：每個社員對其他每一方各算一局（名次高贏、同名次和）；對手的強度用賽前的 rating。大場次（例如 30 人的每日賽）每局的權重是 `min(1, 3 ／ (方數 − 1))`，一場最多等於 3 局，不會一天就把新人的 rating 定死（標準 Glicko-2 沒有權重，這是我們的延伸；權重為 1 時跟標準一樣）。
- **沒打的期間**：每 30 天沒比賽算一個空的評分期，RD 照公式變大（最多 350），rating 不變。
- **機器人的固定 rating**：只有一個機器人 TKB（§5.1），固定 1500、RD 50、不會變。隊制賽或雙人賽有機器人坐的位置，那一方的強度是社員與機器人的平均（RD 取平方平均）。挑戰與每日賽裡每個人都配一樣的機器人，所以只比社員之間。之後有 TKB Adv 再給它自己的數字。
- **哪些比賽算 rating**：上表的全部，包括兩個人互挑的挑戰（積分不給，但 rating 看對手強度，刷不了分）。
- **不公開**：個人檔案上自己勾「不公開我的實力評分」（`POST /api/ratings/visibility { hidden }`），別人（包括管理員）只拿到「不公開」，看不到數字與走勢。積分榜不受影響（積分是社團活動，全社公開）。
- **頁面**：`GET /api/ratings/:userId` → `RatingView`（目前 rating、RD、暫定、場數、最近 200 場的走勢）。個人檔案卡與個人頁（`ProfileDetails`）顯示 rating 與走勢圖（`src/components/RatingTrend.tsx`：簡單 SVG 折線、每場一點、滑過顯示日期與分數，旁邊有給螢幕閱讀器的表格）。

### 功能旗標 `rankings`（預設關）

`shared/features.ts`：頁首的「積分榜」、`/rankings`、個人檔案的 rating 與它們的 API。**管理員旗標關著也進得去**（先設規則、看記下的帳），社員要旗標開。記帳不看旗標（上面）。

### 待社長決定

1. 上面的預設分數（每種比賽給多少、挑戰要不要三人才給分）。
2. 年榜用日曆年，還是設學期／學年賽季。
3. rating 要不要只算社團的比賽（每日賽、每週、隊制賽、雙人賽），不算朋友之間的挑戰。
4. 新人 rating 顯示「暫定」的門檻（RD 110，大約打 5～10 場）。
5. 「用這副牌挑戰」的發起者不算積分與 rating（目前不算）。
6. 實體社課的比賽要不要合併計算（E9 未決問題；目前只有線上）。
## 5.22 雙人賽（決策紀錄，`e9-t09`～`e9-t13`，2026-11-02，J3）

照 §5.18 的共同模型：**Event** 是一場雙人賽，**Round** 是移位的一輪，**Table** 是那一輪每一張同時開打的牌桌（`mode=pairs`），**Board** 是同一副在多桌各打一次（traveller）。功能旗標 `pairs`（`shared/features.ts`）**預設關**。

### 移位（`e9-t09`，`shared/movement.ts`）

- **只做 Mitchell**（3–10 桌，5–20 對）。Howell 的每一種桌數都要查表（不是公式），而且它是一、兩桌的移位，社團這個人數打隊制賽就好；之後要加照同一個 `Movement` 形狀加。
- 南北坐著不動（南北第 t 對在第 t 桌），東西每輪往上一桌、牌組往下一桌；T 桌就有 T 組牌。**奇數桌**打 T 輪，每對東西都遇到每對南北、打到每一組牌。**偶數桌**是跳桌 Mitchell：過了一半的輪數東西多跳一桌，打 T − 1 輪（每對東西少遇一對南北、少打一組牌；打滿 T 輪會回到第一輪的對手）。
- **輪空**：奇數對時最後一個東西位置是空的（phantom），它走到哪一桌那一桌那一輪就不開，那一桌的南北輪空。
- 每輪每組牌剛好在一桌，所以每一副打的次數一樣（phantom 經過的那幾組少一次，Neuberg 補）。每輪副數 1–4，全場最多 32 副（`DEAL_SET_MAX`），超過就自動減少每輪副數（10 桌最多每輪 3 副）。
- 測試（`tests/engine/movement.test.ts`）：5–20 對每一種都檢查每對不重複打同一副、不重複遇到同一個對手、南北只遇東西、每輪每組牌與每對只出現一次、沒打的就是輪空的。

### 建立與報名（`e9-t10`）

- 有旗標的社員都能建立，建立的人就是**裁判**（`directorId`）：只有他能開始、取消、移除別的搭檔。設定（`parsePairsSettings`）：名稱、每輪副數、每副限時；錯了回 `badPairsSettings`。
- **報名**：社員填搭檔的帳號名稱，兩人一起成為一對（`pairsBadPartner`：自己、不存在、任一方封鎖對方；`pairsInPair`：任一人已經報名；最多 20 對 `pairsFull`）。搭檔不用另外確認（社課當場報名），兩人任一人都能退出（`withdraw`）。報名的順序就是移位的位置：前 T 對坐南北、其餘東西（`pairPlace`），**桌數由對數自動決定**（`tablesFor`）。
- **開始**：裁判、5–20 對（`pairsTooFew`）、所有人在線（`pairsOffline`）、沒有人在打隊制賽或別的雙人賽（`pairsPlayerBusy`）。全場一組牌（`makeDealSet`，副號 1…），每個人先離開所在的牌桌，第一輪的桌一起開；有一桌開不了就把開好的關掉，比賽留在報名中。

### 進行（`e9-t11`）

- **每一輪的每一張牌桌是一個獨立的牌桌**（H1 的 `TableObject`，`pairs-mode.ts`）：開桌時帶那一輪的快照（兩對、要打的副號、全場牌組、每副限時、全場參賽者名單），各自發牌、各自排程。南北對的第一位坐北、東西對的第一位坐東。桌號不在大廳，`TableView.pairs` 給牌桌頁上方的 `PairsBanner`（第幾輪、第幾桌、打了幾副）。
- **每輪結束換桌**：一副打完，牌桌回報 `EventReport { kind: 'pairs', round, table, boardNo, ns, ew, result }`，社團把結果交給那一場（`PairsStep.result`，同一桌同一副只寫一次，重送略過）。**那一輪每一桌都打完**，社團（`PairsService.advance`，每場一次只做一件）先告訴那一輪的每一桌結束（`matchEnded`：不再發牌、人走了就關），讓每個參賽者離桌，再一起開下一輪的桌，最後送 `PairsStep.round`；已經開過（另一個呼叫先到）就把多開的關掉。瀏覽器的 `usePairsFollow` 看到自己不在這一桌了就跳到新的桌，輪空的人回比賽頁（它在下一輪開桌時再帶過去）。
- 最後一輪的最後一副在同一個步驟把比賽改成結束；社團再告訴最後一輪的桌、**公開所有紀錄**（`revealEvent`），只做一次（社團記 `settled`）。社團物件在換桌途中被回收：載入時與每次讀比賽頁時都再看一次狀態，該換桌的補做。
- 同步換桌（不是各桌各自往下走）：Mitchell 下一輪要的牌組正在別桌打，所以要等那一輪全部打完。一桌拖住時裁判可以重新開那一桌，或替還沒打的副給一個裁定分數讓這一輪換桌（`e9-t17`，§5.23）；每副限時照牌桌的設定倒數。

### 計分與即時成績（`e9-t12`，`shared/pairs.ts` 的 `scorePairs`）

- 每一副南北跟南北比：贏一個 2 分、平手 1 分，東西拿剩下的。**Neuberg**：這一副打了 n 次、全場最多打 N 次（照移位算出來的，`plannedPlays`）時 `mp' = (mp + 1) × N / n − 1`，滿分 `2 × (N − 1)`；只打一次的是 50%。
- 南北、東西**分開排名**（Mitchell 一定是兩組），每對的百分比是「拿到的 MP ÷ 自己打過那幾副的滿分」，所以輪空或還沒打完的對也能公平比較：這就是即時成績，每次讀頁面時從結果算，不存。同分同名次。
- **積分**（§5.21）：比賽結束收尾時（`settled`，只一次）呼叫 `RankingsService.record({ id, kind: 'pairs', at, sides })`（`pairsRanked`）：每對一方，**兩組合在一起依百分比排名**（Mitchell 的南北、東西分開排名，但百分比都是「自己打過那幾副的滿分」的比例，可以比），同百分比同名次；積分規則用 `shared/points.ts` 的 `pairs`（至少 3 對）。積分明細頁的雙人賽連到 `/pairs/:id`。
- **裁定與處罰**（`e9-t17`，§5.23）：`scorePairs` 讀紀錄上的裁定（`board_rulings`，跟挑戰一樣）與裁判直接給沒打的副的分數（`PairsResult.ruling`）；指定分數照常比，Avg 類 50／60／40% 不和任何人比，其他人的 Neuberg 次數也不算它；處罰從那一對的 MP 扣掉。積分照收尾當時的成績。

### 結果頁（`e9-t13`，`/pairs/:id`）

報名中：搭檔名單、報名表、裁判的開始與取消。進行中與結束：這一輪的桌（自己的桌與「到我的牌桌」、輪空提示）、南北與東西的成績表、**我的逐副表現**（每副的對手、合約、南北分數、我這一方的百分比）、**每副 traveller**（每一桌的輪次、兩對、合約與莊家、首攻、結果、南北分數、南北的百分比；看得到的才送，§4）。進行中每 5 秒重讀一次。

### 比賽住在哪：`EventObject`（同一個開關 `EVENT_OBJECTS`）

- 一場雙人賽的正本**建立時決定住哪裡，之後不搬**：`EVENT_OBJECTS=on` 時在自己的 `EventObject`（`idFromName('pairs:<id>')`，同一個類別，`EventHost` 依 `kind = 'pairs'` 分派，整場存在一個 key），否則在社團的儲存（`LocalPairs`）。社團一律留一份副本（`pairsev:<id>`：正本、住哪裡、最後寫進的變更編號、收尾過沒有），列表、頁面、`tableOf` 全讀副本。
- 每個變更是一個 `PairsStep`，在社團先用副本跑一次同一個純函式（`applyPairsStep`，錯誤照樣丟），再交給正本跑一次，正本的回答（`PairsSnapshot`：整場＋`rev`）寫回副本（只寫比較新的）。物件說沒有這場時拿副本給它 `adoptPairs` 再送一次；物件的變更 5 秒後再回報一次（`pairsChanged`，回答丟了的時候補）。一副的結果送不到時錯誤傳回牌桌，沿用牌桌的 `outbox` 重送。
- **開關關著時**：新的雙人賽都在社團的物件裡，行為完全一樣（測試兩種模式都跑）。**跟挑戰、隊制賽不同，不做搬移與退回**：雙人賽是新的，沒有舊資料要搬；開關從開改成關時，已經在物件裡的那幾場繼續從物件存取（`ClubConfig.pairsObjects` 一直都接著），新的才在社團。沒有自己的期限工作，所以物件只在社團呼叫時變。
- 需要 workerd 才能測的只有接線（`event-object.ts` 的 `adoptPairs`／`stepPairs`、`Club.pairsChanged`）：PR 預覽與 staging 已經是開的。

## 5.23 比賽的裁判工具（決策紀錄，`e9-t17`，AC-9.8，2026-11-03）

AC-9.8：「裁判工具：調整分數、處罰、延遲開賽、重新開一桌；都留紀錄。」建在 `e2-t35` 的裁定與 `e2-t36` 的「顯示時重算」上，**不另外存一份成績**：每次讀頁面（與結算積分）時，從原本的結果、紀錄上的裁定與裁判紀錄重算。

### 誰可以

- **雙人賽**：建立它的裁判（`directorId`）與管理員（`actsAsAdmin`，要開兩步驟登入）。
- **隊制賽**：房主（本來就能做超時裁定，`e8-t15`）與管理員；多隊賽的比賽（§5.26）是多隊賽的裁判與管理員，房主不行（他也在比賽）。
- **挑戰**（含每週、每日賽）：只有管理員，因為發起的人自己也在打。
- 沒有另外的「裁判」角色：`roles.ts` 只有管理員與各項權限，比賽的裁判就是建立比賽的人。社長 2026-11-03 決定**不另設全社團的「裁判」權限**。
- 檢查全在 `ClubService.refereeAct`（雙人賽的部分在 `PairsService.requireReferee`）；頁面上的 `canReferee` 只決定顯示表單。

### 做什麼（`POST /api/referee/:kind/:id`，`kind` 是 `pairs`／`match`／`challenge`）

`parseRefereeRequest`（`shared/referee.ts`）檢查，錯了回 `badReferee`；每一個都要理由（1–200 字，跟裁定一樣），撤銷裁定除外。

| 工具 | 雙人賽 | 隊制賽 | 挑戰 |
| --- | --- | --- | --- |
| **調整分數**（`score`） | 打完的副：`{ boardId, ruling }`，就是 `e2-t35` 的裁定（`ruleRecord`）；**還沒打的副**（一桌拖住這一輪）：`{ round?, table, boardNo, ruling }`，在比賽裡加一筆沒有紀錄的結果（`PairsStep.assign`），那一輪全部有結果就換桌（拖住的桌由換桌關掉）；打完的副回 `refereePlayed`，結束的輪不能撤銷（`refereeRoundOver`） | `{ boardId, ruling }`（某一室的紀錄）；房主的超時裁定（`matchRule`）照舊 | `{ boardId, ruling }`（某位參賽者的紀錄） |
| **處罰**（`penalty`） | 某一對，扣 MP（`target` 是那一對的序號），開始之後才能 | 某一隊（`A`／`B`），扣 IMP（BAM 是板分），開始之後才能；VP 由扣過的總分算，所以一起變 | 某位參賽者（搭檔賽是那一組的第一位），扣挑戰的單位：MP 是平均百分比的百分點，IMP 是 IMP，總分是分 |
| **撤銷處罰**（`withdraw`） | ✓ | ✓ | ✓ |
| **延後開賽**（`delay`） | 報名中：`minutes`（0–240，0 取消）；在那之前 `start` 回 `eventDelayed { minutes }`，頁面顯示到幾點 | —（房主自己按開始） | —（各自打，沒有開賽時間） |
| **重新開一桌**（`restart`） | 進行中的這一輪：那一桌關掉（正在打的那一副不留紀錄）、四位離桌，再開一張新桌打那一桌還沒有結果的副，加上 `replay` 勾選的（已經打完、要重打的，結果刪掉；舊紀錄留在牌局紀錄裡，比賽結束時一起公開）；`PairsStep.retable` 換掉 `roundTables` 裡那一桌的 id，瀏覽器的 `usePairsFollow` 把四位帶到新桌。跟換桌在同一條 lane，一次一件 | — | — |

不適用的回 `refereeNotHere`。隊制賽的「重新開一桌」與挑戰的「重打一副」沒有做：隊制賽一室卡住時房主已經有暫停、代打、超時裁定，挑戰各自打、沒有要等的人；要的話另開 task。

### 紀錄（`worker/referee.ts` 的 `RefereeLog`）

- 每場比賽一個值 `referee:<kind>:<id>`（`RefereeEntry[]`：`id`、`at`、`by`（社員 id）、`reason`，加上做了什麼），**只加不改**，處罰用一筆 `withdraw` 撤銷；最多留 200 筆。社團載入時全部讀進記憶體（頁面是同步組的，每次都要讀處罰）。比賽住在 `EventObject` 時也一樣存在社團，因為頁面與計分都在社團組（§5.12），`EventObject` 不需要知道。
- **稽核紀錄**：每一筆同時寫一筆 `audit:`（`worker/audit.ts`，`referee:score`／`referee:penalty`／`referee:withdraw`／`referee:delay`／`referee:restart`，收尾後重算積分時另有 `points:recredit`，`target` 是 `<kind>:<id>`，紀錄上的裁定是 `board:<id>`，`note` 是一句說明加理由），跟淡江橋館的變更在同一份，管理頁（`GET /api/book/audit`）看得到。不屬於比賽的牌（一般牌桌）的裁定只寫稽核紀錄。
- `REPLICA_VERSION` 不變：`summarize`、`BoardSummary` 沒改，D1 副本與裁判紀錄無關。

### 計分（全部在顯示時重算）

- 雙人賽：`scorePairs(movement, results, { rulingOf, penalties })`（§5.22）；`pairsView`、`pairsRanked` 都用 `pairsScoring`。`PairStanding.penalty`、`PairsTravellerEntry.ruling`。
- 隊制賽：`penalizedMatch(scoreTeamMatch(…), penaltiesOf(…))` 從兩隊的總分扣、重算領先；`teamMatchView` 與 `matchEvent`（積分）都用它。`TeamMatchView.penalties`。
- 挑戰：`scoreChallenge` 的 `penalties` 從 `total` 扣再排名次；`challengeStandings`、`challengeView`、`challengeEvent` 都帶著。`ChallengeStandingView.penalty`。
- **積分**：比賽收尾時（只記一次，§5.21）用當時的成績，所以收尾前的處罰與裁定都算進去。
- **收尾後的調整自動重算積分**（社長 2026-11-03）：已經記過積分的比賽（`ranked_events` 有它），裁判再調整分數、處罰或撤銷處罰（`refereeAct`），或在紀錄頁裁定那場的一副（`ruleRecord`），`ClubService.recreditPoints` 就用頁面現在的成績重算那一場（雙人賽 `PairsService.rankedNow`、隊制賽 `matchNow`、挑戰 `challengeNow`），交給 `RankingStore.recredit`：用**記帳當時的規則**（`ranked_events.rule`；之前記的沒有，就用現在的規則）算每人應得的分數，和「規則給的分數＋之前的重算」比，差額寫一筆 `points_adjustments`（`auto = 1`、原因是裁判的理由、誰是裁判），名次與方數改成新的。同樣的成績再算一次差額是 0、什麼都不寫，所以**冪等**；管理員自己的更正疊在上面不受影響。只重算原本有一列的人（刪掉的帳號不會回來；裁判工具不會改變誰打完）。同時寫一筆稽核 `points:recredit`（`target` 是 `<kind>:<id>`，`note` 是每個人的差額與重算後的分數，加上理由）。積分明細把重算的那筆標成「裁判調整後重算」。還沒記過積分的比賽（進行中、還沒收尾）不重算，收尾時本來就會算進去。rating 不重算（依時間順序算，不回頭重算）。出錯只記 log（`recreditPoints`），不擋裁判的動作。測試：`tests/worker/challenge-points.test.ts`、`team-match-referee.test.ts`、`pairs-referee.test.ts` 的重算。

### 可見性（`worker/views.ts`，§4）

- 紀錄的每一筆（`RefereeNote`：做了什麼、理由、裁判的名字、時間、處罰撤銷了沒有）跟著比賽頁給**看得到那場比賽的人**；只有「調整分數」那一筆跟著那一副的成績：雙人賽要看得到那一副的 traveller（`seesBoard`）才給、隊制賽要那一副已經顯示（兩室都打完或房主裁定）才給、挑戰跟著排名（自己打完或比賽結束）才給。否則比賽中還沒打那一副的人會從理由或分數知道那一副怎麼了。
- 雙人賽：本來只有「不在任何一對裡的裁判」看得到全部 traveller（為了裁定）；現在**管理員**（不在任何一對裡時）也一樣，因為管理員也能裁定。
- 延後開賽的時間（`PairsView.delayedUntil`）給所有看得到比賽的人。

### 介面

`src/components/RefereePanel.tsx`：`RefereeNotes`（裁判紀錄）與 `RefereeTools`（一次一個工具的表單：選工具、對象、多少、哪一桌哪一副、裁定、要重打的副、理由），放在雙人賽頁、隊制賽頁、挑戰結果頁的最下面；有紀錄就給所有人看，`canReferee` 才有表單。成績表標「處罰 −1.5」，traveller 標「裁定 Avg+ NS」（`RulingTag`）。打完的副照舊在牌局紀錄頁裁定（`RulingPanel`）。

## 5.24 比賽公告與報名（決策紀錄，`e9-t16`，AC-9.7，2026-11-03）

**比賽公告不是另一套比賽引擎**：它是「公告＋報名名單」，到時候由管理員把名單交給現有的比賽建立流程，比賽本身照樣是一場雙人賽（§5.22）、隊制賽（§5.8）或多隊賽（§5.26，`e9-t14`，它的每一輪又是一場場的隊制賽），在它們自己的頁面打、計分、出結果。所以 `e9-t17` 的裁判工具（§5.23）、積分（§5.21）、可見性（§4）都不用為比賽公告另外做。功能旗標 `tournaments`（`shared/features.ts`）**預設關**；管理員不開也能進 `/tournaments` 先準備（管理頁的功能旗標區有連結），頁首的「比賽」只在社員有旗標時出現。

- **資料**（`shared/tournament.ts`、`worker/tournaments.ts` 的 `TournamentService`，不碰 Cloudflare API）：每場一個 KV key `tourn:<id>`（`Tournament`：設定、狀態 `open`／`started`／`finished`／`cancelled`、報名名單、建立的比賽 id、提醒過的開賽時間），載入時全部讀進記憶體。社團一場一場地少，不放 SQL、不放 `EventObject`。
- **公告**（只有管理員，`tournamentAdminOnly`）：比賽方式（`pairs` 雙人賽／`match` 隊制賽）、名稱、說明、開賽時間、報名截止（不晚於開賽）、名額（雙人賽 5–20 對；隊制賽固定兩隊），以及那種比賽自己的設定（雙人賽的每輪副數與每副限時、隊制賽的副數、IMP／BAM、每副限時，用 `parsePairsSettings`、`parseTeamMatchSettings` 檢查）。錯了回 `badTournament { field }`。建立時通知每位有旗標的社員（`tournamentAnnounced`）。開賽前可以改（已經有人報名就不能換比賽方式、名額不能少於已報名的）、可以取消（通知報名的人）、可以移除某一組報名（通知那組的人）。
- **報名**（有旗標的社員，報名截止前）：雙人賽可以自己報名（算半對，開賽時和其他單人依報名順序兩兩配對）或帶一位搭檔；隊制賽一定是四人一隊（可取隊名）。搭檔、隊友用帳號名稱指定，檢查：存在、不是自己、不重複、兩邊都沒封鎖對方（`tournamentBadPartner`，不說是哪一種）、沒人已經在別組（`tournamentAlreadyIn`）、人數對（`tournamentEntrySize`）、沒超過名額（`tournamentFull`）。**搭檔要確認**（`tournamentPartner` 通知；`POST …/answer { accept }`），確認在開賽前都可以，婉拒和**退出**（同組任何一人）只能在截止前（`tournamentClosed`），而且整組一起取消，通知同組其他人（`tournamentWithdrawn`）。
- **報名名單**：所有有旗標的社員都看得到每一組的人、誰還沒確認（`TournamentView.entries`）；取消的比賽只有管理員看得到。
- **開賽前提醒**：統一排程器（`worker/scheduler.ts`）的 `tournament:<id>:<開賽時間>` 工作（`JobKind` 的 `tournament`），排在開賽前一小時（已經過了就立刻），給名單上每一個人（含還沒確認的）`tournamentReminder`。改了開賽時間就排新的一個，舊的到時發現時間不對什麼都不做；送過的記在 `remindedFor`，物件被回收後 `load()` 重排時也不會送第二次。取消或結束了就不送。
- **前一天的提醒**（社長 2026-11-03）：另一個工作 `tournament:<id>:<開賽時間>:day`（每種比賽方式都有，含個人賽），開賽前 24 小時送 `tournamentDayReminder`（「明天這個時候開賽」），對象一樣。只有**設定開賽時間的那一刻離開賽還有 24 小時以上**才有（公告時、或改了開賽時間時判斷，記在 `dayReminderFor`）；公告或改到不到一天後開賽就只有一小時前那一則。改時間的處理和一小時前的一樣（新時間新工作、舊的醒來什麼都不做），送過記在 `dayRemindedFor`。物件睡過頭、醒來時離開賽不到 12 小時（`dayReminderLateMs`）就不送前一天那則（會說「明天」），一小時前的照送。推播文字 `npm run push:texts` 重產。
- **用名單開賽**（管理員，`POST …/start`）：
  - 雙人賽：搭檔確認過的每一對（依報名順序），加上單人兩兩配成的對（照下面的配對；多出一人就不排），至少 5 對（`tournamentTooFew { count, min }`），最多前 20 對。`PairsService.createFrom` 建立雙人賽（**裁判是按開賽的管理員**，設定照公告），把每一對報名進去。之後管理員在雙人賽頁按「開始」（照 §5.22：所有人在線、沒在別的比賽才開得了）。
  - 隊制賽：前兩支四人都確認的隊伍。由第一隊的第一位當房主建立隊制賽（`invite = direct`、不放機器人、隊名照報名），用房主的身分把其他七人邀請到座位（第一隊：開室北、閉室東西；第二隊：開室東西、閉室南北），他們在邀請彈窗接受、房主在準備室開始（§5.8，照常的 `matchInvited` 流程）。有一個邀請失敗（例如有人封鎖房主）就把剛建立的隊制賽取消，比賽公告留在報名中。
  - 比賽公告變成 `started`、記下比賽 id；頁面多一個「前往比賽」連到 `/pairs/:id` 或 `/matches/:id`。
- **雙人賽頁的旗標**：從比賽公告建立的雙人賽，參賽的人與裁判不需要 `pairs` 旗標也能看那場的頁面與操作（`PairsService.allowed` 加上「是這場的人」），所以 `/pairs/:eventId` 的路由一律掛上、由伺服器決定（別人照樣 `pairsOff`）；雙人賽列表與建立仍要旗標。
- **結果公告**：雙人賽收尾（§5.22 的 `settled`，和積分同一個時機）與隊制賽收尾（`settleMatch`，完賽或放棄都算，放棄時兩室都打完的副照樣計分）時呼叫 `TournamentService.eventEnded`；讀比賽頁、列表時也會再看一次（社團漏聽的時候補）。比賽結束 → 比賽公告 `finished`，通知名單上每一個人 `tournamentResults`（直接連到結果頁），頁面的連結改成「看比賽結果」。建立的比賽在開打前被取消（雙人賽的裁判取消、隊制賽的房主取消）或不見了 → 比賽公告回到 `open`，管理員可以重新開賽。
- **單人報名的配對**（社長 2026-11-03，只有雙人賽；個人賽每個人都自己報名、和每個人當一次搭檔，沒有配對可調，`setPairing` 回 `tournamentBadPairing`）：單人照樣依報名順序兩兩配對，但開賽前比賽頁有「單人報名的配對」（`TournamentView.singles`：預計的每一對與多出的一人、管理員調整過沒有），所有看得到比賽的人都看得到。管理員可以用每個人旁邊的「交換…」把兩個人對調（`POST /api/tournaments/:id/pairing { order }`，送出整個順序），或「恢復報名順序」（`order: null`）。伺服器（`TournamentService.setPairing`）檢查：管理員、報名中、雙人賽、順序剛好是現在每一位單人各一次（`isPairingOrder`），不然 400 `tournamentBadPairing`（例如這中間有人報名或退出，頁面重新讀）。順序存在 `Tournament.pairing`；之後有單人退出就從順序裡拿掉、新報名的單人接在最後（`singlesOrder`），所以退出的人後面的會往前遞補，開賽前再看一次。開賽（`pairsFromEntries`）照這個順序配。
- **API**：`GET /api/tournaments`（依開賽時間）、`POST /api/tournaments { settings }`、`GET /api/tournaments/:id`、`POST /api/tournaments/:id/{settings|cancel|remove|enter|answer|withdraw|pairing|start}`。頁面 `src/pages/TournamentPages.tsx`（`/tournaments`、`/tournaments/:id`）。
- **個人賽**（`individual`，`e9-t15`，§5.25）：名額是人數（8–20），每個人都自己報名（帶搭檔回 `tournamentEntrySize`），一人算一個名額；和已報名的任何人有封鎖關係就不能報名（`individualBlocked`，個人賽每兩人會當一次搭檔）。開賽時依報名順序取 8、12、16 或 20 人（不超過報名人數的最大那一種，`playersFromEntries`），多的人這次不排；不到 8 人回 `tournamentTooFew`。`PairsService.createIndividual` 建立個人格式的雙人賽，之後一樣在 `/pairs/:id` 開始、打、計分；結束時 `tournamentResults` 的 `eventKind` 是 `individual`。
- **多隊賽**（`teams`，`e9-t14`）：見 §5.26。名額 3–16 隊，每隊 4–6 人（`entrySizes`），開賽時每一支全部確認的隊伍建立一場多隊賽（`TeamEventService.createFrom`），結束時同樣呼叫 `eventEnded` 公告結果。
- **還沒做**：隊制賽只取前兩隊（多的隊伍留在名單上）；雙人賽開賽仍要裁判在雙人賽頁按「開始」（要所有人在線，不在開賽時間自動開）；報名費、候補名單沒有做。

## 5.25 個人賽（決策紀錄，`e9-t15`，AC-9.6，2026-11-03）

AC-9.6：「個人賽：每輪換搭檔的移位與個人排名。」**不是另一套比賽引擎**：一場個人賽就是一場格式為 `individual` 的雙人賽（`PairsEvent.format`），用同一個 `PairsService`、`applyPairsStep`、`EventObject`（同一個開關 `EVENT_OBJECTS`、同一把 key `pairs:<id>`）、同一種牌桌（`mode=pairs`）、同一個計分（`scorePairs`）與同一頁（`/pairs/:id`）。差別只在「一個參賽單位是一個人」與移位。

### 移位（`shared/movement.ts` 的 `individual`）

- **8、12、16、20 人**（2–5 桌，`INDIVIDUAL_SIZES`）。雙人賽的引擎不放機器人，所以只收剛好坐滿的人數，沒有人輪空；其他人數回 `individualSize`。
- 用 **Z-cyclic whist tournament** Wh(n)：參賽者是 0 … m − 1（m = n − 1）與 ∞，第一輪的每一桌 `[a, b, c, d]` 是 a、c（南北）對 b、d（東西），第 r 輪每個數加 r（mod m，∞ 不動），共 m 輪。四種人數的第一輪（`WHIST_FIRST_ROUNDS`）是電腦搜尋找到的，滿足「搭檔的差（±(a − c)、±(b − d)）剛好涵蓋每個非零數一次、對手的差剛好兩次」，所以**全場每兩人剛好當一次搭檔、當兩次對手**，這是最平均的排法（每人 n − 1 輪、每輪一個新搭檔、兩個對手）。測試（`tests/engine/individual-movement.test.ts`）把四種人數全部展開檢查：每輪每人剛好一個座位（沒有衝突、沒有輪空）、每兩人搭檔 1 次、對手 2 次。
- 報名順序就是號碼：最後報名的人是 ∞（整場坐同一桌同一個位置），其他人每輪換桌換位置。
- **只打前幾輪**（社長 2026-11-03 核准；16 人 15 輪、20 人 19 輪太長）：設定 `PairsSettings.rounds`（1 … 人數 − 1，不給就是全部 n − 1 輪），移位只取上面排法的**前 N 輪**（`individual(players, boardsPerRound, rounds)`，`individualRoundsFor`），每輪副數照設定。建立時還不知道人數，所以伺服器只檢查 1–19（`INDIVIDUAL_ROUNDS_MAX`），**開始時比人數 − 1 多就打滿 n − 1 輪**；比賽公告知道名額，檢查 1 …（名額最多坐得下的人數 − 1，例如名額 13 坐 12 人、最多 11 輪）。錯了回 `individualRounds { max }`；雙人賽（Mitchell）不能設（同一個錯誤），比賽公告的雙人賽／隊制賽不保留這個欄位。
  - **還剩下的平衡**：每一輪是完整的一輪，所以**每個人每一輪都上場**（沒有座位衝突、沒有輪空），而且排法裡每兩人只搭檔一次，取前 N 輪**也不會有人跟同一人搭檔兩次**（每人 N 個不同的搭檔）；每一副仍在每一桌各打一次。**沒有的**：不是每兩人都當過搭檔，對手次數也不一定一樣（完整排法是每兩人當兩次對手），所以搭檔的強弱不再完全抵銷。
  - **排名照舊用總百分比**：每個人「拿到的 MP ÷ 自己打過那幾副的滿分」，沒有另外的校正；每個人打的副數一樣，Neuberg 的 N 照 `plannedPlays`（截短後的排法，每副 = 桌數），積分（`individual`）照名次，不受影響。測試：`tests/engine/individual-movement.test.ts`（四種人數截短都檢查座位、搭檔不重複、每人 N 輪、百分比與 Neuberg）、`tests/worker/pairs-individual.test.ts`（檢查、打完前 3 輪就結束、積分、比賽公告）。
- **牌**：線上沒有實體牌要傳，所以**同一輪每一桌打同一組牌**（第 r 輪打第 (r − 1) × 每輪副數 + 1 起的那幾副），每一副在每一桌各打一次（桌數 = 比較的次數，Neuberg 的 N）。每輪副數 1–4，全場最多 32 副：8 人 7 輪（最多每輪 4 副）、12 人 11 輪（2 副）、16 人 15 輪（2 副）、20 人 19 輪（1 副）。只打前 N 輪時 32 副的上限照實際打的輪數算（例如 20 人打 6 輪可以每輪 4 副）。
- `MovementTable` 多一個 `seats`（北、南、東、西的參賽者序號）；`ns`／`ew` 是北家與東家的序號（牌桌回報的結果照舊帶 `ns`／`ew`，`applyPairsStep` 照舊比對）。`entrantsAt`、`sidesAt`、`resultSides` 把「一張桌或一筆結果的兩方」統一成參賽者的序號清單，雙人賽是 `[ns]`／`[ew]`，個人賽是兩位。

### 報名、開始、進行

- `POST /api/pairs { settings, format: 'individual' }` 建立（有 `pairs` 旗標的社員；格式錯了回 `badPairsSettings`），`POST /api/pairs/:id/enter`（不帶搭檔）自己報名。`PairsPair.players` 在個人賽只有一位，所以報名名單、退出（自己或裁判）、`pairOf`、`pairsPlayers` 都照舊。最多 20 人（`individualFull`）。**封鎖**：個人賽每兩人會當一次搭檔，所以和已經報名的任何人有封鎖關係就不能報名（`individualBlocked`，不說是誰）。
- 開始的檢查與雙人賽一樣（裁判、所有人在線、沒在別的比賽），人數不對回 `individualSize { sizes }`。每一輪的每一桌照 `seats` 坐（`seatsOf`），換桌、拖住的桌、`usePairsFollow` 帶人去新桌都照 §5.22；`TablePairs.individual` 讓牌桌上方的 `PairsBanner` 寫「個人賽」。

### 計分與排名

- 每一副照雙人賽算 MP（同一副在每一桌的結果互比，§5.22 的 `scorePairs`，含裁定與 Neuberg），**每個人拿自己那一方的 MP**：南北兩位都拿 `mpNS`、東西兩位都拿 `mpEW`（`resultSides`）。
- **一個排名**（沒有南北／東西之分，`PairStanding.dir` 不給），百分比是「拿到的 MP ÷ 自己打過那幾副的滿分」，同百分比同名次；即時成績每次讀頁面重算。
- **積分**：收尾時 `pairsRanked` 送 `kind: 'individual'`，每人一方（§5.21 的新種類 `individual`，預設參加 2 分、每贏過一人 0.5 分、至少 4 人），積分明細連到 `/pairs/:id`。

### 裁判工具、可見性、比賽公告

- **裁判工具**（§5.23）全部適用，`POST /api/referee/pairs/:id`：處罰的對象是一位參賽者（序號），調整分數、沒打的副給分數、重新開一桌（四位照 `seats` 離桌、到新桌）都照雙人賽。
- **可見性**（§4）：traveller 的每一列多帶 `seats`；參賽者打完那一副（自己坐過那一桌那一輪）才看得到別桌的結果，紀錄的 id 只跟著自己坐過的那一列；結束後全部公開。
- **比賽公告**（§5.24）多一種比賽方式 `individual`：只能自己報名，名額是人數，開賽時取前 8／12／16／20 人；「輪數」放在 `TournamentPairsSettings.rounds`，建立的個人賽帶著它。

### 頁面

`src/pages/PairsPages.tsx` 依 `PairsView.format` 顯示：建立表單多「比賽方式」（雙人賽／個人賽），個人賽多「輪數」（`IndividualRoundsSelect`：全部，或 1–19；比賽公告的表單也用，上限照名額）、報名中的比賽頁寫「只打前 N 輪」、報名只要按「報名」、每一桌與 traveller 的每一方寫那兩位、成績只有一張表（「社員」）、「我的逐副表現」多一欄「搭檔」。比賽公告頁（`TournamentPages.tsx`）的個人賽：名額（人）、只有「自己報名」、開賽說明。

### 社長的決定（2026-11-03）

- **人數照舊只收 8／12／16／20**；其他人數要機器人補位（雙人賽的引擎還沒有），或接受每輪有人輪空的排法（搭檔次數會不平均），這次都不做。比賽公告多出來的人**不排**（照報名順序取前面的人）。
- **輪數**：給「只打前幾輪」的選項（上面「只打前幾輪」），預設仍是人數 − 1。
- **積分預設不變**：個人賽參加 2、每贏過一人 0.5、至少 4 人。

## 5.26 多隊賽：循環與瑞士制（決策紀錄，`e9-t14`，AC-9.5，2026-11-03）

AC-9.5：「多隊賽：多隊循環或瑞士制配對，VP 計分（用 E8 的 VP 換算）。」照 §5.18 的共同模型：**Event** 是一場多隊賽，**Round** 是一次配對，**Table** 是那一輪每一場隊制賽的兩室，**Board** 同隊制賽。**每一輪的每一組配對就是一場一般的雙桌隊制賽（§5.8）**：不另寫一套比賽引擎，開桌、兩室推進、結果、裁定、暫停、代打、替補、結果頁、觀賽、整場重播、`EVENT_OBJECTS` 的正本與副本（H2c）、裁判工具（§5.23）全部照舊。多隊賽本身只記「誰、第幾輪、跟誰、是哪一場比賽」，名次在每次讀頁面時從那幾場比賽現在的比分算。

**只從比賽公告建立**（§5.24 的新比賽方式 `teams`）：管理員公告（名額 3–16 隊、每場副數 4–32、每副限時、**賽制**（自動、循環賽、瑞士制）與輪數 3–9），社員整隊報名（自己加 3–5 位隊友，4–6 人一隊，可取隊名；隊友照 §5.24 確認），管理員「用報名名單開賽」→ 每一支全部確認的隊伍（依報名順序，最多 16 隊，少於 3 隊回 `tournamentTooFew`）建立一場多隊賽，**按開賽的管理員是裁判**。旗標用 `tournaments`，沒有另外的旗標；比賽公告頁連到 `/team-events/:id`。

### 賽制與配對（`shared/team-event.ts`，純函式）

- **賽制由管理員在公告上選**（社長 2026-11-03，`TournamentTeamsSettings.format`、`TeamEventSettings.format`）：
  - **循環賽**（`roundRobin`）：輪數一定是「名額 − 1」（奇數名額是名額），每隊遇到每隊一次；公告時伺服器檢查（`roundsFit`，不對回 `badTournament { field: 'rounds' }`），所以循環賽最多 10 隊（9 輪）。開賽時照**實際報名的隊數**打完整的循環（`eventFormat`：n 隊 n − 1 輪，奇數隊 n 輪），報名少於名額就少打幾輪。
  - **瑞士制**（`swiss`）：輪數由管理員定，要少於名額（`roundsFit`）；開賽時不超過實際隊數 − 1。
  - **自動**（`auto`，表單的預設建議，也是之前公告的比賽）：照原本的規則（`formatFor`）：n 隊的循環要 n − 1 輪（奇數隊 n 輪），**不超過「最多幾輪」就打循環**，否則打「最多幾輪」輪的瑞士制（不超過 n − 1 輪）。預設最多 5 輪：3–6 隊打循環、7 隊以上打瑞士制。
  - 表單選了循環賽時，輪數欄跟著名額自動算、不能改（名額最多 10），並寫出規則。
- **循環**（`roundRobinSchedule`）：圓桌法（第 0 隊不動、其他每輪轉一格）；奇數隊加一個空位，遇到它的那一隊**輪空**，每隊剛好輪空一次。誰是 A 隊（A 隊的第一位當房主）照輪次與位置交替，不會有一隊每場都是房主。
- **瑞士制**（`swissPairing`）：照目前排名由上往下配，每一隊配給排名最高、**還沒遇過**的那一隊；配到後面有人沒得配就退回去換（回溯），所以**只要有不重複的配法就一定找得到**；真的沒有（例如場數太多）才允許重複。第一輪照報名順序（1 對 2、3 對 4…）。為了免費方案的 CPU（每次請求 10 ms），回溯最多走 20,000 步，超過就當作沒有、改用允許重複的配法。
- **輪空**（奇數隊）：瑞士制給**排名最低、還沒輪空過**的一隊（大家都輪空過就給最低的），而且要讓其他隊仍配得出不重複的對手；輪空得 **12 VP**（`BYE_VP`，WBF 的慣例），在**那一輪的比賽都結束之後**才算進排名，排名才是同樣場次在比。

### 計分與排名（`eventStandings`、`teamStandings`）

- 每場比賽的 IMP 用跟隊制賽頁**同一個算法**（`worker/ranking-events.ts` 的 `matchTotals`：每副結果、紀錄上的裁定、裁判的超時裁定、**裁判的處罰**），再照 E8 的 WBF 連續 VP 表換算（`matchVictoryPoints`，副數用比賽設定的副數），每場兩隊加起來 20 VP。比賽一律 IMP 計分（VP 要 IMP）。
- 算進排名的：**完賽**的比賽，與**中止**（`abandoned`）的比賽（照中止時兩室都打完的副算，同 §5.8）。開打前就取消的比賽兩隊都不得分（正常不會發生，見下面「比賽的規矩」）。
- **排名**：VP 總分；**同分時**：只有**兩隊**同分、而且兩隊打過，看兩隊之間比賽的 VP；再看 **IMP 商數**（IMP 得分 ÷ 失分，沒有失分最大，都沒有是 1）；還是一樣就**並列**（同名次，列表上照報名順序）。三隊以上同分直接看商數（不做小循環）。頁面寫出這些規則。
- **輪空 12 VP、同分規則（兩隊看對戰的 VP、再看 IMP 商數、不做小循環）、積分的預設**（上場給 2 分、每贏過一隊 2 分，只算實際上場過的隊員）：社長 2026-11-03 決定**照現在的做法**，不改。
- 裁判在比賽頁做的調整分數與處罰（§5.23，`POST /api/referee/match/:id`）就是多隊賽的調整：隊制賽頁的比分、多隊賽的 VP 與排名都從同一份紀錄重算，**不用另外做**。多隊賽本身沒有「扣 VP」的工具（扣 IMP 就會換成 VP；要直接扣 VP 等社長決定）。

### 一輪怎麼進行（`worker/team-events.ts` 的 `TeamEventService`，不碰 Cloudflare API）

- **出賽名單**：每隊有一份「下一輪的出賽名單」，四位、依座位順序（開室一對、閉室一對），預設是報名的前四位。**隊長**（報名的第一位）、裁判或管理員在比賽結束前都能改（`POST /api/team-events/:id/lineup { team, players }`，`teamEventCaptainOnly`、`teamEventBadLineup`）；改了只影響之後開的輪。
- **開下一輪**（`POST /api/team-events/:id/next`，只有裁判或管理員 `teamEventDirectorOnly`；上一輪的每一場都結束才行 `teamEventRoundOn`；打完了 `teamEventOver`）：算出配對，每一組建立一場隊制賽（`TeamMatchService.createSeated`），**八個座位直接入座**（報名時已經確認過，不再邀請）：A 隊的出賽名單坐開室南北（第一位坐南、當房主）與閉室東西，B 隊坐開室東西與閉室南北（B 隊第一位是 B 隊隊長，`invite = captains`）；IMP、不放機器人（出賽名單少人時那個座位才放比賽制度的機器人）、副數與每副限時照公告。有一場建不起來就把這一輪已建的取消、這一輪不算。這一輪每一隊的每個人都收到 `teamEventRound`（有比賽的連到自己那一場、輪空的連到多隊賽頁）。**每場由房主或裁判在準備室開始**（八位都在線、沒在打別場，照 §5.8 的 `matchReady`），各場不必同時。
- **一輪的各場打同一組牌**（社長 2026-11-03）：開一輪時發一次牌（`TeamEventDeps.newDeals`，副數照設定、牌號 1、2、3…，所以發牌者與身價跟著牌號，機器人也照它），存在 `teamevdeal:<多隊賽>:<輪>`、那一輪標 `sameDeals`；每一場開始時（`ClubService.startMatch`）用 `TeamEventService.dealsFor` 拿這一組，不再各自洗牌（之前開的輪沒有這組牌，照舊各自洗）。這一輪建不起來時連牌一起刪。所以賽後可以**跨場比較**每一副（多隊賽頁的「各副比較」，`roundComparison`）：每一場的兩室合約、結果、南北分數、各隊得的 IMP，以及每一室對**基準分**的 IMP（基準分是那一副所有沒被裁定的室的南北分數平均、取到 10 分，Butler 的做法但不去掉最高最低；少於兩室就不算）。同一組牌帶來的可見性規則（一副要這一輪每一場都打完才對外公開、同一輪別場的隊伍不能觀看）見 §4。
- **比賽的規矩**（`TeamMatchDeps.eventTeams`）：多隊賽的比賽座位就是出賽名單，所以準備中**只能在同一隊裡換座位**（`matchMove`），邀請、離開、移出、補機器人、改設定、取消都回 `teamEventMatch`；**替補只能是這一隊報名的隊員**（`teamEventRoster`；5、6 人的隊伍用得上）。房主自己也是參賽者，所以（社長 2026-11-03）**多隊賽的比賽由多隊賽的裁判（與管理員）管理，不是房主**：超時裁定（`matchRule`）、暫停與繼續、中止、機器人代打、開始下一段（`e8-t21`）都只有裁判與管理員能做，房主做回 `matchEventDirector`（403）；裁判也能**替房主按「開始」**（房主自己照樣能按），比賽開始的通知照誰按的寄（`TeamMatchService.started` 的 `by`）。**房主只剩自己隊的座位**：準備中與中場換位只能換 A 隊的（B 隊由 B 隊隊長），暫停時的替補也只能補 A 隊的座位（`matchNotCaptain`；裁判兩隊都可以）。比賽頁的裁判工具（§5.23）也給這場多隊賽的裁判與管理員（`refereeOnly`；`canReferee`）。檢查在 `team-match-flow.ts`（`EventRole`、`runsMatch`）：社團算出這個人是不是這場比賽的裁判（`TeamMatchDeps.eventRole` ← `TeamEventService.roleIn`），跟著 `MatchStep` 的 `role` 送到比賽自己的物件，那裡用同一條規則再檢查一次（H2c）。裁判在準備中就看得到比賽（`teamMatchView` 的 `EventDirecting.directs`），比賽有變化也推給他（`eventDirector`），兩室的時鐘（`rooms`）給他不給房主。
- **結束**：最後一輪的最後一場結束（`ClubService.settleMatch` → `TeamEventService.matchEnded`；讀頁面時也會再看一次）→ 多隊賽 `finished`，記**積分**（種類 `teams`，每隊一方、名次照排名，每隊**實際上場過**的社員才算；同名次同分；rating 每隊一方）→ 比賽公告 `finished`、通知名單上每一個人 `tournamentResults`（直接連到多隊賽頁）。**多隊賽裡的每一場隊制賽不另外記 `match` 積分**（不然一場比賽記兩次）。裁判在多隊賽結束前做的調整都算進積分；**結束之後**在某一場比賽上的調整（處罰、撤銷、調整分數）照 §5.23 的自動重記：那一場本身沒有積分，所以重算的是整場多隊賽（`TeamEventService.rankedNow` → `RankingsService.recredit`），稽核紀錄是一筆 `points:recredit`、`target` 為 `teams:<id>`（沒有新的稽核動作）。
- **取消**（`POST /api/team-events/:id/cancel`）：裁判或管理員，只在第一輪開始前（`teamEventStarted`）；比賽公告回到報名中，可以再開一次（會是新的一場）。
- **刪除帳號**：從還沒結束的多隊賽的隊伍裡拿掉（在出賽名單裡就由隊上下一位補上）；已經在比賽裡的座位照 §5.8（機器人代打）。

### 儲存

每場多隊賽一個 KV key `teamev:<id>`（`TeamEvent`：設定、賽制、輪數、隊伍與出賽名單、每一輪的配對與比賽 id、輪空、狀態），社團載入時全部讀進記憶體；每一輪的牌另外一個 key `teamevdeal:<id>:<輪>`（不跟多隊賽放在一起：32 副 × 9 輪會太大，也不必每次讀進記憶體），比賽開始時才讀（跟比賽公告一樣，一場一場地少）。**不放 `EventObject`**：多隊賽只在開一輪、改出賽名單時改，一輪幾十分鐘一次；每一副的結果都在那幾場隊制賽裡，而它們照 H2c 在 `EVENT_OBJECTS=on` 時住在自己的物件。排名不存，每次讀頁面時從那幾場比賽的副本算（16 隊 × 9 輪最多 72 場，一場 32 副）。測試在兩種 `EVENT_OBJECTS` 模式都跑（`tests/worker/team-events.test.ts`、`team-event-director.test.ts` 在 `event-objects` project）。

### 可見性（`worker/views.ts` 的 `teamEventView`，§4）

看得到多隊賽的：有 `tournaments` 旗標的社員（報名名單本來就給他們看）、參賽隊伍的每一個人與裁判（沒有旗標也可以）、管理員；取消的只有裁判與管理員；其他人一律 `teamEventGone`（不透露存在）。隊伍、配對、每場目前的 IMP（跟隊制賽頁給局外人的一樣：只算兩室都打完的副；一輪各場同一組牌時，給那兩隊以外的人只算這一輪每一場都打完的副，`shownImps`）、結束的比賽的 VP、排名、各副比較（只有這一輪每一場都打完的副），全部公開給看得到的人。**唯一不公開的是「下一輪的出賽名單」**：只給自己隊的人、裁判與管理員（其他人拿到空的），等那一輪開了，座位本來就在比賽頁上。

### 介面

`/team-events/:id`（`src/pages/TeamEventPage.tsx`）：狀態、賽制、輪數與副數、裁判；「你們這一輪的比賽」（連到準備室）或「這一輪輪空」；裁判的「開始第 n 輪」與取消；**排名表**（名次、VP、場數、輪空、IMP 得失、商數，下面寫出同分規則）；**各輪**（每一場的兩隊、狀態、IMP、VP、連到比賽頁；輪空的隊；可展開的「各副比較」：每一副的基準分與每一場的兩室、IMP、對基準 IMP）；**隊伍與出賽名單**（隊長與裁判有選四位的表單）。比賽公告頁多一種比賽方式「多隊賽」（名額、賽制、副數、輪數、每副限時；整隊報名 3–5 位隊友）。隊制賽頁（`MatchPage`）在多隊賽的比賽上寫出這是多隊賽的一場、連回多隊賽頁；裁判看到「開始比賽」與「比賽管理」（暫停、中止、超時裁定、代打），房主看不到比賽管理、改設定與取消。積分明細的多隊賽連到這一頁。進行中每 10 秒重讀。

### 社長決定（2026-11-03）

1. 輪空給 **12 VP**（WBF 慣例），照舊。
2. **管理員直接選賽制**（循環賽或瑞士制，或自動），見上面「賽制與配對」。
3. 同分規則照舊：只有兩隊同分看兩隊之間的 VP，再看 IMP 商數，**不做小循環**。
4. 多隊賽的比賽，超時裁定、暫停、中止、代打**由裁判（與管理員）做**，裁判也能替房主按「開始」；房主只管自己隊的座位。
5. 每一輪的各場**打同一組牌**，多隊賽頁可以跨場比較每一副（等每一場都打完那一副）。
6. 積分照舊：只算上場過的隊員；預設上場 2 分、每贏過一隊 2 分、至少 3 隊。

還沒做：線上報名費、候補隊伍（同 §5.24）；多隊賽本身「直接扣 VP」的工具。

## 5.8 隊制賽（決策紀錄，`e8-t01`，2026-10-25）

隊制賽（E8，雙桌隊制賽，Teams of Four）：房主找齊 8 個人（不夠可補機器人），兩隊在開室與閉室打同一組牌，依兩室的南北分差計 IMP 或 BAM。這一節是 F2 定下的設計，後面的批次（F3–F5、M2）照這裡做；要改設計先改這裡。PRD 沒有定、F2 先選的做法（原本標「建議預設」）社長 2026-10-25 全部確認。

**座位對應**（`shared/team-match.ts` 的 `teamAt`、`MATCH_SEATS`）：

| | 開室（Table 1，`open`） | 閉室（Table 2，`closed`） |
| --- | --- | --- |
| 南北 | A 隊 | B 隊 |
| 東西 | B 隊 | A 隊 |

座位不存「哪一隊」，由房間與方位算出來，所以永遠一致；8 個座位的順序是開室 N E S W、閉室 N E S W。**房主就是 A 隊**（A 隊隊長），建立時坐 A 隊的一個座位（預設開室南，同 BBO 坐南），不能坐 B 隊的位子。B 隊隊長在隊長制（`e8-t05`）時由房主指定。

**資料模型**（`worker/team-matches.ts` 的 `TeamMatch`，狀態、設定與畫面型別在 `shared/team-match.ts`）：

```
match（matches 一列）
  ├─ settings   兩隊隊名、副數、計分（imp／bam）、每副時間上限、可否補機器人、機器人的制度、邀請方式（JSON）
  ├─ captains   A（＝房主）、B（隊長制才有）
  ├─ deals      DealSet（shared/deal-set.ts）：開始時才發，之前改副數不必重發
  ├─ tables     open／closed 兩張牌桌的 id：開始時才有
  ├─ seats[8]   match_seats：room × seat → empty｜invited（userId）｜seated（userId 或機器人）
  └─ boards[]   match_boards：每副一列：開室、閉室各自的牌局 id、南北分數、時間；房主的裁定與理由
```

和挑戰一樣，結果只存計分要用的南北分數與牌局 id；合約、莊家、首攻、墩數由 `board_id` 接 `boards_index`（§5.3），重播讀 `board:<id>`，不存第二份。每副的 IMP／BAM 不存，每次由 `scoreTeamMatch` 算（改計分規則或裁定時不必回寫）。

**狀態**（`MatchStatus`）：

| 從 | 到 | 什麼時候 |
| --- | --- | --- |
| — | `setup` | 建立（準備室）。房主可改設定、取消；F3 起可邀請、入座、補機器人 |
| `setup` | `playing` | 房主按開始（`e8-t07`），而且 `matchReady`：8 個座位都 `seated`（真人接受了或機器人）、設定允許才有機器人、每位真人都在線。開始時發 `DealSet`、開兩張牌桌、寫 `started_at` |
| `setup` | `cancelled` | 房主取消（開始前才能）；或房主的帳號被刪除 |
| `playing` | `finished` | 每一副兩室都打完或已裁定（`e8-t11`） |
| `playing` | `abandoned` | 房主中止（中止前要先暫停或在段與段之間，`matchPauseFirst`，`e8-t16`）；已有結果的副照算，結果頁標「已中止」 |

分段（`e8-t21`）不是新的狀態：`playing` 之內記「現在第幾段」（`matches.segment`，第 1 段不存）與「段與段之間」（`matches.break_at`），見下面的「分段與中場換位」。

PRD 的 `ready` **不存**：能不能開始由座位與「誰在線」算出（`matchReady`，回傳不能開始的原因 `seats`／`robots`／`offline` 給準備室的按鈕，`e8-t06`），因為在線狀態不存。`finished`、`cancelled`、`abandoned` 之後不再改動（`isOpenMatch`）。

**設定**（`TeamMatchSettings`，`parseTeamMatchSettings` 檢查：每欄可省略，建立時套預設、改設定時套比賽現有的設定，不能有其他欄位，錯了回 `badMatchSettings { field }`）：

| 欄 | 範圍 | 預設 |
| --- | --- | --- |
| `teamNames` | 兩個字串，去頭尾空白後 0–20 字、不含控制字元 | `['', '']`：空的由瀏覽器顯示成該語言的「A 隊」「B 隊」（伺服器不存介面文字） |
| `boards` | 4–32 | 8 |
| `scoring` | `imp`／`bam` | `imp` |
| `boardMinutes` | 0（不限）或 3–30 分鐘 | 10（PRD；下限 3、上限 30） |
| `robots` | 是否允許機器人補位；關掉時已經坐著的機器人離座 | `true` |
| `robotKind` | `tku`／`gib`：整場所有機器人用同一種制度，兩室面對同一個機器人；`tku` 要房主有 `tkuSystem`（§5.1.2） | `gib`（同挑戰） |
| `invite` | `direct`（房主邀請到指定座位）／`captains`（隊長制） | `direct` |
| `delay` | 觀看者落後一墩（`e8-t19`，§4）；之前存的比賽沒有這一欄，讀出來是預設值 | `false` |
| `segmentBoards` | 0（不分段）或 2 到副數減 1：每段幾副（`e8-t21`，見下面的「分段與中場換位」）；之前存的比賽讀成 0 | `0` |

PRD 寫的「機器人等級」不做：機器人只有一個 TKB、沒有等級（CLAUDE.md 規則 6），送 `robotLevel` 會被當成不認得的欄位拒絕。

**建立、改設定、取消**（F2，`e8-t03`）：都走 HTTP，`worker/team-match-service.ts` 的 `TeamMatchService`（`ClubService.matches`）。`ClubService` 只建它、在載入時建表、刪帳號時呼叫 `forget`，給它時鐘、id、`publicUserById` 與每位社員的速率限制（§5.6）；步驟是 `worker/team-match-flow.ts` 的純函式，錯誤一律是 `ClubError` 加 `shared/messages.ts` 的代碼。

- `POST /api/matches { settings?, seat? }` → `{ match }`：任何社員都能建立；`seat` 是 A 隊的座位 `{ room, seat }`（不是就 `badMatchSettings { field: 'seat' }`）。**一個人同時只能主辦一場還沒結束的比賽**（`setup`／`playing`，`matchOpen`，避免準備室亂開）。
- `POST /api/matches/:id/settings { settings }` → `{ match }`：只有房主（`matchHostOnly`，403），只在 `setup`（`matchStarted`）。
- `POST /api/matches/:id/cancel` → `{ match }`：只有房主，只在 `setup`；寫 `ended_at`。開始之後要停只能中止（`abandoned`，F5）。
- `GET /api/matches` → `{ matches }`（我主辦或有座位的，新的在前）、`GET /api/matches/:id` → `{ match }`。看不到的比賽一律 `matchGone`（404），不透露比賽存在。
- 改設定與取消之後推送（`match`，見下）；取消時通知座位上的每個人（`matchCancelled`）。

**座位、邀請與隊長制**（F3，`e8-t04`、`e8-t05`，2026-10-25）：步驟是 `team-match-flow.ts` 的純函式（`inviteToSeat`、`answerSeat`、`moveSeat`、`leaveSeat`、`clearSeat`、`robotSeat`，回傳要寫的座位與 B 隊隊長），`TeamMatchService.act` 檢查封鎖、寫入（一個 transaction）、送通知、推送。同一組動作有 socket 訊息（`matchInvite { matchId, room, seat, userId }`、`matchAnswer { matchId, accept }`、`matchMove { matchId, from, to }`、`matchLeave`、`matchClear { matchId, room, seat }`、`matchRobot { matchId, room, seat }`，`GUARDS` 先檢查欄位型別）與 HTTP（`POST /api/matches/:id/invite|answer|move|leave|clear|robot`，同一套檢查與速率限制，回 `{ match }`，自己看不到了是 `null`）。都只在 `setup`（否則 `matchStarted`）。

- **誰安排哪一隊**（`arrangerOf`，`shared/team-match.ts`）：A 隊永遠是房主。`direct` 時 B 隊也是房主；`captains` 時 B 隊在有隊長之後歸 B 隊隊長，之前歸房主——但房主只能邀請**一位**到 B 隊（那位就是隊長；B 隊已經有人受邀或入座時回 `matchCaptainPending`），可以先放機器人。受邀到 B 隊、在 B 隊沒有隊長時接受的人成為 B 隊隊長（`captains.B`）。房主在有人入座 B 隊之後改成隊長制，第一位坐 B 隊的真人成為隊長。
- **邀請**：安排這一隊的人邀請一位社員到這隊的空位（`matchNotCaptain`、`matchSeatTaken`；不能邀自己 `notSelf`、已在比賽裡的人 `matchAlreadyIn`、不存在的帳號或機器人 `userGone`）。**邀請對象不限好友**（湊 8 人比挑戰難），但受邀者和邀請者、受邀者和房主之間任一方封鎖另一方都回中性的 `cannotInvite { name }`（不透露誰封鎖誰）。受邀者收到 `matchInvited`。一人在一場比賽只有一個座位；同時參加幾場比賽不限（開始時的衝突是 F4 的事）。
- **回覆**：受邀者接受（座位變 `seated`）或拒絕（變空位）；安排那一隊的人收到 `matchAccepted`／`matchDeclined`（是自己時改通知房主）。沒有邀請 `matchNoInvite`。
- **換座位**：只在同一隊的座位之間（隊伍由房間與方位決定，`matchOtherTeam`）。入座的人可以自己換到同隊的空位；安排這一隊的人可以交換同隊任兩個座位（連同受邀中、機器人）。
- **離開**：房主以外的人都能離開（受邀中就等於拒絕，`matchDeclined`；已入座 `matchLeft`，通知安排那一隊的人）；房主不能離座（`matchHostStays`，要不比就取消）。B 隊隊長離開或被移出時，B 隊第一位入座的真人接任隊長；沒有人就沒有隊長，由房主再邀請一位。
- **移出、補機器人**：安排這一隊的人（以及房主，任何座位）可以清空座位——撤回邀請、移出社員（對方收到 `matchRemoved`）或拿掉機器人——但不能清房主的座位。補機器人只能放在空位、要設定允許（`matchNoRobots`）；機器人的制度是整場的 `robotKind`，沒有等級（CLAUDE.md 規則 6）。
- **推送**：每次改動（含改設定、取消）把比賽依各人能看到的樣子推給這場比賽在線的人，改動前在比賽裡、之後看不到的人收到 `match: null`；社員上線或離線時推給他所在、還在準備的比賽（`presence`），因為「能不能開始」看誰在線。畫面的 `ready` 就是 `matchReady`，`online` 只標在真人座位上。

**準備室**（`e8-t06`，`/matches/:id`，`MatchPage`；比賽列表 `/matches`，`MatchesPage`，頁首的「隊制賽」）：兩室各四個座位（隊伍顏色、空位／等待回覆／入座、在線點、隊長標記），自己能做的動作按鈕（邀請時從大廳的社員列表選人，排除已在比賽裡與自己封鎖的人）；兩隊名單；受邀時的接受／拒絕；隊長制的說明；兩室機器人座位不對稱時的提醒（`robotsUneven`）；房主的設定表單、取消比賽；其他人的「離開比賽」。開始按鈕只給房主，F3 一律停用並寫出原因（`ready.reason`：座位沒滿、設定不允許機器人、有人不在線），都滿足時說明開始功能即將開放——按下去開始比賽是 F4（`e8-t07`）。

**計分**（`e8-t02`，`shared/team-scoring.ts`）：A 隊每副的淨分＝開室南北分數 − 閉室南北分數（A 在開室坐南北，閉室的南北是 B）。

- `imp`：淨分照 WBF IMP 表（`shared/imp.ts`）換算，IMP 給贏的那一隊（兩隊的數字都 ≥ 0，例如「A 23 : B 15」）。
- `bam`：淨分 > 0 得 1、= 0 各 ½、< 0 得 0。
- **裁定**（AC-8.6，`Ruling`：`avg`、`avgPlus`、`avgMinus` 加「給哪一隊」）：IMP 時 Avg 是 0、Avg+ 給那一隊 +3、Avg- 是 −3（也就是對方 +3）；BAM 時 Avg 各 ½、Avg+ 是那一隊 0.6／對方 0.4、Avg- 反過來（比照 MP 的 60%／40%）。每副的結果都是零和。有裁定的那一副**以裁定為準**，就算兩室後來都打完了也一樣（裁定可以撤回，`setRuling(…, null)`）。
- 一副只有一室打完、又沒有裁定時不算分（`null`）；`scoreTeamMatch` 回傳每副結果、兩隊總分、已完成副數與領先的隊（同分是 `null`）。測試含手算的四副比賽（`tests/engine/team-scoring.test.ts`）。
- M2 的 VP（`e8-t22`）用總 IMP 差換算，放在 `shared/vp.ts`（同 `shared/imp.ts`），見下面 J5a。

**開始與兩桌推進**（F4，`e8-t07`、`e8-t08`，2026-10-25 已實作）：
- 牌桌模式 `team`（`TABLE_MODES` 加 `team`；掛勾在 `worker/team-mode.ts`，`modes.ts` 只登記）。`modeState` 是 `TeamTableState`：比賽 id、房間、兩隊隊名（大廳列比賽用）、桌上這一副是第幾副（`seq`）、副數、這一室打完的副（`played`）、兩室的參賽者（`players`，擋另一室用）、機器人的制度、比賽結束（`closed`）。`Table.dealSource` 是 `dealSourceOf(deals)`，兩桌共用同一個 `DealSet`；第 n 副就是牌組的第 n 副，牌號 n（發牌者與身價照牌號）。`DEAL_SET_MAX` 提高到 32；挑戰仍限 16（`CHALLENGE_LIMITS.boardsMax`，「用這副牌挑戰」的 `fromBoards` 也改看它）。
- **開始**：socket `startMatch { matchId }` 或 `POST /api/matches/:id/start`（回 `{ match }`），`GUARDS` 先檢查欄位。只有房主、只在 `setup`（`matchHostOnly`、`matchStarted`），而且 `matchReady`（否則 `matchNotReady`）；比賽裡有人正在打另一場比賽就不能開始（`matchPlayerBusy { name }`）。步驟：發新的 `DealSet` → 每位參賽者離開他所在的桌（挑戰桌照舊只是暫停）→ `Promise.allSettled` 同時 `open` 兩桌（`teamTable`：座位照比賽，機器人用 `robotKind`；設定 `public`＋允許觀看＋比賽的每副時間上限；桌號 0；`hostId` 是比賽的房主，但比賽桌沒有房主能做的事）→ 有一桌失敗就把開好的那桌 `close`，比賽留在 `setup`，房主拿到原來的錯誤代碼或 `serverError` → 寫 `deals`、兩桌 id、`started_at`、`playing`，通知其他參賽者 `matchStarted { matchId, username }`，推送比賽。每桌開桌就發第 1 副（兩室同時）。設計原本寫兩桌 `invite`，實作改成 `public`：入座本來就由模式擋住（`matchTableFixed`），`public` 讓非參賽者能觀看。
- **兩桌各自推進**（`e8-t08`）：每桌打完一副照常倒數、自動發下一副，不等另一桌；最後一副打完停在結果，不再發牌（`dealAt` 是 `null`），牌桌的 `TableView.match.over` 為 true，牌桌上方顯示「這一室打完了，等待另一室」。一室只剩機器人也照打（兩位真人＋六個機器人可能整室都是機器人；`TableService.playsOn`），觀看者都走了也不關桌，直到比賽結束。
- **每室的結果**（`e8-t10`）：一副打完，牌桌回報 `{ kind: 'team', matchId, room, seq, result }`；社團先存紀錄，再用 `roomFinished`（`team-match-flow.ts`）檢查：比賽在進行、`seq` 在範圍內、這一室這一副還沒有結果——同一份回報重送（§5.10 的 `outbox`）或比賽已經不在進行，就什麼都不寫。寫入後兩室都有結果時公開這一副的兩筆紀錄，並把比賽推給參賽者與兩桌上的人（比分只算兩室都完成的副）。
- **結束**（`e8-t11`）：每一副都兩室完成（或已裁定）就 `finished`、寫 `ended_at`，通知每位參賽者 `matchFinished { matchId }`，告訴兩桌 `matchEnded`（不再發牌；從此是一般的桌：人可以離開、沒人了就關，只剩機器人的那一室立刻關），其餘還沒公開的紀錄一起公開。比賽頁與牌桌上方顯示勝隊與總分（同分是平手）。
- **進紀錄**（`e8-t13`）：紀錄 `mode: 'team'`、`eventId`、`room`；E4 的模式篩選多了「隊制賽」（`HISTORY_MODES`），紀錄列表、側欄、收藏、個人檔案、詳細頁顯示成「隊制賽 開室」（`boardPlace`）。
- 每副時間上限（`boardMinutes`）沿用 F1 的每副時間上限（`e2-t27`）；超時只提示，由房主裁定（`e8-t15`，F5，見下）。斷線代打沿用 F1 的 `e2-t31`（比賽的手動代打、替補、暫停是 F5，見下）。比賽中刪除帳號：那個座位改成比賽制度的機器人（`TableService.forget`、`TeamMatchStore.forget`），比賽照打。
- **瀏覽器**：準備室的開始按鈕（人到齊才能按），開始後參賽者直接到自己的牌桌；比賽頁顯示比分、逐副兩室分數（連到紀錄）、參賽者的「回到我的牌桌」、其他人的「觀看開室／閉室」；牌桌頁上方的 `MatchBanner`（房間、第幾副、比分、等待另一室；比分來自 `useTeamMatch`，也就是同一份 `teamMatchView`）。比賽桌不顯示房主設定與入座按鈕。

**例外與結果頁**（F5，`e8-t12`、`e8-t14`～`e8-t17`，2026-10-25 已實作）：比賽中房主的動作都有 socket 訊息（`GUARDS` 先檢查欄位）與 HTTP（`POST /api/matches/:id/rule|pause|abandon|replace|sitin`，同一套檢查、速率限制、依社員排隊，回 `{ match }`）。規則是 `team-match-flow.ts` 的純函式（`ruleBoard`、`pauseMatch`、`abandonMatch`、`replaceSeat`、`sitInFor`），`TeamMatchService` 寫入 SQL 與通知，`ClubService.matchPlay` 再用 `TableApi.matchUpdate` 告訴兩桌（每桌一個物件時走 RPC），最後推送比賽。
- **代打**（`e8-t14`，AC-8.6）：沿用 F1 的斷線代打（3 分鐘），但比賽桌**不要求同桌還有別的真人在線**（整室只剩機器人也照打），代打的機器人用比賽的制度（`robotKind`）。房主也可以手動讓機器人代打某位參賽者（`matchSitIn`，例如人在線但離開座位）。本人回來：重新連線自動換回（同 F1），或從比賽頁「回到我的牌桌」進自己那一室（`joinTable` 自己那一室＝拿回座位）。代打中的座位在比賽頁標「機器人代打中」（`TeamMatchView` 座位的 `substitute`，從牌桌目錄的 `substitutes` 來）。
- **超時裁定**（`e8-t15`，AC-8.6）：每副時間上限沿用 F1（`boardStartedAt`），牌桌目錄另記發牌時間（`TableEntry.match.startedAt`），房主的比賽頁看得到兩室各在第幾副、剩幾分鐘、已超時（`TeamMatchView.rooms`，只給房主）。只有某一室**正在打**、而且**超過時間上限**的那一副才能裁定（暫停中以暫停的那一刻算；否則 `matchNotOverTime`），已裁定的副可以改判；裁定 Avg／Avg+／Avg-、給哪一隊、理由（1–200 字，`parseRulingReason`，否則 `badRuling`）。裁定後那一副算完成：還在打它的那一室收起來（不留紀錄）、直接發下一副，之後也不會再發它（`TeamTableState.ruled`，`TableMatch.ruled`）；已打完那一室的紀錄立刻公開；是最後一副就結束比賽。計分照 `team-scoring.ts` 的裁定規則；結果頁那一副標「裁定」並寫出種類、給哪一隊與理由。
- **暫停／繼續**（`e8-t16`）：房主暫停時兩室都停（`TeamTableState.pausedAt`，`matches.paused_at`）：叫牌出牌回 `matchPaused`、機器人不動、不發牌、不算太久提醒、`boardEndsAt` 不送；繼續時發牌時間與輪到誰的時間都往後移暫停的長度（暫停不算在時間上限裡），該發的下一副重新倒數。牌桌上方顯示「房主暫停了比賽」。
- **中止**：只有房主、要先暫停（`matchPauseFirst`）；`abandoned`、寫 `ended_at`、清掉暫停，兩桌 `matchEnded`（正在打的那一副收起），所有紀錄公開，其他參賽者收到 `matchAbandoned`。結果頁寫「比賽已中止：只計兩室都打完（或已裁定）的副」。
- **替補**（同隊替補）：房主或安排那一隊的隊長（`arrangerOf`），比賽要先暫停；換上來的必須是社員、不在這場比賽、沒在打別場比賽（`matchPlayerBusy`）、和安排的人與房主都沒有封鎖關係（`cannotInvite`）、沒在觀看這場比賽（`matchWatching`）；房主自己的座位不能替補（`matchHostStays`）。座位的隊伍由房間與方位決定，所以替補一定是同一隊。換上的人離開他原本所在的桌（挑戰桌照舊暫停）、收到 `matchSubIn`，被換下的人收到 `matchRemoved`；換下的是 B 隊隊長時隊長交給替補。牌桌那一側（`matchUpdate.replace`）：座位直接換人，從那一副打到哪裡接著打；兩桌的參賽者名單只增不減，所以換下的人仍然不能看另一室，也不能看自己那一室。
- **結果頁**（`e8-t12`，AC-8.7）：比賽頁的「逐副結果」：兩室各自的合約（含莊家）、首攻、結果、南北分數（連到紀錄），兩隊得分、累計比分，以及兩室的並排重播（C7 的 `/history/:open/vs/:closed`）。合約與墩數由 `boards_index` 接（`eventBoards`，`teamMatchView` 的 `details`），首攻是牌桌回報結果時一起送的（`RoomResult.lead`）。牌桌上方的比分條、比賽頁都從同一份 `teamMatchView` 來。房間的進度變了（發新一副、代打開始或結束）也會推送比賽，房主的超時提示才會跟著更新。
- **端對端測試**（`e8-t17`）：`tests/worker/team-match-finish.test.ts`：兩位真人＋六個機器人打 4 副，每副的 IMP 與總分用測試裡另外寫的 IMP 表手算比對；比賽中參賽者進不了另一室、只打完一室的副誰都看不到。同一檔有代打、裁定、暫停、中止、替補、房主刪帳號的測試；`table-objects.test.ts` 在兩個牌桌物件之間（RPC）再跑一次暫停、替補、代打與裁定。

**資訊隔離與可見性**：誰看得到什麼在 §4（「隊制賽」與其下的「牌桌層」），判斷在 `worker/views.ts`（`teamMatchView`、`chatFor`、`recordVisible`）與 `TableService`（另一室、座位）。比分只用兩室都完成的副，所以快的一桌看不到慢的一桌在同一副的結果。E11 的資訊隔離回歸測試（`e11-t13`）從 `tests/worker/team-match-play.test.ts` 擴充。

**未決問題的決定**（PRD 的兩題，社長 2026-10-25 確認）：
- 機器人補位**不強制**兩室在對應座位（湊人已經很難）；但整場的機器人用同一種制度（`robotKind`）。準備室在兩室機器人不對稱時顯示提醒（`e8-t06`）。
- 觀看者（不是參賽者的社員）**可以看兩桌**的牌（同 BBO Vugraph）；參賽者（含被邀請還沒回覆、替補）在比賽中不能看另一室，自己隊的另一室也不行。

**儲存**：三張 SQL 表就是隊制賽的正本（同挑戰，不是索引）。

| 表 | 欄位 | 索引 |
| --- | --- | --- |
| `matches` | `match_id`（主鍵）、`host_id`、`created_at`、`status`、`started_at`、`ended_at`、`settings`（JSON）、`captain_a`、`captain_b`、`deals`（`encodeDealSet`，開始前是 null）、`open_table`、`closed_table`、`paused_at`（F5） | `(status, created_at)` |
| `match_seats` | `match_id`、`room`、`seat`（主鍵三欄）、`status`（`empty`／`invited`／`seated`）、`user_id`（空位與機器人為 null）、`robot`（0／1）、`invited_at`、`answered_at` | `(user_id, match_id)` |
| `match_boards` | `match_id`、`seq`（主鍵兩欄）、`open_board_id`、`open_score_ns`、`open_at`、`closed_board_id`、`closed_score_ns`、`closed_at`、`open_lead`、`closed_lead`（F5）、`ruling`、`ruling_team`、`ruling_reason`、`ruled_by`、`ruled_at` | — |
| `match_chat`（J5a） | `match_id`、`id`、`at`、`user_id`、`text`（主鍵 `match_id, at, id`）：觀賽頁的觀看者聊天，每場留最近 100 句（`MATCH_CHAT_KEEP`） | — |
| `match_watchers`（J5a） | `match_id`、`user_id`（主鍵兩欄）：比賽中開過觀賽頁的社員，不能替補上場 | — |

`matches` 另有 V1 加的 `segment`、`break_at`（分段，`e8-t21`，`ADDED_COLUMNS`）。

- 每副一列（不是每室一列）：一副的兩室結果與裁定放在一起，結果頁的逐副比較只讀一列；第一室打完或第一次裁定時才建立。
- 建立時一次寫好 8 列座位，之後只改不增減，所以「8 個座位都在」不必另外檢查。
- 和挑戰一樣不放記憶體快取，每次讀 SQL；表是新的，載入時 `CREATE TABLE IF NOT EXISTS`，沒有舊資料要搬，`meta:schema` 不變。之後加欄位用 `PRAGMA table_info` 檢查、`ALTER TABLE ADD COLUMN`，同挑戰的 `reminded_at`：F5 的 `paused_at`、`open_lead`、`closed_lead` 就是這樣加的（`TeamMatchStore.createTables` 的 `ADDED_COLUMNS`）。
- 首攻存在 `match_boards`（一張牌兩個字元）而不是只讀 `board:`：結果頁一次要全部副的首攻，`boards_index` 沒有首攻、逐筆讀紀錄太慢；合約與莊家墩數仍從 `boards_index` 接（`eventBoards`）。F5 之前打完的副沒有首攻，顯示「—」。
- 大小：一場 8 列座位＋最多 32 列結果，牌組 32 副約 2.4 KB，沒有負擔。

**刪除帳號**（`TeamMatchStore.forget`）：他主辦、還在準備的比賽 `cancelled`；別人的準備中比賽，他的座位清成空位（是 B 隊隊長就拿掉隊長）；比賽中的座位改成機器人代打，他打過的副照算；已結束的比賽保留他（名字顯示為已刪除的社員）。比賽中刪掉的是房主時，房主交給 A 隊第一位入座的真人，沒有就是 B 隊隊長，再沒有就是任何一位入座的真人（`setHost`，F5）；一個都沒有時機器人照打完，沒有房主。

**M2／E11**：拆分後每場比賽是一個 `Event` Durable Object（同挑戰），三張表原樣搬進去；VP（`e8-t22`）供 E9 的多隊賽用；分段（`e8-t21`）見下，`match_boards` 不變。

**各批做什麼**：

| 批 | 做什麼 |
| --- | --- |
| F2（本批） | 這份設計、`shared/team-scoring.ts`、`shared/team-match.ts`、三張表與 `TeamMatchStore`、建立／改設定／取消／讀取的 HTTP 與 `teamMatchView` |
| F3（已完成） | 座位邀請（接受、拒絕、換座位、離開、通知）、隊長制、準備室頁、補機器人、WebSocket 推送 |
| F4（已完成） | 開始（`team` 牌桌、共用 `DealSet`）、兩桌推進、牌桌層的資訊隔離、即時比分、結束與通知、比賽牌局進紀錄（`mode=team`、`event_id`、E4 篩選「隊制賽」） |
| F5（已完成） | 結果頁、斷線代打、超時裁定、暫停／繼續／同隊替補、中止、端對端測試；E11 的資訊隔離回歸測試（`e11-t13`） |
| J5a（已完成） | 觀賽頁（Vugraph）、觀看延遲、賽後整場重播、VP（`e8-t18`～`e8-t20`、`e8-t22`，見下） |
| V1（原 J5b，已完成） | 分段與中場換位、替補，比分延續（`e8-t21`，見下） |

**分段與中場換位**（V1，`e8-t21`，AC-8.9）：
- **設定**：`segmentBoards`＝每段幾副，0 是不分段（預設；之前存的比賽讀成 0，照舊一口氣打完）。至少 2 副、要少於整場副數（否則 `badMatchSettings { field: 'segmentBoards' }`）；最後一段可以比較短（10 副每段 4 副＝4、4、2）。改副數時沒一起改分段、原本的分段又不再少於副數，就改回不分段。`segmentCount`、`segmentOf`、`segmentRange`（`shared/team-match.ts`）。
- **牌桌**：開桌時 `TeamTableState.segmentBoards` 與 `upTo`（這一段最後一副）；`nextTeamSeq` 不超過 `upTo`，所以一室打完這一段就停在最後一副的結果（`TableMatch.over`），像打完整場一樣等另一室。`TableMatch.segment { n, of }` 給牌桌上方的比分條顯示「第 n / m 段」，這一段打完時寫「等房主開始下一段」。
- **段與段之間**：每副結算時（或裁定讓這一段都完成時）若這一段兩室都完成而且還有下一段，寫 `break_at`（`roomFinished`／`finishedWithRuling` 的 `segmentDone`）。這時：
  - 隊長（`arrangerOf`）可以換自己隊的座位（`matchMove`，平常只在準備中）：座位的隊伍由房間與方位決定，所以「A 隊開室南北那一對換到閉室東西」就是交換兩個座位；換座位只寫比賽的座位，**牌桌在下一段開始時才換人**。
  - 房主或隊長可以替補（`matchReplace`），不必先暫停；替補照舊立刻換到牌桌上。
  - 房主可以中止（不必先暫停）；暫停照常可用。
  - 開始下一段：socket `matchNextSegment { matchId }` 或 `POST /api/matches/:id/next`，只有房主（`matchHostOnly`）、只在段與段之間（`matchNotBreak`）。寫 `segment`、清 `break_at`，社團把兩室各自的四個座位（社員或比賽制度的機器人）交給牌桌（`matchUpdate.segment { last, seats, players }`）。牌桌（`TableService.startSegment`）先把當莊換過去的座位換回來，照新的座位入座、不在這一室的人離桌（瀏覽器的 `MatchBanner` 看到自己的座位在另一室就自動轉過去）；機器人代打中、座位沒變的人照舊代打。`upTo` 改成新一段的最後一副，倒數後發下一副（暫停中就等繼續）。
- **另一室的限制**：下一段開始時兩室都打完了之前發的每一副，所以 `TeamTableState.players` 換成新的座位（換到另一室的人只能進新的那一室）；被替補下場、已經不在比賽裡的人兩室都還是進不去（同 F5）。
- **比分延續**：比分本來就是整場每一副加總，分段不影響；比賽頁的逐副結果在每一段最後一副後面加「第 n 段小計」。VP 用整場的副數與總 IMP。整場重播、觀賽頁照舊（觀賽頁多顯示第幾段與段與段之間）。
- **座位公開**：段與段之間誰換到哪裡和準備室一樣，看得到比賽的人都看得到（沒有「雙方各自交排陣、同時公開」）。

**觀賽、延遲、整場重播與 VP**（J5a，`e8-t18`～`e8-t20`、`e8-t22`，2026-10-30 已實作）：誰看得到什麼在 §4（「牌桌層」下的觀賽頁、觀看者聊天、觀看延遲）。
- **觀賽頁**（`/matches/:id/vugraph`，`VugraphPage`）：兩室並排（`RecordDiagram` 畫四家，`vugraphRecord` 把每一手「現在手上的＋打過的」拼回原來的 13 張，只用伺服器送來的牌）、叫牌、合約與兩方墩數、比分條（含 VP）、觀看者聊天。**每 3 秒問一次**（`VUGRAPH_POLL_MS`，分頁在背景時不問，比賽不在進行就停）：觀看者不在牌桌上，牌桌的推送到不了他；每次請求由社團向兩桌各發一次 RPC（`TableApi.vugraph`），不改任何狀態。之後觀看者多了再改成推送（每桌一份觀賽畫面，所有觀看者共用）。比賽頁給非參賽者「觀賽（Vugraph）」按鈕，原本的「觀看開室／閉室」（坐到牌桌上當觀看者）保留。
- **觀看延遲**：設定 `delay`（準備室的勾選）；牌桌開桌時寫進 `TeamTableState.delay`，所以延遲由牌桌自己做（`laggedBoard`），觀賽頁與牌桌上的觀看者一樣。
- **整場重播**（`/matches/:id/replay?board=<seq>`，`MatchReplayPage`）：比賽裡**兩室都打完**的每一副（只裁定、少一室的副不列），用 C7 的並排重播（`ComparePage` 的 `SideBySide`：兩室一組播放鈕、逐墩同步），上一副／下一副或下拉選單切換；每筆紀錄照樣從 `/api/history/:id` 讀，能不能看由伺服器決定（§4 `recordVisible`）。比賽頁有兩室都打完的副時就有「整場重播」按鈕（比賽中也有：那些副已經公開）。不另做事件時間軸。
- **VP**（`shared/vp.ts`）：WBF 2013 連續 VP 表（20 分制）：B＝15 ×√副數，贏 M IMP（M < B）得 10 + 10 × (1 − τ^(3M/B)) / (1 − τ³)，τ＝(√5 − 1)/2，四捨五入到小數兩位，輸方是 20 減贏方，M ≥ B 是 20 : 0。副數用比賽設定的副數（中止的比賽也一樣）。只有 IMP 計分才換算；比分條（比賽頁、觀賽頁、整場重播、牌桌上方）在 IMP 後面顯示「VP a : b」。E9 的多隊賽（`e9-t14`）用 `matchVictoryPoints`。

## 5.5 挑戰（決策紀錄，`e7-t01`，2026-10-24）

挑戰（E7）：發起者邀請 1–20 位社員（不限好友，社長 2026-10-27），每個人各自坐南、和三個用同一種制度的 TKB 打同一組牌，打完比名次。這一節是 C2 定下的設計，後面的批次（C3–C9）照這裡做；要改設計先改這裡。

**資料模型**（`worker/challenges.ts` 的 `Challenge`，型別與狀態在 `shared/challenge.ts`）：

```
challenge（challenges 一列）
  ├─ settings  計分、機器人的制度（TKB 用淡江制度或 2/1）、Best Hand、Just Declare、截止天數、排名公開範圍（JSON）
  ├─ deals     DealSet：N 副的牌號與四手牌（shared/deal-set.ts，一副一行 PBN）
  ├─ players   challenge_players：invited → accepted｜declined；開打、完成時間、已知牌、搭檔（e7-t28）
  └─ results   challenge_results：人 × 副：牌局 id、南北分數、時間
```

結果只存計分要用的南北分數和牌局 id；合約、莊家、墩數由 `board_id` 接 `boards_index`（§5.3），首攻與重播讀 `board:<id>`，不複製第二份。

**狀態**（`ChallengeStatus`）：

| 從 | 到 | 什麼時候 |
| --- | --- | --- |
| — | `pending` | 建立；發起者自動是 `accepted`，**建立後就能先打** |
| `pending` | `active` | 發起者以外有人接受；之後到截止時間前，其他人仍可接受，接受後就能打 |
| `pending`／`active` | `cancelled` | 發起者取消，而且除了他以外還沒人開打（別人都沒有 `started_at`）；或帳號刪除後剩不到 2 位沒拒絕的人 |
| `pending` | `expired` | 截止時間到時，除了發起者沒人接受；或受邀者全都拒絕了（不必等到截止，C3） |
| `active` | `finished` | 截止時間到；或每個受邀者都回覆了、每位接受者都打完；名次就此固定 |

截止時間到時沒回覆的人算 `declined`。發起者在 `pending` 與 `active` 都能打，其他人接受後才能打；`finished`、`cancelled`、`expired` 之後不再改動（`isOpenChallenge`）。這些規則是 2026-10-24 社長的決定（E7 PRD 的未決問題）。

**期限**：只有一個截止時間 `deadline` ＝ 建立時間＋`days`（1–7 天，`challengeDeadline`），所有人共用，回覆與打完都要在這之前。SQL 的欄名沿用 C2 建表時的 `accept_by`（表已在正式環境建立，不改名）；`challenge_players.finish_by` 不再使用，欄位留著是空的。期限走統一排程器（§5）：每個進行中的挑戰一個 `challenge:<id>` 工作，排在它最近的一個時間點（`e7-t07` 的 12 小時前提醒，或截止時間），到時重新判斷狀態再排下一個；工作不存，`load()` 用 `ChallengeStore.openIds()` 重排（`e7-t13`，`JobKind` 的 `challenge`）。

**期限工作與結算**（C5，`e7-t13`，2026-10-24）：
- 下一個時間點由 `nextChallengeTime` 決定：提醒還沒送就是截止前 12 小時（`REMINDER_MS`），送了就是截止時間。工作執行時（`ClubService.challengeDue`）用現在的時間重新判斷，所以早跑只是把自己排回去；物件睡著時錯過的時間點在 `load()` 後立刻補跑。
- **提醒**：截止前 12 小時送 `challengeReminder` 給已接受、還沒打完的人（沒回覆的不送）；送出前先寫 `challenges.reminded_at`，所以只送一次，物件被回收也不會重送。物件睡到截止時間以後才醒，就不補送提醒，直接結算。
- **截止**：`deadlineOutcome`（沒回覆的改 `declined`；除了發起者沒人接受就 `expired`，否則 `finished`），寫 `ended_at`。
- **提前完成**（`earlyFinish`）：`active` 的挑戰，每個受邀者都回覆了、每位接受者都打完了，就立刻 `finished`。在回覆、取消、打完一副、刪除帳號之後檢查（`challengeChanged`）。
- **結束時**（完成、過期、取消都一樣，`challengeEnded`）：收掉這個挑戰所有的牌桌（停著的、打到一半的都收，打到一半的那一副作廢）；唯一的例外是打完最後一副還坐在桌上的人，桌子留到他離開，讓他看完最後一副的結果。牌局紀錄的 `revealAt` 提前到結束的那一刻：`boards_index.reveal_at` 依 `event_id` 一次改（`revealEvent`，`event_id` 有索引），KV 的 `board:`、`hist:`、`uhist:` 跟著重寫。
- **通知**：`finished` 時送 `challengeResults` 給每位接受的人（含沒打完的）；`expired` 不送通知（發起者在挑戰列表看得到狀態）。

**建立與回覆**（C3，`worker/challenge-flow.ts` 的純函式，`ClubService` 檢查身分、在一個 transaction 裡寫回 `ChallengeStore`、送通知）：
- `createChallenge { invitees, boards?, settings? }`：`invitees` 是 1–20 個不重複的社員 id（`challengeInvitees`、`badChallengeSettings`），任何社員都可以，**不用是好友**（社長 2026-10-27，原本要是發起者關注的好友、回 `notFriend`；那個代碼留著不用）；發起者封鎖了對方要先解除（`unblockToInvite`），不能是自己（`notSelf`）、不存在的帳號或機器人（`userGone`）；對方封鎖了發起者時回 `cannotInvite`，不說是被封鎖。`boards` 1–16，預設 8（`challengeBoards`；BBO 是 4–16，社長 2026-10-25 開放 1 副）。`settings` 由 `parseChallengeSettings`（`shared/challenge.ts`）檢查：每欄可省略、套 `defaultChallengeSettings`，不能有其他欄位；計分單挑只能 `imp`／`total`，多人 `mp`／`crossImp`／`total`；`unfinished` 只能是 `worst`；機器人的制度 `tku`／`gib`（機器人沒有等級，`robotLevel` 跟其他不認得的欄位一樣被拒絕）；`days` 1–7 的整數；錯了回 `badChallengeSettings { field }`。牌組用 `makeDealSet({ kind: 'random', count })`、社團的亂數。
- `answerChallenge { challengeId, accept }`：只有受邀、還沒回覆的人（發起者已經是 `accepted`，所以回 `alreadyAnswered`）；挑戰要是 `pending`／`active` 而且還沒到截止時間（`challengeClosed`）。不是參與者的一律 `challengeGone`，不透露挑戰存在。
- `cancelChallenge { challengeId }`：只有發起者（`challengeCreatorOnly`），只在 `pending`／`active`，而且除了他以外沒人有 `started_at`（`challengeStarted`；發起者自己先打了不影響）。
- 截止時間的處理寫成 `deadlineOutcome`（沒回覆的改 `declined`，除了發起者沒人接受就 `expired`，否則 `finished`），C5 的期限工作呼叫它並結算（見上面的「期限工作與結算」）。

**對象與牌組**（2026-10-24 社長決定，2026-10-27 改）：可以邀請任何社員，不用是好友（原本只能邀請好友；2026-11-03 重新開放好友時維持任何社員都能邀，見 §5「好友與封鎖」），雙方任一方封鎖另一方都不行，選人是可以搜尋的輸入框（`e7-t17`）；全社的每週挑戰（`e7-t23`）由管理員建立，不受這條限制。牌組**只用隨機牌**（`makeDealSet({ kind: 'random' })`，不用條件預設集），選項只有 Best Hand 與 Just Declare。唯一的例外是「用這副牌挑戰」（`e7-t22`）：發起者拿自己打過、可以先收藏的牌（`kind: 'given'`）挑戰別人，他不再打，建立時就把他當時的結果寫進 `challenge_results`（`known_deals = 1`），照樣計分、排名。他當時不一定坐南，所以牌組轉成讓他的座位變成南，結果也換成南北的角度。只限他和三個機器人打的牌，挑戰的機器人種類與等級鎖成當時的（紀錄裡的 `robotKind`、`robotLevel`），否則他的成績和別人的比不起來。

**挑戰牌桌**（`e7-t08`）：牌桌模式 `challenge`（`worker/modes.ts`），`modeState`（`ChallengeTableState`）記挑戰 id、參與者、桌上這一副是牌組的第幾副（`seq`），以及離開時坐的位子（`parkedSeat`）；`Table.dealSource` 是 `dealSourceOf(deals)`（`fixed`，整組牌只在伺服器的 `Table` 裡，§4）。一人一桌：真人坐南，北東西是設定裡同種類、同等級的機器人；不能觀看、不能撤回、不能換座位、大廳不列出。真人離開不關桌（「中途斷線視同暫停」，`e7-t12`），回來從下一副繼續。`boardFinished` 寫 `challenge_results`（同一副第二次寫入會被主鍵擋下，「每副只打一次」由資料庫保證）；`record` 加上 `mode=challenge`、`eventId`＝挑戰 id、`revealAt`。牌號、發牌者與身價照 `DealSetBoard.boardNo`（隨機牌組就是 1…N，照 16 副循環；「用這副牌挑戰」是轉過之後同樣發牌者與身價的那一號，見下面的 C8），C4 讓挑戰模式的發牌用它，不用 `boardsPlayed + 1`。

C4 的實作（2026-10-24）：
- **開打與續打**：`playChallenge { challengeId }`。只有 `accepted` 的參與者、挑戰還是 `pending`／`active` 而且沒過截止時間（`challengeTakesPart`）：不是參與者 `challengeGone`、受邀還沒接受或拒絕了 `challengeNotAccepted`、截止或結束了 `challengeClosed`（順便把他停著的桌子收掉）、全部打完或「已知牌」的發起者 `challengeDone`。第一次開一張新桌（`number` 是 0，不佔大廳的桌號），先離開他原本在的桌。發牌時找他還沒有結果的第一副（`nextSeq`），第一副發牌時寫 `started_at`。
- **離開＝暫停**（`e7-t12`）：`leaveTable`、開新桌、坐到別桌都會呼叫 `leave`；挑戰牌桌不關，只把他從座位拿下來、記住位子（他可能因為當莊換到北），桌子留在 `table:` 裡（物件回收後照樣載入）。座位空了就不發牌、機器人也不動。再送 `playChallenge` 就坐回原位：**打到一半的那一副原封不動接著打**（叫牌、出牌都在，不重發，也不能換一副重來，否則可以先看牌再重打），已經打完的那一副就倒數發下一副。斷線（沒送 `leaveTable`）時座位照舊保留，跟一般牌桌一樣，重連就回到桌上。牌桌頁卸載時照樣送 `leaveTable`，伺服器把它當暫停。打完最後一副後離開，或挑戰已經結束，桌子才關掉。
- **固定的桌子**：撤回 `challengeNoUndo`（`BoardView.canUndo` 一律是 false）；`stand`、換座位、`kick`、`addRobot`、`removeRobot`、`updateTableSettings` 是 `challengeTableFixed`；攤牌照舊由機器人判斷。桌子設定是隱藏（`hidden`）、不允許觀看。
- **結果**：`boardFinished` 在一個 transaction 裡寫 `challenge_results`（南北分數就是他的分數，換到北當莊也一樣）；最後一副寫 `finished_at`。**截止時間一到就停止**（同 BBO）：之後送來的叫牌、出牌一律回 `challengeClosed`，機器人也不再動（`challengeClosedAt`），打到一半的那一副作廢、不寫結果，還沒打的副也不再發。挑戰變 `finished`、結算與通知見上面的「期限工作與結算」（C5）。
- **確定性**（`e7-t09`）：TKB 沒有亂數、不刻意失誤，所以兩個人做一樣的叫牌與出牌，機器人的反應完全一樣，不需要種子（`tests/worker/challenge-table.test.ts`）。
- **紀錄**：`BoardRecord.mode = 'challenge'`、`eventId`、`revealAt` ＝截止時間；`boards_index.mode` 照 `record.mode` 寫。紀錄、側欄與牌局頁把挑戰的牌顯示成「挑戰」而不是桌號。
- **畫面**（`e7-t15`）：`TableView.challenge`（`TableChallenge`：第幾副、共幾副、打完幾副、截止時間）；牌桌頁首顯示「挑戰 · 第 3／8 副」與截止時間（`ChallengeBanner`），沒有房主設定、座位選單，撤回鍵停用並說明原因，打完全部顯示提示與回大廳的連結。大廳的「我的挑戰」列出現在能打的挑戰（開始打／繼續打），挑戰頁是 C6。

**挑戰頁**（C6，`e7-t16`～`e7-t18`，2026-10-25）：
- `/challenges`（`ChallengesPage`）：等待接受（受邀還沒回覆，或除了發起者還沒人接受）、進行中、已完成（結束了，或自己拒絕了）三個分頁（`src/lib/challenges.ts` 的 `challengeTab`）；每個挑戰是一張卡片，列出參與者的狀態與進度條、自己的進度、截止倒數，整張卡片連到挑戰頁；排序與分頁在瀏覽器做（`useListParams`，記在網址）。新通知進來就重新讀列表。
- 發起挑戰對話框（`ChallengeDialog`）：選人列出自己以外的全部社員（不含機器人與自己封鎖的人，`LobbyView.members`），點輸入框列出全部，打字 150 ms 防抖後篩選，可多選；副數、計分（依人數 `scoringsFor`）、機器人的制度、截止天數、排名公開範圍，Best Hand、Just Declare 兩個勾選（C8），下方預覽。
- `/challenges/:id`（`ChallengePage`）：接受／拒絕、開始打／繼續打、取消（發起者，別人都還沒開打）都在這裡（社長 2026-10-27 起列表的卡片只負責打開這一頁）。伺服器照 §4 給什麼就顯示什麼：名次、總成績，自己那一列高亮，沒打完的列在下面標「未完成」與打了幾副；接著是 BBO 式的每一副結果（見下面的「結果頁」）；還沒打完全部的人只看到每個人的進度。
- 建立、回覆、取消也走 HTTP（`POST /api/challenges`、`/api/challenges/:id/answer`、`/cancel`），讓頁面立刻拿到結果；伺服器是同一套檢查（`ClubService.challengeRequest` 呼叫 socket 訊息的同一個處理），錯誤一樣是 `ClubError` 的代碼。開始打仍用 socket 的 `playChallenge`（要跟著伺服器進牌桌）。通知點下去：邀請到 `/challenges`，其他到那個挑戰的頁面。

**牌組的選項、再戰與「用這副牌挑戰」**（C8，`e7-t10`、`e7-t11`、`e7-t21`、`e7-t22`，2026-10-25）：全部在**建立時**決定、存進 `deals`，所以每位參與者拿到的完全一樣（純函式在 `shared/challenge-deals.ts`）。
- **Best Hand**（`bestHand`）：每副發好後轉一下，讓南拿四家點力（HCP）最高的一手；同點力時依 南、北、西、東 的順序取第一個（`BEST_HAND_ORDER`，南已經是最高就不轉）。轉牌是整副一起轉（`rotateHands`），發牌者與身價照牌號不變。
- **Just Declare**（`justDeclare`）：四個 TKB（設定裡的制度）先叫牌（`robotAuction`），南北當莊才留下，否則重發（每副最多 60 次，`JUST_DECLARE_TRIES`；做不到回 `serverError`，實際上不會發生）；可以和 Best Hand 一起用。叫牌存在牌組裡（`DealSetBoard.auction`，`encodeDealSet` 在那一行後面加 ` | 1C P 1H …`，載入時檢查要合法、要有合約），不靠「機器人每次都叫一樣」，部署新版機器人也不會讓莊家換邊。發牌時（`modes.ts` 的 `deal`）照存下的叫品重演一次（每個叫品都標機器人；機器人現在還是叫這個時帶上它的說明），桌子直接進入打牌；北當莊時照常由 `swapForDeclarer` 讓真人坐到北主打。首攻由莊家左手的機器人出，參與者從首攻之後開始。
- **每副都坐南**：發下一副前，替機器人當莊而換過座位的真人先換回自己的位子（`unswap`，#74），所以挑戰的參與者每副都從南開始；Just Declare 的叫牌重演完才照新合約換座位。
- **一鍵再戰**（`rematchChallenge { challengeId }`，HTTP `POST /api/challenges/:id/rematch`）：挑戰結束後（`finished`／`expired`／`cancelled`；還開著回 `challengeNotOver`），接受過的參與者（不是參與者 `challengeGone`、沒接受 `challengeNotAccepted`）邀請其他沒拒絕、帳號還在的人（沒人 `rematchNobody`），同樣的設定與副數、新牌組；走 `createChallenge` 的同一套檢查，所以他要關注每一位（`notFriend`），發起者是按再戰的人。人數變了、原本的計分不適用時用預設。副數照原本的（最少 1 副，2026-10-25 起；之前「已知牌」的挑戰副數不到 4 時再戰用 4 副）。
- **用這副牌挑戰**（`createChallenge` 加 `fromBoards: string[]`，1–16 副不重複的紀錄 id；不能同時給 `boards`）：每副都要是他打的（不是就 `boardGone`，不透露存在）、已經公開（`revealAt` 沒過的挑戰牌局也是 `boardGone`）、另外三家都是機器人（`challengeRobotsOnly`）、而且是同一種制度（`challengeRobotKinds`）；淡江制度的要有 `tkuSystem`（`tkuSystemOnly`，§5.1.2）。設定的機器人制度鎖成那一種（送了別的回 `badChallengeSettings { field: 'robotKind' }`），Best Hand、Just Declare 不能開（`badChallengeSettings`）。他叫牌的座位（替機器人當莊而換過座位的，看叫品裡沒標機器人的那一家）轉成南（`boardAsSouth`）：發牌者與身價跟著轉，牌號換成 16 副循環裡同樣發牌者與身價的那一號（坐南就是原牌號；`boardNoFor`），他的分數換成他那一方的角度（坐東西就變號）。建立時就寫進他的 `challenge_results`（`board_id` 是原本的紀錄、`played_at` 是當時打完的時間）、`known_deals = 1`、`started_at`／`finished_at` 是建立時間（`newChallenge` 的 `known`）。紀錄頁的「用這副牌挑戰」只在他和三個同制度的機器人打、已公開的牌出現（`challengeRobotsOf`），對話框不給選副數、Best Hand、Just Declare，機器人鎖住；排名上他的名字後面標「已知牌」。
  - 已知的限制：traveller 裡他那一列的合約與莊家照原本紀錄的方位（沒有轉），分數是轉過的。

**每週社團挑戰、分享卡與端對端測試**（C9，`e7-t23`～`e7-t25`，2026-10-25）：
- **排程**（`shared/weekly-challenge.ts`、`worker/weekly-challenge.ts`）：管理員在挑戰頁（`/challenges` 的「每週社團挑戰」，只有管理員看得到）設定開關、星期幾、幾點、副數、計分（`mp`／`crossImp`／`total`，全社人多，不給 `imp`）、機器人的制度、截止天數。API 是 `GET`／`POST /api/admin/weekly-challenge`（`ClubService.weeklyChallenge`、`adminSetWeeklyChallenge`，設定錯了回 `badChallengeSettings { field }`）。存在 KV 的 `meta:weekly`（`WeeklyState`：排程、存的人、存的時間、上一場的排定時間與 id）。
- **時間一律是台灣時間**（UTC+8，台灣沒有日光節約），不跟著伺服器或管理員的瀏覽器走（`latestWeeklySlot`、`weeklySlotAfter`）。
- **工作**：統一排程器的 `weekly:<存的時間>` 工作（`JobKind` 的 `weekly`），排在「存檔之後、上一場之後」的第一個排定時間（`nextWeeklyRun`），所以存檔不會立刻開一場。改了排程就是新的 key，舊的工作醒來發現存的時間不同就什麼都不做。到時先把 `lastRunAt` 寫成這次的排定時間（失敗也不會開兩場）再建立挑戰；物件睡過好幾週，醒來只補開一場，下一場照排程。工作不存，`load()` 從 `meta:weekly` 重排。
- **建立**（`createWeeklyChallenge`）：`settings.weekly = true`（只有伺服器設；社員送這個欄位跟其他不認得的欄位一樣被拒絕）、`ranking = club`、不開 Best Hand／Just Declare、隨機牌。邀請**全社每一位社員**，不限好友、不看封鎖（是社團邀請，不是某個社員），也不受 20 人上限。發起者是存排程的那位管理員（照一般挑戰的規則自動接受、可以打）；他已經不是管理員或帳號刪了，就用最早的管理員。全社只有他一人時不開。每個人（含發起者）收到 `challengeWeekly` 通知，點了到挑戰大廳接受。接受、拒絕**不通知**發起者（不然管理員每週收幾十則）。之後的回覆、截止、結算、可見性都和一般挑戰一樣。
- **不能再戰**（`weeklyNoRematch`）：下週自動有新的一場。頁面標題顯示「每週社團挑戰」（`challengeTitle`），不顯示「某某發起」。
- **建議預設**（PRD 沒定，待社長確認）：
  - 預設關閉；開啟後預設 **星期一 20:00（台灣時間）、8 副、MP、TKB 2/1（淡江制度只給有權限的社員，全社的挑戰預設用 2/1，社長 2026-10-26）、7 天**（截止時間剛好是下一場開始的時間）。
  - 發起者＝存排程的管理員，自動接受；他不打就列在「未完成」（和一般挑戰的發起者一樣）。
  - 邀請全社、不看封鎖、不限人數；後來才加入的社員不會被補邀（等下一場）。
  - 全社只有兩人時 MP 改用 IMP（`scoringsFor` 的規則）。
- **分享卡**（`e7-t24`，`src/lib/shareCard.ts`、`ShareCardDialog`）：排名頁上**有名次的人**看得到「成績分享卡」，在瀏覽器用 canvas 畫一張 1200 × 630 的 PNG（連結預覽的尺寸）：網站名、挑戰名稱、名次（共幾人排名）、總成績、最精彩的一副（合約與結果、那一副的分數），顏色取自頁首的 token。可以下載；手機瀏覽器支援分享檔案時（`navigator.canShare`）多一個「分享」叫出系統的分享面板。只用伺服器已經給他的 `ChallengeView`，所以不會露出他還不能看的東西。**建議預設**：「最精彩的一副」＝他在挑戰計分裡分數最高的那一副，同分取前面的；結束前（他已打完、看得到即時排名）也能產生，卡下註明「目前排名」。
- **端對端測試**（`e7-t25`，`tests/worker/challenge-e2e.test.ts`）：三位真人經由真的挑戰牌桌與 TKB 打 4 副 MP 挑戰，其中兩人分兩次打完、一人打兩副就離開；截止時間到時結算，名次、總成績、每副分數與用他們實際的南北分數手算的 MP 一致，沒打完的人列在「未完成」（打了 2 副），三人都收到結果通知，停著的桌子收掉。

**Traveller 與並排重播**（C7，`e4-t32`、`e4-t33`、`e7-t19`，2026-10-25）：
- 型別在 `shared/traveller.ts`（`Traveller`、`TravellerEntry`：社員、合約、莊家、首攻、結果、南北分數、這一副在挑戰計分裡的分數），之後隊制賽、雙人賽用同一個型別（`kind`）。
- `GET /api/history/:id/traveller`：用這一副的任何一份紀錄都能問；可見性見 §4。
- 紀錄頁（`BoardPage`）在挑戰的牌下面顯示 traveller（`TravellerTable`），每一列可以「和他並排看」：和自己打的那一副比，自己沒打就和頁面上那一副比。
- 結果頁的每一副連到那一副的頁面（`/challenges/:id/boards/:seq`），上面是 traveller，同樣可以並排看（見下面的「結果頁」）。
- 並排重播 `/history/:id/vs/:other`（`ComparePage`）：一組控制鍵同時逐墩播放兩邊，步數以較長的那一副為準（先攤牌的那一邊停在攤牌時）。

**結果頁**（社長 2026-10-25，照 BBO 的挑戰結果）：社員打完挑戰最想看的是每一副，不是矩陣。
- `ChallengePage` 在名次下面放 `ChallengeResults`：
  - **你對每位的成績**：我對每一位、只算兩人都打過的副，加上「對全部」。單位照挑戰的計分（`shared/challenge-scoring.ts` 的 `pairResult`／`headToHead`／`headToHeadTotal`，純函式、手算範例測試）：`imp`、`crossImp` 是兩人分數差換成的 IMP（正數是我贏）；`mp` 是兩人比較的 100／50／0%，合計取平均（「對全部」是所有比較的平均）；`total` 是分數差，合計相加。Cross-IMP 挑戰裡兩人比較用的是一般 IMP，所以標題寫 IMP。
  - **每一副的結果**：每一副一張卡（牌號、發牌、身價，連到那一副的頁面），每個人一列：合約與莊家方位、首攻、結果、南北分數、這一副的成績（挑戰計分，手機上收起來）、**你對他**（我在這一副對他的勝負，贏綠輸紅）。我在第一列，其他人照名次、再照邀請順序；點名字到那一副的頁面、打開他的分頁。
  - 全部只用伺服器給的 `ChallengeView`（traveller 與排名），瀏覽器只做算術，不判斷誰看得到什麼：還沒打完的人沒有 traveller，什麼都不顯示；沒打過某一副的人（沒打完、或拒絕了的參與者在結束後）在那一副沒有「你對他」。
- `/challenges/:id/boards/:seq`（`ChallengeBoardPage`）：那一副的 traveller（`TravellerTable`，莊家名字、每副成績、「和他並排看」到 `ComparePage`，和自己的那一副比），上一副／下一副，以及**每個人一個分頁**：分頁顯示我對他的勝負，內容是 `BoardRecordView`（不帶標題）：牌、重播、叫牌、雙夢家、出牌紀錄。網址的 `?p=社員 id` 記住選的人，預設是自己。伺服器沒給這一副的 traveller 時只說「現在還看不到」，不讀任何紀錄；每份紀錄照樣走 `/api/history/:id`（`recordVisible`、`challengeBoardVisible`）。
- **1 副的挑戰**：計分不用改，只是每個人只有一副：MP 兩人打完是 100%／0%，同分各 50% 並列第一；只有一人打完照舊用 `total`、只顯示總分；Cross-IMP 兩人時就是 IMP。再戰維持 1 副。測試在 `tests/engine/challenge-scoring.test.ts`（「a challenge of one board」）與 `tests/worker/challenge-options.test.ts`（「one-board challenges」：三人 MP、兩人打完、一人未完成）。

**M2：IMP 對 datum、每副討論串、挑戰戰績**（J4，`e7-t27`、`e7-t29`、`e7-t30`，2026-11-02）：
- **IMP 對 datum**（`e7-t30`，計分 `datumImp`，`shared/challenge-scoring.ts` 的 `datumOf`）：多人挑戰與每週社團挑戰多一個計分選項（`scoringsFor`、`WEEKLY_SCORINGS`；單挑沒有，兩人時 datum 就是兩人的平均，沒有意義）。每一副的 datum ＝ 那一副比較的所有分數（**含自己**）的平均，**三個以上時去掉一個最高與一個最低**，四捨五入到 10 分；每個人以「自己的分數 − datum」查 IMP 表，各副加總。只有一人打的那一副 datum 就是他自己的分數，得 0 IMP（同其他 IMP 計分）。裁定照舊：Avg／Avg+／Avg- 是 0／+3／−3 IMP，不放進別人的 datum；指定分數用指定的分數。結果頁的「你對每位的成績」跟 Cross-IMP 一樣用兩人分數差的一般 IMP。
  - **已決定**（社長 2026-11-02，照 J4 的建議）：3 個分數以上去掉一個最高與一個最低（BBO 與多數俱樂部軟體依人數去掉更多，社團規模用 1 高 1 低）；datum 含自己的分數；四捨五入到 10 分。
- **每副討論串**（`e7-t27`）：每一副的頁面（`/challenges/:id/boards/:seq`，`ChallengeBoardPage` 最下面的 `ChallengeThread`）。誰讀、誰寫見 §4（`challengeThreadAccess`）。留言 1–500 字（`CHALLENGE_COMMENT_MAX`），每串送最新 200 則（`CHALLENGE_COMMENTS_SHOWN`），走社員的動作速率限制。**不用論壇**（§5.19）：論壇是牌桌與橋館共用、所有社員都能讀的公開討論，挑戰的討論串要依「打完沒有」把關，而且不該出現在橋館；所以是 `Club` 自己的一張表 `challenge_comments`（`id`、`challenge_id`、`seq`、`user_id`、`text`、`at`；索引 `(challenge_id, seq, id)`、`(user_id)`），程式在 `worker/challenge-extras.ts`（`ChallengeExtras`，不碰 Cloudflare API）。`EVENT_OBJECTS` 開著時也留在 `Club`：留言不改挑戰的狀態，判斷權限讀的是 `Club` 的挑戰副本。刪除帳號時他的留言一起刪（`removeMember`），個資匯出帶 `challengeComments`。沒有通知、沒有即時推送（打開頁面時讀、送出後拿到新的整串）。管理員只有在**自己看得到這一串時**才能刪別人的留言（社長 2026-11-02 決定，照 J4 的建議）。
- **挑戰戰績**（`e7-t29`，`/challenges/stats`，`ChallengeStatsPage`，挑戰頁右上的「我的戰績」）：純函式 `shared/challenge-stats.ts` 的 `challengeStats`，`ChallengeExtras.stats` 從 `Club` 的副本取這個人參與、已經 `finished`、**他打完全部副數**的挑戰，只放排名裡的人（同 `challengeStandings`，含裁定）。
  - 每場挑戰和每一位**同樣打完的**對手算一次「交手」，照那一場的計分（`headToHead`，只比兩人都有分數、沒被判人工分數的副）分勝負：IMP／總分正數贏、負數輸、0 和；MP 高於 50% 贏。**勝率** ＝（勝 ＋ 和 ÷ 2）÷ 交手次數。
  - **平均 IMP** 不管那一場的計分，一律是每一副和每一位對手的分數差換算的 IMP，加總後除以比過的副數。
  - 另有「挑戰場數」（排名裡至少還有一人的挑戰）、「第一名」（含並列），以及**對每位的戰績**（head-to-head：場數、勝負和、比過幾副、IMP 合計、最近一次），依場數、再依最近一次排序。
  - **已決定**（社長 2026-11-02，照 J4 的建議）：不算每日賽與每週社團挑戰（那是全社對機器人，不是社員之間的挑戰，人數多會把勝率稀釋掉）；沒打完的挑戰不算；和局算半場。雙人搭檔挑戰（`e7-t28`）也不算：成績是兩個人的，不是本人的（見下面的「雙人搭檔挑戰」）。
- **沒做**：`e7-t26` 主題牌組已取消（社長 2026-10-24）。

**雙人搭檔挑戰**（`e7-t28`，AC-7.9，2026-11-02）：兩位真人坐南北、對兩個機器人，和其他搭檔打同一組牌比成績。設計上**每個人仍是 `challenge_players` 的一列**（回覆、通知、可見性、我的挑戰都照舊），只多一欄 `partner_id`；搭檔是「一組」只表現在幾個純函式（`worker/challenge-flow.ts` 的 `partnerOf`、`pairLead`、`isPairSecond`、`pairReady`）。沒有沿用雙人賽（§5.22）的 `pair` 實體：那是事先登記、跨比賽的搭檔，挑戰的搭檔只活在這一場，`partner_id` 就夠，也不用動 E2 的搭檔表。
- **建立**：`createChallenge` 的 `settings.partners = true`（`parseChallengeSettings` 檢查，社員可以送，不像 `weekly`／`daily`）。`invitees` 依序是**自己的搭檔，再兩兩一組的對手搭檔**（`challengePairsOf`：`[搭檔, A1, A2, B1, B2, …]`），所以人數一定是奇數，3–19 位（對手 1–9 組，`CHALLENGE_LIMITS.pairsMin`／`pairsMax`）；偶數回 `badChallengeSettings { field: 'invitees' }`，太少太多回 `challengeInvitees { min, max }`。計分的選項以**對手組數**算（`opponentsOf`）：一組對手時只有 `imp`／`total`，兩組以上多了 `mp`／`crossImp`／`datumImp`。「用這副牌挑戰」不能是搭檔挑戰（`badChallengeSettings { field: 'partners' }`：那是他一個人打過的牌）；每週、每日都不是。發起者照舊自動接受；淡江制度的 TKB 照舊只檢查發起者（§5.1.2）。**封鎖**（社長 2026-11-04）：發起者和每位受邀者照一般挑戰檢查（`unblockToInvite`／`cannotInvite`）；受邀者之間（同一組的搭檔、或彼此比成績的對手組）任兩位有一方封鎖另一方就回 `challengePairBlocked { a, b }`（依邀請順序給兩人的名字，不說誰封鎖誰，`checkPairings`）。建立之後才封鎖的：受邀者接受時，他和挑戰裡任何沒拒絕的人（含發起者）有封鎖關係就回 `challengeAcceptBlocked`（不帶名字），拒絕照常可以。
- **回覆**（`answer`，純函式）：每個人各自接受或拒絕。一組**兩人都接受**才算接受：發起者那一組以外有一組兩人都接受時才 `pending` → `active`。**一人拒絕，整組拒絕**：他的搭檔（不管接受了沒）一起改 `declined`（`declinePairs`，同一個 transaction 寫兩列），搭檔收到 `challengePartnerDeclined` 通知（發起者照舊收到 `challengeDeclined`，不重複通知）。發起者的搭檔拒絕時發起者那一組就出局，其他組照打。發起者那一組以外每一組都拒絕了就立刻 `expired`。截止時間到時沒回覆的人改 `declined`，他的搭檔也跟著（`deadlineOutcome`），所以「接受了」一定表示整組接受。
- **開打**（`playChallenge`）：搭檔還沒接受回 `challengePartnerWaiting`（社團的副本與 `ChallengeEvent.started` 都檢查，兩種 `EVENT_OBJECTS` 模式一樣）。一組一張桌：先受邀的那位（`pairLead`，發起者那一組就是發起者）坐**南**、搭檔坐**北**、東西是設定的機器人；`ChallengeTableState.userId` 是南、`partnerId` 是北，`TableEntry.challenge` 也帶 `partnerId`，兩人都用 `challengeEntry` 找得到這張桌。誰先來誰先坐，另一個位子空著：**四個位子都有人才發牌**（一般牌桌的 `canDeal`），空著時 `TableChallenge.partnerAway`，牌桌頁首顯示「搭檔不在桌上，等他入座再繼續」。
- **暫停與續打**：一人離開（`leaveTable`、開別桌）只把他從位子拿下來，桌子停著；**打到一半時整桌停住**（`TableService.partnerAway`）：機器人不動，留下的那位也不能叫牌出牌（`challengePartnerAway`），所以不會一個人替兩人打。回來（`playChallenge` → `resume`）坐回原位接著打。座位固定：南北都是真人，沒有「替機器人當莊而換座位」（`swapForDeclarer` 只在莊家是機器人、夢家是真人時換），北家當莊就是北的人主打，所以搭檔回來一定是北，只有南記 `parkedSeat`。打完最後一副後兩人都離開桌子才關。
- **斷線逾時**（社長 2026-11-02 決定；原本只斷線、沒送 `leaveTable` 時座位一直保留，桌子無限等）：入座的一人斷線（`presence(false)`）時座位先保留 **3 分鐘**（`PARTNER_AWAY_MS`，`shared/protocol.ts`），排程器的 `partnerAway:<桌>:<社員>` 工作計時；留在桌上的那位看到「搭檔斷線了：HH:MM 前沒回來，這一副就先擱著」（`TableChallenge.partnerOfflineUntil`）。時間內重新連線就取消（`presence(true)` 清掉記錄，工作醒來看到他在線就什麼都不做）。時間到還沒回來：**照他自己離開處理**（`TableService.partnerAwayDue` → `leave`），座位空出來、整桌停住（同上，`partnerAway`），桌上這一副原封不動擱著，留下的那位看到「搭檔斷線太久，這一副先擱著……」（`partnerDropped`），可以先離開、不會被卡住。**不讓機器人代打**：計分的挑戰不能由機器人替真人打（一般牌桌的 `substitute` 在挑戰桌一律不排）。被拿掉座位的人記在 `ChallengeTableState.dropped`（`TableEntry.challenge.dropped`），他**重新連線時社團自動讓他坐回去**（`ClubService.rejoinDropped` → `playChallenge`，不發入座通知）；兩人都回到桌上就從原處接著打，截止時還沒打完照「截止時打到一半的那一副作廢」的規則。斷線的起算時間寫在 `ChallengeTableState.offline`（存進牌桌的儲存），物件被回收後 `load()` 只排剩下的時間，不從頭算（一般牌桌的代打仍從現在重新起算）。兩種 `EVENT_OBJECTS` 模式一樣（牌桌的事，不經過挑戰的物件）。
- **搭檔入座通知**（社長 2026-11-02 決定）：一人按「開打／繼續」坐上這組的牌桌（`playChallenge`，開新桌或 `resume`）而搭檔不在桌上時，搭檔收到 `challengePartnerSeated`（`{ challengeId, tableId, username }`），點了直接到牌桌（`/table/<桌>?challenge=<挑戰>`，牌桌頁看到 `challenge` 參數就替他送 `playChallenge` 入座）。每次入座一則；搭檔已經坐著不送；重新連線（含上面的自動坐回）不送；已經坐著又按一次也不送。
- **結果**：牌桌的 `boardFinished` 照舊寫一筆（`userId` ＝南）；`ChallengeEvent.result` 寫給**兩個人**（同一個 `board_id`、同一個南北分數），兩人一起 `finished_at`。所以「打完幾副」「打完全部」「每副只打一次」的既有規則與 `challengeBoardVisible` 都不用改。截止時間到時打到一半的那一副照舊作廢，沒打完的搭檔列在「未完成」（一列，帶 `partnerId`）。
- **計分與顯示**：`challengeStandings` 只排每組的第一位（`isPairSecond` 的不排），`ChallengeStandingView.partnerId`、`unfinished[].partnerId` 帶搭檔；traveller 每組一列（`ChallengeTravellerEntry.partnerId`、牌局頁的 `TravellerEntry.partner`）。`scoreChallenge`（`shared/challenge-scoring.ts`）不用改：它比的本來就是「一列一個分數」，搭檔就是一列。結果頁、每副頁、牌局頁把一組寫成「A & B」，自己那一組寫「你和 B」（`src/lib/challenges.ts` 的 `pairLeadOf`、`entryName`）；名次與「你對每位的成績」以自己那一組為準。挑戰卡與設定列多一個「雙人搭檔」標籤。
- **社團積分與實力評分**（J2，§5.21）：**照挑戰的種類照給**（`challengeKind`，一般挑戰就是 `challenge` 的規則），一組是一個 side、**兩人各得那一個名次的分數**（`challengeEvent` 的 `userIds: [南, 北]`，同隊制賽一隊多人的做法）。名次與「需要幾組才給分」都以組數算。
- **挑戰戰績**（`e7-t29`）不算搭檔挑戰：勝率與 head-to-head 是個人的，搭檔的成績是兩個人的。
- **刪除帳號**（`ChallengeStore.forgetIn`）：進行中的搭檔挑戰拿掉他，他的搭檔改 `declined`、這一組的結果一起刪；剩不到兩組（不到 4 位沒拒絕的人）就 `cancelled`。牌桌照舊關掉（`forget` 認得南北兩人）。
- **再戰**：同樣的搭檔，按再戰的人和他的搭檔是第一組；有人拒絕過或帳號不在的組不再邀請；自己的搭檔不在了或沒有別組可邀就 `rematchNobody`。
- **儲存**：`challenge_players.partner_id`（TEXT，可空）。舊表由 `createTables` 用 `PRAGMA table_info` 檢查、缺了就 `ALTER TABLE ADD COLUMN`（同 C5 的 `reminded_at`），不升 `meta:schema`；`EventObject` 的 SQLite 用同一個 `ChallengeStore`，一起補。`boards_index`、`summarize` 都沒改，所以 `REPLICA_VERSION` 不變。
- **建議預設**（PRD 沒定，待社長確認）：由發起者一次選好全部的搭檔組（不是受邀的人再去找搭檔）；一人拒絕整組出局、不能換人；搭檔挑戰給積分且兩人各得一份；不算進個人戰績；一組最多 9 組對手（受邀的上限仍是 20 人以內）。

**公平與確定性**（`e7-t09`）：機器人是確定的（§5.1），兩個人做一樣的事就遇到一樣的反應。機器人的制度（`robotKind`）在建立時鎖進 `settings`；機器人沒有等級（社長 2026-10-24），`settings` 帶 `robotLevel` 會被拒絕，以前存下來的挑戰帶著的 `robotLevel` 載入時丟掉。以後若 TKB Adv 要用亂數（模擬），種子要用「挑戰 id＋第幾副＋動作序號」，不能用牌局 id。

**可見性**（伺服器把關，§4）：
- 牌：`deals` 只在伺服器；第 k 副的四手牌只有在參與者的挑戰牌桌發到第 k 副時才進 `BoardState`，之後照一般規則。
- 別人的結果：traveller（別人的合約、結果、分數、重播）、總成績與人 × 副矩陣都只給已打完全部的參與者，或挑戰結束後；還沒打完全部的人，連自己打過的那幾副也看不到別人的結果，因為知道自己領先或落後會影響後面的打法（社長，2026-10-24）。之前只看得到每個人的狀態與進度（打完幾副）。
- 非參與者：挑戰結束前什麼都看不到；結束後 `ranking = club` 才看得到排名。
- 牌局紀錄：寫入時 `revealAt` ＝ 最晚可能的結束時間；挑戰結束時改成實際結束時間（KV 的紀錄與 `boards_index.reveal_at`，依 `event_id`）。在那之前搜尋只給打的人（AC-4.9 現有的規則），詳細頁另外給打過同一副的參與者（traveller 的重播）。結束後所有人都看得到牌局，不管 `ranking`；`ranking` 只管排名。
- 這些判斷寫成 `worker/views.ts` 的純函式（`challengeView`、`challengeBoardVisible`，`e7-t14`），和 `recordVisible` 一樣在每個出口套用；誰看得到什麼的表在 §4。
- 挑戰的牌局在 E4 的搜尋可以用 `mode=challenge` 篩選（`GET /api/history/search?mode=challenge`，`shared/history-query.ts` 的 `mode`，§5.3）；紀錄頁的「篩選」裡有「模式：挑戰」（E1）。

**計分**：`scoreChallenge`（`shared/challenge-scoring.ts`）吃 `scores[參與者][副 − 1]`（南北分數，沒打是 null），**排名的人只有打完全部副數的參與者**（只有打完全部副數的人才排名，沒打完的人不排名、也不替他沒打的副算分（社長，2026-10-24））：例如 10 人的挑戰只有 8 人打完，就只排這 8 人，沒打完的 2 人列在排名下面、標「未完成」。所以 `scores` 裡沒有 null，`unfinished` 的規則用不到（設定裡也拿掉了，送來會被拒絕）。結束前的「目前排名」只排已經打完的人。已知牌的發起者（`knownDeals`）用他當時的結果，算打完，一起比、一起排名。只有一人打完時他就是唯一的名次，沒有對手可比，只顯示他的總分。實作是 `challengeStandings`（`worker/challenge-flow.ts`）：只把打完的人交給 `scoreChallenge`，只有一人時用 `total` 計分（`ChallengeStandingsView.scoring` 說明 `total` 與每副的單位），沒人打完就沒有名次；`unfinished` 列出接受了但沒打完的人和打了幾副。

**儲存**：三張 SQL 表就是挑戰的正本（不像 §5.3 的索引可以從 KV 重建）。

| 表 | 欄位 | 索引 |
| --- | --- | --- |
| `challenges` | `challenge_id`（主鍵）、`creator_id`、`created_at`、`status`、`accept_by`、`started_at`（變 `active` 的時間）、`ended_at`、`settings`（JSON）、`deals`（`encodeDealSet`）、`reminded_at`（截止前提醒送出的時間，C5） | `(status, accept_by)` |
| `challenge_players` | `challenge_id`、`user_id`（主鍵兩欄）、`position`（邀請順序，發起者 0）、`status`、`invited_at`、`answered_at`、`started_at`、`finish_by`（不再使用）、`finished_at`、`known_deals`、`partner_id`（雙人搭檔挑戰的搭檔，`e7-t28`） | `(user_id, challenge_id)` |
| `challenge_results` | `challenge_id`、`user_id`、`seq`（主鍵三欄；`seq` 是牌組裡第幾副）、`board_id`、`score_ns`、`played_at` | — |

為什麼用 SQL、不用 KV：
- 要查的東西 KV 做不到或要手動維護好幾份索引：我的挑戰（依狀態分頁）、載入時找進行中的挑戰重排期限、人 × 副矩陣、traveller 接 `boards_index`。
- 一個動作常改好幾列（接受＋轉 `active`；寫結果＋打完＋結算），SQL 有 transaction。
- 讀寫都在同一個物件裡、同步，所以不放記憶體快取：每次都讀 SQL，物件被回收也不會掉資料。
- 只有要查的欄位拆成欄；其他設定放 JSON，之後加設定不必改表。
- 大小：M1 社團規模，一個挑戰最多 21 人 × 16 副＝336 列結果，牌組一副約 75 字元；全社每週一場 50 人 8 副，一年約兩萬列，沒有負擔。

**版本**：三張表是新的，載入時 `CREATE TABLE IF NOT EXISTS`，沒有舊資料要搬，所以 `meta:schema` 不變（仍是 3）。C5 加的 `challenges.reminded_at`（提醒送出的時間）由 `createTables` 用 `PRAGMA table_info` 檢查、缺了就 `ALTER TABLE ADD COLUMN`（新欄位是空的，不必回填），所以也不升 `meta:schema`；之後要搬資料的改動才把 `meta:schema` 升到 4，做法同 2→3。

**刪除帳號**（`ChallengeStore.forget`）：進行中的挑戰拿掉他的位子與結果，剩不到 2 位沒拒絕的人就 `cancelled`；已結束的挑戰保留他的列，最終名次不變（同牌局紀錄，名字顯示為已刪除的社員）。

**M2／E11**：拆分後每個挑戰是一個 `Event` Durable Object，三張表原樣搬進去（`challenge_id` 變成物件本身）；`Club` 只留「誰在哪些挑戰」給大廳用。牌局紀錄依 AC-11.4 搬到 D1。

**各批做什麼**：

| 批 | 做什麼 |
| --- | --- |
| C2（本批） | 這份設計、`DealSet`（`shared/deal-set.ts`）、三張表與 `ChallengeStore`（`ClubService.challenges`） |
| C3 | 建立（設定檢查、封鎖、`makeDealSet`）、邀請／接受／拒絕／取消與狀態轉移、通知種類與訊息 |
| C4 | 挑戰牌桌模式、確定性種子、進度與續打、牌桌頁首提示 |
| C5 | 期限工作與結算、可見性函式、挑戰牌局進紀錄（`mode`、`event_id`、`revealAt`）；`ChallengeView` 加 `standings`、`travellers` |
| C6 | 挑戰大廳、發起對話框、排名頁（建立／回覆／取消的訊息與 `ChallengeView` 在 C3 已經有了；這時加畫面要的推送與排名的型別） |
| C7 | Traveller、並排重播（見下面「Traveller 與並排重播」） |
| C8–C9 | Best Hand（發給參與者前旋轉牌組，所有人一致）、Just Declare、再戰、「用這副牌挑戰」（`DealSetSpec` 的 `given`）、每週社團挑戰、分享卡、端對端測試 |

## 5.4 通知中心

`NotificationService`（`worker/notifications.ts`）是 `ClubService.notifications`；其他功能呼叫 `notify(userId, kind, params)`。伺服器只存種類（`NOTIFICATION_KINDS`）和參數，文字由瀏覽器依語言組出來、點了到哪一頁也由瀏覽器決定（`src/lib/notifications.ts`），所以加新種類時要一起加 `strings.ts` 六種語言與連結。某位社員的通知第一次用到時才從儲存讀出、之後留在記憶體；有變就推 `notifications` 給在線的他（同樣只送有變的部分）。頁首鈴鐺（`NotificationBell`）顯示未讀數與列表，點一則標為已讀並跳到對應頁。

**邀請彈窗**（`e1-t35`，`src/state/InvitationsContext.tsx`）：`challengeInvited`、`matchInvited` 不只進鈴鐺，也在畫面中間彈出（DESIGN.md 的 InviteDialog）。全在瀏覽器做，伺服器的通知與 API 都沒變：從推來的通知找出邀請（同一個挑戰／比賽只看最新的一則），用既有的 `GET /api/challenges/:id`、`GET /api/matches/:id` 讀詳細內容並判斷還能不能回覆（挑戰：`answerable`；隊制賽：準備中且自己的座位還是 `invited`），接受／拒絕呼叫既有的 `answer`。離線時收到的邀請在登入或重連、通知推來時一樣會彈。之後同一個挑戰或比賽又有通知（取消、移出、再邀請）就重讀一次，`match` 推送（§5.8）直接更新；挑戰的截止時間到了也會變成失效。處理過的（接受、拒絕、稍後回覆、關掉失效的）與響過的通知 id 記在 localStorage（`tku-invites-handled`、`tku-invites-rang`，留 60 天），所以同一個瀏覽器不重複彈、開好幾個分頁也只響一次；別的分頁處理了，`storage` 事件讓這一頁也關掉。接受、拒絕會把那幾則邀請標為已讀；稍後回覆不標，鈴鐺裡還看得到。

現有的種類：`application`（有人申請註冊，通知每位管理員，連到管理頁）；挑戰（§5.5）：`challengeInvited`（給受邀者）、`challengeAccepted`／`challengeDeclined`（給發起者）、`challengeCancelled`（給沒拒絕的人），參數是 `challengeId` 與對方的 `username`；`challengeReminder`（截止前 12 小時，給接受了還沒打完的人）與 `challengeResults`（挑戰 `finished` 時給每位接受的人），參數是 `challengeId`，由期限工作與結算送出（§5.5，`e7-t13`）；`friendOnline`（好友上線了，參數 `username`，連到大廳，§5.7；只給有 `friends` 旗標的社員，不在線的只推播、不進通知中心）。受邀桌（`e2-t25`）：`tableInvited`，參數 `tableId`、`number`（桌號）與房主的 `username`，連到那一桌。隊制賽（§5.8，`e8-t04`）：`matchInvited`（給受邀者）、`matchAccepted`／`matchDeclined`／`matchLeft`（給安排那一隊的人）、`matchRemoved`（給被移出的人，連到 `/matches`）、`matchCancelled`（給座位上的人），參數是 `matchId` 與做這件事的人的 `username`，其餘連到那場比賽的準備室。搭檔（淡江橋譜 E2，`e2-t03`）：`pairInvited`（給受邀者）、`pairAccepted`／`pairDeclined`（給邀請者）、`pairEnded`（給另一位），參數 `pairId` 與做這件事的人的 `username`，連到淡江橋譜的搭檔頁（`/pairs/:id`，橋譜 C4 做；鈴鐺用整頁開啟另一個網站）。精選（`e4-t29`）：`boardFeatured`，第一次設為精選時給打那副的社員（不含機器人與設精選的人自己；之後編輯不再通知），參數 `boardId` 與設的人的 `username`，連到那副的紀錄頁。挑戰頁出來前（C6）挑戰的通知連到大廳。比賽公告（§5.24，`e9-t16`）：`tournamentAnnounced`（給有 `tournaments` 旗標的社員）、`tournamentPartner`（被一起報名的搭檔或隊友，要確認）、`tournamentWithdrawn`（同組的人退出或婉拒，這組報名取消）、`tournamentRemoved`（管理員移除這組報名）、`tournamentCancelled`、`tournamentDayReminder`（開賽前一天，開賽時間設在一天以上之後才有）、`tournamentReminder`（開賽前一小時）、`tournamentResults`（建立的比賽結束），參數 `tournamentId`、`title`（`tournamentPartner`、`tournamentWithdrawn`、`tournamentRemoved` 加做這件事的人的 `username`），連到比賽頁；`tournamentResults` 多帶 `eventKind`、`eventId`，直接連到那場雙人賽或隊制賽的結果頁。受邀桌等之後各自加；私訊不進通知中心（§5.7），所以也不推播。

**PWA 推播**（`e1-t28`，AC-1.8；`worker/push.ts`、`worker/web-push.ts`、`shared/push.ts`、`shared/push-texts.ts`，DEPLOY.md §4.17、docs/SECURITY.md）：通知中心的每則**新**通知（`NotificationService` 的 `onNew`）交給 `PushService.queue`；社員**沒有連線**（`Connections.onlineUserIds` 沒有他）、那個種類沒關掉、有訂閱的裝置時，推到他的每台裝置。

- **開關**：`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`（`mailto:`／`https:`）三個 Worker secret 都設而且格式對才開（`pushFrom`）；否則 `GET /api/push` 回 `enabled: false`、「我的帳號」沒有卡片，其他路由回 503 `pushOff`。PR 預覽拿不到 secret，所以沒有推播。
- **API**（都要登入）：`GET /api/push`（`PushView`：是否開、VAPID 公鑰、自己的裝置 `{ id, name, createdAt }`、每個種類推不推）；`POST /api/push/subscribe`（`PushSubscription.toJSON()`＋頁面語言；同一個 endpoint 再訂一次是更新，第 11 台擠掉最舊的）；`POST /api/push/unsubscribe { id }`；`POST /api/push/kinds { kinds: { <種類>: boolean } }`；`POST /api/push/test { id? }`（測試推播，在線也推，每人 10 秒一次）。裝置的 `id` 是 endpoint 的 SHA-256 前 16 個十六進位字（`pushDeviceId`），頁面用同樣的算法認出「這台裝置」，endpoint 與金鑰不回給頁面。endpoint 只接受瀏覽器的推播服務（FCM、Mozilla autopush、WNS、Apple，`allowedEndpoint`），社團不會替人去打任意網址。
- **文字**：鈴鐺的文字在瀏覽器依語言組（`strings.ts` 太大，Worker 不能帶），推播要在沒開網頁時由 service worker 直接顯示，所以伺服器自己寫：`shared/push-texts.generated.ts` 是 `strings.ts` 的 `notificationTexts` 轉成的範本（`{username}`、`{number}`…），由 `npm run push:texts`（`tests/presentation/push-texts.test.ts` 加 `-u`）產生；同一個測試在每種語言、每個種類比對推播和鈴鐺的文字一樣，`strings.ts` 改了沒重產就會失敗。語言是那台裝置訂閱時頁面的語言。點了到哪裡跟鈴鐺同一個函式（`notificationLink` 搬到 `shared/notification-link.ts`），討論區連牌桌或橋館看社員的 `forum` 旗標。內容 `{ title, body, url, tag }`，`body` 最多 300 字、`tag` 是通知的 id。
- **送出**：在社團的 Durable Object 裡，不在 Worker 的請求裡（10 ms CPU）。同一輪（一個動作）通知的全部收進一批，`ctx.waitUntil` 撐著物件、回應不必等推播服務；一批 6 個同時送。每台裝置的推播：新的 P-256 金鑰對與 salt、ECDH＋HKDF、AES-128-GCM（RFC 8291 `aes128gcm`，一個 4096 的 record），`Authorization: vapid t=<JWT>, k=<公鑰>`；JWT（ES256，`aud` 是推播服務的 origin，12 小時）每個推播服務簽一次、快到期前一小時才換（`WebPush.jwtFor`），所以推給全社團（大多在 FCM）只簽一次。等人回應的種類（邀請、申請加入、叫裁判、隊制賽開始或替補）`Urgency: high`，其他 `normal`；跟某一桌或某人上線有關的 `TTL` 一小時（過了推播服務就丟掉），其他一天。推播服務回 404／410 表示瀏覽器已經取消訂閱，那台裝置刪掉；其他失敗（429、5xx、連不上）只記日誌（`push`），**不重送**：通知照樣在鈴鐺裡。物件在送出途中被回收，那一批就沒了（同樣的理由不存佇列）。
- **在線不推**：用社團的連線判斷，跟鈴鐺推 `notifications` 同一個依據；送出那一刻才看（排隊時離線、送出時上線就不推）。在線包括開在背景分頁的網頁（電腦上通常一直連著；手機瀏覽器在背景幾分鐘內會斷線，之後就會推）；這時鈴鐺與邀請彈窗（e1-t35）已經會提醒。
- **偏好**：存每個種類（`PushKinds`，只存跟預設不同的）；「我的帳號」把種類分成幾組（`PUSH_GROUPS`：挑戰、牌桌、隊制賽、搭檔、比賽（有 `tournaments` 旗標或管理員才顯示）、精選、好友上線（有 `friends` 旗標才顯示）、橋譜與文章、討論區、管理（只給管理員看）），勾一組就改那組全部的種類；每個種類一定在一組（測試）。`friendOnline` 預設不推（`PUSH_OFF_BY_DEFAULT`），其他預設推。偏好只管推播，鈴鐺不受影響。
- **裝置的生命**：「在這台裝置關閉」與**登出**都會先 `POST /api/push/unsubscribe` 再取消瀏覽器的訂閱（同一台電腦下一個登入的人不會收到前一個人的推播，`forgetPushOnSignOut`，最多等 1.5 秒）；被登出所有裝置（`revokeSessions`：重設密碼、管理員改密碼、兩步驟被關掉…）時清掉全部裝置，社員之後要在各裝置重新開啟。自己改密碼只登出其他 session，不動推播（分不出哪個訂閱屬於這個 session）。瀏覽器換了訂閱（`pushsubscriptionchange`）時，service worker 自己用同一把公鑰重新訂閱並送到 `subscribe`。匯出資料有裝置名稱、開啟時間與種類，沒有 endpoint 與金鑰。
- **瀏覽器**（`public/sw.js`、`src/lib/push.ts`、`src/components/PushCard.tsx`）：service worker 的 `push` 顯示通知（圖示 `icon-192.png`），`notificationclick` 把已開著的本站視窗叫到前面並前往 `url`，沒有就開新視窗（淡江橋譜的網址直接開）。iPhone／iPad 只有加入主畫面、從主畫面打開（iOS 16.4+）才有 `PushManager`，卡片改成說明；瀏覽器封鎖了通知也會說明。正式站載入時就註冊 service worker；開發模式不註冊，按「開啟推播」時才註冊。

## 5.3 紀錄的 SQL 索引（決策紀錄，`e4-t10`）

**決定**：紀錄的篩選與搜尋用 Durable Object 自己的 SQLite（`ctx.storage.sql`），不用 D1、不另開服務。完整紀錄仍放在 KV 的 `board:<id>`；SQL 只放查詢需要的欄位，隨時可以從 `board:` 重建。列表（`/api/history`）與搜尋都從 SQL 讀；`hist:`／`uhist:` 的 KV 索引仍照寫（管理頁的每人副數用 `uhist:`），之後確定沒人用再拿掉。舊的 `meta:count:` 已不再使用。

**為什麼**：
- `Club` 本來就是 SQLite 後端（`wrangler.jsonc` 的 `new_sqlite_classes`），不用新增 binding 或付費方案；查詢跟牌局在同一個物件裡，寫入和讀取都不必跨網路。
- KV 索引只能依時間往前翻，做不到「4♠ 合約」「我和 X 是搭檔」這種條件；SQL 加上索引在一萬副時也很快（AC-4.8 的測試在 `e4-t23`）。
- E11 把紀錄搬到 D1（AC-11.4）時，這份 schema 原樣搬過去。**H2a 做了（§5.12）**：D1 有一份同樣 schema 的副本給紀錄頁讀，這裡的索引留著當寫入端與重建來源。

**介面**：`ClubService` 只透過 `Store.sql`（`worker/store.ts` 的 `Sql`：同步的 `exec`、`transaction`）碰 SQL；Durable Object 接到 `storage.sql.exec` 與 `storage.transactionSync`，測試用 Node 內建的 `node:sqlite`（`tests/worker/sqlite.ts`）。所有查詢一律用 `?` 參數，不拼字串。程式在 `worker/history-index.ts`。

**表**（載入時 `CREATE TABLE IF NOT EXISTS`，每次載入都跑也沒關係）：

| 表 | 欄位 | 索引 |
| --- | --- | --- |
| `boards_index` | `board_id`（主鍵）、`played_at`、`table_no`、`mode`（`casual`，挑戰牌桌是 `challenge`）、`event_id`、`board_no`、`dealer`、`vul`、`level`、`strain`（四家 Pass 時兩者為 null）、`doubled`（0／1／2）、`declarer_seat`、`declarer_user`（機器人主打為 null）、`tricks`、`score_ns`、`claimed`、`reveal_at`（null＝已公開；挑戰的牌寫截止時間，挑戰結束時依 `event_id` 提前到結束時間） | `(played_at, board_id)`、`(level, strain, played_at)`、`(declarer_user, played_at)`、`(event_id)` |
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
| `vul`、`boardNo`、`table`、`mode` | 身價、牌號、桌號、模式（`mode=challenge` 只列挑戰的牌，C5） |
| `sort` | `date_desc`（預設）、`date_asc`、`score_desc`、`score_asc`、`tricks_desc`、`tricks_asc`（四家 Pass 一律排最後） |
| `page`、`size` | 頁碼（超過最後一頁就給最後一頁）、每頁 10／20／50／100 |

SQL 由 `worker/history-index.ts` 的 `searchBoards` 組：只有固定的 SQL 片段會拼進字串，所有值都用 `?` 參數。先數總數，再取那一頁的 id，摘要從 `board:<id>` 讀。

**每天幾副**（`e3-t48`，側欄紀錄依日期分層）：`GET /api/history/days?<條件>`，條件與 `/api/history/search` 相同（`sort`、`page`、`size` 不作用），回 `HistoryDays`：`{ days: { date, count }[] }`，新的一天在前，最多 `LIMITS.historyDaysMax`（366）天。日期是**台灣日期（UTC+8）**，跟 `from`／`to` 同一個日曆：社團在台灣、台灣沒有夏令時間，而且點進某一天就是用 `from=to=那天` 搜尋，兩邊的日界線一定對得上（用瀏覽器時區的話，在國外的社員會看到「那天 3 副、點進去 2 副」）。SQL 是 `history-index.ts` 的 `dayStatement`：同一個 `where()`、`GROUP BY (played_at + 8h) / 1 天`，所以還沒公開的牌（`reveal_at`）一樣只算給打過的人；社團的索引與 D1 副本（`daysReplica`）跑同一段，資訊隔離套件比對兩邊相同，而且每天的副數加起來等於搜尋的總數。

**效能**（`e4-t23`，AC-4.8）：`tests/worker/history-perf.test.ts` 建一萬副假資料（40 位社員、約兩成座位是機器人、一成是挑戰，最新的挑戰牌還沒公開），跑 31 種篩選與排序組合（單一條件、搭檔／同桌的 join、全部疊在一起、第 50 頁），量「數總數＋取第一頁＋讀那頁的 `board:`」三次取最慢，每種都要 < 300 ms，並檢查沒公開的牌不會出現在別人的結果裡。本機最慢一種約 15 ms；數字印在測試輸出。

**收藏**（`e4-t24`～`t27`，AC-4.4）：跟索引同一個 SQLite，表也在 `createHistoryIndex` 一起建；程式在 `worker/favorites.ts`，筆記與標籤的規則在 `shared/favorites.ts`（前後端共用）。

| 表 | 欄位 | 索引 |
| --- | --- | --- |
| `favorites` | `user_id`、`board_id`（主鍵兩欄）、`note`、`tags`（JSON 陣列，保留順序）、`created_at`、`updated_at` | 主鍵 |
| `favorite_tags` | `user_id`、`tag`（`COLLATE NOCASE`）、`board_id`（主鍵三欄） | 主鍵（篩選與數標籤都用它的前綴） |

| API | 做什麼 |
| --- | --- |
| `GET /api/favorites?<搜尋條件>` | 「我的收藏」的一頁：條件與 `/api/history/search` 相同（`parseHistoryQuery`），另加 `tag`；`scope` 不作用（收藏不管是誰打的）。回 `FavoritesPage`：`boards`、`total`、`page`、`size`，加上這一頁的 `favorites`（筆記與標籤）與自己全部的 `tags`（標籤與次數，給標籤篩選與自動完成） |
| `GET /api/favorites/ids` | 自己收藏的所有牌局 id（星號按鈕整頁共用一次讀取，`src/lib/favorites.ts`） |
| `GET /api/favorites/:id` | 這副的收藏（沒收藏是 `null`）與自己的標籤；看不到這副是 404 |
| `PUT /api/favorites/:id` | 收藏，或改筆記／標籤（`{ note?, tags? }`，沒給的保持原樣）；看不到這副是 404 |
| `DELETE /api/favorites/:id` | 取消收藏（本來就沒收藏也回成功） |

規則：筆記最多 500 字（`favoriteNoteTooLong`）；標籤最多 8 個、每個 20 字（`favoriteTagsBad`），去頭尾空白、連續空白合成一個、逗號與控制字元換成空白，大小寫不同算同一個標籤；每人最多收藏 1,000 副（`favoritesFull`）。`tag` 也是一般搜尋的條件（「我收藏且標了這個標籤的」），所以紀錄頁的篩選標籤也會顯示它。帳號刪除時連收藏一起刪。一頁的筆記逐筆讀（Durable Object 一個查詢最多 100 個參數，一頁可能有 100 副）。

介面：星號（`FavoriteButton`）在紀錄列表每一列、紀錄頁、牌桌側欄的紀錄、牌桌的結果面板；按了立刻變色，伺服器拒絕就變回來並顯示錯誤。「我的收藏」在 `/favorites`（`FavoritesPage`）：沿用紀錄頁的篩選、條件標籤與排序，另有一排標籤按鈕；每副的筆記與標籤在原地編輯（`FavoriteNotes`：Enter 或逗號加入標籤，打字時列出自己用過的相符標籤）。

**匯出與分享**（`e4-t36`～`t38`，J8；可見性見 §4「匯出與公開分享連結」）：

| API | 做什麼 |
| --- | --- |
| `GET /api/history/export.pbn?<搜尋條件>` | 紀錄頁「下載 PBN」：條件與 `/api/history/search` 相同（紀錄頁另把分組選到的主題與日期併進去），照搜尋的排序取前 `LIMITS.exportBoardsMax`（500）副，一份 PBN 2.1（`shared/pbn.ts` 的 `toPbnFile`：必要的標籤、`Deal`、`Auction`（Alert 寫成 `=n=` 與 `[Note]`）、`Play`（從首攻者起每墩一行，攤牌後的寫 `*`）、`Score`）。`X-Boards-Total` 是搜尋找到幾副，超過上限時頁面說只下載了前 500 副。不經 D1 副本（§5.12），由社團回答 |
| `GET /api/history/:id/session.lin` | 「下載整場 LIN」：這一副與同一張桌連續打的其他副（`shared/lin.ts` 的 `toSessionLin`：一行 `vg`，之後每副一行 `qx|o<n>|` 加那一副的 LIN，各帶自己的 `pn`，因為中途可能換人） |
| `GET`／`POST`／`DELETE /api/history/:id/share` | 這一副的公開連結：讀（沒有是 `null`）、產生（已經有就給同一個）、撤銷 |
| `GET /api/share/:token` | 不用登入：`{ shared: SharedBoard }`（`sharedBoardView`），頁面在 `/share/<token>`（`SharedBoardPage`） |

**一場**（`sessionOf`，`worker/board-shares.ts`）：紀錄從 J8 起帶 `tableId`（那一桌的 id）。同一場＝同一個 `tableId`、依完成時間排序、相鄰兩副相隔不超過 60 分鐘（`SESSION_GAP_MS`）連成的一串，最多 `LIMITS.sessionBoardsMax`（100）副；候選先用索引找（`sessionCandidates`：同桌號、同模式與比賽、前後 12 小時、至少有一位這一副的社員，各方向最多 200 副），再讀紀錄比 `tableId`。J8 以前的紀錄沒有 `tableId`：改用「同桌號、同模式、沒有 `tableId`、有這一副的社員」。`tableId` 只在完整紀錄裡，`BoardSummary` 與索引都沒改，所以 `REPLICA_VERSION` 不用加。單副的 PBN 由瀏覽器從已經載入的紀錄產生（`toPbnFile([record])`），不用另外問伺服器；下載都是先 `fetch` 再存成 `blob:`（`src/lib/download.ts`），CSP 不用改。

| 表 | 欄位 | 索引 |
| --- | --- | --- |
| `board_shares` | `token`（主鍵）、`board_id`（唯一）、`created_by`、`created_at` | 主鍵、`board_id` |

`board_shares` 跟收藏一樣在社團的 SQLite（`BoardShares.createTables`，每次載入時建），不在每日備份裡（同收藏）；帳號匯出帶自己產生過的連結（`boardShares`），刪帳號時一起刪。

**紀錄頁**（`e4-t16`～`t21`）：`/history` 的篩選與排序都寫在網址（`/history?scope=all&level=4&strain=S&sort=score_desc`），重新整理或分享連結都是同一份清單；頁面用 `readHistoryQuery` 讀網址（不認得的參數直接略過，不像 API 回錯誤）、用 `historyQueryString` 寫回，條件改了就回第 1 頁。日期的「今天／本週（從週一）／本月」由 `datePresetRange` 換成台灣日期的 `from`／`to`。篩選介面在 `src/components/HistoryFilters.tsx`。用到的條件在清單上方顯示成標籤（`src/lib/historyChips.ts` 的 `filterChips`：階數＋花色合成一個「合約」、起訖日期合成一個「日期」），每個可單獨移除，「清除全部」只清條件、保留範圍、排序與每頁筆數（e4-t22）。手機版篩選收合在「篩選（n）」按鈕裡，按了才展開，展開後有「完成」收回；寬螢幕開啟帶條件的連結時直接展開。

## 5.2 與淡江橋譜共用帳號

淡江橋譜（TKU BridgeBook，Vercel 上的靜態網站）沒有自己的後端，帳號與線上內容都在這個 Worker：

```
橋譜的瀏覽器 ──/api/*──► Vercel（vercel.json rewrite）──► 這個 Worker ──► Durable Object
             └─匯入上傳（帶一次性憑證，直接連 Worker，不經過 Vercel）──┘
```

- **同一批帳號、各自的登入**：橋譜的 `/api/*` 由 Vercel 轉發，`tbt_session` cookie（沒有 Domain 屬性）因此屬於橋譜自己的網域。兩站用同一組帳號密碼，但要各自登入一次。`/ws` 不經過橋譜。
- **申請與核准**：`ClubService.register` 第一個帳號直接建立（管理員），之後一律存成 `app:<id>`，`adminApprove` 才建立帳號（受人數上限限制）。申請中的名稱不能被別人註冊；用申請時的密碼登入會得到 `awaitingApproval`。
- **申請加入的防濫用**（`e1-t33`，AC-1.9）：
  - **同一個網路的次數**（`worker/register-limit.ts` 的 `RegistrationLimit`）：每個 `CF-Connecting-IP` 一小時最多 10 次（`REGISTRATIONS_PER_ADDRESS`、`REGISTRATION_WINDOW_MS`），送出的申請（第一個帳號也算）與**錯的邀請碼**都算，帳號被用走、密碼太短這類表單錯誤不算；超過回 429 `tooManyRegistrations`（`{minutes}`），日誌 `registerLimited`（不記位址）。**只存位址的雜湊**：以 Worker secret `SEEN_SALT`（§5.17 的鹽）加鹽的 SHA-256 前 16 個十六進位字，存在 `meta:registrations`（一筆，視窗結束的在下一次寫入時清掉，最多 2,000 個位址），不在備份裡。沒設 `SEEN_SALT` 時鹽在物件醒來時隨機產生、次數只放記憶體、不寫進儲存（沒有祕密鹽的 IPv4 雜湊可以窮舉還原），物件被回收就重算。沒有位址（本機開發、測試）不限制。
  - **Cloudflare Turnstile**（`worker/turnstile.ts`）：`TURNSTILE_SITE_KEY`（vars）與 `TURNSTILE_SECRET_KEY`（secret）**都設**才開；`GET /api/register/options`（不用登入）回 `{ turnstileSiteKey: string | null }`（`RegisterOptions`），申請表單有 site key 才載入 `challenges.cloudflare.com` 的 script、畫出元件（`src/components/Turnstile.tsx`），`POST /api/register` 帶 `turnstileToken`。驗證是對 `siteverify` 的 fetch，放在 `club.ts`（`ClubService` 不碰 Cloudflare API），在 `ClubService.register` 之前；沒有、錯的、用過的、過期的 token，或連不到 Cloudflare（不放行）都回 403 `captchaFailed`，日誌 `turnstileFailed`（Cloudflare 的錯誤代碼）。token 只能用一次，表單在每次失敗後重新產生。**淡江橋館的申請也走 `/api/register`**：開 Turnstile 之前橋館要先帶 `turnstileToken`（DEPLOY.md §4.13）。
  - 「忘記密碼」的申請沒有套用：同一個人在申請還在等時不會重複通知管理員，且要邀請碼；Email 重設（`e1-t30`）寄信有成本、可能被拿來灌別人的信箱，那時再用 `RegistrationLimit` 同樣的做法。
- **忘記密碼**（`e1-t36`，管理員核准）：`requestPasswordReset(username, inviteCode)` 只記下申請（`StoredUser.passwordReset.requestedAt`）並通知管理員（`passwordResetRequested`，通知中心）；申請還在等或代碼還有效時再申請不重複通知。管理員在管理頁核准（`adminAnswerPasswordReset`）才產生一組一次性代碼（`XXXXX-XXXXX`，31 個不易混淆的字元、約 49 bit，3 天有效，只存 SHA-256），**只顯示給按核准的管理員**，由他當面或私訊交給本人；拒絕就刪掉申請。`resetForgottenPassword(username, code, password)` 對了才設新密碼，用過就失效；錯的代碼與登入共用 `loginByName`／`loginByAddress` 的失敗次數。改好後登出所有 session、通行證與連線（`revokeSessions`），記下 `passwordResetAt`。管理員帳號不行（`adminNoSelfReset`），還在等核准的註冊申請也不行（`resetApplication`，請管理員拒絕後重新申請）。**為什麼是「核准後發代碼」而不是「申請時附上新密碼的雜湊」**：知道邀請碼的人都能以別人的名義申請；若申請時就附密碼，管理員核准的是「誰送的密碼」無從分辨，冒名者的密碼會生效。代碼只交到管理員確認過的本人手上，冒名者申請了也拿不到。
- **兩步驟登入**（`e11-t31`，docs/SECURITY.md V2.7、DEPLOY.md §4.15）：管理員自己開 TOTP（RFC 6238，`worker/totp.ts`，只用 WebCrypto，一次檢查最多 3 個 HMAC-SHA-1，在社團的 Durable Object 裡算）。**管理員一定要開**（社長 2026-11-02，見下方「強制」）；一般社員沒有這個選項。
  - **強制**（社長 2026-11-02）：沒開的管理員**照樣能登入**、照樣打牌，但在伺服器上只是「帶著自己權限的社員」，開了才算管理員。做法集中在兩處：`ClubService.actsAsAdmin(user)`＝`admin && twoFactor`，`permissionsOf`、`requireAdmin`、`requirePermission`、`mayDirect`（裁判）、給挑戰留言與排名的 `isAdmin` 都改看它；`Me` 多帶 `twoFactor.required: true`，`roles.ts` 的 `allows` 把這樣的 `Me` 當成社員（`adminLocked`），`requireNeed` 擋下時回 403 **`adminTwoFactorRequired`**（不是 `adminOnly`／`noPermission`），所以 `/api/admin/*`、`/api/book/*`、`/api/club/*`、`/api/forum/*` 每條要管理員或權限的路由都一樣擋，**淡江橋館的管理功能也一樣**（同一支 API）。`Me.permissions` 只剩他自己被勾的權限（`StoredUser.permissions`，管理員身分拿掉時留下的那些）；管理頁的社員列表與「指派給誰」看的是身分（`rolePermissions`），不受影響；功能旗標也照身分。**`/api/account/2fa/*` 不擋**（設定只看 `user.admin` 這個身分），所以第一個帳號（創社者）註冊後直接登入、到「我的帳號」開好就能用管理頁。**已經登入的 session 不用重登**：每個請求都從 `userForToken` 重算 `Me`，開啟的那一刻起（同一個 session 留著，其他裝置登出）就是管理員；關掉兩步驟登入、或被設成管理員的新人，也立刻回到「要先開」。管理頁（`AdminPage`）看到 `required` 時只顯示橫幅（`AdminTwoFactorBanner`），連到「我的帳號」的 `#two-factor`，不送任何管理 API。測試不關掉規則：`tests/worker/admin-two-factor.ts` 的 `adminWithTwoFactor` 用真的設定流程替測試裡的管理員開好（選這個而不是設定開關，是為了正式環境沒有「不強制」的路徑可以誤設）。
  - **設定**：`POST /api/account/2fa/setup { password }`（只限管理員身分，`adminOnly`）回 `TwoFactorSetup { secret, uri, expiresAt }`：base32 金鑰與 `otpauth://totp/TKU%20BridgeTable:<帳號>?…` 連結。頁面把連結畫成 **QR code**（`src/components/QrCode.tsx`：`qrcode-generator`，MIT、沒有相依套件、由 Vite 打包進來，畫成頁面裡的 SVG，黑白色在 `tokens.ts` 的 `qr`；CSP 只放行本站，也不該把金鑰送到別的服務去畫），連結（手機上直接點開驗證 App）與手動輸入的金鑰照舊。金鑰先存在 `StoredUser.twoFactorSetup`，10 分鐘內 `POST /api/account/2fa/enable { code }` 給對第一個驗證碼才生效（`twoFactorSetupGone`），回 `{ user, recoveryCodes }`：10 組 `XXXXX-XXXXX` 備用碼只出現這一次，只存 SHA-256；同時登出其他裝置（只靠密碼開的 session 不留）。
  - **登入**：`POST /api/login` 多一個可選的 `code`（和 `lang`，通知信用）。**密碼對了**才會知道要驗證碼：沒帶 `code` 回 401 `twoFactorNeeded`，頁面多一格驗證碼後**用同一組帳號密碼再送一次**（不發中間票證，伺服器不必多存狀態）。6 位數字當 App 的驗證碼（前後各容許一步、同一步只能用一次：`TwoFactor.lastStep`），其他當備用碼（用掉就刪）。錯了回 401 `twoFactorWrong`，算進那個帳號的 `TWO_FACTOR_FAILURES`（5 次／15 分鐘，不分來源；鎖了回 `tooManyLogins`）與那個 IP 的登入失敗次數。**沒開的帳號請求與回應完全不變**；淡江橋館的登入頁也照這個流程多一格驗證碼（橋館 `feat/login-two-factor`，同一支 API 帶 `code`）；橋館的 PR 在牌桌這次（強制）部署之後合併，中間這段時間開了兩步驟登入的管理員暫時只能登入牌桌。
  - **管理**：`POST /api/account/2fa/recovery { password, code }` 換一批備用碼（舊的全部失效）、`POST /api/account/2fa/disable { password, code }` 關掉，都要密碼加驗證碼或備用碼（同一個失敗次數）。`DELETE /api/admin/users/:id/2fa`：另一位管理員替手機與備用碼都不見的人關掉（不能對自己，`notSelf`）。`Me.twoFactor { enabled, recoveryLeft, required? }` 只給管理員與已經開了的人；`AdminUser.twoFactor` 給管理頁。
  - **只有一位管理員時的最後手段**（社長 2026-11-02：社長是唯一的管理員，也是網站與 Cloudflare 帳號的擁有者）：`POST /api/ops/two-factor-reset { username }`，帶 `Authorization: Bearer <TWO_FACTOR_RESET_TOKEN>`。這個 Worker secret **平常不存在**，沒設、設得太短（少於 32 字）或權杖不對時，這條路由回 404 `noSuchApi`，跟不存在一樣；只有能登入 Cloudflare 帳號的人能用 `wrangler secret put` 設它，用完立刻 `wrangler secret delete`（步驟在 DEPLOY.md §4.15）。比對沿用 `seedTokenMatches`（SHA-256 後定時比較），在 `club.ts` 查 session 之前。`ClubService.ownerResetTwoFactor` 清掉兩步驟登入與還沒完成的設定、清掉失敗次數、**登出那個帳號所有的 session**、寄安全通知信，日誌 `twoFactorOwnerReset`（不記是誰）。為什麼不用 `wrangler` 直接改資料：社團的資料在 Durable Object 的儲存裡，wrangler 沒有指令能改它；從備份還原（DEPLOY.md §4.4）會連其他人的新資料一起倒回去。
  - **Email**（§5.20）：驗證碼錯到鎖住（有人知道密碼）、用了備用碼、兩步驟登入被關掉時，寄「帳號安全通知」到驗證過的 Email（`mailSecuritySubject` 與三種內文，算進每個帳號的寄信次數）；沒有 Email 就不寄。**改密碼與 Email 重設密碼都不會關掉兩步驟登入**：拿到信箱的人也還要驗證碼。
  - **儲存**：金鑰要能算驗證碼，所以跟密碼雜湊一樣原樣放在 `user:<id>`（備份裡也有）；匯出資料（`GET /api/account/export`）只有 `twoFactorEnabledAt`，沒有金鑰與備用碼雜湊。
- **Google 登入**（`e1-t31`，AC-1.9；`worker/oauth.ts`＋`worker/google.ts`，docs/SECURITY.md V2、DEPLOY.md §4.16）：與 LINE 登入（下一段）共用同一套流程：`ClubService` 的 `startOAuth`／`finishOAuth`／`oauthPending`／`finishOAuthCode`／`unlinkOAuth` 都以登入方式（`OAuthName`：`'google' | 'line'`）為第一個參數，各自的部分只有 `OAuthProvider`（授權網址、換 token、`identify` 檢查 ID token）；下面以 Google 說明，路由、cookie、流程前綴把 `google` 換成 `line` 就是 LINE 的。社長 2026-11-02 定案的設計是「Google 是綁在既有帳號上的**另一種登入方式**」。帳號名稱與顯示名稱永遠不因 Google 改變；Google 的 Email 與頭像不給其他社員看（頭像根本不存）。`GOOGLE_CLIENT_ID`＋`GOOGLE_CLIENT_SECRET`（兩個 Worker secret）**都設**才開，否則 `Me.google` 不送、所有 Google 路由回 503 `googleOff`；PR 預覽不設，所以預覽站沒有 Google 登入。
  - **流程**（OpenID Connect 授權碼流程，全部在伺服器）：頁面 `POST /api/auth/google/start { origin, returnTo }` → 社團新增一筆 `google:<state>`（`step: 'start'`：PKCE verifier、nonce、redirect URI、回去的路徑，10 分鐘）並設 HttpOnly cookie `tbt_google=<state>`（`Path=/api/`、`SameSite=Lax`），回 Google 的網址（`scope=openid email profile`、`state`、`nonce`、`code_challenge`（S256）、`prompt=select_account`），頁面用 `location.assign` 過去。Google 帶 `code`、`state` 回 `GET /api/auth/google/callback`：**cookie 要等於 `state`**（流程屬於開始它的瀏覽器，擋登入 CSRF），那筆紀錄用一次就刪；社團的 Durable Object 拿 code＋client secret＋verifier 去 Google 的 token endpoint 換 ID token，檢查 `iss`（`accounts.google.com`）、`aud`（＝client id，多個時 `azp` 也要是）、`exp`、`iat`、`nonce`、`email_verified`（`checkIdToken`），**用 `sub` 找帳號，從不用 Email**。結果用 302 轉回同一個網站的相對路徑（`oauthRedirect`），錯誤用 `?google=error&code=<訊息代碼>` 帶回去給頁面翻譯。
  - **為什麼不驗 ID token 的簽章**：OpenID Connect Core §3.1.3.7 第 6 點允許「直接從 token endpoint 經 TLS 拿到的 ID token」以 TLS 驗證伺服器身分代替簽章檢查。請求是我們自己發的、對象是 Google 固定的網址、帶 client secret，回應不可能被別人換掉；所以不抓 JWKS、不做 RSA 驗證，也省掉快取 JWKS 的狀態。整個交換在社團的 Durable Object 裡（不是 Worker 每次請求 10 ms CPU 的那一段），只是一次 fetch 加一次 base64／JSON 解析。
  - **哪個網站**：頁面送自己的 `location.origin`，只接受這個 Worker 自己的網址（淡江牌桌、staging）或淡江橋館的 `BOOK_SITE`（`oauthSite`；Worker 在 localhost 時，任何 localhost 埠也可以，給橋館的開發伺服器）。redirect URI 就是那個網站的 `/api/auth/google/callback`：橋館的 `/api/*` 經 Vercel 轉來，cookie 因此留在橋館自己的網域，跟密碼登入一樣「同一批帳號、各自的登入」。回去的路徑（`returnTo`）只能是同一個網站的路徑（`safeReturn`：`/` 開頭、不是 `//`、沒有反斜線）。不是這兩個網站（例如橋館的 Vercel 預覽）回 403 `googleOff`。
  - **登入**：`sub` 綁在某個帳號 → 那個帳號的 session（cookie 與密碼登入相同：`tbt_session`、通行證、`tbt_device`）。**有兩步驟登入的帳號（管理員一定有）Google 不能取代第二步**：callback 改存一筆 `step: 'code'`（只有 `userId`，5 分鐘）、cookie 換成它，轉到 `/?google=code`（橋館 `/login?google=code`）；頁面只顯示驗證碼欄位，`POST /api/auth/google/code { code, lang }` 走跟密碼登入同一個 `secondStep`（沒帶 → `twoFactorNeeded`、錯 → `twoFactorWrong`，算進同一個帳號 5 次與 IP 的失敗次數，鎖住寄通知信），對了才發 session 並回 `{ user, returnTo }`。等待中的紀錄留到對或過期，讓人可以重打；用掉就刪。沒開兩步驟登入的管理員（`adminTwoFactorRequired`）跟密碼登入一樣能登入、不能用管理功能。
  - **沒有帳號的 Google**：牌桌轉到 `/?google=apply`，存一筆 `step: 'apply'`（`sub`、Email、Google 的名字，30 分鐘）；頁面 `GET /api/auth/google/pending` 拿到 `{ step: 'apply', name }`，只拿 Google 的名字**預先填入顯示名稱**（可改，截到 16 字）。申請表跟一般申請一樣要**帳號名稱、密碼、邀請碼**，Turnstile 與同 IP 次數照舊，`POST /api/register` 多帶 `google: true` 與 `displayName`；`StoredApplication.google { sub, email }` 與 `displayName` 在 `adminApprove` 時變成 `StoredUser.google` 與個人檔案的顯示名稱（那時若同一個 Google 已被別的帳號綁走就不綁）。**用 Google 申請也要設密碼**：解除綁定時一定還有密碼可以登入。同一個 Google 已經綁了帳號或還有等待中的申請 → `googleTaken`；用 Google 登入還在等的申請 → `awaitingApproval`。橋館沒有申請表的這條路：沒綁的 Google 在橋館回 `googleNotLinked`（請用密碼登入後到牌桌的「我的帳號」綁定，新社員到牌桌申請）。
  - **綁定與解除**（「我的帳號」的 `OAuthCard provider="google"`）：`POST /api/account/google/link { password, origin }` **先驗密碼**（session 被別人拿到也加不了登入方式），已經綁了回 `googleLinked`，然後同一個流程去 Google；callback 時同一個瀏覽器**還要是同一個人登入著**，`sub` 已綁別人（或在申請裡）回 `googleTaken`，成功轉到 `/account?google=linked`。`POST /api/account/google/unlink { password }` 刪掉綁定，密碼照樣能登入。`Me.google` 是 `{ email, linkedAt } | null`（只有本人看得到）；`AdminUser`、個人檔案、大廳都沒有。
  - **儲存**：`StoredUser.google { sub, email, linkedAt }`（Email 是綁定當時 Google 給的，只顯示給本人辨認是哪個 Google 帳號）；流程在 `google:<id>`（`OAuthFlows`，每次新增時清掉過期的，每個登入方式最多 500 筆同時存在；同一個 IP 一分鐘 1 次（可連續 10 次，Google 與 LINE 合計），超過回 `slowDown`），不在備份裡。匯出資料的 `account.google` 有 `sub`、Email 與綁定時間；刪除帳號（`removeMember`）連同 `user:<id>` 一起刪掉。日誌 `oauthSignIn`、`oauthLinked`、`oauthUnlinked`、`oauthFailed`（都帶 `provider`；`reason`：`state`、`denied`、`exchange`、`token`、`session`、`taken`、`unknown`…，不記帳號與 Email）。
  - **多個社團**：callback 沒有 `X-Club-Id`，一定到淡江的物件，所以只有淡江的物件拿到 Google（`club.ts`），別的社團沒有 Google 登入（`googleOff`）；開放多社團（`e12`）時再把社團帶進 redirect URI 或 state。LINE 也一樣。
  - **按鈕**（`components/SignInButtons.tsx`，DESIGN.md §7.11）：登入頁、申請表與「我的帳號」的 Google 按鈕照 Google 的品牌規範（白底灰框、四色「G」、「使用 Google 帳戶登入」），LINE 的照 LINE 的按鈕規範（LINE 綠、白色 LINE logo、「用 LINE 登入」）；logo 是頁面裡的 SVG，CSP 不用改。
- **LINE 登入**（`e1-t32`，AC-1.9；`worker/line.ts`，DEPLOY.md §4.18）：跟 Google 同一套設計與流程（上一段）：綁在既有帳號、綁定與解除要密碼、用 LINE 申請仍要帳號名稱、密碼、邀請碼與核准、兩步驟登入照樣要驗證碼、只回本站與橋館、橋館只能登入（沒綁的回 `lineNotLinked`）、只有淡江的物件有。`LINE_CHANNEL_ID`＋`LINE_CHANNEL_SECRET` **都設**才開，否則 `Me.line` 不送、所有 LINE 路由回 `lineOff`；PR 預覽沒有。
  - **LINE Login v2.1**：`GET https://access.line.me/oauth2/v2.1/authorize`（`response_type=code`、`scope=openid profile`、`state`、`nonce`、`code_challenge`（S256）），callback `GET /api/auth/line/callback`，cookie `tbt_line`，流程 `line:<id>`。**不要 `email` scope**（要 LINE 審核，也用不到）。code 在社團物件裡帶 Channel secret 與 PKCE verifier 到 `https://api.line.me/oauth2/v2.1/token` 換 ID token。
  - **ID token**：LINE 網頁登入的 ID token 是 HS256、以 Channel secret 簽章；雖然跟 Google 一樣是直接從 token endpoint 經 TLS 拿到的，仍**驗簽章**（`verifyHs256`：header 一定要 `HS256`，`none` 或 ES256 都不收；一次 HMAC，CPU 很少），再檢查 `iss`＝`https://access.line.me`、`aud`＝Channel ID（只能一個）、`exp`、`iat`、`nonce`（`checkLineIdToken`）。**用 `sub`（LINE 的 user id）找帳號**；LINE 的名字截到 100 字，只用來預先填入申請表的顯示名稱，與給本人辨認綁的是哪個 LINE。
  - **儲存**：`StoredUser.line { sub, name, linkedAt }`（`name` 是綁定當時的 LINE 名字，只顯示給本人）、`StoredApplication.line { sub, name }`；`Me.line` 是 `{ name, linkedAt } | null`。一個帳號可以同時綁 Google 與 LINE，各自解除。匯出資料的 `account.line`；刪除帳號一起刪。頁面回來的參數是 `?line=code|apply|linked|error&code=…`。
- **權限**：`StoredUser.permissions`：`bookEdit`（線上編輯：草稿、送審）、`bookReview`（審核發布：發布、退回、隱藏、還原；橋館 e8-t01。審核者一定也是編輯者：存權限時 `withImpliedPermissions` 自動補上 `bookEdit`）、`bookImport`（匯入檔案）、`boardCurate`（設精選牌局，牌桌用，§5.9）、`tkuSystem`（淡江制度機器人，牌桌用，§5.1.2）、`forumModerate`（淡江橋館討論區的幹部：發公告、置頂、鎖定、刪別人的貼文與留言、處理檢舉；橋館 e11-t09）；管理員全部都有，管理頁的「權限」欄逐項勾選。淡江橋譜的 `/api/me` 也會看到 `boardCurate`、`tkuSystem`，橋譜不用它們。
- **角色**（使用者決定，2026-10-25；名稱暫時沿用）：**管理員**什麼都能管，包括使用者帳號；**編輯者**（`bookEdit`）能管帳號以外的所有東西。帳號＝申請與核准、新增與刪除帳號、重設密碼、管理員身分、權限、社團設定（人數上限、邀請碼，管的是誰能加入），只限管理員；橋譜的特約（草稿、送審、版本）、分類、制度集，以及關閉卡住的牌桌，編輯者都能做；**發布特約（含直接發布）、退回草稿、隱藏、還原是審核者（`bookReview`）的**（橋館 e8-t01，2026-10-28 起；之前編輯者按儲存就上線）。`bookImport`（AI 匯入，花 API 額度）與 `boardCurate` 仍是各自勾選的權限，`bookEdit` 不包含它們。每條路由要什麼寫在 `worker/roles.ts`（`bookRouteNeed`、`adminRouteNeed`；`tests/worker/roles.test.ts` 列出每條路由），`club.ts` 先查表再分派。牌桌管理頁目前仍只給管理員開（編輯者能用 `DELETE /api/admin/tables/:id`，但畫面還沒開給他們）。隊伍與搭檔的制度集另有成員權限（`profileAccess`，e2-t04，見下方「制度集的成員權限」）：隊長、隊員、搭檔不必是編輯者也能改自己的。

**橋譜 API**（`worker/book.ts` 的 `BookService`；讀取路由在 `book.ts` 的 `publicBookResponse`，其他在 `club.ts` 的 `bookApi`）。**2026-10-29 起橋館全站要登入**，原本「不用登入」的讀取（下表標「社員」的 GET：內容、manifest、分類、名詞、文章、電子書、制度集、修題、學習路徑）都要登入，未登入回 401 `signInFirst`；只剩分享中的制度卡版本、簽名網址的檔案、健康檢查、錯誤回報與登入相關路由不用登入。文章與電子書的 `members-only` 因此和其他授權沒有差別（型別與檢查保留）：

**線上版本缺中繼欄位時沿用內建**（`withBuiltinMeta`、`INHERITED_META`，`worker/book.ts`）：A3（橋館 #15）與 e3-t12 之前存的線上版本沒有 `kind`、`level`、`prerequisites`、`cardSlots`、`brownSticker`。讀線上版本的地方（`/api/book/content`、`/content/:slug`、`/manifest` 的 `meta`、`/export`）一律由 `BookService.readable` 補上**同 slug 內建特約**有、線上版本沒有的這幾個欄位；線上版本有的照原樣，`sections`、名稱、摘要等原文一律不動，儲存的資料（版本紀錄）也不改。橋館的編輯器打開時就拿到補好的值，下次存檔便寫進去。之後再加中繼欄位要加進 `INHERITED_META`。

| 路由 | 權限 | 說明 |
| --- | --- | --- |
| `GET /api/book/content` | 社員 | 所有線上修改 `{ version, entries }`，帶 ETag `W/"book-<version>"`（舊版橋譜用，保留不變） |
| `GET /api/book/manifest` | 社員 | `{ version, entries: BookEntrySummary[], categories, builtin: ConventionMeta[] }`（`builtin` 是內建特約，依目錄順序，L0）：每個線上版本去掉內容，`meta` 是特約的欄位（沒有 `sections`）加上 `outline`（段落 id／標題／子段落）與 `pending`（待確認，與橋譜 `pendingNotes()` 同順序）；隱藏的特約 `meta: null`；`categories` 同 `GET /api/book/categories` 的清單。ETag `W/"book-manifest-<version>"` |
| `GET /api/book/categories` | 社員 | `{ version, categories: BookCategory[], updatedAt?, updatedBy? }`，依 `order` 排；空清單表示沒在線上改過，橋譜用內建的分類。ETag `W/"book-categories-<version>"` |
| `PUT /api/book/categories` | bookEdit | `{ categories: { id, label, description? }[], baseVersion }`：整份取代（新增、改名、排序、刪除一次存），`order` 依清單位置；最多 20 個，代號小寫英數與連字號、不可重複。`baseVersion` 不符回 409 `categoryConflict`；拿掉的分類裡還有線上特約時回 409 `categoryInUse`（內建特約只有橋譜知道，由橋譜檢查） |
| `GET /api/book/glossary` | 社員 | 橋館的名詞表（e4-t05）：`{ version, terms: { term, aliases, definition, see? }[], updatedAt?, updatedBy? }`；version 0 的空清單表示沒在線上改過，橋館用內建的。存在 `book:glossary`（標頭）＋`bookpart:glossary:<i>`（`worker/glossary.ts`），不快取。ETag `W/"book-glossary-<version>"` |
| `PUT /api/book/glossary` | bookEdit | `{ terms, baseVersion }`：整份取代（e4-t07）；最多 500 條，名詞與別名不分大小寫不可重複，解釋 1–1000 字，`see` 是特約 slug。`baseVersion` 不符回 409 `glossaryConflict`；記稽核 `book:glossary` |
| `GET /api/book/builtin/:slug` | 社員 | 內建特約（L0）`{ convention }`，原樣回傳寫入時的內容；沒有回 404 `conventionGone`。ETag `W/"builtin-<slug>-<內建版本>"` |
| `GET /api/book/builtin` | 社員；或種子權杖 | 全部內建特約（依目錄順序的清單），給橋館的 `seed-builtin.ts --verify` 逐字比對。ETag `W/"builtin-<內建版本>"` |
| `GET /api/book/search-index` | 社員；或種子權杖 | 內建特約的搜尋索引（橋館建好、寫入時一起送來，Worker 不解讀）；還沒寫入過回 404。ETag `W/"builtin-index-<內建版本>"` |
| `PUT /api/book/builtin` | 管理員；或種子權杖（`Authorization: Bearer <BOOK_SEED_TOKEN>`，`worker/book-seed.ts`） | 寫入內建特約：`{ conventions, searchIndex, dryRun?, allowRemove? }`。**預設是預演**（`dryRun: false` 才寫）；回 `BuiltinSeedReport`：每個特約 `new`／`changed`／`same`／`removed`、有沒有線上版本（`online`，讀者看到的是線上版本）、順序與索引有沒有變。整份取代，每個特約照發布時的規則檢查形狀；會移除內建特約時要 `allowRemove: true`。**不動線上版本**（`book:entry:`）。有變動時 `book:version` 加一（所有橋館重新抓 manifest），記稽核 `book:builtin` |
| `POST /api/book/errors` | 不用登入，**不讀登入身分** | 淡江橋館的瀏覽器錯誤（e10-t06，§5.15）：`{ kind: 'error' \| 'rejection' \| 'boundary', message, source?, stack?, page?, version? }`；不是 JSON 物件、`kind` 不對、沒有 `message`、超過 8,192 字元回 400（本文超過 4 倍邊讀邊算就停，`worker/body.ts`）。回 204（被限流時也一樣，靜默丟掉） |
| `GET /api/book/errors` | bookEdit | `{ errors: BookClientError[] }`：新→舊，最多 100 列 |
| `DELETE /api/book/errors` | bookEdit | 清空錯誤回報，回 204 |
| `POST /api/book/events` | 不用登入，**不讀登入身分** | 淡江橋館的匿名使用事件（e10-t07，§5.15）：`BookAnalyticsBatch` `{ visitor, events }`，`visitor` 16–64 個 `[A-Za-z0-9_-]`、`events` 1–50 筆、本文 ≤ 16,384 字元，否則 400；不合規的事件個別丟掉。回 204（統計關閉或被限流時整批丟掉，也回 204） |
| `GET /api/book/analytics` | bookEdit | `BookAnalyticsView`：最近 12 週的不重複訪客與頁面數、最近 28 天的熱門特約與搜尋（各 ≤ 20）、切換制度集次數、練習作答與答對 |
| `PUT /api/book/analytics/settings` | 管理員 | `{ enabled: boolean }` 開關使用統計（預設開），回 `BookAnalyticsView`；格式不對回 400 |
| `GET /api/book/export` | 管理員；或匯出權杖（`Authorization: Bearer <BOOK_EXPORT_TOKEN>`，只讀這一條） | 橋館的匯出備份（L1，`e8-t12`）：社員讀到的全部特約 `BookExport` `{ format: 1, exportedAt, version, builtinVersion, conventions, hidden, categories }`。`conventions` 依目錄順序：內建特約（有線上版本就換成線上版本，`source: 'online'`）、再接只有線上版本的新特約（舊→新）；每筆帶 `builtin`（有沒有內建層）與線上版本的 `online: { version, updatedAt, updatedBy, bundledUpdated? }`。被線上隱藏的放 `hidden`。`categories` 是線上改過的分類（沒改過是空的）。不含草稿。`Cache-Control: no-store` |
| `GET /api/book/content/:slug` | 社員 | `{ entry: BookEntry }`（隱藏時 `convention: null`）；沒有線上版本回 404 `conventionGone`，橋譜改用內建的版本。ETag `W/"book-<slug>-<entry.version>"` |
| `PUT /api/book/conventions/:slug` | bookReview | 發布：`{ convention, baseVersion, bundledUpdated?, note?, draftRevision? }`；`baseVersion` 不是目前版本時回 409 `bookConflict`。有草稿時帶 `draftRevision`＝從草稿發布（草稿用掉，送審者記在版本上；不符回 409 `bookDraftConflict`）；不帶就保留草稿。版本記 `status: 'published'`、`reviewedBy/At`、`reviewRequestedBy/At`。**沒有 `status` 的舊資料也是已發布** |
| `GET /api/book/conventions/:slug/draft` | bookEdit | `{ draft: BookDraft \| null }` |
| `PUT /api/book/conventions/:slug/draft` | bookEdit | 存草稿：`{ convention, baseVersion, draftRevision, bundledUpdated?, note?, submit? }`；第一次存檢查 `baseVersion`（同發布），之後檢查 `draftRevision`（不符 409 `bookDraftConflict`）。`submit: true` 送審（`in-review`），否則是 `draft`（送審中的再存一次就撤回）。退回的理由保留到再送審 |
| `DELETE /api/book/conventions/:slug/draft` | bookEdit | `{ draftRevision }` 捨棄草稿；沒有草稿 404 `bookDraftGone` |
| `POST /api/book/conventions/:slug/reject` | bookReview | `{ draftRevision, note }` 退回送審中的草稿（不是送審中 409 `notInReview`），理由最多 500 字 |
| `GET /api/book/reviews` | bookEdit | `{ drafts: BookDraftSummary[], articles: ArticleDraftSummary[] }`：所有特約與文章的草稿（送審中的在前），不含內容、附特約名或文章標題 |
| `GET /api/book/audit` | bookEdit | `{ entries: AuditEntry[] }`：最近 200 筆審計紀錄（新的在前）：草稿、送審、退回、捨棄、發布、隱藏、還原、分類、制度集新增／儲存／刪除；發布、隱藏、還原帶 `revisionId` 連到版本 |
| `GET /api/book/pending` | 社員 | `{ open: PendingMeta[], closed: PendingMeta[], editors: string[] }`：待確認面板（橋館 e8-t06）。`open` 是有人動過的待確認（`pendingmeta:<slug>/<sectionId>/<n>`；沒有紀錄的是「未處理」），`closed` 是最近 100 筆已關閉（`pendingdone:<時間>-<id>`），`editors` 是有 bookEdit 的帳號（指派用） |
| `PUT /api/book/pending/:slug/:sectionId/:n` | bookEdit | body `{ text, status: 'open'\|'working'\|'parked', assignee?, note?, resolution? }` → `{ meta }`。`已確認`不能手動設：發布（`PUT /api/book/conventions/:slug`）時，新版本裡找不到的待確認（以段落＋原文比對）自動關閉，記發布者、版本、關閉依據（沒填就用版本說明）；還在的跟著換位置 |
| `POST /api/book/conventions/:slug/reset` | bookReview | 刪除線上版本，橋譜改回顯示內建的版本 |
| `POST /api/book/conventions/:slug/hide` | bookReview | 從橋譜隱藏 |
| `GET /api/book/conventions/:slug/revisions[/:id]` | bookEdit | 版本紀錄（新的在前）與某一版的內容 |
| `GET /api/book/articles` | 社員 | 叢書的文章（橋館 e5-t04）：`{ version, entries: ArticleEntrySummary[], files, series }`，不含內容區塊；`files` 是封面的簽名網址（沒有 R2 bucket 時是空的）；`series` 是線上編過的系列（e5-t06，沒編過是空清單）。`?text=1` 多回 `text`：每篇的摘要與區塊文字（每篇最多 2 萬字，給橋館搜尋，e5-t13）。未登入看不到 `members-only`，只有 bookEdit 看得到隱藏的 |
| `GET /api/book/articles/:slug` | 社員 | `{ entry: ArticleEntry, files }`：一篇文章與它的封面、圖片的簽名網址；看不到的回 404 `articleGone` |
| `PUT /api/book/articles/:slug` | bookReview | 發布：`{ article, baseVersion, note? }`；`baseVersion` 不是目前版本時回 409 `articleConflict`；帶 `draftRevision` 是發布草稿（草稿被改過回 409 `bookDraftConflict`），發布後草稿刪除、版本記下送審的人 |
| `POST /api/book/articles/:slug/hide` | bookReview | `{ baseVersion, note? }` 從叢書隱藏（版本紀錄保留） |
| `GET /api/book/articles/:slug/revisions[/:id]` | bookEdit | 文章的版本紀錄與某一版的內容 |
| `GET/PUT/DELETE /api/book/articles/:slug/draft` | bookEdit | 文章的草稿（e5-t07，同特約草稿）：`PUT { article, baseVersion, draftRevision, note?, submit? }`，`submit: true` 送審；`DELETE { draftRevision }` 捨棄；沒有草稿 404 `articleDraftGone`；審計 `article:draft`／`article:submit`／`article:discard` |
| `POST /api/book/articles/:slug/reject` | bookReview | `{ draftRevision, note }` 把送審中的草稿退回（審計 `article:reject`） |
| `GET /api/book/ebooks` | 社員 | 叢書的電子書（橋館 e5-t09、e5-t11）：`{ ebooks, files, usage? }`；`files` 是封面的簽名網址；未登入看不到 `members-only`；bookEdit 多拿到 `usage`（R2 用量，e5-t15） |
| `GET /api/book/ebooks/:id` | 社員 | `{ ebook, files }`：一本書與它封面、PDF 的簽名網址（PDF 的 15 分鐘失效）；看不到的回 404 `ebookGone` |
| `POST /api/book/ebooks/ticket` | bookReview | `{ size }` → PDF 的一次性上傳憑證（≤ 50 MB，§5.14） |
| `POST /api/book/ebooks` | bookReview | 新增一本書：`EbookInput`（授權必填，`fileKey` 要是剛上傳的 PDF） |
| `PUT /api/book/ebooks/:id`、`DELETE /api/book/ebooks/:id` | bookReview | 修改（換 PDF 時刪舊檔）、下架（連 PDF 一起刪） |
| `PUT /api/book/series` | bookEdit | 整份系列一次存（e5-t06）：`{ series: { id, label, description }[], baseVersion }`；版本不符 409 `seriesConflict`；拿掉的系列裡還有文章 409 `seriesInUse`；審計 `article:series` |
| `GET /api/book/profiles` | 社員 | `{ profiles: ProfileSummary[] }`：每個制度集去掉內容、只留數量（`counts`），`club` 在前、再來隊伍、搭檔，各依名稱。未登入只回 `club`（備忘數為 0）；登入後只列自己看得到的（下面「制度集的成員權限」），看不到備忘的備忘數為 0 |
| `GET /api/book/profiles/:id` | 社員 | `{ profile: SystemProfile, access: ProfileAccess }`（`access` 是自己能做什麼：`notes`、`edit`、`share`）；`club` 沒存過時回空的（版本 0）；未登入讀 `club` 時只回 `{ profile }` 並拿掉 `notes`，讀其他的回 401；看不到的回 403 `noPermission`，看不到備忘時 `notes` 是空的；不存在回 404 `profileGone` |
| `POST /api/book/profiles` | bookEdit | `{ profile: ProfileInput, note? }` 新增隊伍或搭檔的制度集，id 由伺服器產生（12 碼 hex），版本 1 |
| `PUT /api/book/profiles/:id` | 能編輯的人（下面） | `{ profile: ProfileInput, baseVersion, note? }`；`baseVersion` 不符回 409 `profileConflict`。`club` 第一次存時 `baseVersion` 是 0。編輯者以外的人改 `scope`、`parentId`，或沒有 `share` 卻改 `visibility`，回 403 `noPermission` |
| `DELETE /api/book/profiles/:id` | bookEdit | `{ baseVersion }`；`club` 回 403 `profileProtected`，還有別的制度集繼承它時回 409 `profileInUse`；版本紀錄一起刪 |
| `GET /api/book/profiles/:id/revisions[/:version]` | bookEdit／隊伍或搭檔的成員 | 版本紀錄（新的在前，最多 100 筆，不含內容）與某一版的完整制度集 |
| `GET /api/book/cards/:profileId` | 讀得到該制度集的人 | `{ snapshots: CardSnapshotMeta[] }`：這個制度集各版型的制度卡版本，新的在前（橋館 e3-t09） |
| `POST /api/book/cards/:profileId` | 能編輯該制度集的人 | `CardSnapshotInput`（`templateId`、`profileVersion`、`card`、`docx?` base64、`note?`）發布一個版本，同制度集同版型從 1 編號；卡 JSON 最多 800 kB、Word 檔 600 kB（413 `contentTooLarge`），每個制度集最多 200 個版本。回 `{ snapshot: CardSnapshotMeta }`，記一筆 `card:publish` 審計 |
| `GET /api/book/cards/:profileId/:templateId/:n[/docx]` | 讀得到該制度集的人；**分享中的版本不用登入** | `{ snapshot: CardSnapshot }`，或 Word 檔本身（`/docx`，`Content-Disposition: attachment`）；不存在或沒有 Word 檔回 404 `cardSnapshotGone`。分享中的版本在登入檢查之前就回，連結關掉後只有讀得到制度集的人看得到 |
| `PATCH /api/book/cards/:profileId/:templateId/:n` | 有 `share` 權限的人（編輯者、隊長、現役搭檔） | `{ shared: boolean }` 開關分享連結，回 `{ snapshot }` |
| `DELETE /api/book/cards/:profileId/:templateId/:n` | 能編輯該制度集的人 | 刪掉這個版本（含 Word 檔），記一筆 `card:delete` 審計 |
| `POST /api/book/card-pdf` | 社員 | `CardPdfRequest`（`html` ≤ 1.9 MB、`paper`、`name?`）→ `application/pdf`：橋館制度卡頁的列印版面用 Browser Run 印成 A4 PDF（橋館 e3-t13，`worker/card-pdf.ts`；不跑 JS、擋掉所有 http(s) 請求）。每人一次 5 份、之後每 2 分鐘 1 份，全社每天 8 分鐘瀏覽器時間，同內容一小時內回記憶體的結果；沒有 `BROWSER` 綁定或失敗回 503 `cardPdfOff`，額度用完 429 `cardPdfBusy`，橋館都退回瀏覽器列印（DEPLOY.md §4.11） |
| `GET /api/book/system-spec?profileId=` | bookEdit | `SystemSpecStatus`：`{ tableProfileId, synced }`，`synced` 是該制度集最後同步的 `SystemSpec`（`shared/systemSpec.ts`）、時間與同步者，沒同步過是 `null`；沒給 `profileId` 時是 TKB 跟著的制度集（橋館 e7-t03） |
| `PUT /api/book/system-spec/:profileId` | bookEdit | `{ spec: SystemSpec }`：橋館的差異報告頁用 `toSystemSpec` 在瀏覽器轉好送來（內建特約只在橋館、轉換的 CPU 一次請求不夠），這裡只檢查形狀（`worker/system-spec.ts`）、`spec.profileId` 要等於網址、JSON 最多 1 MB（413 `contentTooLarge`）；制度集不存在回 404 `profileGone`。存在 `book:spec:<id>`（本體分段），每日備份一起備。回同 GET |
| `POST /api/book/robot-meanings` | bookEdit | `RobotMeaningsQuery`（`{ items: { after, calls }[] }`，一次最多 10 個叫牌過程、每個 38 個叫品）→ `{ items }`：TKB 淡江制度的規則說每個叫品表示什麼（`explain`，只看叫牌過程；`RobotShows` 是橋館啟發式讀得到的欄位加中文說明），沒有規則是 `null`。差異報告頁分批問（橋館 e7-t04） |
| `GET /api/book/quiz/rounds` | 社員 | `{ rounds: QuizRound[] }`（`shared/quiz.ts`）：自己的練習成績，新的在前（橋館 e6-t04） |
| `POST /api/book/quiz/rounds` | 社員 | `{ round: QuizRoundInput }`（制度集 id、每題的 id、特約、對錯；一次 1–50 題）→ `{ round }`；存在 `quizlog:<userId>:<時間>-<id>`，每人只留最新 100 次 |
| `DELETE /api/book/quiz/rounds` | 社員 | 清除自己的練習成績 → `{ ok }` |
| `GET /api/book/quiz/fixes` | 社員 | `{ fixes: QuizFix[] }`：幹部的修題（停用、改答案或選項、手動出題），練習頁出題時套用（橋館 e6-t06） |
| `PUT /api/book/quiz/fixes` | bookEdit | `{ fix: QuizFixInput }` → `{ fix }`：`source: 'auto'` 修自動題（`basis` 是修正時的叫品與正解，原文改了橋館就不套用）、`'manual'` 手動出題（意義題或含 `hand` 的叫品題）；只檢查形狀，最多 2000 筆。存在 `book:quizfix:<題目 id>`（每日備份一起備），寫審計 `quiz:fix` |
| `DELETE /api/book/quiz/fixes` | bookEdit | `{ id }` → `{ ok }`：刪掉修正（題目回到自動產生的樣子）或手動題；審計 `quiz:unfix` |
| `GET /api/book/paths` | 社員 | `{ paths: SavedLearningPath[] }`（`shared/learning.ts`）：幹部改過的學習路徑，橋館用來取代同 id 的內建路徑（橋館 e4-t08） |
| `PUT /api/book/paths` | bookEdit | `{ path: LearningPath }` → `{ path }`：存一條路徑（id 不能是 `edit`，1–40 課）；只檢查形狀，最多 20 條；審計 `path:save`（橋館 e4-t12） |
| `DELETE /api/book/paths` | bookEdit | `{ id }` → `{ ok }`：刪掉線上版本，回到橋館內建的路徑；審計 `path:reset` |
| `GET /api/book/paths/progress` | 社員 | `{ progress: PathProgress[] }`：自己每條路徑完成的課次（橋館 e4-t11） |
| `PUT /api/book/paths/progress` | 社員 | `{ progress: { pathId, lessonId, done } }` → `{ progress }`：標記一課完成或取消 |
| `GET /api/book/reading` | 社員 | `{ places: ReadingPlace[] }`：自己在文章與電子書讀到哪裡，新的在前（橋館 e5-t14） |
| `PUT /api/book/reading` | 社員 | `{ reading: { kind: 'article'｜'ebook', id, title, place, of } }` → `{ place }`：記下讀到的段落（文章，從 0 起）或頁碼（電子書，從 1 起）；同一篇移到最前 |
| `DELETE /api/book/reading` | 社員 | `{ kind, id }` → `{ ok }`：從「繼續閱讀」拿掉一篇 |
| `GET /api/club/members` | 社員 | `{ members: ClubMember[] }`：全部社員的 id 與帳號名稱（只有這兩個欄位），依名稱；選隊員、邀搭檔用 |
| `GET /api/club/members/:id/teams` | 社員 | `MemberTeams`：那位社員所在的隊伍（含封存）與現役搭檔；邀請中、已結束的不列。橋館他人檔案頁 `/u/:id` 用（`e11-t04`） |
| `GET /api/forum/boards` | 社員 | `{ boards: Board[] }`，依 `order` |
| `POST /api/forum/boards`、`PATCH`／`DELETE /api/forum/boards/:id` | 管理員 | `BoardInput`；代號小寫英數與 `-`（不給就產生），重複 409 `forumBoardExists`，最多 20 個（409 `forumBoardLimit`）；內建的不能刪（409 `forumBoardBuiltIn`）、有貼文的不能刪（409 `forumBoardNotEmpty`）；不存在 404 `forumBoardGone` |
| `GET /api/forum/boards/:id/posts?page=` | 社員 | `BoardPage`：第 1 頁先列置頂（新置頂的在前），其他新→舊，一頁 20 則 |
| `POST /api/forum/boards/:id/posts` | 社員（公告板只有幹部，403 `forumBoardOfficersOnly`） | `PostInput` → `{ post }`；每人每分鐘發文加留言 ≤ 5（429 `slowDown`） |
| `GET /api/forum/feed?page=` | 社員 | `ForumFeed`：所有板面的貼文新→舊，一頁 20 則，不另列置頂（橋館討論區首頁 `/forum`，e11-t15） |
| `GET /api/forum/feed?page=&author=` | 社員 | 同上，只列那位社員發的貼文（橋館「我的貼文」，e11-t10） |
| `GET /api/forum/feed?page=&mentions=` | 社員 | 同上，只列貼文或其留言 `@` 提到那位社員的（橋館「我提到的」） |
| `GET /api/forum/search?q=&page=&board=` | 社員 | `ForumSearch`：標題或文字區塊（段落、提示、條列）含每個詞（空白分開、最多 5 個、共 50 字；英文不分大小寫）的貼文，新→舊，一頁 20 則，多 `query`、`total`；留言、圖說、替代文字不搜。文字存在 `forum_posts.body_text`（舊貼文在 `createTables` 補）；`q` 空或太長回 400（e11-t10）；`board` 只搜那個板面（牌桌 e13-t11） |
| `GET /api/forum/latest` | 社員 | `ForumLatest`：公告板最新三則（置頂優先）與其他板最新三則（橋館首頁） |
| `GET`／`PATCH`／`DELETE /api/forum/posts/:id` | 社員；改只有作者；刪是作者或幹部 | `PostThread`（貼文與全部留言，舊→新）；`PostInput` → `{ post }`；別人的 403 `notYours`，不存在 404 `postGone` |
| `POST /api/forum/posts/:id/pin`、`/lock` | 幹部（`forumModerate`） | `{ pinned }`／`{ locked }` → `{ post }`；有變才寫審計、置頂通知作者 |
| `POST /api/forum/posts/:id/hide` | 幹部（`forumModerate`） | `{ hidden }` → `{ post }`；隱藏後只有作者與幹部看得到（其他人所有列表與搜尋都沒有、開了是 404 `postGone`），未處理的檢舉關成 `removed`；有變才寫審計 `forum:hide`／`unhide`（牌桌 e13-t10） |
| `POST /api/forum/posts/:id/comments` | 社員（鎖定的只有幹部，409 `postLocked`） | `CommentInput`（`parentId` 是回覆）→ `{ comment }` |
| `PATCH`／`DELETE /api/forum/comments/:id` | 改只有作者；刪是作者或幹部 | `{ blocks }` → `{ comment }`；不存在 404 `commentGone` |
| `PUT`／`DELETE /api/forum/posts/:id/reaction`、`/comments/:id/reaction` | 社員 | `{ emoji }`（五種之一）設定或換掉自己的反應、刪掉 → `{ reactions }` |
| `POST /api/forum/reports` | 社員 | `ReportInput` → `{ report }`；不能檢舉自己的（400），每人未處理 ≤ 20（409 `forumReportLimit`） |
| `GET /api/forum/reports?status=open\|all` | 幹部 | `{ reports: ReportItem[] }`，新→舊最多 100 則 |
| `POST /api/forum/reports/:id` | 幹部 | `ReportDecision`（`dismiss`／`remove`）→ `{ report }`；已處理 409 `forumReportHandled`，不存在 404 `forumReportGone`；寫審計 |
| `GET /api/club/teams` | 社員 | `{ teams: ClubTeam[] }`，封存的在後，各依名稱 |
| `POST /api/club/teams` | bookEdit | `TeamInput`（`name`、`captainId`、`memberIds?`，隊長自動算隊員）；同時開隊伍的制度集（繼承 `club`）。最多 8 人（409 `teamFull`）；制度集已達上限時整個不建立 |
| `GET /api/club/teams/:id` | 社員 | `{ team, pairs }`：隊伍與它現役的搭檔；不存在回 404 `teamGone` |
| `PATCH /api/club/teams/:id` | 隊長／bookEdit | `TeamPatch`：改名、換隊長（要是隊員）、開放隊員編輯隊伍制度集（`membersEdit`，e2-t10）、封存（`archived`）；封存後只能取消封存（409 `teamArchived`） |
| `POST /api/club/teams/:id/members`、`DELETE …/members/:userId` | 隊長／bookEdit；本人可退出 | `{ userId }` 加隊員；拿掉隊員（隊長要先換人才能離隊） |
| `GET /api/club/pairs` | 社員 | `{ pairs: Partnership[] }`：自己的搭檔與邀請（含已結束），新的在前 |
| `POST /api/club/pairs` | 社員 | `PairInvite`（`partnerId`、`teamId?`，兩人都要是那隊的隊員）邀請，通知對方 `pairInvited`。同兩人同隊伍已有邀請或現役搭檔時 409 `pairExists`；任一方等回覆加現役已有 10 個時 409 `pairLimit` |
| `GET /api/club/pairs/:id` | 社員 | `{ pair }`；不存在回 404 `pairGone` |
| `POST /api/club/pairs/:id/accept` | 受邀者 | 成立搭檔並開制度集（名稱「邀請者＋受邀者」，繼承隊伍的或 `club`），通知邀請者 `pairAccepted` |
| `POST /api/club/pairs/:id/decline` | 受邀者 | 刪掉邀請，通知邀請者 `pairDeclined` |
| `POST /api/club/pairs/:id/end` | 兩人之一 | 現役 → `ended`（制度集保留），通知另一位 `pairEnded`；等回覆時邀請者是收回（不通知）、受邀者是婉拒。已處理過的回 409 `pairAnswered` |
| `POST /api/book/import/ticket` | bookImport | 一次性憑證與上傳網址 |
| `POST /api/book/import` | 憑證 | multipart：`ticket`、`meta`、`file`（PDF）或 `text`；回應是 Claude 的 SSE 串流，CORS `*`。`meta.target: 'articles'`（e5-t08）改做叢書文章：`categories` 是系列、schema 是 `articleImportSchema`（逐字轉錄，多小標題、引文、牌例、出牌過程） |
| `GET/POST /api/book/drafts`、`GET/DELETE /api/book/drafts/:id` | bookImport | 匯入草稿（`result.conventions` 或文章的 `result.articles`，摘要多 `articles` 篇數） |

**制度集**（`worker/profiles.ts` 的 `ProfileService`，型別在 `shared/protocol.ts` 的 System profiles 區段，橋譜 `src/lib/api.ts` 對拍）：`checkProfileInput` 只留可編輯的欄位（`name`、`scope`、`parentId`、`adopted`、`overrides`、`notes`），id、版本、`updatedAt`、`updatedBy`（使用者 id）由伺服器填。層次固定：`club` 只有一個、不能改種類；隊伍繼承 `club`；搭檔繼承 `club` 或隊伍（沒給 `parentId` 就是 `club`），所以不會繞圈；有搭檔繼承的隊伍不能改成搭檔。上限 `PROFILE_LIMITS`：整份 JSON 200,000 bytes（UTF-8，超過 413 `contentTooLarge`）、覆寫 500 條、`club` 以外 100 個、名稱 40 字、每則備忘 2,000 字。整段覆寫的 `section` 用和特約一樣的 `checkSections` 檢查，且 `section.id` 要等於 `sectionId`；覆寫指到的段落、列存不存在由橋譜的 `resolveProfile` 回報。`visibility` 是可見範圍：沒有＝全社團，`members`＝只有成員（`club` 不能設）。新增與刪除要 `bookEdit`；讀、存、版本紀錄依下面的成員權限。

**隊伍與搭檔**（`worker/teams.ts` 的 `TeamService`，型別在 `shared/protocol.ts` 的 Teams and partnerships 區段，橋譜 `src/lib/api.ts` 對拍；隊伍型別叫 `ClubTeam`，因為 `Team` 已是隊制賽的 A／B 兩邊）：隊伍由編輯者建立，隊長與編輯者管（`roles.ts` 的 `managesTeam`）；搭檔由任一社員邀請，只有兩人能回覆或結束。隊伍建立時、搭檔接受時用 `ProfileService.createOwned` 開空的制度集（算在 100 個上限裡）。上限 `TEAM_LIMITS`：一隊 8 人、每人等回覆加現役的搭檔 10 個、隊名 40 字。不放在記憶體，備份還原後不用重載；四種鍵都在每日備份裡。還沒處理：帳號刪除時的隊伍與搭檔。

**制度集的成員權限**（e2-t04、e2-t10，AC-2.3；規則在 `roles.ts` 的 `profileAccess`，`TeamService` 用隊伍與搭檔的 `profileId` 找出制度集屬於誰，每次現查、不快取）：

| | 讀 | 看備忘 | 存（`edit`） | 改可見範圍（`share`） | 版本紀錄 |
| --- | --- | --- | --- | --- | --- |
| 編輯者（`bookEdit`）、管理員 | 全部 | 全部 | 全部 | 全部 | 全部 |
| `club` | 社員 | 社員 | — | — | — |
| 隊伍的：隊長 | ✓ | ✓ | ✓（封存後不行） | ✓（封存後不行） | ✓ |
| 隊伍的：隊員 | ✓ | ✓ | 隊長開了 `membersEdit` 才行（封存後不行） | — | ✓ |
| 搭檔的：兩人 | ✓ | ✓ | 現役時 | 現役時 | ✓ |
| 其他社員 | `visibility` 不是 `members` 時 | — | — | — | — |
| 沒有隊伍或搭檔擁有的（編輯者手動建的） | `visibility` 不是 `members` 時 | — | — | — | — |

母制度集看不到時，子制度集也看不到（橋譜要每一層才能顯示）。編輯者以外的人存檔時不能改 `scope`、`parentId`。

伺服器只檢查特約的**形狀**（`checkConvention`：必填欄位、段落 id 唯一、區塊種類），不管內容；橋譜載入時也會再檢查一次，壞掉的內容不會讓網站掛掉。

**AI 匯入**（`worker/importer.ts`）：用官方 SDK 呼叫 `claude-opus-5-5`（`max_tokens` 128K、effort medium、結構化輸出、伺服器端 refusal fallback）。PDF 用 Files API 上傳（Worker 不必自己做 base64，免費方案每次請求的 CPU 只有 10 ms），文字直接放進 document 區塊。回應用 `asResponse()` 原封不動串流回瀏覽器，Worker 不解析。上傳不經過 Vercel，因為 Vercel 轉發外部請求最多等 120 秒。結構化輸出不支援遞迴 schema，所以回覆是扁平的（段落用 `parentId`、條列用 `level`），**由橋譜的 `src/lib/importResult.ts` 組回樹狀，兩邊要一起改**。

## 5.1 機器人

機器人只有一個，叫 **TKB**，用淡江制度或 2/1（GIB 相容）叫牌；**沒有等級**（社長 2026-10-24，`ROBOT.md` §7）。座位裡的 id 若是 `robot:<制度>:<座位>` 這種格式就是機器人：`robot:gib:N` 是用 2/1 的 TKB，`robot:tku:N` 是用淡江制度的 TKB（`shared/protocol.ts` 的 `robotId`、`robotKindOf`）。制度放在 id 裡而不是牌桌狀態，是因為座位對調（`swapForDeclarer`／`unswap`）時 id 跟著機器人走、物件重新載入時跟著牌桌存檔回來、紀錄的玩家（`publicUserById`）也直接從 id 帶出 `robotKind`。**舊的 id 照讀**：`robot:N`（2/1 之前）讀成淡江制度；有等級時的 `robot:<制度>:<等級>:<座位>`（例如 `robot:tku:beginner:E`）只看制度，等級不管。存下來的牌桌設定（`TableSettings.robotLevel`）、挑戰設定（`settings.robotLevel`）與紀錄玩家的 `robotLevel` 載入時忽略（`settingsOf`、`ChallengeStore` 讀設定時丟掉）；新的訊息裡牌桌設定與挑戰設定帶 `robotLevel` 會像其他不認得的欄位一樣被拒絕（`badTableSettings`、`badChallengeSettings`），`addRobot` 多帶的 `level` 則跟其他訊息多帶的欄位一樣不理會。房主放機器人時選制度（`addRobot` 的 `kind`，沒寫就看房主：有 `tkuSystem` 是淡江制度，沒有是 2/1；只有有權限的人能選，§5.1.2），機器人照自己的種類叫牌（`shared/robot/robots.ts` 的 `robotCall`）；2/1 機器人的叫品除了繁中說明還存著叫品的意義（`AuctionCall.meaning`），瀏覽器依觀看者的語言顯示，規則檔需要時才載入。名牌與紀錄裡的機器人帶 `robotKind`：名牌顯示「TKB」加上制度的小標籤（淡江制度／2/1），紀錄顯示「TKB（2/1）」這樣的名字（`strings.ts` 的 `robotName`、`robotSystems`、`playerName`）。每次狀態改變後，`ClubService.scheduleRobots` 檢查是否輪到機器人（叫牌、出牌，或回應攤牌／撤回），經排程器（§5）排一個短暫延遲再執行：延遲看牌桌的**機器人出牌速度**（`shared/protocol.ts` 的 `ROBOT_PACE`；極快是叫牌 0.2 秒、出牌 0.4 秒、一墩結束後 1.0 秒、回答 0.15 秒，快與較慢見 DESIGN.md「節奏」，較慢是之前的 0.6／1.05／2.3／0.3 秒），配合瀏覽器同一速度的滑動（`src/lib/motion.ts` 的 `PACES`）。速度是社員自己的設定（社長 2026-10-27，`StoredUser.robotSpeed`，預設 `veryFast` 不存；`POST /api/account/preferences` 的 `robotSpeed`，只收 `ROBOT_SPEEDS`），俱樂部把它放在 `Person.robotSpeed` 交給牌桌（入座、觀看、回到挑戰、替補、隊制賽開桌時），在牌桌上改設定時馬上通知那一桌（`TableApi.robotSpeed`）；牌桌記在 `Table.speeds`（只記不是預設的），用**在座真人裡最慢的**（`slowestSpeed`），沒有人被催，觀看者不算，`TableView.robotSpeed` 告訴瀏覽器。最後一墩停留的時間（`lastTrick`）也跟著速度，執行完再排下一個；每張桌子同時最多一個機器人工作。機器人同意撤回；攤牌由對手方的機器人用雙夢家分析判斷（`shared/robot/claim.ts`，見 `ROBOT.md` §3.1）。物件重新載入時也會重新排程。至少要有一位真人在座，機器人才會行動；最後一位真人離開，桌子就關閉。

**真人不當機器人的夢家**：叫牌結束時若莊家是機器人、夢家是真人，`swapForDeclarer` 把兩人的座位對調（同 BBO），真人坐到莊家的位子主打，機器人帶著它的種類坐到原本的位子當夢家；對調記在 `Table.swapped`。若撤回最後一個 Pass 讓叫牌重新開始，`unswap` 換回來；下一副發牌時清掉記錄（座位維持對調後的樣子）。叫牌與出牌規則見 `ROBOT.md`。

**機器人的大腦**（`shared/robot/brain.ts`）：`ClubService` 只透過 `RobotBrain`（`bid`、`play`、`acceptsClaim`，都帶機器人用的制度）問機器人，預設是規則機器人 `ruleBrain`（TKB），測試或之後的 TKB Adv（伺服器 DDS）從 `ClubConfig.brain` 換進來。排程時只決定「哪個機器人、多久後動」（`robotMove`），輪到它時才問大腦（`decide`），所以每一步只想一次。

**非同步思考**（`e6-t11`）：大腦的回答可以是 `Promise`（`Answer<T>`）。`runRobot` 問之前先記下局面（`positionOf`：座位、撤回請求、第幾副、階段、叫品數、出牌數、攤牌），等回答時不擋別的訊息（Durable Object 等的不是儲存，其他請求照常進來）；這段時間這張桌子不再排別的機器人工作（`thinking`），排程器同時到期的工作也並排跑（`AlarmQueue.runDue` 用 `Promise.all`），一張桌子的機器人在想不會拖到別桌。回答回來時局面若已經變了（真人出了牌、撤回、有人換座位），這個回答**丟掉**，照新局面重新排程。**思考上限 2 秒**（`THINK_LIMIT_MS`，測試用 `ClubConfig.thinkLimitMs` 縮短）：大腦逾時、丟出錯誤或回傳失敗的 `Promise`，就改問規則機器人 `ruleBrain`，牌桌不會卡住；逾時後才到的回答不理會。預設的大腦就是規則機器人時不設計時器。機器人行動前的節奏仍是上面的延遲。物件被回收時正在想的回答跟著消失，重新載入後照常重新排程。

**確定性**：TKB 沒有亂數，也不刻意失誤，同一個局面一定做同一件事，所以不需要種子（B6 的刻意失誤與 `mistakeSeed` 已依社長 2026-10-24 的決定拿掉）。

### 5.1.2 淡江制度的 TKB 只給有權限的社員（社長 2026-10-26）

淡江制度的機器人（`RobotKind` 的 `tku`）不公開：只有管理員在管理頁勾了 **`tkuSystem`**（「淡江制度機器人」）的社員能用，管理員本來就有。其他人只有一個 TKB、沒有制度可選，就是 2/1（`gib`）的那個。**伺服器檢查**，不只是畫面藏起來：沒有權限卻要 `tku` 一律回 `tkuSystemOnly`（403）。

- **看的是誰設定機器人**：放機器人的房主、建立挑戰或隊制賽的人、開練習桌的人。坐到有權限的房主桌上的其他人照常跟淡江制度的機器人同桌、對打，看得到它的說明（§4 的機器人叫品說明不變）；挑戰的受邀者照打挑戰的制度。
- **每個選制度的地方**（`ClubService` 的 `mayUseTku`、`defaultKindOf`、`checkRobotKind`，牌桌的 `TableService.robotKindFor`；瀏覽器用 `shared/protocol.ts` 的 `robotKindsFor`、`mayUseTkuSystem`）：
  - 牌桌的 `addRobot`、`replaceWithRobot`：由牌桌自己檢查（`TableService.robotKindFor`），所以走大廳的連線或牌桌自己的連線（`/ws/table/<id>` → `TableHost.message`，不經過 `ClubService`）都一樣。牌桌透過 `ClubLink.mayUseTku` 問社團（Durable Object 之間是 RPC `Club.tableMayUseTku`），帳號只在社團，每次問到的都是現在的權限，房主換人或權限改了也不用通知牌桌；問不到就是 `serverError`，不會放錯。沒寫 `kind` 就用房主的預設（有權限 `tku`，否則 `gib`）。座位選單有權限時有「放 TKB（淡江制度）」「放 TKB（2/1）」兩個，沒有時只有「放 TKB」。
  - 代打（斷線 3 分鐘，`substituteDue`）：同伴是機器人就用同伴的制度，否則用牌桌的 `Table.robotKind`（開桌時記下房主的預設）。
  - 練習桌：`parsePracticeSettings(value, 預設)`，沒寫 `robotKind` 就用開桌者的預設；`PracticeDialog` 只在有權限時顯示制度。
  - 挑戰：`createChallenge` 檢查設定的 `robotKind`（預設本來就是 `gib`）；「用這副牌挑戰」的牌若是跟淡江制度的機器人打的（例如在別人桌上），沒有權限也回 `tkuSystemOnly`，紀錄頁不顯示那個按鈕。一鍵再戰是新的牌，所以沒有權限的人再戰淡江制度的挑戰時改成 2/1，不拒絕。`ChallengeDialog` 只在有權限時顯示「機器人」。
  - 隊制賽：`TeamMatchService.create` 與 `update` 檢查（`TeamMatchDeps.mayUseTku`）；預設本來就是 `gib`。只有從別的制度**改成** `tku` 才要權限，已經是 `tku` 的比賽改其他設定照常。設定表只在有權限（或比賽已經是淡江制度）時顯示制度。
  - 每週挑戰：只有管理員設定（管理員有權限），全社都會打，所以預設是 2/1（社長 2026-10-26）；管理員仍可以改成淡江制度。已經存過的設定照存的。
- **舊資料照舊**：存下來的牌桌、座位 id、挑戰、隊制賽、紀錄裡的 `tku` 都照讀照打，不改寫；沒有 `Table.robotKind` 的舊牌桌代打照舊用淡江制度。權限被收回時，已經開好的牌桌、挑戰、比賽也照舊，只是不能再新開或改成淡江制度。
- **不受影響的**：真人叫品的推論意義（§4，同伴不是機器人時用淡江制度讀）與叫牌提示卡（`bookTopics`）是淡江橋譜的公開內容，不是機器人，照舊。
- **測試**：`tests/worker/tku-system.test.ts`（權限、放機器人、混合的牌桌、代打與舊牌桌、練習桌、隊制賽）、`tests/worker/table-objects.test.ts`（牌桌自己的連線上放機器人）、`tests/worker/challenge-service.test.ts`、`challenge-options.test.ts`（挑戰、用這副牌挑戰、再戰）；畫面：`tests/presentation/practice.test.tsx`、`challenges.test.tsx`、`matches.test.tsx`。

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

1. **先把規則機器人做強**，不用 DDS：出牌時讀叫牌推論、數牌、坐莊計畫、防守推論（ROADMAP 新的 B4、B10）。這就是 TKB，不需要伺服器 DDS。
2. **DDS 只用在不花錢的地方**：殘局與攤牌判斷用 `dd.ts`（已經在做）；牌打完、四家公開以後，紀錄頁在**瀏覽器**裡用 WASM 版 DDS 算 DD 表與 par（`e6-t43`，B11，已完成：`src/lib/dds.worker.ts` 是延遲載入的 Web Worker，`bridge-dds` 只打包進它，Worker 端的程式碼不含 DDS；授權聲明在 `public/licenses/dds-apache-2.0.txt`，紀錄頁的 DD 表下方有連結）。重播的**雙夢家模式**也用同一個 Web Worker：`doubleDummy.ts` 的 `ddPosition` 把重播到的那一點（實際出過的牌加上假設出的牌）換成 DDS 的 `SolveBoardPBN` 輸入（還在手上的牌、這一墩已經出的牌與首家），`ddsSolve.ts` 的 `solvePosition` 要每張可出的牌的墩數，`cardOutcomes` 換算成莊家對合約的結果。每個局面在頁面載入期間只算一次；同時只送一個局面給 Worker，還在排隊的局面在觀看者移開後就撤回（`useDoubleDummy.ts` 的 `solvePosition`），重播一張張出牌時也先不算。只有打完的牌才有，四家牌紀錄本來就看得到，不需要伺服器的新資料。機器人打牌時的思考不能放在瀏覽器，因為那需要別人的牌（`CLAUDE.md` 硬性規則 2）。
3. **之後再付**：要做 TKB Adv（DDS 殘局、模擬出牌），或同時在線的人多到規則機器人不夠用時，再升級付費方案。升級只是在 Cloudflare 後台切換方案，不用搬家；`RobotBrain` 讓 DDS 大腦直接換進來（ROADMAP Phase P）。

**規模估算**（全台灣使用時參考，2026-10 的官方價格）：最壞的情況是 300 人同時在線、每人一桌配 3 個 GIB 式機器人，尖峰每天 4 小時，每月約 43 萬副。每次出牌模擬 50 副牌、每副機器人約用 10–20 秒 CPU：

| 項目 | 每月 |
| --- | --- |
| 月費（含 3,000 萬 CPU ms、1,000 萬次請求） | 5 美元 |
| 機器人 CPU（43–86 億 ms，超出部分每百萬 ms 0.02 美元） | 約 85–170 美元 |
| 牌桌的 Durable Object 時間（依在記憶體裡的時間計費，機器人每 1.05 秒動一次，物件不會休眠） | 每桌一個物件約 200 美元；幾十桌共用一個物件幾乎是 0 |
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
