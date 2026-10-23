---
title: BBO 競品分析
date: 2026-10-23
status: draft
owner: GeneCLee6
---

# BBO 競品分析

> 目的：弄清楚 BBO（Bridge Base Online）的核心功能與機器人 GIB 是怎麼做的，找出淡江牌桌要「一樣有」和「做得比它好」的地方。結論直接對應到各 epic（`docs/PRD/e*.md`）。
>
> 資料來源是 BBO 官方說明、BBO 新聞與部落格、Funbridge 官方部落格、公開論文與開源專案（見 §10）。標「社群回報」的是 BBO 論壇上的使用者觀察，不是官方說法，做決定前要再驗證。

## 1. 結論先講

1. **BBO 的護城河是「人多」和「GIB 隨時有空」，不是單一功能。** 它的功能大多數我們做得出來；真正難追的是同時在線人數。所以前期策略是**先把一個社團（淡江）服務到比 BBO 好用**，再複製到其他社團（E12），而不是一開始就跟 BBO 搶公開大廳。
2. **GIB 本質上不是「訓練」出來的。** 叫牌是人工維護的規則資料庫加模擬，打牌是「抽樣 → 雙明手解 → 取平均」。2025 年 12 月 BBO 把它升級成 GIBBO，才在估墩與首攻加入神經網路。這代表我們可以用**同樣的公開方法**（規則＋推論＋模擬＋DDS），再加上 GIB 沒有的東西：**多制度（5542、精準、淡江制度）、可調等級、可解釋、評測棘輪**（E5、E6）。
3. **BBO 的挑戰只有一對一。** 官方說明只有一對一（Friend／Robot／Arena），多人「群組挑戰」只出現在論壇的口耳相傳，沒有正式的多人排名表。**多人挑戰＋即時排名＋逐副並排重播**是最明確的差異化機會（E7）。
4. **BBO 的隊制賽能用，但體驗很陽春**：輸入八個名字就開打，沒有準備室、沒有即時比分條、場外資訊隔離靠規定。我們做「準備室＋機器人補位＋即時比分＋兩桌並排觀賽」（E8）。
5. **BBO 的牌局紀錄（My Hands）是以帳號＋日期查詢**，沒有依合約、莊家、結果的篩選，也沒有收藏與精選講解。這一塊我們用 SQL 索引就能大幅領先（E4）。
6. **中文使用者的痛點**：GIB 只會一套 2/1 制度，台灣常用的 5542 自然制、精準制搭配不了；挑戰、比賽的付費以 BB$ 計價。我們以中文優先、社團制度優先切入。

## 2. BBO 概況

| 項目 | 內容 |
| --- | --- |
| 定位 | 全球最大的線上橋牌平台，休閒桌、比賽、機器人練習、轉播（Vugraph）都在同一個地方 |
| 機器人 | GIB（2025-12 起為 GIBBO，V44），分 Basic 與 Advanced；另有實驗性的 ACBL-Ben |
| 付費 | 虛擬幣 BB$：租機器人、付費比賽、進階挑戰（例如 BXP Challenge 0.49 BB$）、Challenge Reward（各付 0.10 BB$，勝者得 0.20 BB$）；ACBL 認證比賽可得大師分 |
| 社群 | 好友、私訊、大廳聊天、個人檔案（自評等級） |
| 對我們的意義 | 社員已經熟悉 BBO 的牌桌與叫牌盒，所以介面照 BBO（已完成）；功能則挑 BBO 做得不夠好的地方超越 |

## 3. 功能盤點：BBO 有什麼、我們在哪裡

狀態：✅ 已完成（M0）　🟡 部分完成　⬜ 未開始。Epic 與里程碑見 `00-prd.md` §11。

