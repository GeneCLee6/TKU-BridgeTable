# eval/ — 機器人評測平台

機器人對機器人的複式對抗（`e6-t15`～`e6-t17`，AC-6.9）：兩組機器人設定 A、B 在同一組牌上兩桌換位對打，算 A 對 B 的 IMP／副、標準誤、MP 百分比與合約統計。用來證明機器人變強（AC-6.14）、之後量 TKB Adv 對 TKB（AC-6.8），以及在 CI 擋住退步。機器人只有 TKB（不分等級，社長 2026-10-24，`ROBOT.md` §7），設定就是它用的制度。

不需要 npm 套件，Node 22 直接跑 TypeScript（`--experimental-strip-types`）。

## 怎麼跑

```bash
npm run eval -- --a tku --b gib                 # 快速版 200 副：淡江制度對 2/1
npm run eval -- --a gib --b gib@../main --set full  # 全部 5,000 副（約 50 秒），這份程式的 TKB 對另一份 checkout 的
npm run eval -- --a tku --b tku,play=../main     # 叫牌相同、只換出牌（ROBOT.md §3.3 那種比較）
npm run eval:gate -- --base ../main              # CI 門檻（見下）
```

| 參數 | 意思 |
| --- | --- |
| `--a`、`--b` | 機器人設定：TKB 用的制度，`tku`（淡江制度）或 `gib`（2/1）；預設 `tku`。以前的 `種類:等級` 寫法已經拿掉 |
| `@目錄` | 機器人用那個目錄的 `shared/robot/brain.ts`（`ruleBrain`），例如 main 的 checkout；叫牌與出牌都換 |
| `,play=目錄` | 只換出牌與攤牌的回應，叫牌照這份程式：兩桌合約一樣，差別只在出牌 |
| `--set` | `quick`（200 副，預設）、`full`（5,000 副）或副數 |
| `--from` | 從第幾副開始（預設 1），例如 `--from 4001 --set 1000` |
| `--seed` | 換一組牌（預設 `tku-eval-v1`）；不同種子的結果不能互相比較 |
| `--json 檔名` | 另存每一副兩桌的合約、墩數、分數與摘要 |

在 Windows 的 PowerShell 一樣用 `npm run eval -- …`。要比較 main，先把 main 放到另一個目錄（例如 `git worktree add ../main main`）。

## 怎麼打

- **兩桌換位**：第 1 桌 A 坐南北、B 坐東西；第 2 桌換過來。同一方的四個機器人用同一組設定。
- **A 在一副的得分**＝第 1 桌南北的分數 − 第 2 桌南北的分數，換成 IMP（`shared/imp.ts`）。
- **完全確定**：TKB 沒有亂數、不刻意失誤，所以同一個設定對自己每一副都是 0 IMP（測試會檢查）。
- 機器人叫完、打完 13 墩，不攤牌。每副的發牌者與身價照副號的 16 副循環。

## 數字的意思

| 數字 | 意思 |
| --- | --- |
| IMP/board | A 平均每副贏幾個 IMP（負的是輸）。± 後面是**標準誤**（各副 IMP 的樣本標準差 ÷ √副數）；95% CI 是平均 ± 1.96 個標準誤 |
| MP | A 的配對賽百分比：一副贏任何分數得 1、平手 ½、輸 0；只有兩桌，所以就是「贏的副數＋平手的一半」÷ 副數 |
| Boards won / lost / tied | 依分數贏、輸、平手的副數 |
| Same contract | 兩桌同一個合約、同一個莊家的副數；越多表示差別越在出牌 |
| Declaring side | 每一方當莊的次數、做成與倒的次數、部分合約／成局／滿貫、被賭倍的次數（兩桌合計） |

**判斷差別是不是真的**：平均超過兩個標準誤（95% CI 不含 0）才算贏或輸；在兩個標準誤以內就可能只是牌運。200 副的標準誤大約 0.3～0.4 IMP／副，5,000 副大約 0.07；要證明小的改進（AC-6.14），用 `--set full`。

## 固定牌組（`deals.ts`，`e6-t16`）

牌組**不存檔**：一組牌就是一個種子加上 `deals.ts` 的產生器。第 n 副用自己的亂數（mulberry32，種子是 `種子:n` 的 FNV-1a 雜湊）洗一副固定順序的牌，所以每一副可以單獨發、快速版就是全組的前 200 副、從第 4,001 副開始也不用先發前面的。產生器放在 `eval/` 而不是用 `shared/board.ts` 的 `deal`，牌桌的發牌改了也不會動到評測的牌。

5,000 副存成 JSON 超過 1 MB，壓成每副 13 bytes 也是 65 KB 看不懂的二進位檔；種子＋程式只要幾十行，`tests/eval/eval.test.ts` 釘住第 1 副的牌與 200 副、5,000 副的指紋，產生器被改到就會失敗。真的要換一組牌，就換 `EVAL_SEED`（舊的結果不能再拿來比）。

