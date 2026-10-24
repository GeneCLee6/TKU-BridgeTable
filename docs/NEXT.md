# NEXT — 接下來怎麼做（給 AI 協作者與自己的交接手冊）

最後更新 2026-10-24。**完整順序在 [`ROADMAP.md`](ROADMAP.md)**（一批一個 PR，從現在到網站完成）；這份只記「現在的位置」與工作方式。這份文件回答三件事：**現在做到哪、下一個做什麼、怎麼做最省**。每完成一個 task 就更新「現在的位置」；每個 AI session 開頭只需要讀 `CLAUDE.md` 和這一份。

## 1. 現在的位置

- **M0 社團 MVP** ✅ 已上線。
- **M1 社團完整版**進行中（PRD 進度表見 `docs/PRD/README.md`）。
- **2/1 機器人（GIB 相容）這條線做完並已合併**（#17 引擎、#27 2/1 制度、#29 牌桌整合、#30 交接文件）。
- **A1 完成**（#32）：牌桌模式（`worker/modes.ts`）、`DealSource`（`shared/deal-source.ts`）、統一排程器（`worker/scheduler.ts`，Durable Object 用 storage alarm）。
- **A2 完成**（#33）：牌桌設定 `TableSettings`（`visibility` public／invite、`allowKibitz`），開桌對話框與房主的設定按鈕。設定目前只存、只顯示；受邀名單與「不允許觀看」的實際限制在 F1（`e2-t25`、`e2-t26`）。
- **A3 完成**（#34）：紀錄的 SQL 索引（`worker/history-index.ts`：`boards_index`、`board_players`），新紀錄同時寫 KV 與 SQL、舊紀錄載入時回填（`meta:schema` 3）。決策紀錄在 `ARCHITECTURE.md` §5.3。
- **A4 完成**（#35）：搜尋 API `GET /api/history/search`（`shared/history-query.ts`，條件見 `ARCHITECTURE.md` §5.3），紀錄列表也改從 SQL 讀；未公開的牌局（`revealAt`）只有打那一副的人看得到（`views.ts` 的 `recordVisible`）。篩選的介面在 Phase E。
- **A5 完成**（#37）：通知中心（`worker/notifications.ts`，`ARCHITECTURE.md` §5.4）與頁首鈴鐺；第一種通知是「有人申請註冊」給管理員。之後的挑戰、受邀桌直接呼叫 `notifications.notify`。
- **B1 完成**（#36）：淡江機器人搬進制度引擎（`shared/robot/system/tku/`，`System.firstFit`），`bidding.ts` 與 `inferShown` 已刪；兩種機器人都有叫牌盒提示、Alert 依觀看者的語言顯示。規則書的叫品跟舊程式完全一樣，後備改用引擎的推論（差異見 `ROBOT.md` §2）。
- **A6 完成**（#38）：`shared/imp.ts`（WBF IMP 表）、`shared/challenge-scoring.ts`（IMP、總分、MP、Cross-IMP、沒打完的副、同分名次）、`shared/dealer.ts` 條件發牌與 `deal-presets.ts`。**Phase A 地基全部完成。**
- **B2 完成**（#39）：2/1 機器人防守改用 GIB 公開的出牌慣例（`play.ts` 的 `gib*`，`ROBOT.md` §3.2）：被動首攻、AK 攻 K、王牌合約攻短門、態度正、標準張數、第三家相等牌出最小、墊牌不打信號；淡江機器人不變。`chooseCard` 多一個 `kind` 參數。
- **B3 完成**（#40）：`RobotBrain` 介面（`shared/robot/brain.ts`，`ClubConfig.brain`，執行時才問大腦）；決策紀錄 `ARCHITECTURE.md` §5.1.1：機器人運算選 Workers 付費方案＋WASM 版 DDS（`bridge-dds`），**付費要在 B4 開工前由社團確認**；DDS spike 的數字也在那裡。
- **暫不付費**（2026-10-24 社團決定，`ARCHITECTURE.md` §5.1.1）：先把規則機器人做強（新的 B4、B10），DDS 只用在殘局（`dd.ts`）與牌打完後的瀏覽器分析（B11）；伺服器 DDS 移到 ROADMAP Phase P，等需要等級 4 或使用者多了再付。
- **下一批：ROADMAP 第 B4 批**（`e6-t39` `e6-t40` 出牌時讀叫牌推論、數牌）；B5（等級）、C1（好友）也沒有前提，可以交錯做。