| 類別 | BBO 功能 | 淡江牌桌 | Epic | 我們要做得更好的地方 |
| --- | --- | --- | --- | --- |
| 休閒 | 開桌、入座、觀看（kibitz）、桌上聊天 | ✅ | E2 | 房主權限、自動發牌、斷線重連已和 BBO 同級 |
| 休閒 | 私人桌、邀請制、桌子設定 | ⬜ | E2 | 開桌對話框直接選公開／受邀、允許觀看 |
| 休閒 | 撤回、攤牌 | ✅ | E2 | 機器人用雙明手判斷攤牌，拒絕時說明 |
| 介面 | 叫牌盒、叫牌表、Alert、名牌、牌號 | ✅ | E3 | 六種語言、手機橫躺座位、PWA |
| 介面 | 二次確認叫品／出牌 | ⬜ | E3 | — |
| 機器人 | GIB 補位、GIB 說明（hover 看叫品意義） | 🟡 | E5、E6 | 社團制度＋5542；**連真人的叫品也能查意義**（依推論） |
| 機器人 | Basic／Advanced 兩級 | ⬜ | E6 | **初學者／大專／公開組／橋士組四級**，可自訂 |
| 機器人 | 只會一套 2/1 GIB 制度 | — | E5 | **制度即資料**：淡江制度、5542、精準、2/1 都能選 |
| 練習 | 和機器人練習、Just Declare、Best Hand | ⬜ | E10 | 條件發牌（指定要練的牌型） |
| 練習 | 叫牌練習（Bidding practice、Partnership bidding） | ⬜ | E10 | 叫完立刻看 DD 表與機器人建議 |
| 練習 | 教學桌 | ⬜ | E10 | 老師排牌、講解標記 |
| 比賽 | 挑戰（一對一） | ⬜ | E7 | **多人挑戰、即時排名、並排重播、可取消、再戰** |
| 比賽 | 隊制賽（Team match，兩桌 IMP） | ⬜ | E8 | 準備室、機器人補位、即時比分、資訊隔離由伺服器把關 |
| 比賽 | 每日機器人賽（Daylong）、即時賽（Instant） | ⬜ | E9 | 社團每日賽、社團積分 |
| 比賽 | 雙人賽、個人賽、移位、TD 工具 | ⬜ | E9 | — |
| 比賽 | 大師分、BBO Points、BXP | ⬜ | E9 | 社團積分與實力評分（rating） |
| 紀錄 | My Hands、Handviewer、LIN | ✅ | E4 | 已有分頁、逐墩重播、Handviewer 樣式 |
| 紀錄 | 依合約／莊家／結果篩選 | ⬜（BBO 也沒有） | E4 | **合約（如 4♠）、莊家、搭檔、日期、結果、模式組合篩選** |
| 紀錄 | 收藏、精選講解 | ⬜（BBO 沒有精選講解） | E4 | 收藏＋筆記、精選＋逐墩講解 |
| 紀錄 | 雙明手分析 | ⬜ | E4、E6 | DD 表、par、「這張牌少了幾墩」 |
| 社群 | 好友、私訊、個人檔案 | ⬜ | E1 | 通知中心串起挑戰、隊制賽邀請 |
| 轉播 | Vugraph | ⬜ | E8 | 隊制賽兩桌並排觀賽 |
| 平台 | 帳號、付費、多語 | 🟡 | E1、E12 | 社團方案、在地金流 |

## 4. GIB 深入分析

### 4.1 GIB 是怎麼做的（也就是 BBO「怎麼訓練 GIB」）

GIB（Ginsberg's Intelligent Bridgeplayer）是 Matt Ginsberg 在 1990 年代開發、後來由 BBO 接手維護的機器人。依 Ginsberg 2001 年在 JAIR 的論文與後續資料，它的核心有三塊：

| 部分 | 做法 | 結果 |
| --- | --- | --- |
| **叫牌** | 一個人工維護的**規則資料庫**：每條規則描述「什麼叫牌過程、什麼手牌 → 叫什麼、代表什麼」。資料庫裡的意義同時用來產生叫品說明（BBO 上 hover 看到的那段文字） | 叫牌行為完全由規則決定，BBO 修規則就改變 GIB 的叫法 |
| **叫牌模擬** | 規則給出多個候選時，依目前叫牌過程的**推論**發出符合條件的其他三家牌（Borel 模擬），用資料庫預演每個候選之後的叫牌，再用雙明手結果估分，取期望值最高 | Advanced GIB 模擬得比 Basic 多；2025 年起 Basic 也會模擬 |
| **出牌** | **蒙地卡羅＋雙明手**：依叫牌與已出的牌抽樣多副可能的牌，每副用雙明手解算器解，選平均墩數（或分數）最好的那張 | 做莊與防守都很強，但有雙明手偏差（§4.2） |

所以「BBO 怎麼訓練 GIB」的正確答案是：**大部分不是機器學習，而是人工改規則＋調模擬參數**。真正的「訓練」只出現在：

