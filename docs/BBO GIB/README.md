# BBO GIB — 2/1 機器人（GIB 相容）的依據

淡江牌桌的「2/1 機器人」照 BBO 公開的 GIB 制度叫牌，目標是**叫法與說明跟 BBO 的 GIB 一致**，讓社員在這裡練的 2/1 到 BBO 上也通用。這個資料夾記錄它依據的資料、我們自己整理的制度表，以及還要到 BBO 上核對的地方。

- 制度表：[`gib-2over1.md`](gib-2over1.md)（我們依官方說明整理的 2/1 制度，逐條標出處）
- 引擎設計：[`ROBOT.md`](../../ROBOT.md) §6（規則格式、叫品意義、說明怎麼產生）
- 工作項目：[`docs/PRD/e5-robot-bidding-brain.md`](../PRD/e5-robot-bidding-brain.md)「M1 · 2/1 機器人（GIB 相容）」

## 為什麼不直接用 BBO 的 GIB

GIB 是 BBO 的專有軟體，只在 BBO 自己的伺服器上執行，沒有公開 API 或授權方案。唯一的「借用」方法是寫程式登入 BBO、把牌丟給 GIB 再把叫品抓回來，而 BBO 的使用條款（Terms of Use，〈Our Proprietary Rights〉與〈Prohibited Uses of the Site〉）明文禁止：使用自動化程式（bots）、模擬或轉接 BBO 的通訊協定、建立未經授權的連線、複製或轉載 BBO 的內容、用 BBO 的內容營利；帳號也只能由真人使用。

所以我們**照公開的制度說明自己寫規則與說明文字**：用到的是叫牌方法，不是 BBO 的程式或文字。為了避免混淆，介面上不把我們的機器人叫做「GIB」，制度名稱寫「2/1（GIB 相容）」。

## 來源

查閱日期都是 2026-10-23。BBO 的頁面有多個鏡像網域（`online-cf.bridgebase.com`、`www2.dal10.sl.bridgebase.com` 等），內容相同，以 `www.bridgebase.com` 為準。

