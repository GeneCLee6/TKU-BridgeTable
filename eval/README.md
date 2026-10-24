# eval/ — 機器人評測平台

機器人對機器人的複式對抗（`e6-t15`～`e6-t17`，AC-6.9）：兩組機器人設定 A、B 在同一組牌上兩桌換位對打，算 A 對 B 的 IMP／副、標準誤、MP 百分比與合約統計。用來證明機器人變強（AC-6.14）、校準等級（`e6-t22`），以及在 CI 擋住退步。

不需要 npm 套件，Node 22 直接跑 TypeScript（`--experimental-strip-types`）。

## 怎麼跑

```bash
npm run eval -- --a tku:college --b tku:beginner              # 快速版 200 副
npm run eval -- --a gib:college --b gib:beginner --set full   # 全部 5,000 副（約 20 秒）
npm run eval -- --a tku:college --b tku:college@../main       # 這份程式的機器人對另一份 checkout 的
npm run eval -- --a tku:college --b tku:college,play=../main  # 叫牌相同、只換出牌（ROBOT.md §3.3 那種比較）
npm run eval:gate -- --base ../main                           # CI 門檻（見下）
```

| 參數 | 意思 |
| --- | --- |
| `--a`、`--b` | 機器人設定 `種類:等級`：`tku`／`gib`，`beginner`／`college`／`open`／`master`；預設 `tku:college` |
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
- **完全確定**：規則機器人沒有亂數；刻意失誤（ROBOT.md §8）的種子是 `eval:種子:副號`，兩桌一樣，所以同一個設定對自己每一副都是 0 IMP（測試會檢查）。
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

`.github/workflows/ci.yml` 的 `robot-eval`：pull request 改到 `shared/`（機器人和它們依照的引擎）或 `eval/` 時，把目標分支（main）checkout 到 `base/`，這個分支的機器人對 main 的機器人打快速版 200 副，兩種機器人各打大專與初學者四場。

**規則**：任何一場 A（這個分支）比 B（main）**差超過 2 個標準誤，而且差超過 0.25 IMP／副**，就失敗（`stats.ts` 的 `regressed`）。

- 兩個標準誤：沒有變差時，因為牌運而失敗的機率大約 2%（單邊）；
- 0.25 IMP／副的下限：差別很集中時（例如只換了少數幾副的打法）標準誤很小，很小的真實損失也會超過兩個標準誤；下限讓「某些牌少一點、換到別的好處」的改動不會被擋。真的要證明變強，用全部 5,000 副自己跑。
- 機器人沒改時兩邊完全一樣，每場都是 0.00 ± 0.00。

報告寫在那次 CI 的 **job summary**（PR 的 Checks 頁面點 `robot-eval`），不用另外的權限或 secret。四場在 CI 大約十秒內跑完（本機約 3 秒）；不需要 `npm ci`。

在本機跑門檻：`npm run eval:gate -- --base <main 的 checkout>`；失敗時結束碼是 1。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `deals.ts` | 固定牌組：`EVAL_SEED`、`evalBoard`、`evalBoards`、`fingerprint` |
| `match.ts` | 一桌打完一副（`playTable`）、兩桌換位的對抗（`playMatch`）；`RobotConfig` 可以帶別的 `RobotBrain` |
| `stats.ts` | IMP／副、標準誤、MP、合約統計（`summarize`）與門檻（`regressed`） |
| `report.ts` | Markdown 報告 |
| `config.ts`、`cli.ts`、`gate.ts` | 指令列（只在 Node 跑；`tsconfig.node.json` 檢查型別） |