## 2. 建議順序

**以 [`ROADMAP.md`](ROADMAP.md) 為準**（Phase A 地基 → B 機器人等級 → C 挑戰 → D UI → E 紀錄 → F 雙桌 → G 收尾 ＝ M1 完成；H–L ＝ M2 公開版）。下表是為什麼這樣排的摘要：

優先級由產品決定：**GIB 等級的機器人 → 挑戰 → UI 專業化**。其他（論壇、BM 式練習題、比賽）之後。

| # | 做什麼 | Task | 為什麼排這裡 | 大小 |
| --- | --- | --- | --- | --- |
| 1 | 淡江機器人搬進制度引擎，刪掉 `bidding.ts` | `e5-t15`～`e5-t18` | 兩套引擎並存是現在最大的技術債；搬完後淡江機器人也有叫牌盒提示、也能設等級 | 4 個 task，可合成 1 個 PR |
| 2 | 2/1 機器人的 GIB 出牌慣例 | `e6-t38` | 真人跟 2/1 機器人搭檔時信號才對得上 | 1 PR |
| 3 | 機器人等級 Level 1–4 | `e6-t18`～`e6-t20`（`e6-t21` 失誤注入要等 DDS） | 產品核心需求；見第 5 點的分級表 | 1 PR |
| 4 | 題庫棘輪（CI 每個 PR 跑叫牌題） | `e5-t23`、`e5-t42` | 沒有題庫，300 副隨機牌只能保證「合法」不能保證「叫對」 | 1 PR（格式＋前 50 題） |
| 5 | 挑戰：基礎 | `e2-t20`～`e2-t22`、`e7-t01`～`e7-t04` | 牌桌模式、固定牌組、IMP 計分是挑戰的地基 | 2 PR |
| 6 | 挑戰：流程 | `e7-t05`～`e7-t14` | 建立、邀請、期限可設、沒人開打可取消、排名 | 3 PR |
| 7 | 挑戰：比較與重播 | `e7-t15`～`e7-t20` | 「同一副牌好友怎麼打」的並排重播，是超越 BBO 的點 | 2 PR |
| 8 | UI 專業化與管理頁 | `e3-t39`～`e3-t44`（E3「專業化」段） | 先出 design 提案給人看過再動手 | 提案 1 PR，實作 2–3 PR |
| 9 | 論壇 | E13 | M2；先做 E1 的個人檔案與頭像（`e1-t15`～`e1-t18`） | — |

每一項開工前讀該 task 所在 epic 的那一段就好，不必讀整份 PRD。

## 3. 怎麼跑最省 token

Token 吃掉的是**對話上下文**，不是程式碼。原則：**一個 session 做一組 task，做完就結束**。

**開工指令範本**（貼給 Claude 就能跑，不需要人在旁邊）：

```
讀 CLAUDE.md、docs/NEXT.md、docs/ROADMAP.md。做 ROADMAP 第 <批次號> 批。
規則：
1. 用 worktree 開分支，分支名帶第一個 task 編號。
2. 讀檔只讀需要的段落；搜尋與大範圍檢視交給 subagent，只把結論帶回來。
3. 每個 task 做完跑 npm run lint && npm run build && npm test，只看最後 5 行。
4. 這一批的 task 合成一個 PR（標題列出全部編號），PR 本文寫對應的 AC 與檢查方式；在 PRD 勾選、更新進度表；在 ROADMAP 勾選這一批並寫 PR 號；更新 docs/NEXT.md 的「現在的位置」。
5. PR 開成 ready（不是 draft），CI 綠了就回報，然後結束，不要接著做下一項。
```