## CI 門檻（`gate.ts`，`e6-t17`）

`.github/workflows/ci.yml` 的 `robot-eval`：pull request 改到 `shared/`（機器人和它們依照的引擎）或 `eval/` 時，把目標分支（main）checkout 到 `base/`，這個分支的 TKB 對 main 的打快速版 200 副，淡江制度、2/1 各一場。

**規則**：任何一場 A（這個分支）比 B（main）**差超過 2 個標準誤，而且差超過 0.25 IMP／副**，就失敗（`stats.ts` 的 `regressed`）。

- 兩個標準誤：沒有變差時，因為牌運而失敗的機率大約 2%（單邊）；
- 0.25 IMP／副的下限：差別很集中時（例如只換了少數幾副的打法）標準誤很小，很小的真實損失也會超過兩個標準誤；下限讓「某些牌少一點、換到別的好處」的改動不會被擋。真的要證明變強，用全部 5,000 副自己跑。
- 機器人沒改時兩邊完全一樣，每場都是 0.00 ± 0.00。

報告寫在那次 CI 的 **job summary**（PR 的 Checks 頁面點 `robot-eval`），不用另外的權限或 secret。兩場在 CI 幾秒內跑完（本機約 2 秒）；不需要 `npm ci`。

在本機跑門檻：`npm run eval:gate -- --base <main 的 checkout>`；失敗時結束碼是 1。

## 叫牌題庫（`quiz.ts`，`e5-t23`）

「這手牌、這個叫牌過程，該叫什麼？」附上書上的答案。題目在 `tests/bidding-quiz/`，檔案裡的 `category` 決定分類（`opening` 開叫、`response` 答叫、`rebid` 再叫、`competitive` 競叫、`preempt` 阻擊與對抗阻擊…）。一個分類可以分好幾個檔：檔名用分類開頭（`competitive.json`、`competitive.more.json`），新題目放新檔，不用改別人正在改的檔。

```bash
npm run quiz                  # 這份程式的 TKB 答全部題目，列出各類正確率與答錯的題
npm run quiz -- --base base   # CI 棘輪：base 的 TKB 答同樣的題目，有任何一類比 base 少答對就失敗
```

**一題的格式**：

```json
{ "id": "tku-open-001", "system": "tku", "dealer": "N", "vul": "None",
  "hand": "AK32.KQ4.J52.Q43", "auction": [], "answer": "1N", "accepted": [],
  "source": "淡江橋譜：1NT的答叫", "reviewer": null, "status": "pending", "note": "15 點 4-3-3-3" }
```

| 欄位 | 意思 |
| --- | --- |
| `id` | 全題庫唯一，小寫英數與 `-`，例如 `tku-resp-012` |
| `system` | 答案依哪套制度：`tku`（淡江制度）或 `gib`（2/1）；機器人用這套制度作答 |
| `dealer`、`vul` | 發牌者（`N` `E` `S` `W`）與身價（`None` `NS` `EW` `Both`） |
| `hand` | 輪到叫牌那一家的手牌，`♠.♥.♦.♣` 由大到小，10 寫 `T`，缺門留空（`AKQ32..5432.J43`） |
| `auction` | 從發牌者開始的叫品：`1C`～`7N`、`P`、`X`、`XX`；空的就是開叫題。輪到誰由發牌者與叫品數決定 |
| `answer` | 書上的叫品 |
| `accepted` | 也算對的其他叫品（選填） |
| `source` | 出處：淡江橋譜的哪一篇，或「5542 自然制（ROBOT.md §2）」 |
| `reviewer`、`status` | `pending`（待審核，`reviewer` 是 `null`）或 `reviewed`（社團幹部審過，`reviewer` 寫名字） |
| `note` | 一句話的理由：點力、牌型、哪條規則 |

**怎麼算**：機器人只拿到這一家的手牌（其他 39 張依固定順序分給另外三家，叫牌時機器人不看，ROBOT.md §1）。叫出 `answer` 或 `accepted` 的叫品算答對。報告分制度、分類列出題數、待審核題數、答對率與「完全照書」的題數。

**CI 棘輪**（`.github/workflows/ci.yml` 的 `bidding-quiz`）：每個 pull request 都跑，把目標分支（main）checkout 到 `base/`，**用這個分支的題目**讓兩邊的 TKB 作答；任何一個「制度／分類」這個分支答對的題數比 main 少就失敗。所以只加題目不會失敗（兩邊答同樣的題），改規則讓某類少答對一題就會被擋；新的分類（main 沒有的）不比較。報告在 job summary，答錯的題列在最後。

`tests/eval/quiz.test.ts` 檢查每一題的格式（手牌 13 張不重複、叫牌過程合法、答案合法、出處、審核狀態）、id 不重複，以及 TKB 對每一題都叫出合法的叫品。

