<p align="center">
  <img src="public/logo.svg" alt="TKU BridgeTable 淡江牌桌" width="392" />
</p>

# TKU BridgeTable · 淡江牌桌

**淡江橋藝社自己的線上牌桌。**

BBO（Bridge Base Online）要開桌和朋友打牌得買 premium 會員。淡江牌桌把我們真正會用到的部分做成一個小網站：社員註冊帳號、開一張桌、四個人坐下就自動發牌、打完自動發下一副，叫牌和出牌的樣式都照 BBO 做，打完的每一副都會存進牌局紀錄，可以逐墩重播，也能一鍵在 BBO Handviewer 開啟。

為一個社團設計：最多 10 個帳號（管理員可調），註冊需要邀請碼。人不夠時可以放**機器人**補位，機器人用的是淡江橋譜裡的社團制度與特約。

## 功能

| 功能 | 說明 |
| --- | --- |
| 帳號 | 註冊（邀請碼＋人數上限）、登入、登出、修改密碼；密碼以 PBKDF2 雜湊保存 |
| 管理 | 第一個註冊的帳號是管理員：看所有社員、新增帳號、重設密碼、設定／取消管理員、刪除帳號、改人數上限與邀請碼、關閉牌桌 |
| 機器人 | 空位可放機器人，一到三人也能打；叫牌用淡江制度（1NT 15–17、一高弱二、Bergen、J2N、雷本索、回答性賭倍等），防守用社團的信號，詳見 `ROBOT.md` |
| 大廳 | 開新桌、看所有牌桌與座位、點空位坐下、觀看、線上社員 |
| 牌桌 | BBO 式綠色牌桌，牌的大小隨視窗放大，自己永遠在下方；牌號羅盤（身價紅色、發牌者底線）、身價紅色名牌、輪到誰閃黃框 |
| 叫牌 | BBO 叫牌盒（1–7 → ♣♦♥♠NT，Pass 綠 / X 紅 / XX 藍 / Alert 黃），只能按合法叫品；叫牌時中間是放大的叫牌表，欄位依自己的座位排列（左手敵方、同伴、右手敵方、自己），表頭標出名字，叫牌超過 5 輪就在表格內捲動並自動跟到最新；輪到自己才在叫牌表與手牌之間出現叫牌盒；Alert 說明只給對手看 |
| 側欄 | BBO 式：最右側一條直立選單（聊天、社員、紀錄），點一個才展開、再點一次收起；社員顯示上線狀態與所在牌桌；紀錄可切換本桌／我的，點一副直接在側欄看牌例、叫牌與逐墩重播，左邊照常打牌 |
| 出牌 | 必須跟花色、首攻後夢家攤牌（左右家的夢家照 BBO 分四個花色欄、上下疊放；夢家也看得到莊家的牌）、莊家出夢家的牌、勝墩高亮、上一墩 |
| 攤牌與撤回 | 攤牌由另外兩位非夢家接受；撤回由對手同意 |
| 計分 | 複式橋牌計分（含加倍、再加倍、滿貫、身價），16 副身價循環 |
| 觀看 | 沒坐下的人可以觀看，看得到四家牌（同 BBO kibitz） |
| 聊天 | 每張桌子有聊天室 |
| 牌局紀錄 | 我打過的／全部社員，每次載入 50 副；牌例圖（含點力）、叫牌過程、逐墩重播、出牌紀錄、BBO Handviewer、複製 LIN |
| 斷線 | 重新整理或斷線後自動重連，座位與牌局都保留；離線玩家的座位可以請他離座 |
| 顯示 | 六種語言（繁中、簡中、英、越、日、韓）、實體牌／文字牌（♠ A K Q）、淺色／深色、雙色／四色牌，手機可用 |

## 文件

| 文件 | 內容 |
| --- | --- |
| [`PRD.md`](PRD.md) | 產品需求：背景、目標、使用者故事、功能需求、MVP 與 Roadmap |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 資料夾結構、遊戲引擎、伺服器、通訊協定、可見性規則、儲存 |
| [`DESIGN.md`](DESIGN.md) | 設計系統：色彩、BBO 牌桌、元件、版面、Logo |
| [`ROBOT.md`](ROBOT.md) | 機器人的叫牌制度、防守信號，與淡江橋譜的對照 |
| [`DEPLOY.md`](DEPLOY.md) | 部署到 Cloudflare、管理員、邀請碼、人數上限、資料存在哪 |
| [`RULES.md`](RULES.md) | 工程慣例與 commit 格式 |
| [`CLAUDE.md`](CLAUDE.md) | 給 AI 協作者的專案說明 |

## 技術

- React 19 + TypeScript（strict）+ Vite + styled-components 6（與 TKU BridgeBook 相同）
- Cloudflare Workers + 一個 Durable Object（帳號、牌桌、牌局紀錄、WebSocket），免費方案即可
- `shared/`：前後端共用的橋牌引擎（發牌、叫牌、出牌、計分、LIN），純函式
- Vitest + Testing Library；oxlint

選擇理由見 `ARCHITECTURE.md` §6。

## 開始使用

需要 Node.js 22。

```bash
npm install
cp .dev.vars.example .dev.vars   # 本機的邀請碼
npm run dev                      # http://localhost:5173（前端＋Worker＋Durable Object）
```

| 指令 | 說明 |
| --- | --- |
| `npm run dev` | 開發伺服器，前端與 Worker 一起跑，本機資料存在 `.wrangler/` |
| `npm run build` | 型別檢查並建置到 `dist/` |
| `npm run preview` | 預覽建置結果 |
| `npm run typecheck` | 只做型別檢查 |
| `npm run lint` | oxlint |
| `npm test` | 執行一次全部測試 |
| `npm run deploy` | 建置並部署到 Cloudflare（見 `DEPLOY.md`） |

本機要測四人同桌，可以開四個不同的瀏覽器設定檔（或一般＋無痕視窗＋其他瀏覽器），各自登入一個帳號。

## Logo

沿用 TKU BridgeBook 的宮燈標誌，字標改為「TKU BridgeTable · 淡江牌桌」。原創圖形，未使用淡江大學校徽、BBO 標誌或任何註冊商標。本專案與 Bridge Base Online 無關，只參考其介面樣式。
