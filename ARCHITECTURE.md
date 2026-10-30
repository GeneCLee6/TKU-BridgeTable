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
- **挑戰可以各自一個 Durable Object**（`EventObject`，H2b，§5.12）：開關 `EVENT_OBJECTS=on` 才用，**預設關**（挑戰照舊在社團的物件裡）；正式站什麼時候開由社長決定（`DEPLOY.md` §4.6）。
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
│  ├─ challenge-scoring.ts 挑戰的計分：IMP、總分、MP、Cross-IMP、沒打完的副、同分名次
│  ├─ challenge.ts         挑戰的狀態、設定、預設值與期限（§5.5）
│  ├─ team-match.ts        隊制賽的狀態、兩室八個座位與隊伍對應、設定與預設值、畫面型別（§5.8）
│  ├─ team-scoring.ts      隊制賽的計分：每副兩室分差 → IMP 或 BAM、Avg／Avg+／Avg- 裁定、總分（§5.8）
│  ├─ history-query.ts     紀錄搜尋的條件型別、解析與網址字串
│  ├─ favorites.ts         收藏的筆記與標籤規則（§5.3）
│  ├─ lin.ts               BBO LIN 匯出與 Handviewer 連結
│  ├─ messages.ts          錯誤代碼與六種語言的訊息
│  ├─ protocol.ts          HTTP／WebSocket 的訊息與畫面型別
│  ├─ message-guard.ts     WebSocket 訊息的大小上限與型別守衛（§5.6）
│  ├─ scrub.ts             錯誤回報去除個資（§5.6）
│  └─ robot/               機器人：robots（兩種機器人與各自的叫牌）、hand（牌型分析）、
│                          play（坐莊、防守信號）、system/（制度引擎與 2/1 制度：規則書、GIB 的牌力、說明、推論，
│                          `ROBOT.md` §6）
├─ worker/
│  ├─ index.ts             Worker 入口：綁上 Durable Object 交給 routing.ts
│  ├─ routing.ts           Worker 的路由（不碰 Cloudflare API）：/api/* 與 /ws 給社團，/ws/table/<id> 確認身分（通行證或問社團）後加 X-TBT-User 給那一桌，紀錄列表與搜尋可從 D1 回答（§5.12），其他給靜態檔案
│  ├─ edge-auth.ts         邊緣通行證：簽發、驗證、cookie（§5.12）
│  ├─ history-replica.ts   紀錄索引的 D1 副本：ReplicaSync（outbox、填副本、開關）、寫入與搜尋的 SQL（§5.12）
│  ├─ d1.ts                把 D1 binding 包成 ReplicaDb（唯一碰 D1 的程式）
│  ├─ club.ts              社團的 Durable Object：HTTP 路由、WebSocket（hibernation）、儲存轉接、牌桌回報的 RPC
│  ├─ table-object.ts      每桌一個的 Durable Object：儲存、alarm、這一桌的 WebSocket、社團的 stub（只是接線，§5.10）
│  ├─ table-host.ts        TableHost：一個 TableObject 做的事（RPC 包裝錯誤、桌的連線只收在桌上的人、訊息驗證與速率限制、搬移），可在 Node 測試
│  ├─ events.ts            社團與挑戰之間的介面（EventApi、EventLink、EventRpc、RemoteEvents）與社團自己的 event_homes、challenge_settled（§5.12 H2b）
│  ├─ event-service.ts     ChallengeEvent：一場挑戰的規則、期限工作與結算（不碰 Cloudflare）；LocalEvents＝挑戰在社團的物件裡
│  ├─ event-host.ts        EventHost：一個 EventObject 做的事（RPC 包裝、變更編號、回報與重送、搬移），可在 Node 測試
│  ├─ event-object.ts      每場挑戰一個的 Durable Object：儲存、SQLite、alarm、社團的 stub（只是接線，EVENT_OBJECTS=on 才用）
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
│  ├─ relations.ts         好友與封鎖名單（§5）
│  ├─ direct-messages.ts   私訊的 SQL 表與 DirectMessageStore（§5.7）
│  ├─ forum.ts             淡江橋館的討論區：SQL 五張表與 ForumService（§5.7 後的「論壇」）
│  ├─ forum-notices.ts     討論區的通知：被回覆、被提到、公告、被置頂（橋館 e11-t08）
│  ├─ log.ts               結構化日誌（§5.6）
│  ├─ rate-limit.ts        速率限制（§5.6）
│  ├─ metrics.ts           指標與告警，`/api/health` 與管理頁「系統狀態」（§5.13）
│  ├─ client-errors.ts     瀏覽器錯誤回報的檢查（§5.6）
│  ├─ book-telemetry.ts    淡江橋館的錯誤回報與匿名使用統計：SQL 四張表與 BookTelemetry（§5.15）
│  ├─ challenges.ts        挑戰的 SQL 表與 ChallengeStore（§5.5）
│  ├─ challenge-flow.ts    挑戰的狀態轉移（建立、回覆、取消、截止）：純函式，ClubService 寫回（§5.5）
│  ├─ team-matches.ts      隊制賽的 SQL 表與 TeamMatchStore（§5.8）
│  ├─ team-match-flow.ts   隊制賽的步驟（建立、改設定、取消、座位與隊長、開始、每室的結果與結束）：純函式（§5.8）
│  ├─ team-match-service.ts 隊制賽的動作（HTTP 與 socket）、通知與推送，ClubService 建好交給 Durable Object（§5.8）
│  ├─ modes.ts             牌桌模式（casual、challenge、practice、team）與三個掛勾（發新一副、寫紀錄、一副結束）
│  ├─ team-mode.ts         隊制賽一室的牌桌：team 模式的掛勾、開桌時的快照、紀錄先不公開（§5.8）
│  ├─ scheduler.ts         統一排程器：機器人、自動發牌、挑戰的提醒與截止都走同一個 alarm 佇列
│  ├─ auth.ts              PBKDF2 密碼雜湊、session cookie
│  └─ store.ts             儲存介面與測試用 MemoryStore
├─ src/                    React app
│  ├─ components/          牌、手牌、叫牌盒、叫牌過程、牌號、名牌、墩、面板、頁首、聊天
│  ├─ pages/               Login、Lobby、Table、History、Favorites、Board、Challenges、Challenge、Account、Admin
│  ├─ state/               AuthContext、ClubContext（社團與牌桌兩條 WebSocket，`lib/liveSocket.ts` 保持連線）、PreferencesContext
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

**隊制賽**（§5.8，`teamMatchView`，`GET /api/matches`、`/api/matches/:id`、socket 的 `match`）：牌組永遠不送；準備中的比賽只給房主與有座位（受邀或已入座）的人，被移出、拒絕或離開後就看不到（推送 `match: null`）；畫面另附每位座位上的社員在不在線（`online`，和大廳的社員列表同一份資訊）與房主能不能開始（`ready`）；比賽中另附兩室牌桌的 id（`tables`，參賽者回到自己那一桌、其他人觀看用；能不能進去由牌桌決定）；比賽中的牌桌只是兩張一般牌桌，看得到的牌和一般牌桌一樣，額外的限制在牌桌層（F4 的 `e8-t09`，見下）。比賽的畫面推給參賽者，比賽中也推給兩桌上的每一個人（入座與觀看），牌桌上方的比分條就是用它（`e8-t10`）。

| 誰 | 準備中（`setup`） | 比賽中（`playing`） | 結束（`finished`／`abandoned`） | 取消（`cancelled`） |
| --- | --- | --- | --- | --- |
| 房主、被邀請或已入座的人（「參賽者」） | 設定、8 個座位與狀態 | 同左，加**兩室都打完（或已裁定）**的每一副：兩室的南北分數、牌局 id、合約、莊家墩數、首攻、裁定與理由、各隊得分與總分；只打完一室的那一副不顯示；座位標「機器人代打中」（`substitute`）、暫停中（`pausedAt`）。**只有房主**另有兩室各在第幾副、何時超時（`rooms`，裁定用，`e8-t15`） | 全部 | 設定與座位 |
| 其他社員 | 404 | 同參賽者（觀看者本來就能看兩桌） | 全部 | 404 |

牌桌層（`e8-t09`，F4 已實作，測試在 `tests/worker/team-match-play.test.ts` 與 `table-objects.test.ts` 的「a team match in two table objects」，E11 的 `e11-t13` 從這裡擴充）：
- **另一室**：參賽者（比賽中有座位的社員，兩室都算，隊友也一樣；F5 起含替補上場的人與被替補下場的人，`TeamTableState.players` 只增不減）不能 `joinTable`／`sit` 另一室的牌桌，錯誤 `matchOtherRoom`。**自己那一室也不能觀看**（`matchNoWatching`）：機器人代打中的參賽者 `joinTable` 自己那一室就是回到座位（`e8-t14`），不會變成看得到四家的觀看者；被替補下場的人兩室都不能看。社團先用目錄與比賽的座位檢查一次（`checkNotInMatch`），牌桌再用自己的快照檢查一次（`TeamTableState.players`，`TableService.otherRoom`），所以繞過社團直接呼叫牌桌也進不去；桌的連線（§5.10）只收在桌上的人，另一室的參賽者連過去會被 4004 關掉。
- **別桌**：比賽中的參賽者不能開桌、坐到或觀看別桌、快速入座、開始挑戰（`inMatch`）；離開牌桌頁面（`leaveTable`）不會離座，座位一直留到比賽結束（斷線照 F1 的代打）。
- **座位**：比賽桌的座位由比賽決定：`sit`、`stand`、`kick`、`addRobot`、`removeRobot`、`replaceWithRobot`、`updateTableSettings` 都是 `matchTableFixed`；不能撤回（`matchNoUndo`，`BoardView.canUndo` 一律 false）。
- **大廳**：比賽桌不列在大廳的牌桌（`tables`），也不算在社員列表的「在哪一桌」；改列在 `LobbyView.matches`（進行中的比賽、兩室的桌 id），`/matches` 頁的「進行中的比賽」從這裡來。
- **觀看**：非參賽者可以觀看兩室（同 BBO Vugraph，看得到四家，和一般牌桌的觀看者一樣）。觀看者說的話標 `kibitz`，只送給觀看者；入座的參賽者的瀏覽器根本收不到（`chatFor` 的 `player`，在伺服器過濾）。參賽者說的話只在本桌，觀看者也看得到。
- **紀錄**：比賽牌局的紀錄帶 `mode: 'team'`、`eventId`＝比賽 id、`room`，`revealAt` 先是 `HELD_BACK`（JavaScript 日期的最大值，`worker/team-mode.ts`）：**某一副兩室都打完就公開那一副**（兩室各一筆紀錄一起改，`revealBoards`），比賽結束時其餘的一起公開（`revealEvent`）；在那之前只有打那一副的四位看得到（`recordVisible`）：紀錄列表、搜尋、詳細頁、牌桌側欄的 `recent`、個人檔案的最近牌局、收藏都一樣。比賽牌局沒有 traveller（`/api/history/:id/traveller` 回 `null`），兩室比較在比賽頁。
- **比分**：只算兩室都打完（或已裁定）的副（`teamMatchView`），所以快的一室看不到慢的一室在同一副的結果，連「這一副已經計分」都看不到。兩室的進度（第幾副、何時超時）只給房主（`rooms`），因為裁定要用；其他參賽者看不到另一室打到哪裡。
- **替補**（`e8-t16`）：正在觀看這場比賽任一室的社員不能替補上場（`matchWatching`），他已經看過兩室的牌。
- **中止**（`e8-t16`）：正在打的那一副直接收起、不留紀錄，其餘已打完的副一起公開（`revealEvent`）。裁定（`e8-t15`）讓那一副「完成」：已打完那一室的紀錄立刻公開，正在打它的那一室收起來、不留紀錄。

**資訊隔離回歸測試**（`e11-t13`，AC-11.8）：`tests/worker/visibility/visibility.test.ts` 集中測一般、練習、挑戰、隊制賽四種牌桌 × 每種角色（入座、觀看、不允許觀看時沒有座位的人、另一室的參賽者、局外人）：每一則送到瀏覽器的 `table` 訊息都檢查有沒有不該看到的牌（`noHiddenCards`），還沒公開的牌局在紀錄、紀錄列表、搜尋（我的與全部）、個人檔案、收藏、traveller、精選都拿不到（`exposure`），公開之後每處都拿得到。新增可見性規則或新的地方會送出牌局時，加在這裡；CI 的 `npm test` 會跑。

單副的 traveller（C7，`GET /api/history/:id/traveller`，`challengeTraveller`）：就是 `challengeView` 給這個人的那一副 traveller，不多給——打完全部副數的參與者、或挑戰結束後的參與者才拿得到，其他人（還沒打完的、非參與者）一律 `null`；伺服器再從那幾副的紀錄補上莊家是誰與首攻，以及排名矩陣裡那一副的分數。並排重播（`/history/:id/vs/:other`）兩邊都走 `/api/history/:id`，所以照樣由 `recordVisible`／`challengeBoardVisible` 把關。

**打完的牌局什麼時候公開**（AC-4.9，`recordVisible`）：紀錄可以帶 `revealAt`（挑戰、隊制賽還在進行時）。在那之前，只有打那一副的四位看得到；其他人在紀錄列表、搜尋、詳細頁、牌桌側欄的 `recent`、收藏、精選都看不到。**收藏**（§5.3）：只能收藏 `recordVisible` 看得到的牌——還沒公開的挑戰／隊制賽牌局只有打的四位能收藏，別人收藏或查詢都拿到跟不存在一樣的 `boardGone`（404），連「打完全部副數、可以看 traveller」的參與者也要等公開；「我的收藏」列表走同一個 `searchBoards`，照樣套用 `reveal_at` 的規則。筆記與標籤只有收藏的人自己讀得到：每個查詢都以自己的 id 為條件，沒有讀別人收藏的 API。**精選**（§5.9）：只有已經公開的牌（沒有 `revealAt` 或已經過了）才能設為精選——打過那副的策展人拿到 `featuredNotRevealed`，沒打過的拿到 `boardGone`，不透露那副牌存在；精選的列表與單副讀取也再套一次 `recordVisible`。搜尋在 SQL 裡套同一條規則（`reveal_at IS NULL OR reveal_at <= 現在 OR 我打過`），而且不管搜尋什麼條件都會套用，前端無法關掉。Worker 從 D1 副本回答的紀錄列表與搜尋（§5.12）跑的是同一段 SQL，規則一樣；資訊隔離套件比對兩邊的回答完全相同。

**練習桌**（§5.11，`practiceView`）：牌照上表（社員只看到自己的牌，打完四家公開）；`TableView.practice` 只有社員自己選的設定與發了幾副，不含任何牌。**顯示四家**（`e10-t16`）：練習桌的主人（有座位）開了 `showHands`，`boardView` 另外帶 `shown`（四家）：只給他、只是看得到，叫牌盒與提示照舊（不是 `acts`）；觀看者照上表，沒有座位的人、別桌的人都不受影響，送不送牌由伺服器決定（`TableService.shownTo`）。**牌組**（`deal: 'set'`）：牌組的牌（`PracticeTableState.problems`）跟挑戰的牌組一樣只在伺服器，`practiceView` 只送正在打的那一副是第幾題、分類、精選的標題，**叫牌結束後**才送教學重點（`note`，叫牌前送會洩漏該怎麼叫）；收藏與精選的牌只能是看得到**而且已經公開**的（`revealAt` 已過或沒有）：還沒公開的挑戰、隊制賽牌，連打過的人也拿到 `boardGone`。練習牌組的 JSON 只有 Worker import，瀏覽器的 bundle 裡沒有（測試檢查 `src/` 沒有 import 它）。Just Declare 練習的叫牌是機器人叫的，跟所有機器人的叫品一樣公開。練習的紀錄所有人仍看得到（`recordVisible` 不變），只是「全部社員」的列表預設不列（§5.11）。

**封鎖與聊天**（AC-1.6，`chatFor`）：牌桌聊天照每位觀看者過濾，他封鎖的社員說的話不會送到他的瀏覽器；其他人照常看得到，解除封鎖後保留的訊息會再出現。大廳的 `friends`／`blocked` 只在社員自己的那一份（`LobbyMine`），別人封鎖或加了誰不會送出。

**私訊**（AC-1.7，§5.7）：一則私訊只送給它的兩位成員（雙方所有分頁的 `direct`），對話列表 `directs` 只送自己的；`GET /api/messages/:userId` 只讀「自己與對方」這一對的訊息，SQL 以兩人 id 組成的 `pair` 查詢，拿不到別人之間的對話。被對方封鎖的人只會收到「不能傳私訊給他」（`cannotMessage`），不會知道被封鎖。

**個人檔案**（AC-1.5，`memberProfileView`，`GET /api/members/:id`）：別人只拿得到 id、帳號名稱、頭像版本與四個欄位（顯示名稱、自評等級、常用制度、自我介紹），一個一個挑出來，帳號的其他東西（密碼雜湊、管理員、權限、登入時間、好友上線提示）不會送出；`recent` 是這位社員最近 10 副**看的人看得到**的牌（走紀錄搜尋，同一條 `revealAt` 規則）。自己的個人檔案在 `/api/me` 的 `profile`。頭像：上傳過的社員，`PublicUser.avatar`（大廳的 `members`、`online`、座位）、`/api/me` 與個人檔案卡帶版本號，瀏覽器用 `/api/avatar/:id?v=<版本>` 載入（兩站同一個網址，橋館經 Vercel 轉發）；沒有上傳或載入失敗時是瀏覽器依 id 與名字畫的預設頭像（`e1-t18`）。頭像所有登入的社員都看得到，跟名字一樣。

瀏覽器拿到的 `BoardView` 只包含它能看的牌，以及伺服器算好的 `legalCalls`／`legalCards`／`canUndo`／`canClaim`，畫面不需要自己判斷規則。攤牌被拒絕後，`rejectedClaim` 記下誰拒絕，直到下一個動作。

## 5. 通訊與儲存

**HTTP**：`GET /api/challenges`（我參與的挑戰，新的在前）、`/api/challenges/:id`、`POST /api/challenges`（建立）、`POST /api/challenges/:id/answer`、`/cancel`（§5.5）、`GET /api/matches`（我主辦或有座位的隊制賽，新的在前；已取消的不列，`/matches` 頁收到 `match` 推送是取消或 `null` 時先拿掉、再重讀列表，連結 `/api/matches/:id` 仍打得開）、`/api/matches/:id`、`POST /api/matches`（建立）、`POST /api/matches/:id/settings`、`/cancel`、`/invite`、`/answer`、`/move`、`/leave`、`/clear`、`/robot`、`/start`，比賽中的 `/rule`、`/pause`、`/abandon`、`/replace`、`/sitin`（§5.8）、`GET /api/practice/sets`（練習牌組，不含牌）、`GET /api/practice/presets`、`POST /api/practice/presets`、`DELETE /api/practice/presets/:id`（存的練習設定，§5.11）、`GET /api/featured`（全部精選，新的在前）、`GET /api/featured/:boardId`（那副的精選或 `null`）、`POST /api/featured/:boardId`（設為精選或編輯，要 `boardCurate`）、`DELETE /api/featured/:boardId`（取消精選，§5.9）、`POST /api/register`（第一個帳號直接登入，之後回 202 `{ pending }`）、`/api/login`、`/api/logout`、`/api/password/reset`（忘記密碼）、`/api/account/password`、`/api/account/preferences`（欄位都選填、至少一個：`friendOnlineNotice` 好友上線提示開關，`e1-t24`；`bookAdoptedNotice` 採用特約的發布通知開關（橋館 F4，關掉後只停「隊伍／搭檔制度集採用該特約」這個原因的 `bookPublished`，關注、送審者、覆寫段落變更、建議統一照常；`/api/me` 一律帶）；`bookProfile` 淡江橋館讀的制度集 id，空字串或 `club` 回到社團預設，只檢查格式、不查是否存在，橋譜 `e1-t16`；`/api/me` 的 `bookProfile` 同步回傳；`robotSpeed` 機器人出牌速度 `veryFast`／`fast`／`slower`，其他值 `unknownCommand`，`/api/me` 一律帶，§5.1）、`PATCH /api/account/profile`（自己的個人檔案，`shared/profile.ts` 的 `parseProfile` 檢查：只收四個欄位、長度上限、等級只能是 `PROFILE_LEVELS`，空的欄位清掉）、`PUT /api/account/avatar`（自己的頭像，`e1-t34`：本文是瀏覽器裁好、縮成 256×256 的圖片原始位元組，最多 `AVATAR_MAX_BYTES` 64 KB，超過回 413 `avatarTooLarge`；只看檔頭的 magic bytes 判斷是 WebP／JPEG／PNG，不是就 415 `avatarBadFormat`，Worker 不解碼圖片；每人突發 5 次、之後每分鐘 1 次，與刪除共用，`slowDown`）、`DELETE /api/account/avatar`（回到字首預設頭像）、`GET /api/avatar/:userId?v=<版本>`（要登入；`ETag: "avatar-<版本>"`，`v` 是目前版本時 `Cache-Control: private, max-age=31536000, immutable`，否則 `private, no-cache`，`If-None-Match` 相同回 304；沒有頭像回 404 `noAvatar`）；`GET /api/members/:id`（別人的個人檔案卡，§4）；`GET /api/messages/:userId?before=<id>`（與某位社員的私訊，一頁 30 則，§5.7）；`GET /api/me`（含 `permissions`，管理員另有 `applications` 待審核數）、`/api/history?scope=all&page=<n>&size=<10|20|50|100>`（回傳該頁與總數）、`/api/history/search?<條件>`（§5.3）、`/api/history/days?<條件>`（每天幾副，§5.3）、`/api/history/:id`。維運：`GET /api/health`、`POST /api/client-errors`（§5.6，都不需登入）。管理員：`GET/POST /api/admin/users`、`POST /api/admin/users/:id/password`、`POST /api/admin/users/:id/admin`、`POST /api/admin/users/:id/permissions`、`POST /api/admin/members`（`{ changes: MemberChange[] }`：管理頁社員區一次存好幾位的身分與權限，`ClubService.adminUpdateMembers` 全部先檢查、全部成功或全部不存，規則同單筆：不能拿掉自己的管理員、至少留一位管理員）、`DELETE /api/admin/users/:id`、`GET /api/admin/applications`、`POST /api/admin/applications/:id/approve`、`DELETE /api/admin/applications/:id`、`GET/POST /api/admin/settings`、`DELETE /api/admin/tables/:id`。淡江橋譜的 `/api/book/*` 見 §5.2。session 放在 HttpOnly、SameSite=Lax 的 cookie（`tbt_session`）。錯誤回應帶 `code` 與 `params`（`shared/messages.ts`），瀏覽器依語言顯示。

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
- **邀請名單**（`e2-t25`）：`createTable`／`updateTableSettings` 可帶 `invitees`（社員 id，最多 `LIMITS.tableInvitesMax` 30 位，給了就取代 `Table.invited`），新加入名單的人收到 `tableInvited` 通知。隱藏的桌只有名單上的人能進，申請加入的桌名單上的人不必申請；公開、拒絕所有人時名單留著不用（設定視窗只在申請加入與隱藏時顯示名單，`takesInvitees`）。不能邀請自己（`notSelf`）、不存在的帳號（`userGone`）、自己封鎖的人（`unblockFirst`），對方封鎖了房主時只回中性的 `cannotInvite`（同挑戰，房主看不出被封鎖）。名單只送給房主（`TableView.invited`）
- **舊資料**：改版前存的設定是 `visibility`（`public`／`invite`），讀取時一律經過 `tableSettingsFrom` 轉換：`public` → 公開，`invite`（列在大廳、只限受邀）→ **隱藏**，受邀名單原封不動，所以原本受邀的人照樣能進；缺的欄位用預設值。牌桌自己（`TableService.load`）載入時就換成新格式，下一次存檔寫回；社團的目錄（`tabledir:`）載入時經 `upgradeEntry` 換成新格式並補上 `approved`、`requests`，下一次回報寫回。測試在 `tests/worker/table-rules.test.ts`（牌桌在社團裡）與 `tests/worker/table-objects.test.ts`（每桌一個物件）
- **不允許觀看**（`e2-t26`）：`joinTable` 回 `noKibitzing`，只能 `sit`；桌上沒有座位的人（站起來、被請離座）照 §4 只看得到公開的牌
- **計時**（`e2-t27`、`e2-t28`）：發牌時記 `Table.boardStartedAt`，有時間上限時 `TableView.boardEndsAt`＝發牌時間＋上限（伺服器時鐘，瀏覽器用 `now` 換算），輪到的人名牌上倒數，時間到變紅「超時」；**時間到不強制結束**；隊制賽由房主裁定（`e8-t15`，§5.8）。`TableView.waiting` 是桌子在等哪一位真人（叫牌或出牌的控制者；攤牌、撤回待回覆時不算）與從什麼時候開始（`Table.turnSince`，每個動作、入座、換人都重算）。等超過 `SLOW_TURN_MS`（60 秒）名牌閃爍、本人再聽到一次提示音，房主可以 `replaceWithRobot`（伺服器檢查真的在等他且滿 60 秒，否則 `notSlow`）：他留在桌上沒有座位，座位換成 TKB
- **大廳排序與快速入座**（`e2-t29`、`e2-t30`，`shared/lobby.ts`）：缺人的桌在前，缺越少越前面（最快能開打），滿的桌在後，同組照桌號；大廳卡片標「缺 N 家」。`quickSeat` 選第一張缺人、可以直接入座（`mayEnter`：公開，或受邀、已同意；房主沒封鎖他；不選練習桌、拒絕所有人的桌）的桌，坐第一個空位（南、北、東、西）；都滿就開新桌（預設設定）。已經坐在別桌的人會換過去
- **斷線代打**（`e2-t31`）：一般牌桌上入座的真人斷線（最後一個 socket 關閉）滿 `SUBSTITUTE_MS`（3 分鐘），排程器的 `substitute:<社員>` 工作讓 TKB 坐進他的座位（同伴是機器人就用同伴的制度），`Table.substitutes` 記座位 → 本人，名牌顯示「代打 某某」（`SeatOccupant.substituteFor`）；只在桌上還有別的入座真人在線時才代打。本人重新連線（`connected`）立刻換回原座位（機器人換座位時記號跟著走）；別人坐進代打的座位、房主移走它，代打就結束。這一副有代打過，紀錄的 `BoardRecord.substitutes` 記座位與本人，單副紀錄頁的明細列出「北 · 代打 某某」（`RecordSubstitutes`）。斷線時間在記憶體（`offlineSince`），物件被回收後 `load()` 把離線的入座者從現在重新起算
- **牌桌模式**：`Table.mode`（`casual`、挑戰的 `challenge` 或練習的 `practice`（§5.11），舊資料沒有這欄也當 `casual`）與 `modeState`；`ClubService` 只在三個地方問模式（`worker/modes.ts` 的 `TableModeHooks`，都拿到 `ModeContext`：社團的亂數、現在時間、`ChallengeStore`）：發新一副（`deal`，回傳牌號與四手牌，`null` 表示沒有下一副，最後一副留在桌上）、寫紀錄（`record`）、一副結束（`boardFinished`，在紀錄存好之後，所以拿得到牌局 id）。叫牌、出牌、入座與可見性在每種模式都一樣。牌從 `Table.dealSource` 來（`shared/deal-source.ts`；沒有就是每副重洗）
- **排程**：機器人的下一步與自動發牌都交給同一個排程器（`worker/scheduler.ts`），每桌每種工作一個 key（`robot:<桌>`、`deal:<桌>`），每個進行中的挑戰一個 `challenge:<挑戰>`（§5.5），每位斷線的入座者一個 `substitute:<桌>:<社員>`（代打），一副的紀錄社團還沒收下時每桌一個 `outbox:<桌>`（§5.10），沒搬完的舊牌桌一個 `migrate:tables`，同一個 key 還在等就不重排。Durable Object 用 `AlarmQueue`：工作放在記憶體，只把最早的一個設成物件唯一的 storage alarm（`alarm()` → `runDue()`），所以不會互相覆蓋 alarm，物件在兩步之間也能休眠；工作不寫進儲存，物件被回收後由 `load()` 依狀態重新排程。**每個 `TableObject` 有自己的佇列與 alarm**（牌桌的工作），社團的只剩挑戰、每週挑戰與搬移（§5.10）；`EVENT_OBJECTS=on` 時挑戰的 `challenge:<挑戰>` 也在那一場自己的 `EventObject`，社團只剩每週挑戰與搬移（`migrate:events`，§5.12 H2b）。測試傳 `schedule` 換成手動佇列
- **心跳**：兩條連線都一樣（`src/lib/liveSocket.ts`）：瀏覽器每 15 秒送 `ping`，由 `setWebSocketAutoResponse` 直接回 `pong`（不必喚醒物件）。40 秒沒收到任何訊息、分頁回到前景或網路恢復時，瀏覽器立刻重新連線；重連期間的動作暫存 8 秒內補送（社團的連線補送全部，桌的連線只補牌桌動作）
- **好友與封鎖**（AC-1.6，`worker/relations.ts`）：**介面暫時隱藏**（社長 2026-10-27：現在只有社員在用，不需要加好友）：`shared/features.ts` 的 `FRIENDS_ENABLED` 是 `false` 時，社員列表、個人檔案卡與個人檔案頁不顯示加好友（星星）、「只看好友」與封鎖按鈕（只剩私訊；之前封鎖過的人仍有「解除封鎖」可以按），「我的帳號」沒有好友上線提示的開關，伺服器不送 `friendOnline`，大廳也不把好友置頂。名單、指令（`setFriend`／`setBlocked`）、儲存與封鎖的檢查都還在，資料不刪；重新開放是公開前的最後一批（docs/ROADMAP.md L3）。好友是單向關注，不需對方同意、也不通知對方（同 BBO）；`setFriend`／`setBlocked` 帶對方的 id 與 `true`／`false`，不能對自己（`notSelf`）、不存在的帳號或機器人（`userGone`）。封鎖會同時取消關注，封鎖中不能加好友（`unblockFirst`）。封鎖的效果都在伺服器：被封鎖者的聊天對封鎖者隱藏（§4），封鎖者當房主時被封鎖者不能 `joinTable` 或 `sit` 進那一桌（公開的桌回 `blockedByHost`，其他進入方式回跟任何沒被放行的人一樣的錯誤，申請也只是房主看不到，見「申請加入」；已經在桌上的不會被請走）。私訊（`e1-t27`，§5.7）、挑戰邀請（`e7-t05`）與受邀桌（`e2-t25`）也檢查 `blocks`，之後的隊制賽邀請也要。帳號刪除時雙方名單裡的他都會刪掉
- 使用 Durable Object 的 hibernation API：沒人打牌時物件可以休眠，WebSocket 不會斷，醒來時從儲存重新載入。

**儲存**（Durable Object 的 key-value，SQLite 後端）：

| Key | 內容 |
| --- | --- |
| `user:<id>` | 帳號、密碼雜湊、是否管理員、橋譜權限、最後登入時間、自行重設密碼的時間、關掉好友上線提示（`friendOnlineNotice: false`）、關掉採用特約的發布通知（`bookAdoptedNotice: false`）、頭像版本（`avatar`，上傳時的時間，每次一定變大） |
| `avatar:<userId>` | 上傳的頭像（`e1-t34`）：`{ version, type, bytes }`，瀏覽器裁好的 256×256 WebP（不支援就 JPEG），最多 64 KB，遠低於單筆值的上限；帳號刪除時一起刪，和 `user:` 一起在每日備份裡。不放 R2：每個環境（正式站、staging、PR preview）不必先建 bucket 就能部署，一個社團幾百人、每人幾十 KB 也只有幾 MB |
| `file:meta:<key>`、`file:ticket:<pass>`、`file:day:<userId>`、`file:secret` | 討論區與文章的圖片（淡江橋譜 `e11-t02`，§5.14）：圖片在 R2 `bridgebook-files`，這裡只存上傳者、型別、大小、有沒有縮圖；一次性上傳憑證（10 分鐘）；當天（台灣日期）拿過幾張憑證；簽網址的隨機金鑰。`file:meta:` 與 `file:secret` 在每日備份裡 |
| `app:<id>` | 待審核的註冊申請：帳號名稱、密碼雜湊、自我介紹、從哪個網站申請 |
| `session:<token>` | userId、到期時間 |
| `tabledir:<id>` | 牌桌目錄（`TableEntry`，§5.10）：大廳與跨桌動作只讀它；牌桌在自己的 `TableObject` 時才有 |
| `table:<id>` | 只在牌桌留在社團的物件時（H1a、測試、`TABLE_OBJECTS=off`）：座位、觀看者、目前這副、聊天、撤回請求；它顯示的社員名字（`names`）、各人的封鎖名單（`blocks`，聊天用）、還沒交給社團的牌局紀錄（`outbox`）；挑戰桌的 `modeState` 帶挑戰的快照（§5.10）。由 `TableService` 讀寫。每桌一個物件時同樣的內容在那個物件的 `table`（另有 `closed`：這一桌關了；`frozen`：已交回社團，等 `release`） |
| `board:<id>` | 一副牌的完整紀錄（原始四手牌、叫牌、出牌、結果） |
| `hist:<時間>-<id>` | 全社團的紀錄索引（摘要，補零的時間讓列表依時間排序） |
| `uhist:<userId>:<時間>-<id>` | 每位社員自己的紀錄索引 |
| `featured:<boardId>` | 精選牌局（§5.9）：標題、分類、講解、逐墩講解、誰先設的與時間、那副牌設精選時的摘要（`BoardSummary`）；帳號刪除時保留，設的人顯示「—」 |
| `practicePresets:<userId>` | 社員存的練習設定（`e10-t16`，§5.11）：`SavedPractice[]`（id、名稱、設定、時間），新的在前，最多 20 組；帳號刪除時一起刪 |
| `notif:<userId>:<時間>-<id>` | 通知（`worker/notifications.ts`）：種類、參數、時間、是否已讀；每人只留最新 500 則，帳號刪除時一起刪 |
| `friend:<userId>:<friendId>` | 社員關注的好友（單向），值是 `{ at }`；載入時全部讀進記憶體 |
| `block:<userId>:<otherId>` | 社員封鎖的對象，值是 `{ at }`；載入時全部讀進記憶體 |
| SQL `challenges`、`challenge_players`、`challenge_results` | 挑戰的正本（不是索引），見 §5.5；`EVENT_OBJECTS=on` 時，住在自己 `EventObject` 的挑戰正本在那個物件，這裡是社團的副本（§5.12 H2b） |
| SQL `event_homes` | 哪些挑戰住在自己的 `EventObject`，與社團寫進副本的最後一個變更編號（`rev`，-1＝物件還沒確認收下）；沒有這一列的挑戰住在社團（§5.12 H2b） |
| SQL `challenge_settled` | 社團對每場挑戰已經做過的事：結束（收桌、公開牌、通知結果）、提醒；H2b 建表時把已經結束或已提醒的挑戰都標成做過 |
| `meta:events` | 挑戰住哪裡的版本：1＝社團、2＝每場開著的挑戰都在自己的 `EventObject`（§5.12 H2b）；沒開過開關就沒有這個 key |
| SQL `matches`、`match_seats`、`match_boards` | 隊制賽的正本（不是索引），見 §5.8 |
| SQL `direct_messages`、`direct_threads` | 私訊的正本，見 §5.7 |
| SQL `forum_boards`、`forum_posts`、`forum_comments`、`forum_reactions`、`forum_reports` | 淡江橋館討論區的正本（`worker/forum.ts`，橋館 E11），見 §5.7 後的「論壇 Worker」 |
| SQL `book_errors`、`book_metrics`、`book_visitors`、`book_telemetry_settings` | 淡江橋館的錯誤回報與匿名使用統計（`worker/book-telemetry.ts`，橋館 e10-t06、e10-t07），見 §5.15；不在每日備份裡 |
| `meta:settings` | 管理員改過的人數上限與邀請碼（沒改過就用環境變數） |
| `meta:weekly` | 每週社團挑戰的排程、誰存的、上一場的時間與 id（`worker/weekly-challenge.ts`，§5.5） |
| `meta:schema` | 資料版本（現在是 4）：1→2 把舊版 `board:<時間>-<id>` 搬到新索引；2→3 把所有 `board:` 回填進 SQL 紀錄索引（§5.3）；3→4 把每個 `table:` 搬進自己的 `TableObject`、改存 `tabledir:`（§5.10）；`TABLE_OBJECTS=off` 時搬回來、回到 3 |
| `replq:<boardId>` | 還沒複製到 D1 的牌局（outbox，§5.12）：值是排進來的時間＋序號，寫進 D1 後刪掉（期間又被改的留著） |
| `meta:replica` | D1 副本的狀態（§5.12）：`off`／`filling`（做到哪一個 `board:` key）／`ready`，與填它時的 `REPLICA_VERSION` |
| D1 `boards_index`、`board_players`、`board_summaries`、`index_meta` | 不在 Durable Object 裡：紀錄索引在 D1 的副本，加上每副的摘要與 `ready`（§5.12）；可以隨時從 `board:` 重建 |
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

**備份**（`worker/backup.ts`，淡江橋譜 e10-t08、e11-t12）：cron trigger（每天台灣 03:00）呼叫 `Club.backup()`，把 `BACKUP_PREFIXES` 開頭的 key 匯出成一份 JSON Lines 存到 R2 bucket `tku-bridge-backups`（binding `BACKUPS`）的 `daily/<台灣日期>.jsonl`，保留 30 天；`GET/POST /api/admin/backups`、`POST /api/admin/backups/restore`（預設預演，真的還原要 `confirm`）。範圍：淡江橋譜的 `book*`、`profile*`、`article*`、`team:`、`pair:`、`userteam:`、`userpair:`，加上帳號 `user:`、`app:`、`avatar:`（同一次匯出，頭像版本與圖片一定對得上）；加上討論區的五張 SQL 表（`BACKUP_TABLES`：`forum_boards`、`forum_posts`、`forum_comments`、`forum_reactions`、`forum_reports`，2026-10-30 起，格式第 3 版：key 之後每列一行 `{"t":表,"r":列}`，有 rowid 的表照 rowid 順序寫、照順序寫回）；`session:`、`meta:settings`、好友與封鎖、私訊、牌局紀錄與紀錄索引的 SQL 表、橋館錯誤回報與使用統計的 `book_*` 表（§5.15）不在裡面，還原也不動它們。討論區的圖片本來就在 R2，備份只有它們的 `file:meta:`。格式第 2 版把位元組寫成 `{"$bytes":"<base64>"}`（`encodeValue`／`decodeValue`），第 1 版（只有橋譜）照樣讀、只還原它自己的 `prefixes`；第 1、2 版沒有表，還原時不動討論區。還原表時先檢查每張表與每個欄位現在都有（欄位名稱只用資料庫自己的），再在一個 transaction 裡清空、寫回；之後 `Club` 再跑一次 `ForumService.createTables()`（補內建看板與搜尋用的 `body_text`）。還原後 `Club` 換一個新的 `BookService`（與 `ArticleService`），記憶體裡的快取不會留下；有帳號時再呼叫 `ClubService.reloadAccounts()`：重讀帳號與申請、備份之後才有的帳號照刪除帳號的方式清掉、刪掉全部 `session:`、斷開所有連線，大家重新登入。步驟見 DEPLOY.md §4.4。

每個動作處理完立即寫回，物件隨時被回收都不會遺失牌局。紀錄列表一次只讀到那一頁為止（每頁 10／20／50／100 筆摘要）。

**容量**：免費方案每個帳號 5 GB；一副牌的紀錄連同兩筆索引約 4 KB，大約可存一百萬副以上。

### 5.6 可觀測性與輸入防護（`e11-t08`～`e11-t11`）

- **結構化日誌**（`worker/log.ts`）：每個事件一行 JSON，Workers Logs（`wrangler.jsonc` 的 `observability`）依欄位索引。`action`：WebSocket 動作的種類、userId、耗時（ms，含廣播）、失敗時的錯誤代碼；`rejected`：沒進到處理函式的訊息（格式、大小、速率）；`http`：每個請求的方法、路徑（不含 query）、狀態、耗時、錯誤代碼；`loginLocked`；`clientError`；`crash`（不是 `ClubError`／`GameError` 的例外，層級 error）；`replica`：D1 副本某一步失敗或填完（§5.12）；`edge`：Worker 從 D1 回答的紀錄頁（耗時），或為什麼交給社團（`fallback`）。**不記密碼、token、cookie、聊天內容。** `ClubService` 只拿到 `ClubConfig.log` 這個函式，不碰 Cloudflare API；測試傳陣列收集
- **健康檢查** `GET /api/health`（不需登入）：`{ ok, now, tables, online, events?, playing, robots, metrics, alerts }`（型別 `HealthStatus`，`shared/protocol.ts`），只有數量；回得來表示 Worker 與 Durable Object 都載入了。`metrics` 與 `alerts` 是最近一小時的指標與告警（§5.13）
- **前端錯誤回報**（`src/lib/errorReport.ts`）：`window` 的 `error` 與 `unhandledrejection` → `POST /api/client-errors`（`sendBeacon`，不需登入）。瀏覽器送之前去除個資（`shared/scrub.ts`：URL 的 query 與 fragment、e-mail、6 位以上的數字；只送路徑不送網址參數；不帶 userId），同一個錯誤只送一次、每頁最多 5 則、取樣比例 `REPORT_SAMPLE_RATE`（社團小，目前 100%）。伺服器（`worker/client-errors.ts`）只留已知欄位、截斷長度、再去除一次個資，全社團每秒最多約 1 則（突發 20 則）寫進日誌，不存資料庫。淡江橋館的錯誤回報另走 `POST /api/book/errors`，會存最新 100 列給編輯者看（§5.15）
- **訊息驗證**（`shared/message-guard.ts` 的 `parseClientMessage`）：WebSocket 訊息在 `ClubService.handleRaw` 入口檢查：最多 `MESSAGE_MAX_CHARS`（8,192 字元，二進位訊息只解碼到超過上限為止）、是 JSON 物件、`type` 是 1–40 個英文字母、已知種類的欄位型別對（型別守衛）。不合法就回 `error`（`messageTooLarge`／`badMessage`），不會進到處理函式。**沒有列在守衛裡的新種類只做形狀檢查**，所以新動作不必先改守衛；值的檢查（座位、範圍、權限）仍在各處理函式。HTTP 的 JSON 本文上限 2 MiB（`Content-Length`），超過回 413 `messageTooLarge`
- **速率限制**（`worker/rate-limit.ts`，記在記憶體，物件被回收就重算）：每位社員（所有分頁合計）的訊息 token bucket，突發 30、每秒 10（重連時補送的動作要過得去），超過回 `slowDown` 並丟掉；聊天另外突發 5、每 2 秒 1 句，超過回 `chatTooFast`；私訊另外突發 10、每分鐘 20 則，超過回 `directTooFast`；密碼錯誤以「來源 IP（`CF-Connecting-IP`）＋帳號」計 5 次、單一 IP 計 20 次，15 分鐘內再登入回 429 `tooManyLogins`（連密碼對了也一樣），密碼對了就清掉該帳號的次數。不鎖整個帳號，避免陌生人從別處把社員鎖在外面。速率只在 socket 入口（`handleRaw`）檢查，`handle` 本身不限，測試與機器人照常。**桌的連線**（§5.10）在 `TableHost.message` 做同樣的大小與型別檢查，只收牌桌動作（其他回 `unknownCommand`），動作與聊天的 bucket 另外算（每個 `TableObject` 自己記；所以同一人在社團與桌上的額度是分開的）

### 5.7 私訊（`e1-t25`～`e1-t27`）

- **儲存**（`worker/direct-messages.ts`，Durable Object 的 SQLite，不經記憶體快取）：`direct_messages`（`id` 整數遞增、`pair`＝兩人 id 排序後以 `:` 相連、寄件者、收件者、內文、時間），每一對只留最新 `DIRECT_KEPT` 1,000 則；`direct_threads` 每人每個對話一列（對方、最新一則的 id、讀到哪一則），對話列表與未讀數各一個查詢。帳號刪除時他的訊息與雙方的對話列一起刪，對方收到新的 `directs`
- **送出**：`sendDirect { to, text }`。伺服器去頭尾空白（空的就忽略）；不能給自己（`notSelf`）、機器人或不存在的帳號（`userGone`）；最多 `LIMITS.directMax` 500 字（`directTooLong`）；自己封鎖對方要先解除（`unblockToMessage`），被對方封鎖回 `cannotMessage`；每位社員突發 10、每分鐘 20 則（`directTooFast`，只在 socket 入口）。存好後把 `direct` 送給兩人在線的分頁，再各送一次 `directs`
- **讀取**：連線時送 `directs`（最新 50 個對話，每個帶對方、最新一則與未讀數，另有全部未讀數）；`GET /api/messages/:userId?before=<id>` 從最新往回一頁 30 則（舊的在前，`more` 表示還有更早的）。打開對話就送 `readDirect { userId }`，把對方寄來的都標為已讀
- **介面**：側欄（大廳、牌桌）的「訊息」分頁（`DirectMessages`）：對話列表與單一對話，分頁按鈕上有未讀數；社員分頁每一列的信封直接開啟與他的對話（個人檔案卡做好後也從那裡開）。私訊不另外進通知中心，未讀數就在「訊息」分頁上
- **好友上線提示**（`e1-t24`）：好友隱藏時（`FRIENDS_ENABLED` 是 `false`）整個不送。某位社員第一個分頁連上時，通知中心送 `friendOnline` 給**在線**、關注他、沒關掉提示、也沒被他封鎖的社員；同一個人 30 分鐘（`FRIEND_ONLINE_QUIET_MS`）內只提示一次，手機斷線重連不會一直跳。開關在「我的帳號」，存在伺服器的 `user:<id>`（`POST /api/account/preferences`）

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
| `TableObject` | 每桌一個（`idFromName(<桌 id>)`） | 這一桌的一切：座位與觀看者、叫牌出牌與撤回攤牌、機器人、自動發牌、時間上限與太久提醒、斷線代打、聊天、這桌最近 30 副、每位觀看者的牌桌畫面與「只送有變的」、這一桌的 WebSocket | `worker/table-object.ts`、`TableService`（`worker/table-service.ts`） |
| `EventObject`（H2b，`e11-t18`） | 每場挑戰一個（`idFromName('challenge:<id>')`，`EVENT_OBJECTS=on` 才用）；隊制賽是 H2c | 挑戰的狀態、期限工作與結算 | `worker/event-object.ts`、`EventHost`、`ChallengeEvent`（§5.12「H2b」） |

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
- 挑戰的期限、結算與隊制賽的比分也在 `Club` 裡算（`EventObject` 要拿走的部分，見下面 H2b）。

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
| 隊制賽的狀態與比分 | `Club` 的 SQL | 不變（**H2c**，下一個 PR，見下面 H2b 的「隊制賽為什麼不在這一批」） | `Club` |

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

- 部署後 `Club` 第一次載入，若有 `HISTORY` binding 而 `meta:replica` 還不是 `ready`：先在 D1 建表（`CREATE TABLE IF NOT EXISTS`，表與 `Club` 的完全相同，另加 `board_summaries` 與 `index_meta`）並把 `index_meta.ready` 設成 `0`；然後每次 alarm 寫 20 副 `board:`（一步 1 秒，做到哪一個 key 存在 `meta:replica`，物件被回收就從那裡接著做）；全部寫完才把 `ready` 設成 `1`。填的期間打完的副照樣進 outbox，不會漏。
- **Worker 每次讀 D1 都在同一個 batch 先看 `ready`**，不是 `1`（或表還不存在）就交給 `Club`。所以填到一半的副本永遠不會被讀到，也不需要部署順序上的配合。
- 時間：一萬副 500 步，約 8–10 分鐘；正式站目前遠少於此。每步 11 個 statement，遠低於免費方案每次呼叫 50 個查詢。
- `REPLICA_VERSION`：D1 的表或摘要的內容改了就加一，每個 `Club` 下次載入自動重填（期間 Worker 讀 `Club`）。

### 開關（退回）

- **`HISTORY_D1=off`**：Worker 不讀 D1；`Club` 不再寫 outbox、清掉 outbox、把 D1 的 `ready` 設成 `0`（D1 連不上就一直重試，直到設好）。拿掉這個值再部署，`Club` 從頭重填，填完才讓 Worker 讀。正本一直在 `Club`，怎麼切都不會掉紀錄。
- **`EDGE_AUTH=off`**（或根本沒設 `EDGE_AUTH_SECRET`）：不發通行證，Worker 什麼都問 `Club`，跟 H1 一樣。沒有通行證時 D1 也不會被讀（Worker 不知道是誰）。
- 兩個開關互不影響，都是 `wrangler deploy --var <名稱>:off`（`DEPLOY.md` §4.5）。

### 邊緣通行證（`worker/edge-auth.ts`，`e11-t19`）

- **格式**：`<社員 id>.<到期時間，36 進位>.<HMAC-SHA-256，base64url>`，用 secret `EDGE_AUTH_SECRET` 簽，有效 `EDGE_PASS_MS`（10 分鐘）。cookie `tbt_pass` 與 session 一樣 HttpOnly、SameSite=Lax、Path=/。只有 WebCrypto，Worker、Durable Object、Node 測試同一份程式。
- **誰發**：`Club`。登入、註冊（第一個帳號）時跟 session 一起發；之後任何 `/api/*` 的回答，若瀏覽器沒有通行證或已經用掉一半，就附上新的（`Club.edgePass`）；session 已經失效就清掉；登出時清掉。只要有在用網站（打開頁面就會呼叫 `/api/me`），通行證就一直有效。
- **誰看**：Worker（`worker/routing.ts`）。驗證只是一次 HMAC；不合法、過期、被改過、換了 secret，一律當作沒有，改問 `Club`，結果跟現在一樣。通行證裡**只有社員 id**，沒有管理員與權限，所以需要權限的 API（管理、橋譜、精選）一律照舊進 `Club`。
- **撤銷的代價（取捨）**：改密碼、管理員重設密碼或刪除帳號時，**其他裝置**上還沒過期的通行證最多再有效 10 分鐘，期間只能：讀紀錄列表與搜尋（唯讀）；連到**自己所在那一桌**的連線（`TableObject` 只收在桌上的人；被刪的帳號已經被移出牌桌）。對照：H1 起，已經連著的桌的連線本來就不會因為改密碼而斷。`e11-t23`（session 列表、登出其他裝置）要把這個窗口關掉：通行證帶 session 的雜湊，`Club` 撤銷時通知那一桌。
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

**隊制賽為什麼不在這一批（H2c）**：隊制賽沒有自己的期限工作（每副的時間上限是牌桌的，已經在 `TableObject`），比分在讀的時候才由 `scoreTeamMatch` 算，所以搬出去幾乎省不到 `Club` 的時間；而它的每一個動作都要 `Club` 的資料：誰在線（能不能開始）、封鎖與是否社員（邀請、替補）、牌桌目錄（裁定看兩室到哪裡）、「同時只在一場比賽」與「一人只主辦一場」（要跨比賽查）、推送給每位參賽者與觀看者（`Club` 的連線）。搬過去等於每個動作都要先把這些算好跟著傳過去。做法照這一批：`TeamMatchService` 分成 `Club` 那一半（上面那些檢查、通知、畫面與推送，讀副本）與比賽那一半（`team-match-flow.ts` 的純函式＋寫入，`ChallengeEvent` 的同類），同一個 `EventObject` 類別依 id 前綴（`match:<id>`）分派、同樣的 `rev`／outbox／`settled`、兩室的牌桌仍由 `Club` 開；比分只在比賽物件裡用兩室都完成的副計算（§5.8 不變）。

**實作與測試**：
- 分層照 H1b：`worker/event-object.ts`（只有接線：儲存、`ctx.storage.sql`、alarm、社團的 stub）→ `worker/event-host.ts`（`EventHost`，Node 可測）→ `ChallengeEvent`。`Club` 那一側是 `RemoteEvents`（`worker/events.ts`）；`ClubService` 只拿到 `ClubConfig.eventObjects`／`eventObjectsOn`，不碰 Cloudflare API（CLAUDE.md 規則 4）。`wrangler.jsonc` 加 `EVENT` binding（三個環境各一份）與 migration `v3`（`new_sqlite_classes: ["EventObject"]`，只新增類別，可以安全部署）。`/api/health` 多一個 `events: { objects, unconfirmed }`。
- **兩種模式都跑既有的測試**：`vite.config.ts` 有兩個 Vitest project，`default` 跑全部，`event-objects` 用 `TBT_EVENT_OBJECTS=on` 再跑一次所有挑戰、每週挑戰、隊制賽、TKB 權限與資訊隔離（`tests/worker/visibility/`）的測試。測試用 `tests/worker/event-mode.ts` 的 `clubService(...)` 建社團：開的時候每場挑戰是一個 `EventHost`（自己的儲存與記憶體 SQLite，經 structured clone），工作進同一個手動佇列；同一個 store 上重建社團時物件也一起被回收重載。
- `tests/worker/event-objects.test.ts`：副本與物件一致、拒絕的代碼與跟著補上的副本、截止在物件裡結算而結果只通知一次、物件被回收後工作重排而提醒不重發、回報送不到時重試、物件一開始沒收下時用副本補、物件連不上時一副的結果由牌桌的 outbox 重送且只算一次、開關關時什麼都不搬、搬出去（已結束的留下）、搬移失敗重試與重做、搬回來再搬出去、搬不回來時繼續用物件與搬回後丟掉晚到的回報、舊挑戰的 `challenge_settled` 補值不重發通知。
- 需要 workerd 才能測的只有接線（`event-object.ts`、`club.ts` 的 `eventChanged`、真正的 RPC）：在 staging（已預設開）照 `DEPLOY.md` §4.6 的檢查做一次。
- **還沒做**：隊制賽（H2c）；`Club` 自己的紀錄索引還不能拿掉（挑戰頁的 traveller 仍 join 它）；一場挑戰每次回報整場（幾十人沒問題，全台灣規模的每週挑戰要改成只送變的部分）；負載數字等 `e11-t21`。

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
- **排序**交給瀏覽器（`composeLobby`：桌子照 `lobbyOrder`、社員線上在前、好友置頂（`FRIENDS_ENABLED` 時）、再照名字），「只看好友」本來就在瀏覽器。
- **合併廣播**（`ClubConfig.later`，Durable Object 用 `setTimeout`）：大廳最多每 `LOBBY_GAP_MS`（100 ms）送一次。上一次送出已經超過 100 ms 就立刻送（平常沒有延遲）；之內的變化只記下來，到 100 ms 時一起送一次。同時湧進的入座、觀看、離桌就不必每個都等一次完整的廣播。測試多半不給 `later`，每次變化立刻送，跟以前一樣。
- **日誌取樣**（`worker/log.ts` 的 `sampleActions`）：`action` 每 10 筆寫 1 筆到 Workers Logs（帶 `sample: 10`，查詢時乘回來），有錯誤代碼或超過 200 ms（`ACTION_SLOW_MS`）的一律寫；其他種類照舊。指標在取樣**之前**數（`ClubService` 與 `TableHost` 的 `log` 先交給 `Metrics`／`TableCounters`），系統狀態頁的次數不受影響。
- 數字（前後對照）在 `docs/LOAD.md` §3、§6。

## 5.14 圖片檔案（R2，淡江橋譜 `e11-t02`，2026-10-28）

討論區貼文（E11）與文章（E5）的圖片放 R2 bucket `bridgebook-files`（binding `FILES`），程式 `worker/files.ts`（`FileService`，不碰 Cloudflare API，bucket 是小介面 `FileBucket`），型別與上限 `shared/files.ts`。

- **瀏覽器做影像處理**：縮到長邊 ≤ 2048 px、縮圖長邊 480 px；Worker 只看大小與檔頭（`sniffAvatar`，JPEG／PNG／WebP），不解碼圖片（免費方案 10 ms CPU）。
- **一次性憑證直傳**：`POST /api/files/ticket { purpose: 'post' | 'article', type, size }` → `{ key, uploadUrl, thumbUrl, expires }`（10 分鐘，計入每人每天 30 張）；`PUT uploadUrl`（≤ 2 MB，型別要和憑證一致）、`PUT thumbUrl`（≤ 256 KB，要在原圖之後）；兩個都傳了或過期就作廢。上傳路由不看 session cookie、有 CORS，所以頁面也可以直接傳到 Worker 的網址。
- **簽名短效網址**：`GET /api/files/<key>?e=<到期>&s=<HMAC>`，不用登入（`<img>` 跨站不帶 cookie），到期時間進位到整點再加一小時，同一小時內的網址相同、瀏覽器快取得到；`POST /api/files/urls { keys }` 重簽。金鑰是第一次用時產生的隨機值（`file:secret`），不需要另設 secret。PRD 寫的 `/_file/:key` 改放在 `/api/files/` 底下，兩站的 `/api/*` 本來就轉給 Worker。
- **刪除**：`DELETE /api/files/<key>`，上傳者、討論區幹部（`forumModerate`，橋館 G8）或管理員。帳號刪除時不刪圖片（貼文可能還在用）。
- **沒有 bucket 時**：`FILES` 沒綁就全部回 503 `filesOff`，所以 binding 先註解掉也能部署（DEPLOY.md §4.8）。
- **電子書 PDF**（淡江橋館 `e5-t09`～`e5-t11`，2026-10-29，`shared/ebooks.ts`、`worker/ebooks.ts`）：同一個 bucket、同一套憑證與簽名網址。`POST /api/book/ebooks/ticket { size }`（`bookReview`）→ 一般的 `FileTicket`，key 是 `ebook/<hex>.pdf`；`PUT uploadUrl` ≤ 50 MB、檔頭要是 `%PDF-`、沒有縮圖（傳完憑證就作廢）；上傳路由依憑證決定讀多少（`uploadMax`）。PDF 也是讀進記憶體再寫 R2（50 MB 在 Durable Object 的 128 MB 內）。書的紀錄 `POST /api/book/ebooks`、`PUT`／`DELETE /api/book/ebooks/:id`（`bookReview`，必填授權 `own`／`permitted`／`members-only`；換 PDF 或下架會一併刪掉舊 PDF；稽核 `ebook:save`／`ebook:remove`）。讀取 `GET /api/book/ebooks[/:id]` 不用登入，但未登入時 `members-only` 的書不在列表、單本回 404，所以連結與 PDF 網址都拿不到；PDF 的網址 15 分鐘（進位到 5 分鐘）就失效。簽名網址的回應加 `Access-Control-Allow-Origin: *`（簽名就是檢查），橋館的 PDF 閱讀器直接向 Worker 抓，不經 Vercel 轉址。
- **用量提醒**（橋館 `e5-t15`）：`file:usage` 隨上傳與刪除增減；越過 8 GB（`STORAGE_LIMITS.warnBytes`）時通知每位管理員一次（`filesNearlyFull { gb }`，連到橋館的電子書頁），降回 8 GB 以下再越過才會再通知；會超過 10 GB 的憑證回 507 `fileStorageFull`。編輯者在 `GET /api/book/ebooks` 的回應多一個 `usage`。
- **頭像不搬到 R2**：仍是 `avatar:<userId>`（256×256、≤ 64 KB，見 §5 的表），兩站都讀 `GET /api/avatar/:id?v=`。`GET /api/club/members` 多回 `displayName`、`avatar`，橋譜用來畫別人的頭像（`e11-t01`、`e11-t03`）。
- **顯示名稱上名牌**（`e11-t19`）：大廳的社員與大廳牌桌的座位（`PublicUser.displayName`）帶個人檔案的顯示名稱，改名時重送大廳；牌桌自己的座位與牌局紀錄仍只有帳號名稱，牌桌頁用 `withMemberProfile`（`shared/lobby.ts`）從大廳補上頭像與顯示名稱。`playerName` 有顯示名稱就用它，社員分頁的提示仍附帳號名稱。
- **論壇型別**（`e11-t05`）：`shared/forum.ts` 的 `Board`、`Post`、`PostBlock`、`Comment`、`Reaction`、`Report` 與上限，橋館 `src/lib/forum.ts` 是逐字複本（橋館的型別對拍檢查）；Worker 模組 `worker/forum.ts` 是 `e11-t06`。
- **論壇 Worker**（`e11-t06`、`e11-t07`，`worker/forum.ts` 的 `ForumService`）：Durable Object 的 SQLite，五張表 `forum_boards`（內建四板在建表時補上，`INSERT OR IGNORE`，所以管理員改的名稱與排序會保留；內建的不能刪，有貼文的板也不能刪）、`forum_posts`（區塊與 `mentions` 存 JSON；`pinned_at` 是置頂時間，新置頂的在前，就是 `Board.pinnedPostIds`；`comment_count` 跟留言一起維護）、`forum_comments`（巢狀一層：回覆別人的回覆，`parent_id` 一律是最上層那則）、`forum_reactions`（主鍵 target＋id＋社員，每人每則一種，換表情是覆寫）、`forum_reports`（檢舉，`e11-t09`）。不經記憶體快取；五張表都在每日備份裡（§5 備份，2026-10-30 起；私訊不在）。區塊逐一檢查、只留該種類有的欄位：牌不重複、四家牌每家 ≤ 13 張、叫牌過程輪到誰與合不合規則（`legalCalls`）、圖片要是 `post/` 的檔案 key；文字（段落、提示、條列）合計 ≤ `FORUM_LIMITS.postTextMax`，留言 ≤ `commentTextMax`、只能有 `paragraph`／`auction`／`hand`。`@` 提到（`mentionsIn`）認帳號名稱（不分大小寫）與顯示名稱，最長的先配；名稱以英數結尾時後面不能接英數，中文不受限；e-mail 裡的 `@` 不算；結果存在 `Post.mentions`／`Comment.mentions`。速率：每人發文加留言每分鐘 ≤ 5（`TokenBuckets`，回 429 `slowDown`；編輯不算、被拒的不算）。幹部（`moderatesForum`，roles.ts）是有 `forumModerate` 權限的社員與管理員（`e11-t09`）：只有幹部能在 `postPolicy: 'officers'` 的板（公告）發文、置頂、鎖定、刪除別人的貼文與留言；鎖定的貼文只有幹部能留言。作者才能編輯自己的貼文與留言；刪貼文連同留言與反應，刪最上層留言連同它的回覆。路由見 §5.2 的表（`/api/forum/*`）。帳號刪除時不刪貼文（之後再定）。
- **論壇通知**（`e11-t08`，`worker/forum-notices.ts`，AC-11.5）：走通知中心，四種 `forumMention`（新貼文或留言用 `@` 提到；編輯後新提到的人）、`forumReply`（貼文被留言通知作者；回覆通知那則最上層留言的作者）、`forumAnnouncement`（`postPolicy: 'officers'` 的板有新貼文，通知全部社員）、`forumPinned`（貼文被置頂通知作者），參數 `{ postId, title, username }`（`title` 是標題，沒有就是前 40 字，`postExcerpt`）＋留言的 `commentId`。同一則每人只收一種（提到＞回覆＞公告），自己做的不通知、已不是社員的不通知；鈴鐺連到橋館 `/forum/p/<id>`（有留言時 `#comment-<id>`）。寄送失敗只記 log，貼文照樣存。
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
| `playing` | `abandoned` | 房主中止（中止前要先暫停，`matchPauseFirst`，`e8-t16`）；已有結果的副照算，結果頁標「已中止」 |

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
- M2 的 VP（`e8-t22`）用總 IMP 差換算，也放在這個檔。

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

- 每副一列（不是每室一列）：一副的兩室結果與裁定放在一起，結果頁的逐副比較只讀一列；第一室打完或第一次裁定時才建立。
- 建立時一次寫好 8 列座位，之後只改不增減，所以「8 個座位都在」不必另外檢查。
- 和挑戰一樣不放記憶體快取，每次讀 SQL；表是新的，載入時 `CREATE TABLE IF NOT EXISTS`，沒有舊資料要搬，`meta:schema` 不變。之後加欄位用 `PRAGMA table_info` 檢查、`ALTER TABLE ADD COLUMN`，同挑戰的 `reminded_at`：F5 的 `paused_at`、`open_lead`、`closed_lead` 就是這樣加的（`TeamMatchStore.createTables` 的 `ADDED_COLUMNS`）。
- 首攻存在 `match_boards`（一張牌兩個字元）而不是只讀 `board:`：結果頁一次要全部副的首攻，`boards_index` 沒有首攻、逐筆讀紀錄太慢；合約與莊家墩數仍從 `boards_index` 接（`eventBoards`）。F5 之前打完的副沒有首攻，顯示「—」。
- 大小：一場 8 列座位＋最多 32 列結果，牌組 32 副約 2.4 KB，沒有負擔。

**刪除帳號**（`TeamMatchStore.forget`）：他主辦、還在準備的比賽 `cancelled`；別人的準備中比賽，他的座位清成空位（是 B 隊隊長就拿掉隊長）；比賽中的座位改成機器人代打，他打過的副照算；已結束的比賽保留他（名字顯示為已刪除的社員）。比賽中刪掉的是房主時，房主交給 A 隊第一位入座的真人，沒有就是 B 隊隊長，再沒有就是任何一位入座的真人（`setHost`，F5）；一個都沒有時機器人照打完，沒有房主。

**M2／E11**：拆分後每場比賽是一個 `Event` Durable Object（同挑戰），三張表原樣搬進去；VP（`e8-t22`）供 E9 的多隊賽用；分段（`e8-t21`）在 `match_boards` 不變的情況下加 `segments` 設定與每段的座位紀錄。

**各批做什麼**：

| 批 | 做什麼 |
| --- | --- |
| F2（本批） | 這份設計、`shared/team-scoring.ts`、`shared/team-match.ts`、三張表與 `TeamMatchStore`、建立／改設定／取消／讀取的 HTTP 與 `teamMatchView` |
| F3（已完成） | 座位邀請（接受、拒絕、換座位、離開、通知）、隊長制、準備室頁、補機器人、WebSocket 推送 |
| F4（已完成） | 開始（`team` 牌桌、共用 `DealSet`）、兩桌推進、牌桌層的資訊隔離、即時比分、結束與通知、比賽牌局進紀錄（`mode=team`、`event_id`、E4 篩選「隊制賽」） |
| F5（已完成） | 結果頁、斷線代打、超時裁定、暫停／繼續／同隊替補、中止、端對端測試；E11 的資訊隔離回歸測試（`e11-t13`） |
| M2 | 觀賽頁（Vugraph）、觀看延遲、賽後整場重播、分段與換位、VP |

## 5.5 挑戰（決策紀錄，`e7-t01`，2026-10-24）

挑戰（E7）：發起者邀請 1–20 位社員（不限好友，社長 2026-10-27），每個人各自坐南、和三個用同一種制度的 TKB 打同一組牌，打完比名次。這一節是 C2 定下的設計，後面的批次（C3–C9）照這裡做；要改設計先改這裡。

**資料模型**（`worker/challenges.ts` 的 `Challenge`，型別與狀態在 `shared/challenge.ts`）：

```
challenge（challenges 一列）
  ├─ settings  計分、機器人的制度（TKB 用淡江制度或 2/1）、Best Hand、Just Declare、截止天數、排名公開範圍（JSON）
  ├─ deals     DealSet：N 副的牌號與四手牌（shared/deal-set.ts，一副一行 PBN）
  ├─ players   challenge_players：invited → accepted｜declined；開打、完成時間、已知牌
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
- `createChallenge { invitees, boards?, settings? }`：`invitees` 是 1–20 個不重複的社員 id（`challengeInvitees`、`badChallengeSettings`），任何社員都可以，**不用是好友**（社長 2026-10-27，原本要是發起者關注的好友、回 `notFriend`；那個代碼留著不用）；發起者封鎖了對方要先解除（`unblockFirst`），不能是自己（`notSelf`）、不存在的帳號或機器人（`userGone`）；對方封鎖了發起者時回 `cannotInvite`，不說是被封鎖。`boards` 1–16，預設 8（`challengeBoards`；BBO 是 4–16，社長 2026-10-25 開放 1 副）。`settings` 由 `parseChallengeSettings`（`shared/challenge.ts`）檢查：每欄可省略、套 `defaultChallengeSettings`，不能有其他欄位；計分單挑只能 `imp`／`total`，多人 `mp`／`crossImp`／`total`；`unfinished` 只能是 `worst`；機器人的制度 `tku`／`gib`（機器人沒有等級，`robotLevel` 跟其他不認得的欄位一樣被拒絕）；`days` 1–7 的整數；錯了回 `badChallengeSettings { field }`。牌組用 `makeDealSet({ kind: 'random', count })`、社團的亂數。
- `answerChallenge { challengeId, accept }`：只有受邀、還沒回覆的人（發起者已經是 `accepted`，所以回 `alreadyAnswered`）；挑戰要是 `pending`／`active` 而且還沒到截止時間（`challengeClosed`）。不是參與者的一律 `challengeGone`，不透露挑戰存在。
- `cancelChallenge { challengeId }`：只有發起者（`challengeCreatorOnly`），只在 `pending`／`active`，而且除了他以外沒人有 `started_at`（`challengeStarted`；發起者自己先打了不影響）。
- 截止時間的處理寫成 `deadlineOutcome`（沒回覆的改 `declined`，除了發起者沒人接受就 `expired`，否則 `finished`），C5 的期限工作呼叫它並結算（見上面的「期限工作與結算」）。

**對象與牌組**（2026-10-24 社長決定，2026-10-27 改）：可以邀請任何社員，不用是好友（原本只能邀請好友；好友介面隱藏了，見 §5「好友與封鎖」），雙方任一方封鎖另一方都不行，選人是可以搜尋的輸入框（`e7-t17`）；全社的每週挑戰（`e7-t23`）由管理員建立，不受這條限制。牌組**只用隨機牌**（`makeDealSet({ kind: 'random' })`，不用條件預設集），選項只有 Best Hand 與 Just Declare。唯一的例外是「用這副牌挑戰」（`e7-t22`）：發起者拿自己打過、可以先收藏的牌（`kind: 'given'`）挑戰別人，他不再打，建立時就把他當時的結果寫進 `challenge_results`（`known_deals = 1`），照樣計分、排名。他當時不一定坐南，所以牌組轉成讓他的座位變成南，結果也換成南北的角度。只限他和三個機器人打的牌，挑戰的機器人種類與等級鎖成當時的（紀錄裡的 `robotKind`、`robotLevel`），否則他的成績和別人的比不起來。

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
| `challenge_players` | `challenge_id`、`user_id`（主鍵兩欄）、`position`（邀請順序，發起者 0）、`status`、`invited_at`、`answered_at`、`started_at`、`finish_by`（不再使用）、`finished_at`、`known_deals` | `(user_id, challenge_id)` |
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

現有的種類：`application`（有人申請註冊，通知每位管理員，連到管理頁）；挑戰（§5.5）：`challengeInvited`（給受邀者）、`challengeAccepted`／`challengeDeclined`（給發起者）、`challengeCancelled`（給沒拒絕的人），參數是 `challengeId` 與對方的 `username`；`challengeReminder`（截止前 12 小時，給接受了還沒打完的人）與 `challengeResults`（挑戰 `finished` 時給每位接受的人），參數是 `challengeId`，由期限工作與結算送出（§5.5，`e7-t13`）；`friendOnline`（關注的人上線了，參數 `username`，連到大廳，§5.7；好友隱藏時不送）。受邀桌（`e2-t25`）：`tableInvited`，參數 `tableId`、`number`（桌號）與房主的 `username`，連到那一桌。隊制賽（§5.8，`e8-t04`）：`matchInvited`（給受邀者）、`matchAccepted`／`matchDeclined`／`matchLeft`（給安排那一隊的人）、`matchRemoved`（給被移出的人，連到 `/matches`）、`matchCancelled`（給座位上的人），參數是 `matchId` 與做這件事的人的 `username`，其餘連到那場比賽的準備室。搭檔（淡江橋譜 E2，`e2-t03`）：`pairInvited`（給受邀者）、`pairAccepted`／`pairDeclined`（給邀請者）、`pairEnded`（給另一位），參數 `pairId` 與做這件事的人的 `username`，連到淡江橋譜的搭檔頁（`/pairs/:id`，橋譜 C4 做；鈴鐺用整頁開啟另一個網站）。精選（`e4-t29`）：`boardFeatured`，第一次設為精選時給打那副的社員（不含機器人與設精選的人自己；之後編輯不再通知），參數 `boardId` 與設的人的 `username`，連到那副的紀錄頁。挑戰頁出來前（C6）挑戰的通知連到大廳。受邀桌等之後各自加；私訊不進通知中心（§5.7）。PWA 推播是 `e1-t28`（M2）。

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

**紀錄頁**（`e4-t16`～`t21`）：`/history` 的篩選與排序都寫在網址（`/history?scope=all&level=4&strain=S&sort=score_desc`），重新整理或分享連結都是同一份清單；頁面用 `readHistoryQuery` 讀網址（不認得的參數直接略過，不像 API 回錯誤）、用 `historyQueryString` 寫回，條件改了就回第 1 頁。日期的「今天／本週（從週一）／本月」由 `datePresetRange` 換成台灣日期的 `from`／`to`。篩選介面在 `src/components/HistoryFilters.tsx`。用到的條件在清單上方顯示成標籤（`src/lib/historyChips.ts` 的 `filterChips`：階數＋花色合成一個「合約」、起訖日期合成一個「日期」），每個可單獨移除，「清除全部」只清條件、保留範圍、排序與每頁筆數（e4-t22）。手機版篩選收合在「篩選（n）」按鈕裡，按了才展開，展開後有「完成」收回；寬螢幕開啟帶條件的連結時直接展開。

## 5.2 與淡江橋譜共用帳號

淡江橋譜（TKU BridgeBook，Vercel 上的靜態網站）沒有自己的後端，帳號與線上內容都在這個 Worker：

```
橋譜的瀏覽器 ──/api/*──► Vercel（vercel.json rewrite）──► 這個 Worker ──► Durable Object
             └─匯入上傳（帶一次性憑證，直接連 Worker，不經過 Vercel）──┘
```

- **同一批帳號、各自的登入**：橋譜的 `/api/*` 由 Vercel 轉發，`tbt_session` cookie（沒有 Domain 屬性）因此屬於橋譜自己的網域。兩站用同一組帳號密碼，但要各自登入一次。`/ws` 不經過橋譜。
- **申請與核准**：`ClubService.register` 第一個帳號直接建立（管理員），之後一律存成 `app:<id>`，`adminApprove` 才建立帳號（受人數上限限制）。申請中的名稱不能被別人註冊；用申請時的密碼登入會得到 `awaitingApproval`。
- **忘記密碼**：`resetForgottenPassword(username, inviteCode, password)`，管理員帳號不行（`adminNoSelfReset`）；重設後登出所有 session 並記下 `passwordResetAt`。
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
| `POST /api/book/errors` | 不用登入，**不讀登入身分** | 淡江橋館的瀏覽器錯誤（e10-t06，§5.15）：`{ kind: 'error' \| 'rejection' \| 'boundary', message, source?, stack?, page?, version? }`；不是 JSON 物件、`kind` 不對、沒有 `message`、超過 8,192 字元（`Content-Length` 超過 4 倍也是）回 400。回 204（被限流時也一樣，靜默丟掉） |
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
| `GET /api/forum/search?q=&page=` | 社員 | `ForumSearch`：標題或文字區塊（段落、提示、條列）含每個詞（空白分開、最多 5 個、共 50 字；英文不分大小寫）的貼文，新→舊，一頁 20 則，多 `query`、`total`；留言、圖說、替代文字不搜。文字存在 `forum_posts.body_text`（舊貼文在 `createTables` 補）；`q` 空或太長回 400（e11-t10） |
| `GET /api/forum/latest` | 社員 | `ForumLatest`：公告板最新三則（置頂優先）與其他板最新三則（橋館首頁） |
| `GET`／`PATCH`／`DELETE /api/forum/posts/:id` | 社員；改只有作者；刪是作者或幹部 | `PostThread`（貼文與全部留言，舊→新）；`PostInput` → `{ post }`；別人的 403 `notYours`，不存在 404 `postGone` |
| `POST /api/forum/posts/:id/pin`、`/lock` | 幹部（`forumModerate`） | `{ pinned }`／`{ locked }` → `{ post }`；有變才寫審計、置頂通知作者 |
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