**推論題庫**（`inference.ts`，`e5-t21`）：「這個叫牌過程之後，每一家表示了什麼？」題目在 `tests/inference-quiz/`，每題是叫牌過程加上書上說的範圍（`expect`：每一家的 `hcp`、各門 `len`、`balanced`，只寫書上講清楚的），`tests/eval/inference.test.ts` 用 `infer.ts` 的 `read` 逐題比對。引擎讀錯的題目寫 `miss`（為什麼不同）：測試期待它仍然不同，修好之後會提醒拿掉 `miss`。其他欄位（`source`、`reviewer`、`status`、`note`）跟叫牌題庫一樣。

**出牌題庫**（`play-quiz.ts`，`fix/tkb-defence-reported`）：「這副牌、這個叫牌過程、已經出了這些牌，現在該出哪張？」附教科書的答案。題目在 `tests/play-quiz/`，一個檔一個分類（`second-hand` 第二家與第四家、`third-hand` 第三家…）。機器人只拿到它看得到的牌（自己、夢家、已出的牌，ROBOT.md §1）。

```bash
npm run quiz:play                  # 這份程式的 TKB 答全部題目，列出各類正確率與答錯的題
npm run quiz:play -- --base base   # CI 棘輪：base 的 TKB 答同樣的題目，有任何一類比 base 少答對就失敗
```

```json
{ "id": "play-third-001", "system": "both", "board": 3,
  "hands": { "N": "A32.753.QJT9.K43", "E": "Q876.QT9.A32.872", "S": "KJ5.A62.K87.AQJ6", "W": "T94.KJ84.654.T95" },
  "auction": ["1N", "P", "3N", "P", "P", "P"], "play": ["H4", "H3"],
  "answer": "HQ", "accepted": [], "source": "教科書：第三家大", "reviewer": null, "status": "pending", "note": "…" }
```

| 欄位 | 意思 |
| --- | --- |
| `system` | `tku`、`gib`，或 `both`（兩種制度答案一樣，兩個機器人都答） |
| `board` | 副號，發牌者與身價照副號（`shared/board.ts`） |
| `hands` | 四家的牌，`S.H.D.C`；機器人只看得到規則允許的部分 |
| `auction` | 從發牌者開始的全部叫品，必須叫完 |
| `play` | 已經出的牌，依序；輪到誰由牌局決定 |
| `answer`、`accepted` | 書上的那張牌，與也算對的牌 |

其餘欄位（`source`、`reviewer`、`status`、`note`）跟叫牌題庫一樣。`tests/eval/play-quiz.test.ts` 檢查格式（四家 52 張不重複、叫牌與出牌合法、答案合法、至少兩張牌可選）、id 不重複，以及 TKB 對每一題都出合法的牌；CI 的 `bidding-quiz` job 也跑這個棘輪（`npm run quiz:play -- --base base`）。

**出題與審核**：一開始的 50 題（`e5-t42` 的第一批）是 AI 依淡江橋譜與 5542 自然制寫的，全部標 `pending`；社團幹部逐題確認後把 `status` 改成 `reviewed`、`reviewer` 填名字，答案有錯就直接改，並補到 200 題（開叫、答叫、再叫）。機器人答錯的題目不用刪：它們是之後改規則的目標（例如 `tku-open-004` 第三家輕開、`tku-open-016` Rule of 15，等 `e5-t24`）。

## 離線雙明手模擬（`sim/`）

在社長的電腦上用多核心 DDS 算幾萬到幾百萬副牌，比較 TKB 的出牌跟單明手抽樣的最佳，和首攻研究：`npm run sim -- …`，見 [`sim/README.md`](sim/README.md)。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `sim/` | 離線雙明手模擬：執行緒池、單明手抽樣、TKB 對照、首攻研究（`sim/README.md`） |
| `quiz.ts`、`quiz-cli.ts` | 叫牌題庫：格式檢查、作答、各類正確率、棘輪與報告；`npm run quiz` |
| `play-quiz.ts`、`play-quiz-cli.ts` | 出牌題庫：格式檢查、作答、各類正確率，棘輪與報告沿用叫牌題庫的；`npm run quiz:play` |
| `deals.ts` | 固定牌組：`EVAL_SEED`、`evalBoard`、`evalBoards`、`fingerprint` |
| `match.ts` | 一桌打完一副（`playTable`）、兩桌換位的對抗（`playMatch`）；`RobotConfig` 可以帶別的 `RobotBrain` |
| `stats.ts` | IMP／副、標準誤、MP、合約統計（`summarize`）與門檻（`regressed`） |
| `report.ts` | Markdown 報告 |
| `config.ts`、`cli.ts`、`gate.ts` | 指令列（只在 Node 跑；`tsconfig.node.json` 檢查型別） |