| # | 來源 | 內容 | 用在哪裡 |
| --- | --- | --- | --- |
| 1 | [GIB System Notes](https://www.bridgebase.com/doc/gib_system_notes.php)（BBO 官方，對應 **GIB V40**，2019-02-14 上線） | GIB 的 2/1 制度：開叫、答叫與再叫、競叫、其他特約、GIB 不打的特約、雙向成局試探、RKCB 0314、1NT／2NT 之後、Soloway 跳叫新花、Reverse Drury；另有 GIB 怎麼首攻、防守信號 | **制度的唯一權威來源**。`gib-2over1.md` 每一條標「官方」的都出自這裡 |
| 2 | [GIB Bid Descriptions](https://www.bridgebase.com/doc/gib_descriptions.php)（BBO 官方） | GIB 怎麼描述手牌：大牌點、總點（短門點的算法）、花色品質、擋張、大牌；規則的「條件」與「表示什麼」；滑鼠指到叫品時的說明怎麼由多條規則合併 | 引擎設計（`ROBOT.md` §6）、牌力計算（`evaluate.ts`）、說明文字（`describe.ts`）、叫牌盒的意義提示 |
| 3 | [GIB 的制度卡](https://webutil.bridgebase.com/v2/acblcc/acblCC.html?x=656469743d6e266b65793d4143424c2f4e2f7261696e2f313239383931343233395f313038365f667265642f3132393839313432333926706172746e65723d7261696e)（ACBL 格式，System Notes 頁首的連結） | 制度卡 | 人工核對用；頁面由 BBO 的程式載入資料，我們不抓取 |
| 4 | [Introducing GIBBO](https://news.bridgebase.com/2025/12/18/introducing-gibbo/)（BBO 官方，2025-12） | 2025-12-16 起 BBO 的機器人改用 GIBBO：估墩、首攻、出牌加入神經網路，**叫牌制度、規則與特約不變** | 確認 V40 的制度說明到現在仍適用 |
| 5 | [BBO Terms of Use](https://news.bridgebase.com/terms/) | 自動化、轉接通訊協定、複製內容、營利的禁止條款 | 上面「為什麼不直接用」 |
| 6 | [Meet Lorand, BBO Software Engineer](https://news.bridgebase.com/2026/05/05/meet-lorand-bbo-software-engineer/)（BBO 官方，2026-05） | BBO 版的 Ben：叫牌模型用最新的 GIB 制度訓練，叫品說明沿用 GIB，攤牌引擎用 GIB | 背景：GIB 的制度與說明仍是 BBO 機器人的共同基礎 |
| 7 | [Ben（lorserker/ben）](https://github.com/lorserker/ben) | 開源橋牌引擎，GPL-3.0，Python 3.12＋TensorFlow，可搭配 BBA（EPBot） | E6 的評測對手（`e6-t30`），不放進牌桌 |
| 8 | [BBA／EPBot](https://sites.google.com/view/bbaenglish) | Edward Piwowar 的叫牌引擎（DLL），有 2/1、SAYC、精準等制度卡，可查任何叫品的意義；網站沒有寫第三方使用的授權條件 | 不採用：跑不進 Cloudflare Worker、授權不明，而且它的 2/1 跟 GIB 叫法常不一樣 |
| 9 | [GIB 2/1 System（zaremba.ch）](https://zaremba.ch/files/2over1-gib.pdf)（第三方，V1.0.0，2026-01-06） | 第三方整理的 GIB 2/1 摘要 | **只當參考**：部分內容和官方說明衝突（例如它寫 Lavinthal 墊牌信號，官方說 GIB 墊牌不打信號），衝突時以官方為準 |

## 我們怎麼使用這些資料

1. **官方說明有寫的，照官方。** `gib-2over1.md` 標「官方」。
2. **官方沒寫的，用一般的 2/1 迫叫成局作法**（Standard American 的 2/1 版本），標「一般」，並列進下面的核對清單。
3. **說明文字自己寫。** 叫品意義用 GIB 的特徵（大牌點、總點、張數、花色品質、擋張、迫叫性）描述，六種語言由 `describe.ts` 產生，不複製 BBO 的英文說明。
4. **BBO 改版時**：先看 GIB System Notes 頁面上的版本號是否還是 V40，再看 BBO 的公告；有變動就更新 `gib-2over1.md` 與規則，並在這裡記下日期。

## 待在 BBO 上核對

GIB 的叫法有些官方說明沒寫。社員在 BBO 上和機器人打牌時，**輪到自己叫牌時把滑鼠移到叫品上**，就能看到 GIB 怎麼理解那個叫品；把看到的範圍記在這裡，我們再改規則。

| 項目 | 我們目前的設定（一般） | BBO 上看到的 | 核對人／日期 |
| --- | --- | --- | --- |
| 一線花色開叫的點力 | 11–21 大牌點、12–22 總點；11 點要符合 20 法則 | | |
| 第三、四家開叫 | 第三家 10 點＋可再叫的五張可開；第四家 15 法則 | | |
| 弱二開叫 | 6 張、5–10 大牌點、前三大有兩張或前五大有三張；不含另一門 4 張高花 | | |
| 三線阻擊 | 7 張、5–10 大牌點 | | |
| 1♣／1♦ 答 2NT、3NT | 2NT 11–12 平均邀請、3NT 13–15 平均 | | |
| 高花的 limit raise | 1M–3M：4+ 張王、10–12 總點 | | |
| Splinter 的點力 | 4+ 張王、該門 0–1 張、13–16 總點 | | |
| Jacoby 2NT 之後開叫者的再叫 | 3 新花＝短門、3M＝18+ 無短門、3NT＝15–17、4 新花＝5 張好花色、4M＝低限 | | |
| 二線爭叫 | 5+ 張、10–17 大牌點 | | |
| Michaels 扣叫 | 兩門 5+、8+ 大牌點 | | |
| 不尋常 2NT | 無身價 8–12、有身價 11–15 大牌點 | | |
| Cappelletti 的點力 | 直接位置 10+ 大牌點 | | |
| 2♣ 開叫的答叫 | 2♦ 等待；正面答叫 5+ 好花色 8+ 點；2NT 8+ 平均 | | |
| Gerber 的回答 | 4♦ 0 或 4、4♥ 1、4♠ 2、4NT 3 張 A | | |