- **GIBBO（2025-12-16 上線，V44）**：叫牌時改用**神經網路估計合約能做幾墩**（取代雙明手）；首攻由神經網路選；出牌結合神經網路跑的單明手模擬與雙明手分析；雙明手認為「出哪張都一樣」時改選常識打法（二家小、三家大）；對已出的牌推論更好（例如飛牌成功後調整機率、受限選擇）。**叫牌制度與規則本身沒有改**，而且仍然是**確定性的**：同樣的叫牌與出牌永遠得到同樣的結果。
  - BBO 公布的對抗結果（四場各 4,000 副）：Basic GIBBO 對舊版 Basic GIB 是 MP 57.25%、IMP 每副 +0.9；Advanced GIBBO 對舊版 Advanced 是 MP 53.86%、IMP 每副 +0.4。
- **ACBL-Ben**：BBO 以約 1 億副 ACBL 雙人賽牌局訓練的實驗引擎。BBO 部落格的比較：叫牌最積極（買到 53% 的合約，GIB 50%），但王牌合約做莊明顯較弱（48.41% 對 GIB 55.93%）。
- **評測方式**：BBO 每晚讓各機器人重打真人打過的比賽牌組，比較名次與百分比。

### 4.2 GIB 的已知弱點

| 弱點 | 說明 | 我們的對策 |
| --- | --- | --- |
| **雙明手偏差** | 抽樣後每副都用雙明手解，等於假設「莊家總是猜得對」。BBO 管理員在論壇的說法是：只要某個抽樣能拿到墩，它就假設拿得到（社群回報）。結果是防守時不給莊家製造猜測的機會、有時做莊選了只在看得到牌時才對的路線 | E6：防守時對「莊家看不到的牌」改用單明手評估；保存每步抽樣摘要以便檢查 |
| **只有一套制度** | GIB 用 BBO 自己的 2/1 系統；真人搭檔想用 5542、精準制就只能遷就 | E5：制度描述成資料，牌桌每一方各選制度 |
| **規則沒寫到就亂叫** | 規則資料庫覆蓋不到的情境，GIB 的叫品與說明常讓人看不懂（社群回報） | E5：推論引擎統一產生意義；題庫棘輪（只升不降） |
| **等級太粗** | 只有 Basic／Advanced，沒有「適合初學者」的對手 | E6：四級＋自訂，等級間差距用評測量出來 |
| **黑盒子** | 看不到它為什麼這樣出 | E6：「機器人為什麼出這張」顯示抽樣結論 |
| **不理解真人 Alert** | 真人的 Alert 說明是自由文字，GIB 不讀（Ben 開源版也明說不處理 Alert 與防守信號） | E5：真人選制度後，引擎依制度推論真人叫品；自由文字只給人看 |

### 4.3 其他機器人

| 機器人 | 方法 | 值得學的地方 |
| --- | --- | --- |
| **Ben**（開源，Lorand Dali，2022） | 神經網路叫牌＋雙明手解算器；Python／TensorFlow；開源版只會 2/1、不處理 Alert 與防守信號。BBO 版（作者後來加入 BBO）出牌不依賴雙明手、叫牌用新的 GIB 系統訓練 | 開源，可當我們評測平台的常設對手（E6）；訓練管線可參考 |
| **Argine**（Funbridge） | 商業閉源；支援 Acol、SEF、SAYC、2/1 等多種制度；BBO 部落格的比較中在數個比賽名列前茅 | 「多制度」是可行且有市場的；Funbridge 的賽後分析（指出哪一墩出錯）是付費賣點 |
| **研究方向** | 2019 年有論文用兩個網路做競叫（先推同伴手牌、再選叫品）；2024 年有開源的叫牌強化學習基準（harukaki/brl） | E6 M3 的學習路線參考 |

### 4.4 我們要怎麼「比 GIB 更厲害」

「更厲害」分兩個階段定義，避免一開始就喊做不到的目標：

| 階段 | 「更厲害」的定義 | 怎麼量 |
| --- | --- | --- |
| **M1：更好的搭檔** | 照社團制度叫、說明一致、真人看得懂；有適合初學者到橋士組的四個等級 | 題庫正確率（E5 AC-5.8）、等級校準報告（E6 AC-6.8） |
| **M2：實力追上** | 單明手模擬＋DDS＋推論，修正雙明手偏差 | 評測平台對 Ben 的 IMP／副；匯入 BBO 的 GIB 牌局逐點比對（E6 AC-6.10） |
| **M3：實力超越** | 用社員與公開牌局訓練估墩與叫牌模型，通過門檻才上線 | 新模型必須在評測平台顯著勝過現行版本（E6 AC-6.11） |