其他：
- **effort 用 medium**。照規格寫規則與測試不需要 xhigh；只有設計決策（新 epic、資料模型）開 high。
- **不要在一個 session 做超過一組 task。** 上下文會自動壓縮，但壓縮後品質下降，不如重開。
- **subagent 只用來搜尋和讀大檔**，不要用來寫程式碼（它看不到你的決策，容易重做）。
- 一個 session 想連續做多項時，可以在指令裡寫「做完第 N 項後，用 `/clear` 等價的方式：把結論寫進 NEXT.md，然後從乾淨的上下文開始第 N+1 項」——但目前 Claude Code 的 session 不能自己清上下文，**最可靠的做法是你每項開一個新 session**（或用 `claude -p "<上面的範本>"` 寫成腳本依序跑）。
- 多個 task 合成一個 PR 是允許的（PRD README 的「一個 task 一個 PR」改成「一組相關 task 一個 PR，標題列出編號」）。

## 4. 架構健檢結論（2026-10-24）

方向正確：規則只在伺服器、機器人只看合法可見的牌、制度即資料。要記得的幾件事：

| 項目 | 狀態 | 處理 |
| --- | --- | --- |
| 淡江機器人仍是手寫規則＋另一套推論（`inferShown`） | 已解決（B1，#36） | — |
| 後備書（`fallback.ts`）用 25 條「第 n 個叫品」的規則讓說明在叫之前就算得出來 | 可接受 | 補完 2/1 細節後用到的機會會變少 |
| 推論每次從第一個叫品重讀（O(n²)） | 現在無感（300 副 0.4 秒） | M2 做模擬前改成增量（把 `Reading` 存進 `BoardState`） |
| 300 副隨機牌只驗「合法、會停、有說明」 | 不驗「叫得對」 | 題庫（第 2 點第 4 項）＋社團幹部到 BBO 核對 `docs/BBO GIB/README.md` 的待核對清單 |
| 整個社團一個 Durable Object | 社團內夠用 | 全台灣規模前做 E11 的拆分（每桌一個 DO、索引進 D1） |

## 5. 機器人等級怎麼分

| Level | 名稱 | 叫牌 | 出牌 | 實作 |
| --- | --- | --- | --- | --- |
| 1 | 初學者 | 只用基本自然叫，約定叫品關掉 | 跟規則但不打信號、不算張數、偶爾出錯牌 | 規則加 `minLevel`；失誤注入 |
| 2 | 大專 | 常用特約（Stayman、轉換、負性賭倍） | 有信號、會數王牌 | 現在的規則機器人 |
| 3 | 公開組 | 完整制度＋牌值判斷（LTC、配合重估） | 讀叫牌推論、數牌、坐莊計畫、殘局雙明手 | `evaluate.ts` 擴充；`e6-t39`～`e6-t42`；`dd.ts` 解殘局 |
| 4 | 橋士組 | 競叫邊界用模擬（抽樣＋DDS）決定 | 單明手模擬出牌、首攻模擬（GIB 的做法） | 需要伺服器 DDS，**付費之後**（ROADMAP Phase P） |

需要的型別改動：`Rule` 加 `minLevel`，`RobotKind` 旁加 `RobotLevel`（`e6-t18`）。等級差距要用評測證明（AC-6.8）。

## 6. 不做或延後的

- **BM2000（Bridge Master）**：商業軟體，牌例有版權，不能抓進網站。可行的是自己出「坐莊練習題」（E10 謎題），分級方式可參考它。延後到 M2。
- **直接接 BBO 的 GIB**：BBO 條款禁止。見 `docs/BBO GIB/README.md`。
- **再生一份架構文件**：`ARCHITECTURE.md` 已是唯一來源，不要有第二份要同步的文件。
