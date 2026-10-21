# DESIGN — TKU BridgeTable · 淡江牌桌

所有數值都定義在 `src/styles/tokens.ts`，元件只透過 styled-components 的 theme 取用，不寫死色碼。

## 1. 設計原則

1. **牌桌照 BBO**：社員熟悉 BBO，叫牌盒、叫牌過程、名牌、牌號、出牌的樣子都盡量一樣，不需要重新學。
2. **外框照 TKU BridgeBook**：頁首、大廳、紀錄使用淡江藍與宮燈金，跟社團另一個網站一致。
3. **自己永遠在下方**：畫面依座位旋轉，同伴在上、對手在左右。
4. **不只靠顏色**：身價、輪到誰、Alert 都有文字或無障礙名稱輔助。

## 2. 色彩

### 2.1 外框（淺色／深色）

與 TKU BridgeBook 相同：`bg`、`surface`、`surfaceAlt`、`border`、`text`、`textMuted`、`primary`（淡江藍 `#0f3d7a`）、`lantern`（宮燈金）、`vermilion`；另加 `danger`、`success`。

### 2.2 牌桌（`theme.table`，淺／深色都一樣）

| Token | 色碼 | 用途 |
| --- | --- | --- |
| `felt` / `feltEdge` | `#1f6b43` / `#154d30` | 綠色桌布（放射狀漸層） |
| `panel` | `#f7f8f4` | 叫牌過程、叫牌盒、牌號、結果面板 |
| `plate` / `plateVul` | `#f7f8f4` / `#c62828` | 名牌；有身價的一方為紅色（BBO 慣例） |
| `turn` | `#ffd43b` | 輪到的人：名牌閃黃框；可出的牌（文字列模式） |
| `alert` | `#ffe066` | 叫牌過程中被 Alert 的叫品 |
| `bidPass` / `bidDouble` / `bidRedouble` / `bidAlert` | 綠 / 紅 / 藍 / 黃 | 叫牌盒的 Pass、X、XX、Alert（BBO 配色），叫牌過程中的 Pass/X/XX 文字同色 |
| `cardFace` / `cardBack` | 白 / 藍條紋 | 牌面、牌背 |
| `winner` | `#ffd43b` | 贏得這一墩的牌外框 |

### 2.3 花色

- 牌面上（`cardSuits`）：**雙色**（BBO 預設：♠♣ 黑、♥♦ 紅）或**四色**（♦ 橘、♣ 綠），頁首的調色盤按鈕切換，記在瀏覽器。
- 外框（`suits`）：與 BridgeBook 相同的四色。

## 3. 字體

- 介面：Noto Sans TC。
- 牌、叫品、牌號：`Segoe UI / Helvetica / Arial`（BBO 的牌面是無襯線粗體）。
- 花色符號：Segoe UI Symbol／Apple Symbols，避免被畫成 emoji。

## 4. 牌桌元件

| 元件 | 檔案 | 說明 |
| --- | --- | --- |
| PlayingCard、CardBack | `components/PlayingCard.tsx` | 白色牌面，左上角點數與花色直排（重疊時仍看得到），右下大花色。三種尺寸：lg（自己）、md（同伴／出牌）、sm（左右、手機） |
| HandView | `components/HandView.tsx` | `fan`：重疊排列，花色之間多留一點空隙，可出的牌滑上；不可出的牌在輪到你時變暗。`rows`：每個花色一行（BBO 文字手牌），手機左右兩家使用 |
| BiddingBox | `components/BiddingBox.tsx` | 先按 1–7，再按花色即叫出；不合法的按鈕停用；Alert 開啟後出現說明欄 |
| AuctionBox | `components/AuctionBox.tsx` | W N E S 四欄（BBO 順序），有身價的座位表頭紅色；Alert 叫品黃底，點一下看說明；`?` 是下一個要叫的位置 |
| BoardInfo | `components/BoardInfo.tsx` | 小羅盤：中間牌號，有身價的座位紅底，發牌者加底線；隨座位旋轉 |
| SeatPlate | `components/SeatPlate.tsx` | 座位字母＋名字；莊家／夢家／離線標籤；空位顯示「坐 N」 |
| TrickArea | `components/TrickArea.tsx` | 中間四個位置放這一墩的牌；完成的一墩停留 1.4 秒再清掉（BBO 行為）；勝者黃框 |
| TablePanels | `components/TablePanels.tsx` | 結果、攤牌選墩數、攤牌／撤回詢問 |

## 5. 版面

**桌機（> 900px）**

```
┌ 頁首：Logo · 大廳 · 牌局紀錄 ··········· 四色牌 · 深色 · ● 名字 · 登出 ┐
├──────────────────────── 綠色桌布 ─────────────────────┬── 側欄 300px ──┤
│ [牌號]              [N 名牌]               [合約/墩數] │ 第 1 桌 · 離座 │
│                     [N 手牌]                          │ 聊天 | 桌上成員│
│ [W 名牌]       [叫牌過程 + 叫牌盒]          [E 名牌]  │                │
│ [W 手牌]         或 [這一墩]                [E 手牌]  │                │
│                     [自己的手牌]                       │                │
│                     [S 名牌]  [上一墩][撤回][攤牌]     │ [輸入訊息]     │
└────────────────────────────────────────────────────────┴────────────────┘
```

**手機（≤ 900px）**：桌布改成兩欄（上：同伴，中：左右兩家文字列，下：叫牌或出牌、自己的手牌），側欄移到桌布下方；頁首只剩圖示。

## 6. Logo

沿用 TKU BridgeBook 的宮燈（`public/logo-mark.svg`），字標改為「TKU BridgeTable · 淡江牌桌」，副標「♠♥♦♣ 橋藝社線上牌桌」。`components/Logo.tsx` 是同一個圖形的 inline 版本，深藍部分跟隨主題。不使用 BBO 標誌。