技術路線（細節見 E5、E6）：

1. **制度即資料**：`SystemSpec` 規則檔描述「情境＋手牌條件 → 叫品＋意義」，淡江制度、完整 5542、2/1、精準都是一份檔案。
2. **單一推論引擎**：同一份「意義」同時用於叫品說明、模擬發牌的約束、出牌時的推論。GIB 的說明與實際行為偶爾不一致，我們從結構上避免。
3. **牌值判斷模組**：大牌點之外有牌型點、輸張數、配合調整、控制數、大牌位置，等級越高用得越多。
4. **DDS＋模擬**：採用成熟的雙明手解算器（Bo Haglund 的 DDS，Apache-2.0，可編成 WASM），在獨立的機器人運算環境跑（免費方案每次請求 CPU 只有 10 ms，見 E6 AC-6.5）。
5. **評測棘輪**：每個機器人 PR 自動跑固定牌組對抗，退步就不能合併。BBO 沒有公開這種保證。
6. **可解釋**：保存每個決策的前三候選與期望墩數，紀錄頁可展開看。

## 5. 挑戰功能對照

| 項目 | BBO | Funbridge | 淡江牌桌（E7 目標） |
| --- | --- | --- | --- |
| 人數 | 一對一（Friend、Robot、Arena 陌生人） | 一對一（對真人或 Argine） | **一對一與多人（2–20 人）** |
| 副數 | Friend 4–16 副；Arena 固定 8 副 | 固定 5 副 | 4–16 副 |
| 計分 | IMP、MP、總分 | IMP | 一對一：IMP 或總分；多人：MP、Cross-IMP、總分 |
| 對手與搭檔 | GIB 機器人；BXP Challenge 用 Advanced 機器人（0.49 BB$） | Argine | 指定等級的機器人（四級） |
| 選項 | Best Hand、Just Declare | — | Best Hand、Just Declare、主題牌組（滿貫、競叫…） |
| 期限 | 被挑戰者 7 天內接受；Arena 24 小時過期；開打後有完成期限（不同說明頁寫法不一） | — | 接受期限＋完成期限可設定（1–7 天） |
| 取消 | 建立後**不能取消** | — | 沒人開打前可以取消 |
| 同時進行 | 最多 10 個 Friend 挑戰 | — | 依方案（E12） |
| 結果 | 雙方都打完或期限到才判勝負 | 打完比較 | **完成者即時看排名**；第 1 到第 N 名；每副 traveller；**並排重播自己和任一對手** |
| 其他 | Challenge Reward：付 BB$ 入場、勝者得 BB$ | 有付費的賽後分析 | 一鍵再戰、「用這副牌挑戰」、每週社團挑戰、成績分享卡；**不做付費入場換獎金**（台灣法規風險，E12 AC-12.5） |

## 6. 隊制賽（兩桌）對照

| 項目 | BBO Team Match | 淡江牌桌（E8 目標） |
| --- | --- | --- |
| 建立 | 大廳 Tournaments → Create Team Match，輸入 8 個名字（論壇回報：需要 100 次以上登入才能建立） | 準備室：兩隊名單、8 個座位狀態、邀請到指定座位、不足時補機器人 |
| 副數與時間 | 至少 3 副；每副約 10 分鐘，超時關桌給平均 | 4–32 副；每副時間上限可設定；超時由房主判 Avg／Avg+／Avg- 並記錄理由 |
| 計分 | IMP 或 BAM；兩桌都打完才結算 | 每副兩桌都完成就即時更新比分；IMP 或 BAM；之後支援 VP（E9） |
| 資訊隔離 | 主要靠規定 | **伺服器把關**：參賽者不能進另一桌、比賽牌局在兩桌打完前不出現在任何紀錄 |
| 結果 | 比賽摘要、逐副「movie」與 IMP、My Hands 的 traveller | 逐副兩桌比較、累計比分、重播；可在紀錄篩選「隊制賽」 |
| 觀賽 | Vugraph（另外的轉播系統） | 兩桌並排觀賽、即時比分、可選延遲一墩 |

