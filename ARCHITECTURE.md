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
│  ├─ index.ts             Worker 入口：/api/* 與 /ws 轉給 Durable Object，其他交給靜態檔案
│  ├─ club.ts              Durable Object：HTTP 路由、WebSocket（hibernation）、儲存轉接
│  ├─ service.ts           ClubService：帳號、申請、session、牌桌、權限、牌局紀錄（可單獨測試）
│  ├─ book.ts              BookService：淡江橋譜的線上內容、版本、匯入草稿與憑證
│  ├─ importer.ts          淡江橋譜的 AI 匯入：Claude 的提示、回覆 schema、串流
│  ├─ views.ts             每位觀看者可見的牌桌畫面（可見性規則）
│  ├─ history-index.ts     紀錄的 SQL 索引：建表、寫入、搜尋（§5.3）
│  ├─ favorites.ts         收藏的 SQL 讀寫（§5.3）
│  ├─ notifications.ts     通知中心（§5.4）
│  ├─ relations.ts         好友與封鎖名單（§5）
│  ├─ direct-messages.ts   私訊的 SQL 表與 DirectMessageStore（§5.7）
│  ├─ log.ts               結構化日誌（§5.6）
│  ├─ rate-limit.ts        速率限制（§5.6）
│  ├─ client-errors.ts     瀏覽器錯誤回報的檢查（§5.6）
│  ├─ challenges.ts        挑戰的 SQL 表與 ChallengeStore（§5.5）
│  ├─ challenge-flow.ts    挑戰的狀態轉移（建立、回覆、取消、截止）：純函式，ClubService 寫回（§5.5）
│  ├─ team-matches.ts      隊制賽的 SQL 表與 TeamMatchStore（§5.8）
│  ├─ team-match-flow.ts   隊制賽開始前的步驟（建立、改設定、取消、能不能開始）：純函式（§5.8）
│  ├─ team-match-service.ts 隊制賽的 HTTP 動作，ClubService 建好交給 Durable Object（§5.8）
│  ├─ modes.ts             牌桌模式（casual、challenge）與三個掛勾（發新一副、寫紀錄、一副結束）
│  ├─ scheduler.ts         統一排程器：機器人、自動發牌、挑戰的提醒與截止都走同一個 alarm 佇列
│  ├─ auth.ts              PBKDF2 密碼雜湊、session cookie
│  └─ store.ts             儲存介面與測試用 MemoryStore
├─ src/                    React app
│  ├─ components/          牌、手牌、叫牌盒、叫牌過程、牌號、名牌、墩、面板、頁首、聊天
│  ├─ pages/               Login、Lobby、Table、History、Favorites、Board、Challenges、Challenge、Account、Admin
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
| 不允許觀看的桌上沒有座位的人（站起來或被請離座的玩家，`e2-t26`） | 只看得到所有人都看得到的：首攻後的夢家、防家攤過的牌；打完後四家（`boardView` 的 `kibitz: false`） |
| 所有人，打完後 | 四家原始牌與所有 Alert 說明 |
| Alert 說明 | 叫牌者的同伴在打完前看不到；機器人的說明除外（`AuctionCall.robot`），所有人都看得到，同 BBO 的 GIB |

指定牌組（`Table.dealSource` 的 `fixed`）整份只存在伺服器的 `Table` 裡，發到哪一副才放進 `BoardState.hands`，之後照上表的規則送出；`Table` 本身從不整份送到瀏覽器。

**挑戰**（§5.5）：挑戰的牌組（`DealSet`）只存在伺服器，參與者的挑戰牌桌發到哪一副才放進 `BoardState`。別人的結果（每一副的 traveller、總排名）只給**打完全部副數**的參與者，或挑戰結束後；還沒打完全部的人，連自己打過的那幾副也看不到別人的結果，因為知道自己領先或落後會影響後面的打法（社長，2026-10-24）；非參與者在結束前什麼都看不到（`e7-t14`，規則見下面的「讀挑戰」）。挑戰牌桌（C4）只是一般的牌桌：整組牌在伺服器的 `Table.dealSource`，`boardView` 只看得到正在打的那一副，所以看得到的牌和一般牌桌完全一樣；大廳不列出挑戰牌桌，別人 `joinTable`／`sit` 拿到 `tableGone`，不能觀看。挑戰牌局的紀錄寫入時 `revealAt` ＝截止時間，挑戰一結束（完成、過期、取消）就提前到結束的那一刻，之後所有人都看得到（`recordVisible`）；在那之前只有打的人看得到，另外**打完全部副數的參與者**也能打開別人的紀錄（traveller 與重播，`challengeBoardVisible`，只在 `/api/history/:id`；搜尋仍只列自己打的）。

讀挑戰（`challengeView`，`GET /api/challenges`、`/api/challenges/:id`）：牌組永遠不送。

| 誰 | 挑戰進行中 | 挑戰結束後 |
| --- | --- | --- |
| 參與者（受邀、接受、拒絕都算） | 設定、狀態、每個人的回覆與打了幾副；**沒打完全部的人只有這些**，打過的副也看不到別人的結果 | 同左，再加下面全部 |
| 打完全部的參與者 | 再加每一副的 traveller（每個人的合約、莊家、墩數、南北分數、牌局 id）、目前排名（只排已經打完的人）與人 × 副矩陣 | 最終排名與矩陣（`finished` 才有排名；`expired`、`cancelled` 沒有） |
| 非參與者 | 404 | `ranking = club` 且 `finished`：排名（名次與總成績，不含每副分數、traveller）；否則 404 |

`GET /api/challenges` 的列表不帶 traveller（給大廳用），單一挑戰才帶。這些判斷都在 `worker/views.ts`（`challengeView`、`challengeBoardVisible`），測試在 `tests/worker/challenge-settlement.test.ts`。

**隊制賽**（§5.8，`teamMatchView`，`GET /api/matches`、`/api/matches/:id`）：牌組永遠不送；比賽中的牌桌只是兩張一般牌桌，看得到的牌和一般牌桌一樣，額外的限制在牌桌層（F4 的 `e8-t09`）。

| 誰 | 準備中（`setup`） | 比賽中（`playing`） | 結束（`finished`／`abandoned`） | 取消（`cancelled`） |
| --- | --- | --- | --- | --- |
| 房主、被邀請或已入座的人（「參賽者」） | 設定、8 個座位與狀態 | 同左，加**兩室都打完（或已裁定）**的每一副：兩室的南北分數、牌局 id、各隊得分與總分；只打完一室的那一副不顯示 | 全部 | 設定與座位 |
| 其他社員 | 404 | 同參賽者（觀看者本來就能看兩桌） | 全部 | 404 |

牌桌層（`e8-t09`，**建議預設**）：參賽者不能 `joinTable`／`sit` 另一室的牌桌，也不能觀看自己這一室以外的桌（隊友在另一室也不行），錯誤 `matchOtherRoom`；比賽中的牌桌不列在大廳的一般牌桌裡，改列在「隊制賽」；非參賽者可以觀看兩桌（同 BBO Vugraph），觀看者的聊天只給觀看者，參賽者的聊天只在本桌（`chatFor` 依角色過濾）。比賽牌局的紀錄帶 `eventId`＝比賽 id 與 `revealAt`：**某一副兩室都打完就公開那一副**（兩室各一筆紀錄一起改），比賽結束或中止時其餘的一起公開；在那之前只有打那一副的四位看得到（`recordVisible`）。

單副的 traveller（C7，`GET /api/history/:id/traveller`，`challengeTraveller`）：就是 `challengeView` 給這個人的那一副 traveller，不多給——打完全部副數的參與者、或挑戰結束後的參與者才拿得到，其他人（還沒打完的、非參與者）一律 `null`；伺服器再從那幾副的紀錄補上莊家是誰與首攻，以及排名矩陣裡那一副的分數。並排重播（`/history/:id/vs/:other`）兩邊都走 `/api/history/:id`，所以照樣由 `recordVisible`／`challengeBoardVisible` 把關。

**打完的牌局什麼時候公開**（AC-4.9，`recordVisible`）：紀錄可以帶 `revealAt`（挑戰、隊制賽還在進行時）。在那之前，只有打那一副的四位看得到；其他人在紀錄列表、搜尋、詳細頁、牌桌側欄的 `recent`、收藏、精選都看不到。**收藏**（§5.3）：只能收藏 `recordVisible` 看得到的牌——還沒公開的挑戰／隊制賽牌局只有打的四位能收藏，別人收藏或查詢都拿到跟不存在一樣的 `boardGone`（404），連「打完全部副數、可以看 traveller」的參與者也要等公開；「我的收藏」列表走同一個 `searchBoards`，照樣套用 `reveal_at` 的規則。筆記與標籤只有收藏的人自己讀得到：每個查詢都以自己的 id 為條件，沒有讀別人收藏的 API。**精選**（§5.9）：只有已經公開的牌（沒有 `revealAt` 或已經過了）才能設為精選——打過那副的策展人拿到 `featuredNotRevealed`，沒打過的拿到 `boardGone`，不透露那副牌存在；精選的列表與單副讀取也再套一次 `recordVisible`。搜尋在 SQL 裡套同一條規則（`reveal_at IS NULL OR reveal_at <= 現在 OR 我打過`），而且不管搜尋什麼條件都會套用，前端無法關掉。

**封鎖與聊天**（AC-1.6，`chatFor`）：牌桌聊天照每位觀看者過濾，他封鎖的社員說的話不會送到他的瀏覽器；其他人照常看得到，解除封鎖後保留的訊息會再出現。大廳的 `friends`／`blocked` 只送社員自己的名單，別人封鎖或加了誰不會送出。

**私訊**（AC-1.7，§5.7）：一則私訊只送給它的兩位成員（雙方所有分頁的 `direct`），對話列表 `directs` 只送自己的；`GET /api/messages/:userId` 只讀「自己與對方」這一對的訊息，SQL 以兩人 id 組成的 `pair` 查詢，拿不到別人之間的對話。被對方封鎖的人只會收到「不能傳私訊給他」（`cannotMessage`），不會知道被封鎖。

瀏覽器拿到的 `BoardView` 只包含它能看的牌，以及伺服器算好的 `legalCalls`／`legalCards`／`canUndo`／`canClaim`，畫面不需要自己判斷規則。攤牌被拒絕後，`rejectedClaim` 記下誰拒絕，直到下一個動作。

## 5. 通訊與儲存

**HTTP**：`GET /api/challenges`（我參與的挑戰，新的在前）、`/api/challenges/:id`、`POST /api/challenges`（建立）、`POST /api/challenges/:id/answer`、`/cancel`（§5.5）、`GET /api/matches`（我主辦或有座位的隊制賽，新的在前）、`/api/matches/:id`、`POST /api/matches`（建立）、`POST /api/matches/:id/settings`、`/cancel`（§5.8）、`GET /api/featured`（全部精選，新的在前）、`GET /api/featured/:boardId`（那副的精選或 `null`）、`POST /api/featured/:boardId`（設為精選或編輯，要 `boardCurate`）、`DELETE /api/featured/:boardId`（取消精選，§5.9）、`POST /api/register`（第一個帳號直接登入，之後回 202 `{ pending }`）、`/api/login`、`/api/logout`、`/api/password/reset`（忘記密碼）、`/api/account/password`、`/api/account/preferences`（`friendOnlineNotice`：好友上線提示開關，`e1-t24`）；`GET /api/messages/:userId?before=<id>`（與某位社員的私訊，一頁 30 則，§5.7）；`GET /api/me`（含 `permissions`，管理員另有 `applications` 待審核數）、`/api/history?scope=all&page=<n>&size=<10|20|50|100>`（回傳該頁與總數）、`/api/history/search?<條件>`（§5.3）、`/api/history/:id`。維運：`GET /api/health`、`POST /api/client-errors`（§5.6，都不需登入）。管理員：`GET/POST /api/admin/users`、`POST /api/admin/users/:id/password`、`POST /api/admin/users/:id/admin`、`POST /api/admin/users/:id/permissions`、`DELETE /api/admin/users/:id`、`GET /api/admin/applications`、`POST /api/admin/applications/:id/approve`、`DELETE /api/admin/applications/:id`、`GET/POST /api/admin/settings`、`DELETE /api/admin/tables/:id`。淡江橋譜的 `/api/book/*` 見 §5.2。session 放在 HttpOnly、SameSite=Lax 的 cookie（`tbt_session`）。錯誤回應帶 `code` 與 `params`（`shared/messages.ts`），瀏覽器依語言顯示。

**WebSocket** `/ws`（同網域，帶 cookie 驗證）：

- 瀏覽器 → 伺服器：`createTable`（可帶 `settings`、`invitees`）、`updateTableSettings`（可帶 `invitees`）、`quickSeat`、`joinTable`、`sit`、`stand`、`leaveTable`、`kick`、`addRobot`、`removeRobot`、`replaceWithRobot`、`call`、`play`、`claim`、`claimRespond`、`undoRequest`、`undoRespond`、`chat`、`readNotifications`（不給 `ids` 就是全部標為已讀）、`setFriend`、`setBlocked`、`createChallenge`、`answerChallenge`、`cancelChallenge`、`playChallenge`（§5.5）、`sendDirect`、`readDirect`（§5.7）。`kick`、`addRobot`、`removeRobot`、`replaceWithRobot`、`updateTableSettings` 只有房主能用；房主離開或斷線時，桌上第一位在線的真人（先入座者、再觀看者）接手
- 伺服器 → 瀏覽器：`welcome`、`lobby`（牌桌列表與 `members`：每位社員是否在線、在哪一桌哪個座位，線上在前、各組裡自己的好友置頂；`friends`、`blocked` 是自己的名單）、`table`、`error`、`notifications`（連線時一次，之後內容有變才送：最新 30 則與未讀數）、`directs`（自己的對話列表與私訊未讀數，同樣只送有變的）、`direct`（一則新私訊，只給它的兩位成員）
- **只送有變的部分**：伺服器記住每位社員上次收到的大廳與牌桌（JSON），沒變就不送；牌桌的 `chat` 與 `recent`（本桌最近 30 副的摘要）只在改變時才附上，瀏覽器沿用手上那份（`TableWire`）。所以某桌出一張牌，大廳裡的人什麼都收不到，桌上的人只收到小小一份。新連線一律收完整資料
- **沒有「下一副」**：一副結束後伺服器設定 `dealAt`（打到最後一張多等 `LAST_TRICK_MS` 3.5 秒，再加 `DEAL_COUNTDOWN_MS` 3 秒倒數），時間到自動發牌；`table` 訊息附上伺服器時間 `now`，瀏覽器據此換算成自己的時鐘來倒數
- **牌桌設定**：`Table.settings`（`shared/protocol.ts` 的 `TableSettings`）：`visibility`（`public` 所有社員可入座／`invite` 只限受邀）與 `allowKibitz`（是否允許觀看）與 `boardMinutes`（每副時間上限，`BOARD_TIME_LIMITS` 0／5／7／10／15 分鐘，0 是不限）；舊資料缺的欄位用 `DEFAULT_TABLE_SETTINGS`（公開、允許觀看、不限時）。伺服器用 `parseTableSettings` 檢查，只接受這三欄，錯了丟 `badTableSettings`。挑戰牌桌固定是只限受邀、不允許觀看、不限時，不能改
- **受邀桌**（`e2-t25`）：`createTable`／`updateTableSettings` 可帶 `invitees`（社員 id，最多 `LIMITS.tableInvitesMax` 30 位，給了就取代 `Table.invited`），新加入名單的人收到 `tableInvited` 通知。不能邀請自己（`notSelf`）、不存在的帳號（`userGone`）、自己封鎖的人（`unblockFirst`），對方封鎖了房主時只回中性的 `cannotInvite`（同挑戰，房主看不出被封鎖）。只限受邀的桌照樣列在大廳，`TableSummary.welcome` 告訴觀看者能不能來；不在名單上的人 `sit`、`joinTable` 都拿到 `notInvited`。房主、已經在桌上的人（改成受邀桌之前就在的）不受影響。名單只送給房主（`TableView.invited`）
- **不允許觀看**（`e2-t26`）：`joinTable` 回 `noKibitzing`，只能 `sit`；桌上沒有座位的人（站起來、被請離座）照 §4 只看得到公開的牌
- **計時**（`e2-t27`、`e2-t28`）：發牌時記 `Table.boardStartedAt`，有時間上限時 `TableView.boardEndsAt`＝發牌時間＋上限（伺服器時鐘，瀏覽器用 `now` 換算），輪到的人名牌上倒數，時間到變紅「超時」；**時間到不強制結束**，超時裁定留給隊制賽（`e8-t15`）。`TableView.waiting` 是桌子在等哪一位真人（叫牌或出牌的控制者；攤牌、撤回待回覆時不算）與從什麼時候開始（`Table.turnSince`，每個動作、入座、換人都重算）。等超過 `SLOW_TURN_MS`（60 秒）名牌閃爍、本人再聽到一次提示音，房主可以 `replaceWithRobot`（伺服器檢查真的在等他且滿 60 秒，否則 `notSlow`）：他留在桌上沒有座位，座位換成 TKB
- **大廳排序與快速入座**（`e2-t29`、`e2-t30`，`shared/lobby.ts`）：缺人的桌在前，缺越少越前面（最快能開打），滿的桌在後，同組照桌號；大廳卡片標「缺 N 家」。`quickSeat` 選第一張缺人、可以入座（公開或受邀、房主沒封鎖他）的桌，坐第一個空位（南、北、東、西）；都滿就開新桌（預設設定）。已經坐在別桌的人會換過去
- **斷線代打**（`e2-t31`）：一般牌桌上入座的真人斷線（最後一個 socket 關閉）滿 `SUBSTITUTE_MS`（3 分鐘），排程器的 `substitute:<社員>` 工作讓 TKB 坐進他的座位（同伴是機器人就用同伴的制度），`Table.substitutes` 記座位 → 本人，名牌顯示「代打 某某」（`SeatOccupant.substituteFor`）；只在桌上還有別的入座真人在線時才代打。本人重新連線（`connected`）立刻換回原座位（機器人換座位時記號跟著走）；別人坐進代打的座位、房主移走它，代打就結束。這一副有代打過，紀錄的 `BoardRecord.substitutes` 記座位與本人，單副紀錄頁的明細列出「北 · 代打 某某」（`RecordSubstitutes`）。斷線時間在記憶體（`offlineSince`），物件被回收後 `load()` 把離線的入座者從現在重新起算
- **牌桌模式**：`Table.mode`（`casual` 或挑戰的 `challenge`，舊資料沒有這欄也當 `casual`）與 `modeState`；`ClubService` 只在三個地方問模式（`worker/modes.ts` 的 `TableModeHooks`，都拿到 `ModeContext`：社團的亂數、現在時間、`ChallengeStore`）：發新一副（`deal`，回傳牌號與四手牌，`null` 表示沒有下一副，最後一副留在桌上）、寫紀錄（`record`）、一副結束（`boardFinished`，在紀錄存好之後，所以拿得到牌局 id）。叫牌、出牌、入座與可見性在每種模式都一樣。牌從 `Table.dealSource` 來（`shared/deal-source.ts`；沒有就是每副重洗）
- **排程**：機器人的下一步與自動發牌都交給同一個排程器（`worker/scheduler.ts`），每桌每種工作一個 key（`robot:<桌>`、`deal:<桌>`），每個進行中的挑戰一個 `challenge:<挑戰>`（§5.5），每位斷線的入座者一個 `substitute:<社員>`（代打），同一個 key 還在等就不重排。Durable Object 用 `AlarmQueue`：工作放在記憶體，只把最早的一個設成物件唯一的 storage alarm（`alarm()` → `ClubService.runDue()`），所以不會互相覆蓋 alarm，物件在兩步之間也能休眠；工作不寫進儲存，物件被回收後由 `load()` 依牌桌狀態與進行中的挑戰重新排程。測試傳 `schedule` 換成手動佇列
- **心跳**：瀏覽器每 15 秒送 `ping`，由 `setWebSocketAutoResponse` 直接回 `pong`（不必喚醒物件）。40 秒沒收到任何訊息、分頁回到前景或網路恢復時，瀏覽器立刻重新連線；重連期間的動作暫存 8 秒內補送
- **好友與封鎖**（AC-1.6，`worker/relations.ts`）：好友是單向關注，不需對方同意、也不通知對方（同 BBO）；`setFriend`／`setBlocked` 帶對方的 id 與 `true`／`false`，不能對自己（`notSelf`）、不存在的帳號或機器人（`userGone`）。封鎖會同時取消關注，封鎖中不能加好友（`unblockFirst`）。封鎖的效果都在伺服器：被封鎖者的聊天對封鎖者隱藏（§4），封鎖者當房主時被封鎖者不能 `joinTable` 或 `sit` 進那一桌（`blockedByHost`；已經在桌上的不會被請走）。私訊（`e1-t27`，§5.7）與挑戰邀請（`e7-t05`）也檢查 `blocks`，之後的隊制賽邀請也要。帳號刪除時雙方名單裡的他都會刪掉
- 使用 Durable Object 的 hibernation API：沒人打牌時物件可以休眠，WebSocket 不會斷，醒來時從儲存重新載入。

**儲存**（Durable Object 的 key-value，SQLite 後端）：

| Key | 內容 |
| --- | --- |
| `user:<id>` | 帳號、密碼雜湊、是否管理員、橋譜權限、最後登入時間、自行重設密碼的時間、關掉好友上線提示（`friendOnlineNotice: false`） |
| `app:<id>` | 待審核的註冊申請：帳號名稱、密碼雜湊、自我介紹、從哪個網站申請 |
| `session:<token>` | userId、到期時間 |
| `table:<id>` | 牌桌：座位、觀看者、目前這副、聊天、撤回請求 |
| `board:<id>` | 一副牌的完整紀錄（原始四手牌、叫牌、出牌、結果） |
| `hist:<時間>-<id>` | 全社團的紀錄索引（摘要，補零的時間讓列表依時間排序） |
| `uhist:<userId>:<時間>-<id>` | 每位社員自己的紀錄索引 |
| `featured:<boardId>` | 精選牌局（§5.9）：標題、分類、講解、逐墩講解、誰先設的與時間、那副牌設精選時的摘要（`BoardSummary`）；帳號刪除時保留，設的人顯示「—」 |
| `notif:<userId>:<時間>-<id>` | 通知（`worker/notifications.ts`）：種類、參數、時間、是否已讀；每人只留最新 500 則，帳號刪除時一起刪 |
| `friend:<userId>:<friendId>` | 社員關注的好友（單向），值是 `{ at }`；載入時全部讀進記憶體 |
| `block:<userId>:<otherId>` | 社員封鎖的對象，值是 `{ at }`；載入時全部讀進記憶體 |
| SQL `challenges`、`challenge_players`、`challenge_results` | 挑戰的正本（不是索引），見 §5.5 |
| SQL `matches`、`match_seats`、`match_boards` | 隊制賽的正本（不是索引），見 §5.8 |
| SQL `direct_messages`、`direct_threads` | 私訊的正本，見 §5.7 |
| `meta:settings` | 管理員改過的人數上限與邀請碼（沒改過就用環境變數） |
| `meta:weekly` | 每週社團挑戰的排程、誰存的、上一場的時間與 id（`worker/weekly-challenge.ts`，§5.5） |
| `meta:schema` | 資料版本（現在是 3）：1→2 把舊版 `board:<時間>-<id>` 搬到新索引；2→3 把所有 `board:` 回填進 SQL 紀錄索引（§5.3） |
| `meta:backfill` | 回填 SQL 索引時做到哪一個 `board:` key；做完就刪掉，物件中途被回收時從這裡接著做 |
| `book:entry:<slug>` | 淡江橋譜線上修改的特約（版本、誰在何時改；`convention: null` 表示隱藏），內容在 `bookpart:` |
| `book:rev:<slug>:<時間>-<id>` | 每次儲存、隱藏、還原的版本紀錄 |
| `book:category:<id>` | 淡江橋譜線上編輯過的分類（`{ id, label, description, order }`）；沒有任何一筆時橋譜用它內建的分類 |
| `book:categoryInfo` | 分類的版本號（`baseVersion` 用）與最後修改的人、時間 |
| `book:draft:<時間>-<id>` | AI 匯入產生的草稿（只留最新 30 份） |
| `book:ticket:<token>` | 匯入上傳用的一次性憑證（10 分鐘） |
| `book:version` | 橋譜線上內容的版本號，`GET /api/book/content` 與 `/api/book/manifest` 的 ETag；分類改了也會加一 |
| `bookpart:<key>:<n>` | 大內容的分段（Durable Object 單筆值上限 128 KiB，以 4 萬字一段儲存） |

每個動作處理完立即寫回，物件隨時被回收都不會遺失牌局。紀錄列表一次只讀到那一頁為止（每頁 10／20／50／100 筆摘要）。

**容量**：免費方案每個帳號 5 GB；一副牌的紀錄連同兩筆索引約 4 KB，大約可存一百萬副以上。

### 5.6 可觀測性與輸入防護（`e11-t08`～`e11-t11`）

- **結構化日誌**（`worker/log.ts`）：每個事件一行 JSON，Workers Logs（`wrangler.jsonc` 的 `observability`）依欄位索引。`action`：WebSocket 動作的種類、userId、耗時（ms，含廣播）、失敗時的錯誤代碼；`rejected`：沒進到處理函式的訊息（格式、大小、速率）；`http`：每個請求的方法、路徑（不含 query）、狀態、耗時、錯誤代碼；`loginLocked`；`clientError`；`crash`（不是 `ClubError`／`GameError` 的例外，層級 error）。**不記密碼、token、cookie、聊天內容。** `ClubService` 只拿到 `ClubConfig.log` 這個函式，不碰 Cloudflare API；測試傳陣列收集
- **健康檢查** `GET /api/health`（不需登入）：`{ ok, now, tables, online }`，只有數量；回得來表示 Worker 與 Durable Object 都載入了
- **前端錯誤回報**（`src/lib/errorReport.ts`）：`window` 的 `error` 與 `unhandledrejection` → `POST /api/client-errors`（`sendBeacon`，不需登入）。瀏覽器送之前去除個資（`shared/scrub.ts`：URL 的 query 與 fragment、e-mail、6 位以上的數字；只送路徑不送網址參數；不帶 userId），同一個錯誤只送一次、每頁最多 5 則、取樣比例 `REPORT_SAMPLE_RATE`（社團小，目前 100%）。伺服器（`worker/client-errors.ts`）只留已知欄位、截斷長度、再去除一次個資，全社團每秒最多約 1 則（突發 20 則）寫進日誌，不存資料庫
- **訊息驗證**（`shared/message-guard.ts` 的 `parseClientMessage`）：WebSocket 訊息在 `ClubService.handleRaw` 入口檢查：最多 `MESSAGE_MAX_CHARS`（8,192 字元，二進位訊息只解碼到超過上限為止）、是 JSON 物件、`type` 是 1–40 個英文字母、已知種類的欄位型別對（型別守衛）。不合法就回 `error`（`messageTooLarge`／`badMessage`），不會進到處理函式。**沒有列在守衛裡的新種類只做形狀檢查**，所以新動作不必先改守衛；值的檢查（座位、範圍、權限）仍在各處理函式。HTTP 的 JSON 本文上限 2 MiB（`Content-Length`），超過回 413 `messageTooLarge`
- **速率限制**（`worker/rate-limit.ts`，記在記憶體，物件被回收就重算）：每位社員（所有分頁合計）的訊息 token bucket，突發 30、每秒 10（重連時補送的動作要過得去），超過回 `slowDown` 並丟掉；聊天另外突發 5、每 2 秒 1 句，超過回 `chatTooFast`；私訊另外突發 10、每分鐘 20 則，超過回 `directTooFast`；密碼錯誤以「來源 IP（`CF-Connecting-IP`）＋帳號」計 5 次、單一 IP 計 20 次，15 分鐘內再登入回 429 `tooManyLogins`（連密碼對了也一樣），密碼對了就清掉該帳號的次數。不鎖整個帳號，避免陌生人從別處把社員鎖在外面。速率只在 socket 入口（`handleRaw`）檢查，`handle` 本身不限，測試與機器人照常

### 5.7 私訊（`e1-t25`～`e1-t27`）

- **儲存**（`worker/direct-messages.ts`，Durable Object 的 SQLite，不經記憶體快取）：`direct_messages`（`id` 整數遞增、`pair`＝兩人 id 排序後以 `:` 相連、寄件者、收件者、內文、時間），每一對只留最新 `DIRECT_KEPT` 1,000 則；`direct_threads` 每人每個對話一列（對方、最新一則的 id、讀到哪一則），對話列表與未讀數各一個查詢。帳號刪除時他的訊息與雙方的對話列一起刪，對方收到新的 `directs`
- **送出**：`sendDirect { to, text }`。伺服器去頭尾空白（空的就忽略）；不能給自己（`notSelf`）、機器人或不存在的帳號（`userGone`）；最多 `LIMITS.directMax` 500 字（`directTooLong`）；自己封鎖對方要先解除（`unblockToMessage`），被對方封鎖回 `cannotMessage`；每位社員突發 10、每分鐘 20 則（`directTooFast`，只在 socket 入口）。存好後把 `direct` 送給兩人在線的分頁，再各送一次 `directs`
- **讀取**：連線時送 `directs`（最新 50 個對話，每個帶對方、最新一則與未讀數，另有全部未讀數）；`GET /api/messages/:userId?before=<id>` 從最新往回一頁 30 則（舊的在前，`more` 表示還有更早的）。打開對話就送 `readDirect { userId }`，把對方寄來的都標為已讀
- **介面**：側欄（大廳、牌桌）的「訊息」分頁（`DirectMessages`）：對話列表與單一對話，分頁按鈕上有未讀數；社員分頁每一列的信封直接開啟與他的對話（個人檔案卡做好後也從那裡開）。私訊不另外進通知中心，未讀數就在「訊息」分頁上
- **好友上線提示**（`e1-t24`）：某位社員第一個分頁連上時，通知中心送 `friendOnline` 給**在線**、關注他、沒關掉提示、也沒被他封鎖的社員；同一個人 30 分鐘（`FRIEND_ONLINE_QUIET_MS`）內只提示一次，手機斷線重連不會一直跳。開關在「我的帳號」，存在伺服器的 `user:<id>`（`POST /api/account/preferences`）

### 5.9 精選牌局（`e4-t28`～`e4-t31`）

- **權限**：`boardCurate`（§5.2 的 `permissions`），管理員在管理頁開給社員；管理員本來就有。
- **資料**（`shared/featured.ts`、`worker/featured.ts` 的 `FeaturedService`，`ClubService.featured`）：一副牌最多一筆精選，存在 `featured:<boardId>`：標題（≤ 60 字）、分類（`bidding` 叫牌、`declarer` 坐莊、`defence` 防守、`other` 其他）、講解（≤ 4000 字）、逐墩講解（第 1–13 墩各 ≤ 1000 字，空的不存）、第一次設精選的人與時間、最後編輯時間，以及那副牌的摘要（列表不必讀紀錄）。輸入由 `parseFeaturedInput` 檢查，錯誤 `badFeatured { field }`。全部精選在第一次用到時讀進記憶體。
- **規則**：只有公開的牌才能設（§4）；別的策展人可以編輯或取消，編輯保留原本設的人；第一次設精選時通知打那副的社員（`boardFeatured`，§5.4）。寫入算一次動作（速率限制，§5.6）。
- **介面**：頁首「精選牌局」→ `/featured`（`FeaturedPage`）：「全部」與四個分類的分頁、卡片（標題、合約與結果、分類、桌號與牌號、誰精選與日期），點了到 `/history/:id`。單副紀錄頁的 `FeaturedPanel`：標題、分類、講解；重播到第 N 墩時顯示那一墩的講解（`useTrickReplay` 的 `trick`），另有「第 N 墩」按鈕直接跳過去；有 `boardCurate` 的人在這裡設為精選、編輯（每一墩一個欄位）、取消。牌桌裡的紀錄對話框不顯示。

## 5.8 隊制賽（決策紀錄，`e8-t01`，2026-10-25）

隊制賽（E8，雙桌隊制賽，Teams of Four）：房主找齊 8 個人（不夠可補機器人），兩隊在開室與閉室打同一組牌，依兩室的南北分差計 IMP 或 BAM。這一節是 F2 定下的設計，後面的批次（F3–F5、M2）照這裡做；要改設計先改這裡。標「**建議預設**」的是 PRD 沒有定、F2 先選的做法，社長確認或改了之後拿掉這個標記。

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
| `playing` | `abandoned` | 房主中止（**建議預設**：中止前要先暫停，`e8-t16`）；已有結果的副照算，結果頁標「中止」 |

PRD 的 `ready` **不存**：能不能開始由座位與「誰在線」算出（`matchReady`，回傳不能開始的原因 `seats`／`robots`／`offline` 給準備室的按鈕，`e8-t06`），因為在線狀態不存。`finished`、`cancelled`、`abandoned` 之後不再改動（`isOpenMatch`）。

**設定**（`TeamMatchSettings`，`parseTeamMatchSettings` 檢查：每欄可省略，建立時套預設、改設定時套比賽現有的設定，不能有其他欄位，錯了回 `badMatchSettings { field }`）：

| 欄 | 範圍 | 預設 |
| --- | --- | --- |
| `teamNames` | 兩個字串，去頭尾空白後 0–20 字、不含控制字元 | `['', '']`：空的由瀏覽器顯示成該語言的「A 隊」「B 隊」（**建議預設**，伺服器不存介面文字） |
| `boards` | 4–32 | 8（**建議預設**） |
| `scoring` | `imp`／`bam` | `imp` |
| `boardMinutes` | 0（不限）或 3–30 分鐘 | 10（PRD；下限 3、上限 30 是**建議預設**） |
| `robots` | 是否允許機器人補位；關掉時已經坐著的機器人離座 | `true` |
| `robotKind` | `tku`／`gib`：整場所有機器人用同一種制度，兩室面對同一個機器人 | `gib`（同挑戰） |
| `invite` | `direct`（房主邀請到指定座位）／`captains`（隊長制） | `direct` |

PRD 寫的「機器人等級」不做：機器人只有一個 TKB、沒有等級（CLAUDE.md 規則 6），送 `robotLevel` 會被當成不認得的欄位拒絕。

**建立、改設定、取消**（F2，`e8-t03`）：都走 HTTP，`worker/team-match-service.ts` 的 `TeamMatchService`（`ClubService.matches`）。`ClubService` 只建它、在載入時建表、刪帳號時呼叫 `forget`，給它時鐘、id、`publicUserById` 與每位社員的速率限制（§5.6）；步驟是 `worker/team-match-flow.ts` 的純函式，錯誤一律是 `ClubError` 加 `shared/messages.ts` 的代碼。

- `POST /api/matches { settings?, seat? }` → `{ match }`：任何社員都能建立；`seat` 是 A 隊的座位 `{ room, seat }`（不是就 `badMatchSettings { field: 'seat' }`）。**一個人同時只能主辦一場還沒結束的比賽**（`setup`／`playing`，`matchOpen`，**建議預設**，避免準備室亂開）。
- `POST /api/matches/:id/settings { settings }` → `{ match }`：只有房主（`matchHostOnly`，403），只在 `setup`（`matchStarted`）。
- `POST /api/matches/:id/cancel` → `{ match }`：只有房主，只在 `setup`；寫 `ended_at`。開始之後要停只能中止（`abandoned`，F5）。
- `GET /api/matches` → `{ matches }`（我主辦或有座位的，新的在前）、`GET /api/matches/:id` → `{ match }`。看不到的比賽一律 `matchGone`（404），不透露比賽存在。
- F3 起加 WebSocket 推送（邀請、入座有變時推給這場比賽的人），F2 只有 HTTP。邀請要檢查封鎖（`blocks`，同挑戰的 `cannotInvite`）；**邀請對象不限好友**（**建議預設**：湊 8 人比挑戰難，任何社員都能邀請，被封鎖的除外）。

**計分**（`e8-t02`，`shared/team-scoring.ts`）：A 隊每副的淨分＝開室南北分數 − 閉室南北分數（A 在開室坐南北，閉室的南北是 B）。

- `imp`：淨分照 WBF IMP 表（`shared/imp.ts`）換算，IMP 給贏的那一隊（兩隊的數字都 ≥ 0，例如「A 23 : B 15」）。
- `bam`：淨分 > 0 得 1、= 0 各 ½、< 0 得 0。
- **裁定**（AC-8.6，`Ruling`：`avg`、`avgPlus`、`avgMinus` 加「給哪一隊」）：IMP 時 Avg 是 0、Avg+ 給那一隊 +3、Avg- 是 −3（也就是對方 +3）；BAM 時 Avg 各 ½、Avg+ 是那一隊 0.6／對方 0.4、Avg- 反過來（**建議預設**：比照 MP 的 60%／40%）。每副的結果都是零和。有裁定的那一副**以裁定為準**，就算兩室後來都打完了也一樣（裁定可以撤回，`setRuling(…, null)`）。
- 一副只有一室打完、又沒有裁定時不算分（`null`）；`scoreTeamMatch` 回傳每副結果、兩隊總分、已完成副數與領先的隊（同分是 `null`）。測試含手算的四副比賽（`tests/engine/team-scoring.test.ts`）。
- M2 的 VP（`e8-t22`）用總 IMP 差換算，也放在這個檔。

**開始與兩桌推進**（F4 的設計，`e8-t07`、`e8-t08`）：
- 牌桌模式 `team`（`TABLE_MODES` 加 `team`，`worker/modes.ts` 的掛勾），`modeState` 記比賽 id、房間與桌上這一副是第幾副（`seq`）；`Table.dealSource` 是 `dealSourceOf(deals)`，兩桌共用同一個 `DealSet`，牌號、發牌者與身價照 `DealSetBoard.boardNo`（1…N）。`DEAL_SET_MAX` 要從 16 提高到 32（挑戰仍由 `CHALLENGE_LIMITS.boardsMax` 限 16）。
- 開始時一次建好兩桌、依座位入座（機器人用 `settings.robotKind`）、同時發第 1 副；之後兩桌各自推進，不互等。最後一副打完停在結果，顯示「等待另一桌」。
- `boardFinished` 在一個 transaction 裡 `addResult(id, seq, room, …)`：同一室同一副第二次寫入會被擋（「每室每副只打一次」由程式保證，見 `TeamMatchStore.addResult`）；兩室都有結果時推比分（`e8-t10`），全部完成就 `finished`（`e8-t11`），通知 8 位參賽者。
- 兩桌都是 `invite`、只有座位上的人能坐；**不能撤回**（**建議預設**，同挑戰：比賽不撤回，`BoardView.canUndo` 一律 false）；`stand`、換座位、`kick`、`addRobot`、`removeRobot`、`updateTableSettings` 在比賽桌上不能用，改由比賽層處理（代打、替補）。
- 每副時間上限（`boardMinutes`）沿用 F1 的每副時間上限（`e2-t27`）；超時只提示，由房主裁定（`e8-t15`）。斷線代打沿用 F1 的 `e2-t31`。

**資訊隔離與可見性**：誰看得到什麼的表在 §4（「隊制賽」），判斷寫成 `worker/views.ts` 的 `teamMatchView`（F2 已實作，測試在 `tests/worker/team-matches.test.ts`）；牌桌層的限制（參賽者進不了另一室、觀看者聊天隔開、紀錄的 `revealAt`）是 F4 的 `e8-t09`，E11 的資訊隔離回歸測試（`e11-t13`）要涵蓋。比分條只用兩室都完成的副，所以快的一桌看不到慢的一桌在同一副的結果。

**未決問題的建議預設**（PRD 的兩題）：
- 機器人補位**不強制**兩室在對應座位（湊人已經很難）；但整場的機器人用同一種制度（`robotKind`）。準備室在兩室機器人不對稱時顯示提醒（`e8-t06`）。
- 觀看者（不是參賽者的社員）**可以看兩桌**的牌（同 BBO Vugraph）；參賽者（含被邀請還沒回覆、替補）在比賽中不能看另一室，自己隊的另一室也不行。

**儲存**：三張 SQL 表就是隊制賽的正本（同挑戰，不是索引）。

| 表 | 欄位 | 索引 |
| --- | --- | --- |
| `matches` | `match_id`（主鍵）、`host_id`、`created_at`、`status`、`started_at`、`ended_at`、`settings`（JSON）、`captain_a`、`captain_b`、`deals`（`encodeDealSet`，開始前是 null）、`open_table`、`closed_table` | `(status, created_at)` |
| `match_seats` | `match_id`、`room`、`seat`（主鍵三欄）、`status`（`empty`／`invited`／`seated`）、`user_id`（空位與機器人為 null）、`robot`（0／1）、`invited_at`、`answered_at` | `(user_id, match_id)` |
| `match_boards` | `match_id`、`seq`（主鍵兩欄）、`open_board_id`、`open_score_ns`、`open_at`、`closed_board_id`、`closed_score_ns`、`closed_at`、`ruling`、`ruling_team`、`ruling_reason`、`ruled_by`、`ruled_at` | — |

- 每副一列（不是每室一列）：一副的兩室結果與裁定放在一起，結果頁的逐副比較只讀一列；第一室打完或第一次裁定時才建立。
- 建立時一次寫好 8 列座位，之後只改不增減，所以「8 個座位都在」不必另外檢查。
- 和挑戰一樣不放記憶體快取，每次讀 SQL；表是新的，載入時 `CREATE TABLE IF NOT EXISTS`，沒有舊資料要搬，`meta:schema` 不變（仍是 3）。之後加欄位用 `PRAGMA table_info` 檢查、`ALTER TABLE ADD COLUMN`，同挑戰的 `reminded_at`。
- 大小：一場 8 列座位＋最多 32 列結果，牌組 32 副約 2.4 KB，沒有負擔。

**刪除帳號**（`TeamMatchStore.forget`）：他主辦、還在準備的比賽 `cancelled`；別人的準備中比賽，他的座位清成空位（是 B 隊隊長就拿掉隊長）；比賽中的座位改成機器人代打，他打過的副照算；已結束的比賽保留他（名字顯示為已刪除的社員）。比賽中刪掉的是房主時，房主權限交給 B 隊隊長或第一位在線的真人參賽者（F5，`e8-t16` 一起做）。

**M2／E11**：拆分後每場比賽是一個 `Event` Durable Object（同挑戰），三張表原樣搬進去；VP（`e8-t22`）供 E9 的多隊賽用；分段（`e8-t21`）在 `match_boards` 不變的情況下加 `segments` 設定與每段的座位紀錄。

**各批做什麼**：

| 批 | 做什麼 |
| --- | --- |
| F2（本批） | 這份設計、`shared/team-scoring.ts`、`shared/team-match.ts`、三張表與 `TeamMatchStore`、建立／改設定／取消／讀取的 HTTP 與 `teamMatchView` |
| F3 | 座位邀請（接受、拒絕、換座位、離開、通知）、隊長制、準備室頁、補機器人、WebSocket 推送 |
| F4 | 開始（`team` 牌桌、共用 `DealSet`）、兩桌推進、牌桌層的資訊隔離、即時比分、結束與通知、比賽牌局進紀錄（`mode=team`、`event_id`、E4 篩選「隊制賽」） |
| F5 | 結果頁、斷線代打、超時裁定、暫停／繼續／同隊替補、中止、端對端測試 |
| M2 | 觀賽頁（Vugraph）、觀看延遲、賽後整場重播、分段與換位、VP |

## 5.5 挑戰（決策紀錄，`e7-t01`，2026-10-24）

挑戰（E7）：發起者邀請 1–20 位好友，每個人各自坐南、和三個用同一種制度的 TKB 打同一組牌，打完比名次。這一節是 C2 定下的設計，後面的批次（C3–C9）照這裡做；要改設計先改這裡。

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
- `createChallenge { invitees, boards?, settings? }`：`invitees` 是 1–20 個不重複的社員 id（`challengeInvitees`、`badChallengeSettings`），每位都要是發起者關注的好友（`notFriend`；封鎖對方時已取消關注，所以也是這個），不能是自己（`notSelf`）、不存在的帳號或機器人（`userGone`）；對方封鎖了發起者時回 `cannotInvite`，不說是被封鎖。`boards` 4–16，預設 8（`challengeBoards`）。`settings` 由 `parseChallengeSettings`（`shared/challenge.ts`）檢查：每欄可省略、套 `defaultChallengeSettings`，不能有其他欄位；計分單挑只能 `imp`／`total`，多人 `mp`／`crossImp`／`total`；`unfinished` 只能是 `worst`；機器人的制度 `tku`／`gib`（機器人沒有等級，`robotLevel` 跟其他不認得的欄位一樣被拒絕）；`days` 1–7 的整數；錯了回 `badChallengeSettings { field }`。牌組用 `makeDealSet({ kind: 'random', count })`、社團的亂數。
- `answerChallenge { challengeId, accept }`：只有受邀、還沒回覆的人（發起者已經是 `accepted`，所以回 `alreadyAnswered`）；挑戰要是 `pending`／`active` 而且還沒到截止時間（`challengeClosed`）。不是參與者的一律 `challengeGone`，不透露挑戰存在。
- `cancelChallenge { challengeId }`：只有發起者（`challengeCreatorOnly`），只在 `pending`／`active`，而且除了他以外沒人有 `started_at`（`challengeStarted`；發起者自己先打了不影響）。
- 截止時間的處理寫成 `deadlineOutcome`（沒回覆的改 `declined`，除了發起者沒人接受就 `expired`，否則 `finished`），C5 的期限工作呼叫它並結算（見上面的「期限工作與結算」）。

**對象與牌組**（2026-10-24 社長決定）：只能邀請自己的好友（`worker/relations.ts`，被封鎖的不行），選人是可以搜尋的輸入框（`e7-t17`）；全社的每週挑戰（`e7-t23`）由管理員建立，不受這條限制。牌組**只用隨機牌**（`makeDealSet({ kind: 'random' })`，不用條件預設集），選項只有 Best Hand 與 Just Declare。唯一的例外是「用這副牌挑戰」（`e7-t22`）：發起者拿自己打過、可以先收藏的牌（`kind: 'given'`）挑戰別人，他不再打，建立時就把他當時的結果寫進 `challenge_results`（`known_deals = 1`），照樣計分、排名。他當時不一定坐南，所以牌組轉成讓他的座位變成南，結果也換成南北的角度。只限他和三個機器人打的牌，挑戰的機器人種類與等級鎖成當時的（紀錄裡的 `robotKind`、`robotLevel`），否則他的成績和別人的比不起來。

**挑戰牌桌**（`e7-t08`）：牌桌模式 `challenge`（`worker/modes.ts`），`modeState`（`ChallengeTableState`）記挑戰 id、參與者、桌上這一副是牌組的第幾副（`seq`），以及離開時坐的位子（`parkedSeat`）；`Table.dealSource` 是 `dealSourceOf(deals)`（`fixed`，整組牌只在伺服器的 `Table` 裡，§4）。一人一桌：真人坐南，北東西是設定裡同種類、同等級的機器人；不能觀看、不能撤回、不能換座位、大廳不列出。真人離開不關桌（「中途斷線視同暫停」，`e7-t12`），回來從下一副繼續。`boardFinished` 寫 `challenge_results`（同一副第二次寫入會被主鍵擋下，「每副只打一次」由資料庫保證）；`record` 加上 `mode=challenge`、`eventId`＝挑戰 id、`revealAt`。牌號、發牌者與身價照 `DealSetBoard.boardNo`（隨機牌組就是 1…N，照 16 副循環；「用這副牌挑戰」是轉過之後同樣發牌者與身價的那一號，見下面的 C8），C4 讓挑戰模式的發牌用它，不用 `boardsPlayed + 1`。

C4 的實作（2026-10-24）：
- **開打與續打**：`playChallenge { challengeId }`。只有 `accepted` 的參與者、挑戰還是 `pending`／`active` 而且沒過截止時間（`challengeTakesPart`）：不是參與者 `challengeGone`、受邀還沒接受或拒絕了 `challengeNotAccepted`、截止或結束了 `challengeClosed`（順便把他停著的桌子收掉）、全部打完或「已知牌」的發起者 `challengeDone`。第一次開一張新桌（`number` 是 0，不佔大廳的桌號），先離開他原本在的桌。發牌時找他還沒有結果的第一副（`nextSeq`），第一副發牌時寫 `started_at`。
- **離開＝暫停**（`e7-t12`）：`leaveTable`、開新桌、坐到別桌都會呼叫 `leave`；挑戰牌桌不關，只把他從座位拿下來、記住位子（他可能因為當莊換到北），桌子留在 `table:` 裡（物件回收後照樣載入）。座位空了就不發牌、機器人也不動。再送 `playChallenge` 就坐回原位：**打到一半的那一副原封不動接著打**（叫牌、出牌都在，不重發，也不能換一副重來，否則可以先看牌再重打），已經打完的那一副就倒數發下一副。斷線（沒送 `leaveTable`）時座位照舊保留，跟一般牌桌一樣，重連就回到桌上。牌桌頁卸載時照樣送 `leaveTable`，伺服器把它當暫停。打完最後一副後離開，或挑戰已經結束，桌子才關掉。
- **固定的桌子**：撤回 `challengeNoUndo`（`BoardView.canUndo` 一律是 false）；`stand`、換座位、`kick`、`addRobot`、`removeRobot`、`updateTableSettings` 是 `challengeTableFixed`；攤牌照舊由機器人判斷。桌子設定是 `invite`、不允許觀看。
- **結果**：`boardFinished` 在一個 transaction 裡寫 `challenge_results`（南北分數就是他的分數，換到北當莊也一樣）；最後一副寫 `finished_at`。**截止時間一到就停止**（同 BBO）：之後送來的叫牌、出牌一律回 `challengeClosed`，機器人也不再動（`challengeClosedAt`），打到一半的那一副作廢、不寫結果，還沒打的副也不再發。挑戰變 `finished`、結算與通知見上面的「期限工作與結算」（C5）。
- **確定性**（`e7-t09`）：TKB 沒有亂數、不刻意失誤，所以兩個人做一樣的叫牌與出牌，機器人的反應完全一樣，不需要種子（`tests/worker/challenge-table.test.ts`）。
- **紀錄**：`BoardRecord.mode = 'challenge'`、`eventId`、`revealAt` ＝截止時間；`boards_index.mode` 照 `record.mode` 寫。紀錄、側欄與牌局頁把挑戰的牌顯示成「挑戰」而不是桌號。
- **畫面**（`e7-t15`）：`TableView.challenge`（`TableChallenge`：第幾副、共幾副、打完幾副、截止時間）；牌桌頁首顯示「挑戰 · 第 3／8 副」與截止時間（`ChallengeBanner`），沒有房主設定、座位選單，撤回鍵停用並說明原因，打完全部顯示提示與回大廳的連結。大廳的「我的挑戰」列出現在能打的挑戰（開始打／繼續打），挑戰頁是 C6。

**挑戰頁**（C6，`e7-t16`～`e7-t18`，2026-10-25）：
- `/challenges`（`ChallengesPage`）：等待接受（受邀還沒回覆，或除了發起者還沒人接受）、進行中、已完成（結束了，或自己拒絕了）三個分頁（`src/lib/challenges.ts` 的 `challengeTab`）；每個挑戰列出對手的狀態與進度條、自己的進度、截止倒數，可以接受／拒絕、開始打／繼續打、取消（發起者，別人都還沒開打）。新通知進來就重新讀列表。
- 發起挑戰對話框（`ChallengeDialog`）：選人只列好友（`LobbyView.friends`），點輸入框列出全部，打字 150 ms 防抖後篩選，可多選；副數、計分（依人數 `scoringsFor`）、機器人的制度、截止天數、排名公開範圍，Best Hand、Just Declare 兩個勾選（C8），下方預覽。
- `/challenges/:id`（`ChallengePage`）：伺服器照 §4 給什麼就顯示什麼：名次、總成績、人 × 副矩陣（每格連到那一副的紀錄），自己那一列高亮，沒打完的列在下面標「未完成」與打了幾副；還沒打完全部的人只看到每個人的進度。
- 建立、回覆、取消也走 HTTP（`POST /api/challenges`、`/api/challenges/:id/answer`、`/cancel`），讓頁面立刻拿到結果；伺服器是同一套檢查（`ClubService.challengeRequest` 呼叫 socket 訊息的同一個處理），錯誤一樣是 `ClubError` 的代碼。開始打仍用 socket 的 `playChallenge`（要跟著伺服器進牌桌）。通知點下去：邀請到 `/challenges`，其他到那個挑戰的頁面。

**牌組的選項、再戰與「用這副牌挑戰」**（C8，`e7-t10`、`e7-t11`、`e7-t21`、`e7-t22`，2026-10-25）：全部在**建立時**決定、存進 `deals`，所以每位參與者拿到的完全一樣（純函式在 `shared/challenge-deals.ts`）。
- **Best Hand**（`bestHand`）：每副發好後轉一下，讓南拿四家點力（HCP）最高的一手；同點力時依 南、北、西、東 的順序取第一個（`BEST_HAND_ORDER`，南已經是最高就不轉）。轉牌是整副一起轉（`rotateHands`），發牌者與身價照牌號不變。
- **Just Declare**（`justDeclare`）：四個 TKB（設定裡的制度）先叫牌（`robotAuction`），南北當莊才留下，否則重發（每副最多 60 次，`JUST_DECLARE_TRIES`；做不到回 `serverError`，實際上不會發生）；可以和 Best Hand 一起用。叫牌存在牌組裡（`DealSetBoard.auction`，`encodeDealSet` 在那一行後面加 ` | 1C P 1H …`，載入時檢查要合法、要有合約），不靠「機器人每次都叫一樣」，部署新版機器人也不會讓莊家換邊。發牌時（`modes.ts` 的 `deal`）照存下的叫品重演一次（每個叫品都標機器人；機器人現在還是叫這個時帶上它的說明），桌子直接進入打牌；北當莊時照常由 `swapForDeclarer` 讓真人坐到北主打。首攻由莊家左手的機器人出，參與者從首攻之後開始。
- **每副都坐南**：發下一副前，替機器人當莊而換過座位的真人先換回自己的位子（`unswap`，#74），所以挑戰的參與者每副都從南開始；Just Declare 的叫牌重演完才照新合約換座位。
- **一鍵再戰**（`rematchChallenge { challengeId }`，HTTP `POST /api/challenges/:id/rematch`）：挑戰結束後（`finished`／`expired`／`cancelled`；還開著回 `challengeNotOver`），接受過的參與者（不是參與者 `challengeGone`、沒接受 `challengeNotAccepted`）邀請其他沒拒絕、帳號還在的人（沒人 `rematchNobody`），同樣的設定與副數、新牌組；走 `createChallenge` 的同一套檢查，所以他要關注每一位（`notFriend`），發起者是按再戰的人。人數變了、原本的計分不適用時用預設。「已知牌」的挑戰副數不到 4，再戰用 4 副。
- **用這副牌挑戰**（`createChallenge` 加 `fromBoards: string[]`，1–16 副不重複的紀錄 id；不能同時給 `boards`）：每副都要是他打的（不是就 `boardGone`，不透露存在）、已經公開（`revealAt` 沒過的挑戰牌局也是 `boardGone`）、另外三家都是機器人（`challengeRobotsOnly`）、而且是同一種制度（`challengeRobotKinds`）。設定的機器人制度鎖成那一種（送了別的回 `badChallengeSettings { field: 'robotKind' }`），Best Hand、Just Declare 不能開（`badChallengeSettings`）。他叫牌的座位（替機器人當莊而換過座位的，看叫品裡沒標機器人的那一家）轉成南（`boardAsSouth`）：發牌者與身價跟著轉，牌號換成 16 副循環裡同樣發牌者與身價的那一號（坐南就是原牌號；`boardNoFor`），他的分數換成他那一方的角度（坐東西就變號）。建立時就寫進他的 `challenge_results`（`board_id` 是原本的紀錄、`played_at` 是當時打完的時間）、`known_deals = 1`、`started_at`／`finished_at` 是建立時間（`newChallenge` 的 `known`）。紀錄頁的「用這副牌挑戰」只在他和三個同制度的機器人打、已公開的牌出現（`challengeRobotsOf`），對話框不給選副數、Best Hand、Just Declare，機器人鎖住；排名上他的名字後面標「已知牌」。
  - 已知的限制：traveller 裡他那一列的合約與莊家照原本紀錄的方位（沒有轉），分數是轉過的。

**每週社團挑戰、分享卡與端對端測試**（C9，`e7-t23`～`e7-t25`，2026-10-25）：
- **排程**（`shared/weekly-challenge.ts`、`worker/weekly-challenge.ts`）：管理員在挑戰頁（`/challenges` 的「每週社團挑戰」，只有管理員看得到）設定開關、星期幾、幾點、副數、計分（`mp`／`crossImp`／`total`，全社人多，不給 `imp`）、機器人的制度、截止天數。API 是 `GET`／`POST /api/admin/weekly-challenge`（`ClubService.weeklyChallenge`、`adminSetWeeklyChallenge`，設定錯了回 `badChallengeSettings { field }`）。存在 KV 的 `meta:weekly`（`WeeklyState`：排程、存的人、存的時間、上一場的排定時間與 id）。
- **時間一律是台灣時間**（UTC+8，台灣沒有日光節約），不跟著伺服器或管理員的瀏覽器走（`latestWeeklySlot`、`weeklySlotAfter`）。
- **工作**：統一排程器的 `weekly:<存的時間>` 工作（`JobKind` 的 `weekly`），排在「存檔之後、上一場之後」的第一個排定時間（`nextWeeklyRun`），所以存檔不會立刻開一場。改了排程就是新的 key，舊的工作醒來發現存的時間不同就什麼都不做。到時先把 `lastRunAt` 寫成這次的排定時間（失敗也不會開兩場）再建立挑戰；物件睡過好幾週，醒來只補開一場，下一場照排程。工作不存，`load()` 從 `meta:weekly` 重排。
- **建立**（`createWeeklyChallenge`）：`settings.weekly = true`（只有伺服器設；社員送這個欄位跟其他不認得的欄位一樣被拒絕）、`ranking = club`、不開 Best Hand／Just Declare、隨機牌。邀請**全社每一位社員**，不限好友、不看封鎖（是社團邀請，不是某個社員），也不受 20 人上限。發起者是存排程的那位管理員（照一般挑戰的規則自動接受、可以打）；他已經不是管理員或帳號刪了，就用最早的管理員。全社只有他一人時不開。每個人（含發起者）收到 `challengeWeekly` 通知，點了到挑戰大廳接受。接受、拒絕**不通知**發起者（不然管理員每週收幾十則）。之後的回覆、截止、結算、可見性都和一般挑戰一樣。
- **不能再戰**（`weeklyNoRematch`）：下週自動有新的一場。頁面標題顯示「每週社團挑戰」（`challengeTitle`），不顯示「某某發起」。
- **建議預設**（PRD 沒定，待社長確認）：
  - 預設關閉；開啟後預設 **星期一 20:00（台灣時間）、8 副、MP、TKB 淡江制度、7 天**（截止時間剛好是下一場開始的時間）。
  - 發起者＝存排程的管理員，自動接受；他不打就列在「未完成」（和一般挑戰的發起者一樣）。
  - 邀請全社、不看封鎖、不限人數；後來才加入的社員不會被補邀（等下一場）。
  - 全社只有兩人時 MP 改用 IMP（`scoringsFor` 的規則）。
- **分享卡**（`e7-t24`，`src/lib/shareCard.ts`、`ShareCardDialog`）：排名頁上**有名次的人**看得到「成績分享卡」，在瀏覽器用 canvas 畫一張 1200 × 630 的 PNG（連結預覽的尺寸）：網站名、挑戰名稱、名次（共幾人排名）、總成績、最精彩的一副（合約與結果、那一副的分數），顏色取自頁首的 token。可以下載；手機瀏覽器支援分享檔案時（`navigator.canShare`）多一個「分享」叫出系統的分享面板。只用伺服器已經給他的 `ChallengeView`，所以不會露出他還不能看的東西。**建議預設**：「最精彩的一副」＝他在挑戰計分裡分數最高的那一副，同分取前面的；結束前（他已打完、看得到即時排名）也能產生，卡下註明「目前排名」。
- **端對端測試**（`e7-t25`，`tests/worker/challenge-e2e.test.ts`）：三位真人經由真的挑戰牌桌與 TKB 打 4 副 MP 挑戰，其中兩人分兩次打完、一人打兩副就離開；截止時間到時結算，名次、總成績、每副分數與用他們實際的南北分數手算的 MP 一致，沒打完的人列在「未完成」（打了 2 副），三人都收到結果通知，停著的桌子收掉。

**Traveller 與並排重播**（C7，`e4-t32`、`e4-t33`、`e7-t19`，2026-10-25）：
- 型別在 `shared/traveller.ts`（`Traveller`、`TravellerEntry`：社員、合約、莊家、首攻、結果、南北分數、這一副在挑戰計分裡的分數），之後隊制賽、雙人賽用同一個型別（`kind`）。
- `GET /api/history/:id/traveller`：用這一副的任何一份紀錄都能問；可見性見 §4。
- 紀錄頁（`BoardPage`）在挑戰的牌下面顯示 traveller（`TravellerTable`），每一列可以「和他並排看」：和自己打的那一副比，自己沒打就和頁面上那一副比。
- 排名頁的人 × 副矩陣，點副號在下面打開那一副的 traveller，同樣可以並排看。
- 並排重播 `/history/:id/vs/:other`（`ComparePage`）：一組控制鍵同時逐墩播放兩邊，步數以較長的那一副為準（先攤牌的那一邊停在攤牌時）。

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

現有的種類：`application`（有人申請註冊，通知每位管理員，連到管理頁）；挑戰（§5.5）：`challengeInvited`（給受邀者）、`challengeAccepted`／`challengeDeclined`（給發起者）、`challengeCancelled`（給沒拒絕的人），參數是 `challengeId` 與對方的 `username`；`challengeReminder`（截止前 12 小時，給接受了還沒打完的人）與 `challengeResults`（挑戰 `finished` 時給每位接受的人），參數是 `challengeId`，由期限工作與結算送出（§5.5，`e7-t13`）；`friendOnline`（關注的人上線了，參數 `username`，連到大廳，§5.7）。受邀桌（`e2-t25`）：`tableInvited`，參數 `tableId`、`number`（桌號）與房主的 `username`，連到那一桌。精選（`e4-t29`）：`boardFeatured`，第一次設為精選時給打那副的社員（不含機器人與設精選的人自己；之後編輯不再通知），參數 `boardId` 與設的人的 `username`，連到那副的紀錄頁。挑戰頁出來前（C6）挑戰的通知連到大廳。受邀桌等之後各自加；私訊不進通知中心（§5.7）。PWA 推播是 `e1-t28`（M2）。

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
- **權限**：`StoredUser.permissions`：`bookEdit`（線上編輯）、`bookImport`（匯入檔案）、`boardCurate`（設精選牌局，牌桌用，§5.9）；管理員全部都有，管理頁的「權限」欄逐項勾選。`requirePermission` 在 `/api/book/*` 與 `/api/featured/*` 的寫入檢查。淡江橋譜的 `/api/me` 也會看到 `boardCurate`，橋譜不用它。

**橋譜 API**（`worker/book.ts` 的 `BookService`；不用登入的讀取路由在 `book.ts` 的 `publicBookResponse`，其他在 `club.ts` 的 `bookApi`）：

| 路由 | 權限 | 說明 |
| --- | --- | --- |
| `GET /api/book/content` | 不用登入 | 所有線上修改 `{ version, entries }`，帶 ETag `W/"book-<version>"`（舊版橋譜用，保留不變） |
| `GET /api/book/manifest` | 不用登入 | `{ version, entries: BookEntrySummary[] }`：每個線上版本去掉內容，`meta` 是特約的欄位（沒有 `sections`）加上 `outline`（段落 id／標題／子段落）與 `pending`（待確認，與橋譜 `pendingNotes()` 同順序）；隱藏的特約 `meta: null`；`categories` 同 `GET /api/book/categories` 的清單。ETag `W/"book-manifest-<version>"` |
| `GET /api/book/categories` | 不用登入 | `{ version, categories: BookCategory[], updatedAt?, updatedBy? }`，依 `order` 排；空清單表示沒在線上改過，橋譜用內建的分類。ETag `W/"book-categories-<version>"` |
| `PUT /api/book/categories` | bookEdit | `{ categories: { id, label, description? }[], baseVersion }`：整份取代（新增、改名、排序、刪除一次存），`order` 依清單位置；最多 20 個，代號小寫英數與連字號、不可重複。`baseVersion` 不符回 409 `categoryConflict`；拿掉的分類裡還有線上特約時回 409 `categoryInUse`（內建特約只有橋譜知道，由橋譜檢查） |
| `GET /api/book/content/:slug` | 不用登入 | `{ entry: BookEntry }`（隱藏時 `convention: null`）；沒有線上版本回 404 `conventionGone`，橋譜改用內建的版本。ETag `W/"book-<slug>-<entry.version>"` |
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

機器人只有一個，叫 **TKB**，用淡江制度或 2/1（GIB 相容）叫牌；**沒有等級**（社長 2026-10-24，`ROBOT.md` §7）。座位裡的 id 若是 `robot:<制度>:<座位>` 這種格式就是機器人：`robot:gib:N` 是用 2/1 的 TKB，`robot:tku:N` 是用淡江制度的 TKB（`shared/protocol.ts` 的 `robotId`、`robotKindOf`）。制度放在 id 裡而不是牌桌狀態，是因為座位對調（`swapForDeclarer`／`unswap`）時 id 跟著機器人走、物件重新載入時跟著牌桌存檔回來、紀錄的玩家（`publicUserById`）也直接從 id 帶出 `robotKind`。**舊的 id 照讀**：`robot:N`（2/1 之前）讀成淡江制度；有等級時的 `robot:<制度>:<等級>:<座位>`（例如 `robot:tku:beginner:E`）只看制度，等級不管。存下來的牌桌設定（`TableSettings.robotLevel`）、挑戰設定（`settings.robotLevel`）與紀錄玩家的 `robotLevel` 載入時忽略（`settingsOf`、`ChallengeStore` 讀設定時丟掉）；新的訊息裡牌桌設定與挑戰設定帶 `robotLevel` 會像其他不認得的欄位一樣被拒絕（`badTableSettings`、`badChallengeSettings`），`addRobot` 多帶的 `level` 則跟其他訊息多帶的欄位一樣不理會。房主放機器人時選制度（`addRobot` 的 `kind`，沒寫就是淡江制度），機器人照自己的種類叫牌（`shared/robot/robots.ts` 的 `robotCall`）；2/1 機器人的叫品除了繁中說明還存著叫品的意義（`AuctionCall.meaning`），瀏覽器依觀看者的語言顯示，規則檔需要時才載入。名牌與紀錄裡的機器人帶 `robotKind`：名牌顯示「TKB」加上制度的小標籤（淡江制度／2/1），紀錄顯示「TKB（2/1）」這樣的名字（`strings.ts` 的 `robotName`、`robotSystems`、`playerName`）。每次狀態改變後，`ClubService.scheduleRobots` 檢查是否輪到機器人（叫牌、出牌，或回應攤牌／撤回），經排程器（§5）排一個短暫延遲（叫牌 0.8 秒、出牌 1.4 秒、一墩結束後 3 秒，配合牌 1.3 秒的滑動）再執行，執行完再排下一個；每張桌子同時最多一個機器人工作。機器人同意撤回；攤牌由對手方的機器人用雙明手分析判斷（`shared/robot/claim.ts`，見 `ROBOT.md` §3.1）。物件重新載入時也會重新排程。至少要有一位真人在座，機器人才會行動；最後一位真人離開，桌子就關閉。

**真人不當機器人的夢家**：叫牌結束時若莊家是機器人、夢家是真人，`swapForDeclarer` 把兩人的座位對調（同 BBO），真人坐到莊家的位子主打，機器人帶著它的種類坐到原本的位子當夢家；對調記在 `Table.swapped`。若撤回最後一個 Pass 讓叫牌重新開始，`unswap` 換回來；下一副發牌時清掉記錄（座位維持對調後的樣子）。叫牌與出牌規則見 `ROBOT.md`。

**機器人的大腦**（`shared/robot/brain.ts`）：`ClubService` 只透過 `RobotBrain`（`bid`、`play`、`acceptsClaim`，都帶機器人用的制度）問機器人，預設是規則機器人 `ruleBrain`（TKB），測試或之後的 TKB Adv（伺服器 DDS）從 `ClubConfig.brain` 換進來。排程時只決定「哪個機器人、多久後動」（`robotMove`），輪到它時才問大腦（`decide`），所以每一步只想一次。

**非同步思考**（`e6-t11`）：大腦的回答可以是 `Promise`（`Answer<T>`）。`runRobot` 問之前先記下局面（`positionOf`：座位、撤回請求、第幾副、階段、叫品數、出牌數、攤牌），等回答時不擋別的訊息（Durable Object 等的不是儲存，其他請求照常進來）；這段時間這張桌子不再排別的機器人工作（`thinking`），排程器同時到期的工作也並排跑（`AlarmQueue.runDue` 用 `Promise.all`），一張桌子的機器人在想不會拖到別桌。回答回來時局面若已經變了（真人出了牌、撤回、有人換座位），這個回答**丟掉**，照新局面重新排程。**思考上限 2 秒**（`THINK_LIMIT_MS`，測試用 `ClubConfig.thinkLimitMs` 縮短）：大腦逾時、丟出錯誤或回傳失敗的 `Promise`，就改問規則機器人 `ruleBrain`，牌桌不會卡住；逾時後才到的回答不理會。預設的大腦就是規則機器人時不設計時器。機器人行動前的節奏仍是上面的延遲。物件被回收時正在想的回答跟著消失，重新載入後照常重新排程。

**確定性**：TKB 沒有亂數，也不刻意失誤，同一個局面一定做同一件事，所以不需要種子（B6 的刻意失誤與 `mistakeSeed` 已依社長 2026-10-24 的決定拿掉）。

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
2. **DDS 只用在不花錢的地方**：殘局與攤牌判斷用 `dd.ts`（已經在做）；牌打完、四家公開以後，紀錄頁在**瀏覽器**裡用 WASM 版 DDS 算 DD 表與 par（`e6-t43`，B11，已完成：`src/lib/dds.worker.ts` 是延遲載入的 Web Worker，`bridge-dds` 只打包進它，Worker 端的程式碼不含 DDS；授權聲明在 `public/licenses/dds-apache-2.0.txt`，紀錄頁的 DD 表下方有連結）。機器人打牌時的思考不能放在瀏覽器，因為那需要別人的牌（`CLAUDE.md` 硬性規則 2）。
3. **之後再付**：要做 TKB Adv（DDS 殘局、模擬出牌），或同時在線的人多到規則機器人不夠用時，再升級付費方案。升級只是在 Cloudflare 後台切換方案，不用搬家；`RobotBrain` 讓 DDS 大腦直接換進來（ROADMAP Phase P）。

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