## 7. 牌局紀錄與搜尋對照

| 項目 | BBO | 淡江牌桌 |
| --- | --- | --- |
| 查詢方式 | My Hands：以帳號與日期區間查詢 | ✅ 我的／全部社員、分頁；⬜ 合約、莊家、搭檔、日期、結果、身價、模式組合篩選與排序（E4） |
| 檢視 | Handviewer、LIN | ✅ Handviewer 樣式、逐墩重播、LIN；⬜ DD 表、par、每步損失 |
| 收藏與精選 | 無精選講解 | ⬜ 收藏＋筆記＋標籤、精選＋分類＋逐墩講解 |
| 比較 | 比賽牌局有 traveller | ⬜ 挑戰、隊制賽、雙人賽通用 traveller 與並排重播 |
| 匯入 | — | ⬜ 匯入自己在 BBO 打的 LIN，一起篩選（E4） |

## 8. 介面與在地化

- BBO 的牌桌是社員已經熟悉的樣子，所以我們**刻意照抄互動**（叫牌盒、名牌、牌號、墩牌堆、側欄），這部分已在 M0 完成。
- 差異化放在：繁中為主的六種語言、手機版東西兩家橫躺、可安裝的 PWA、台灣用語的叫品說明、淡江橋譜（社團制度書）直接連結。

## 9. 定位與 SWOT

| 優勢 | 劣勢 |
| --- | --- |
| 社團制度與中文優先；機器人看得懂；開發速度快（一個 task 一個 PR）；免費方案就能營運 | 沒有 BBO 的在線人數；機器人實力目前遠不如 GIB；單一 Durable Object 的規模上限 |
| **機會** | **威脅** |
| BBO 沒做好的：多人挑戰、紀錄搜尋、精選講解、多制度機器人、等級；台灣各大專橋藝社、地方橋藝協會缺一個自己的平台 | BBO 也在快速改進（GIBBO）；機器人運算成本；付費功能若涉及獎金有法律風險 |

## 10. 參考資料

- BBO：[Introducing GIBBO: A Revolutionary Upgrade to GIB](https://news.bridgebase.com/2025/12/18/introducing-gibbo/)（2025-12-18）
- BBO：[About Challenges](https://doc.bridgebase.com/Help/Challenges/About_Challenges.html)、[Bridge Base Online Help — Challenges](https://doc.bridgebase.com/Help/Challenges/HelpChallenges.html)、[What are challenges?](https://news.bridgebase.com/what-are-challenges/)
- BBO：[New Challenges on BBO](https://news.bridgebase.com/2025/09/29/new-challenge-on-bbo)（BXP Challenge、Challenge Reward）
- BBO：[Five unique bridge robots versus human skill](https://blog.bridgebase.com/?p=18894)（GIB、Argine、ACBL-Ben 比較）
- BBO：[An introduction to team games](https://www.bridgebase.com/tourney/help/Articles/Anintroductiontoteamgames.html)、論壇 [how do you play team games on BBO?](https://www.bridgebase.com/forums/topic/82124-how-do-you-play-team-games-on-bbo/)
- BBO 論壇（社群回報）：[Play of the Hand and Defense by GIB](https://www.bridgebase.com/forums/topic/83179-play-of-the-hand-and-defense-by-gib/)、[Is it possible for our couples group to have a tournament on BBO?](https://www.bridgebase.com/forums/topic/86781-is-it-possible-for-our-couples-group-to-have-a-tournament-on-bbo)
- Ginsberg, M. L. (2001). GIB: Imperfect Information in a Computationally Challenging Game. *JAIR* 14（[PDF](https://www-ai.cs.tu-dortmund.de/DOKUMENTE/JAIR/volume14/ginsberg01a.pdf.gz)）
- [Ben（GitHub）](https://github.com/larrycai/ben)、BBO 關於 Ben 的說明（[news.bridgebase.com/?p=30111](https://news.bridgebase.com/?p=30111)）
- Funbridge：[Challenges FAQ](https://funbridge.com/faq/challenges)、[Progress at bridge with our artificial intelligence](https://funbridge.com/blog/?p=31217)
- 論文：[Competitive Bridge Bidding with Deep Neural Networks](https://arxiv.org/abs/1903.00900v2)（2019）、[A Simple, Solid, and Reproducible Baseline for Bridge Bidding AI](https://arxiv.org/pdf/2406.10306)（2024）
