# DEPLOY — 部署與管理

淡江牌桌部署在 Cloudflare Workers（免費方案）。前端靜態檔案、API、WebSocket 與資料庫都在同一個 Worker 底下，網址是 `https://tku-bridge-table.genelee-pro.workers.dev`。

這個 Worker 也是姊妹站**淡江橋譜**（TKU BridgeBook，部署在 Vercel）的後端：兩個網站共用同一批帳號，橋譜線上編輯的內容、版本紀錄與 AI 匯入也存在這裡。橋譜的 `vercel.json` 把它的 `/api/*` 轉給這個 Worker（見 ARCHITECTURE.md §5.2）。**Worker 的網址若改變，要同步改橋譜的 `vercel.json` 與 `src/lib/api.ts` 的 `TABLE_SITE`。**

## 1. 第一次部署

需要一個 Cloudflare 帳號（免費）。

```bash
npx wrangler login                  # 開瀏覽器登入 Cloudflare
npx wrangler secret put INVITE_CODE # 設定註冊用的邀請碼（輸入後不會顯示）
npm run deploy                      # 建置並部署
```

部署完成後終端機會印出網址，把網址和邀請碼給社員即可。

> 第一次部署時 Cloudflare 可能要求先在 Dashboard 選一個 `workers.dev` 子網域。

## 2. 自動部署（CI/CD）

PR 合併到 `main` 後，GitHub Actions 會自動：

1. **CI**（`.github/workflows/ci.yml`）：lint → 型別檢查 → 測試 → 建置。
2. **Deploy**（`.github/workflows/deploy.yml`）：CI 通過後，建置並 `wrangler deploy`，再檢查網站是否已經在跑這個 commit（`/api/me` 回 401、`/history` 回 200）。CI 失敗就不會部署。

要啟用，GitHub repo 需要兩個 secret（Settings → Secrets and variables → Actions）：

| Secret | 內容 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 帳號 ID（Dashboard 右側，或 `npx wrangler whoami`） |
| `CLOUDFLARE_API_TOKEN` | 部署用的 API token，建立方式如下 |

建立 API token：Cloudflare Dashboard → 右上頭像 → **My Profile** → **API Tokens** → **Create Token** → 範本 **Edit Cloudflare Workers** → **Use template** → Account Resources 選你的帳號、Zone Resources 選 **All zones** → **Continue to summary** → **Create Token**，複製產生的 token（只會顯示一次）。

在專案資料夾執行下面這行，貼上 token 後按 Enter（不會顯示在畫面上）：

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

沒有設定這兩個 secret 時，部署步驟會自動略過，不會讓 CI 失敗。要手動重新部署目前的 `main`：GitHub → Actions → Deploy → **Run workflow**，或 `gh workflow run Deploy`。

每次部署都會在 Cloudflare 的版本紀錄留下 commit 編號（`npx wrangler deployments list` 的 Message 欄位）。

## 2.1 PR 預覽與 staging

除了正式站，還有兩種**和正式站完全分開**的環境。它們是不同的 Worker，各有自己的 Durable Object 與資料庫，不會讀寫正式站的帳號與紀錄；邀請碼各自設定，也**不會**有 `ANTHROPIC_API_KEY`（除非你自己幫它設）。

| 環境 | Worker 名稱 | 什麼時候部署 | 資料 |
| --- | --- | --- | --- |
| PR 預覽 | `tku-bridge-table-pr-<PR 號>` | 每個 PR 開啟、每次 push（`.github/workflows/preview.yml`） | 每個 PR 一份，**PR 關閉或合併時連同 Worker 一起刪除** |
| staging | `tku-bridge-table-staging` | `main` 的 CI 通過後自動部署；也可以手動部署任一分支 | 一直保留 |

PR 預覽部署好後，機器人會在 PR 留一則留言貼預覽網址（之後每次 push 更新同一則）。網址是 `https://tku-bridge-table-pr-<號>.<你的子網域>.workers.dev`，staging 是 `https://tku-bridge-table-staging.<你的子網域>.workers.dev`。

**為什麼不用 `wrangler versions upload` 的預覽網址**：版本是同一個 Worker，綁的是同一個 Durable Object，預覽會直接讀寫正式站的資料；而且 Cloudflare 不替有 Durable Object 的 Worker 產生版本預覽網址。所以預覽和 staging 都是獨立的 Worker（`wrangler.jsonc` 的 `env.preview`、`env.staging`），免費方案可以有 100 個 Worker，足夠。

### 要設定的 GitHub secret

除了 §2 的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（同一個 token 就有權限建立與刪除預覽 Worker），再加：

| Secret | 給誰用 | 沒設定時 |
| --- | --- | --- |
| `PREVIEW_INVITE_CODE` | 所有 PR 預覽的註冊邀請碼 | 不部署預覽（工作流程顯示提示，不會失敗） |
| `STAGING_INVITE_CODE` | staging 的註冊邀請碼 | 不部署 staging |
| `SEED_PASSWORD` | 測試帳號的密碼（預覽與 staging 共用，至少 6 個字） | 不建立測試帳號，第一個註冊的人就是管理員 |

在專案資料夾逐一執行（貼上值後按 Enter，不會顯示在畫面上），邀請碼請不要和正式站相同：

```bash
gh secret set PREVIEW_INVITE_CODE
gh secret set STAGING_INVITE_CODE
gh secret set SEED_PASSWORD
```

從 fork 來的 PR 與 Dependabot 的 PR 拿不到 secret，一律不部署預覽（這是 GitHub 的規則，也是刻意的：外人的程式碼不能拿到 Cloudflare 金鑰）。

### 測試資料

設了 `SEED_PASSWORD` 時，每次部署後會自動執行種子指令，建立（已經有的就略過）：

- `admin`：管理員（空的網站第一個帳號）
- `tester1`–`tester8`：已核准的社員
- `applicant1`：一筆等待核准的申請

密碼都是 `SEED_PASSWORD`。也可以自己對 staging、預覽或本機執行（指令會拒絕正式站）：

```bash
SEED_PASSWORD=... SEED_INVITE_CODE=... npm run seed -- --url https://tku-bridge-table-staging.<子網域>.workers.dev
```

若在管理頁改了那個環境的邀請碼，種子會失敗（部署不受影響），把 `SEED_INVITE_CODE` 換成新的再手動執行即可。

### 手動部署某個分支到 staging

GitHub → Actions → Staging → **Run workflow**，在 `ref` 填分支名稱（或 `gh workflow run Staging -f ref=<分支>`）。下一次合併到 `main` 時，staging 會換回 `main`。適合在合併前用真的 Cloudflare 試有風險的改動（例如 Durable Object 拆分、migration）。

### 需要 AI 匯入時

預覽與 staging 預設沒有 Claude API 金鑰，匯入頁會顯示尚未設定。真的要測時，只對那個 Worker 設定（會用到你的 API 額度）：

```bash
npx wrangler secret put ANTHROPIC_API_KEY --name tku-bridge-table-staging
```

### 新增 Durable Object 或其他綁定時

`wrangler.jsonc` 最上層的 `durable_objects`、`vars` 等綁定**不會**被環境繼承：在最上層加了綁定，`env.staging` 與 `env.preview` 也要各加一份；`migrations` 只寫在最上層，三個環境共用。例外是只屬於正式站的東西：R2 bucket `BACKUPS` 不加到環境裡，環境的 `triggers.crons` 設成空的（§4.4）。D1（§4.5）每個環境用**自己的**資料庫：正式站與 staging 的 `database_id` 不同，PR 預覽沒有 D1（一個資料庫會被所有預覽共用）。

### 手動清理

PR 關閉時預覽會自動刪除。若有漏掉的（例如當時還沒設定 secret），在 Cloudflare Dashboard → Workers & Pages 刪除 `tku-bridge-table-pr-<號>`，或執行 `npx wrangler delete --name tku-bridge-table-pr-<號>`。刪除 Worker 會一併刪除它的 Durable Object 資料。**不要刪 `tku-bridge-table`（正式站）。**

## 3. 設定

| 設定 | 位置 | 預設 | 說明 |
| --- | --- | --- | --- |
| `MAX_USERS` | `wrangler.jsonc` 的 `vars` | `10` | 帳號上限，改完重新部署 |
| `INVITE_CODE` | `wrangler secret put INVITE_CODE` | 無 | 註冊與「忘記密碼」時必須輸入；沒設定時任何人都能送出申請 |
| `ANTHROPIC_API_KEY` | `wrangler secret put ANTHROPIC_API_KEY` | 無 | 淡江橋譜「匯入檔案」用的 Claude API 金鑰；沒設定時匯入頁會說明尚未設定，其他功能不受影響 |
| `IMPORT_MODEL` | `wrangler.jsonc` 的 `vars` | `claude-opus-5-5` | 匯入用的模型，通常不用改 |
| `EDGE_AUTH_SECRET` | `wrangler secret put EDGE_AUTH_SECRET` | 無 | 簽邊緣通行證（§4.5）；沒設定時不發通行證，Worker 什麼都問社團 |
| `EDGE_AUTH` | `wrangler.jsonc` 的 `vars` 或 `--var` | 開 | `off` 關掉通行證（§4.5） |
| `HISTORY_D1` | `wrangler.jsonc` 的 `vars` 或 `--var` | 開 | `off` 讓紀錄頁改回社團回答、停止寫 D1（§4.5）；沒有 `HISTORY` binding（PR 預覽）時本來就沒有 |
| `SYSTEM_PROFILE_ID` | `wrangler.jsonc` 的 `vars` 或 `--var` | `club` | TKB 用淡江制度時，叫品帶哪個制度集的橋館文字（ROBOT.md「橋館的文字跟著叫品」）；那個制度集要先在橋館差異報告頁同步過 |
| `BOOK_SEED_TOKEN` | `wrangler secret put BOOK_SEED_TOKEN` | 無 | 橋館寫入內建特約用的權杖（§4.9，至少 32 字）；沒設定時只有管理員登入後能寫 |
| `BOOK_EXPORT_TOKEN` | `wrangler secret put BOOK_EXPORT_TOKEN` | 無 | 橋館排程備份讀全部特約用的權杖（§4.10，至少 32 字，只能讀 `GET /api/book/export`）；沒設定時只有管理員登入後能匯出 |
| `ANTHROPIC_BASE_URL` | `.dev.vars` | 無 | 只給測試或 API 閘道用（本機可以指向假的 API），正式環境不要設定 |

本機開發的值放在 `.dev.vars`（從 `.dev.vars.example` 複製，不會 commit）。

## 4. 管理員與管理頁

**第一個註冊的帳號就是管理員**，直接登入；之後每個人註冊都是送出「申請」，要等管理員核准才能登入（在淡江牌桌或淡江橋譜申請都一樣）。有申請在等時，頁首的「管理」旁會出現紅色數字。管理頁可以：

| 工作 | 做法 |
| --- | --- |
| 核准註冊 | 「待審核的申請」→「核准」或「拒絕」。申請人可以填自我介紹（例如姓名、系級），方便確認是社員；拒絕後那個帳號名稱可以重新申請 |
| 開橋譜權限 | 社員列表的「橋譜權限」：**線上編輯**（在淡江橋譜修改、新增特約）、**匯入檔案**（用 AI 把 Word／PDF 整理成特約，會用到 API 額度）。管理員自動擁有全部權限 |
| 社員忘記密碼 | 社員可以自己在登入頁按「忘記密碼？」：輸入帳號、邀請碼和新密碼就重設，所有裝置的登入會被登出，社員列表會顯示「自行重設密碼」的時間。也可以由管理員在社員列表 →「重設密碼」 |
| 管理員忘記密碼 | 為了安全，管理員帳號不能用「忘記密碼」，要由另一位管理員重設。**請至少設兩位管理員** |
| 新增社員 | 「新增社員」輸入帳號密碼（不需要邀請碼也不用審核，仍受人數上限限制） |
| 釋出名額 | 「刪除」不用的帳號；他的牌局紀錄會保留 |
| 多一位管理員 | 「設為管理員」；至少要保留一位，不能取消自己 |
| 改人數上限或邀請碼 | 「社團設定」；存在資料庫，優先於 `wrangler.jsonc` 與 secret 的設定 |
| 卡住的牌桌 | 「牌桌」→「關閉」 |

社員自己可以在頁首名字 →「我的帳號」修改密碼與顯示設定。

> 「忘記密碼」目前沒有 e-mail 驗證：知道邀請碼和帳號名稱就能重設一般社員的密碼。邀請碼請只給社員，外流時到「社團設定」換一個。之後若要加驗證（例如寄信或管理員核准），改 `ClubService.resetForgottenPassword`。

## 4.0 日誌、健康檢查與速率限制

- **日誌**：Cloudflare Dashboard → Workers & Pages → `tku-bridge-table` → Logs（`wrangler.jsonc` 已開 `observability`），或本機 `npx wrangler tail`。每行是一個 JSON 事件（`ARCHITECTURE.md` §5.6）：用 `event` 篩選，`action`／`http` 看動作與耗時、`code` 看錯誤代碼、`level = error` 看伺服器的例外（`crash`）與瀏覽器回報的錯誤（`clientError`）
- **健康檢查**：`https://<網域>/api/health` 回 `{"ok":true,...}` 表示 Worker 與資料都正常，可以接外部監控；裡面的 `metrics`、`alerts` 是最近一小時的指標與告警（§4.7）
- **速率限制**：密碼錯太多次（同一 IP 對同一帳號 5 次，或同一 IP 20 次）要等 15 分鐘；社員說「登不進去、說密碼錯誤太多次」時，等 15 分鐘或換網路即可，管理員也可以直接重設他的密碼。打牌動作每秒超過 10 個、聊天每 2 秒超過 1 句會被擋下並提示（社團的連線與每一桌的連線各算各的）

## 4.1 部署順序（與淡江橋譜一起改版時）

橋譜的新功能（登入、線上編輯、匯入）要呼叫這個 Worker 的新 API，所以**先部署淡江牌桌，再合併橋譜**。Worker 部署後，舊版的橋譜照常運作（它還沒用到這些 API）。

AI 匯入的費用：每次分析用 `claude-opus-5-5`，一份幾頁的講義約 US$0.3，整本舊講義約 US$1.5–2（依輸出長度而定）。帳單在你自己的 Anthropic 帳號。

## 4.2 資料存在哪

所有資料（帳號、待審核的申請、密碼雜湊、牌桌、牌局紀錄、淡江橋譜的線上內容與版本紀錄）都在 Cloudflare 上這個 Worker 的 Durable Object（SQLite 儲存），不在你的電腦或 GitHub。帳號、頭像與淡江橋譜的資料每天另外備份到 R2（§4.4）。紀錄索引另有一份副本在 D1（`tku-bridge-history`，§4.5），只給紀錄頁讀，隨時可以從社團的紀錄重建。密碼只存 PBKDF2 雜湊，管理員也看不到原文。需要直接查看時：Cloudflare Dashboard → Workers & Pages → `tku-bridge-table` → Durable Objects。

## 4.3 每桌一個 Durable Object（H1b，`e11-t17`）

從這一版起，每張牌桌在自己的 Durable Object（`TableObject`）裡跑，社團的物件（`Club`）只留牌桌目錄（`ARCHITECTURE.md` §5.10）。`wrangler.jsonc` 多了 `TABLE` binding 與 migration `v2`（`new_sqlite_classes: ["TableObject"]`）；staging 與 PR 預覽的 `env` 也各加了 `TABLE` binding（binding 不會繼承，migration 共用）。

**部署步驟**（照一般流程，不需要手動執行 migration）：

1. 挑沒有人在打牌的時候合併 PR（打到一半也不會遺失，但每個人都會斷線重連一次）。合併後 CI 綠了自動部署；手動部署是 `npm run deploy`。`wrangler deploy` 會順便套用 migration `v2`。
2. 部署完，社團的物件第一次載入時把舊的 `table:<id>` 一桌一桌搬進各自的物件（`meta:schema` 3 → 4），寫 `tabledir:<id>`、刪 `table:<id>`。中途被回收或某一桌失敗都沒關係：留在 `table:` 的下次（失敗的 60 秒後）再搬，重做不會重複。
3. 檢查：
   - `https://<網域>/api/health` 回 `{"ok":true,...}`，`tables` 是目前的桌數。
   - `npx wrangler tail` 或 Dashboard 的 Logs 搜尋 `tablesMoved`：應該看到 `{"event":"tablesMoved","to":"objects","moved":N,"failed":0}`（沒有舊牌桌就不會有這一行）；`failed` 不是 0 時看同一時間的 `crash`（`where: "moveTablesOut"`）。
   - Dashboard → Workers & Pages → `tku-bridge-table` → Durable Objects 應該多了 `TableObject`。
   - 開一桌、放三個機器人打一副：瀏覽器開發者工具的 Network → WS 會有 `/ws` 與 `/ws/table/<桌 id>` 兩條連線；打完那副出現在紀錄裡。
4. **部署前就開著的分頁請重新整理**：舊的頁面只有 `/ws` 一條連線，它的牌桌動作社團會轉給牌桌（照樣能叫牌出牌），但收不到牌桌的畫面更新。

**出問題時（切回去）**：Durable Object 的 migration 部署後就不能撤銷，`wrangler rollback` 回 v2 之前的版本可能被 Cloudflare 拒絕，舊程式也看不到已經搬進 `TableObject` 的牌桌。所以這一版內建開關：

```bash
npx wrangler deploy --var TABLE_OBJECTS:off   # 牌桌搬回社團的物件，其他不變
```

社團的物件重新載入時，把每一桌從它的 `TableObject` 拿回來（那一桌先停住，不再存檔、推送或讓機器人出牌），存回 `table:<id>`、清掉那個物件、刪 `tabledir:<id>`，`meta:schema` 回到 3，之後的行為和 H1a 一樣（瀏覽器連 `/ws/table/<id>` 會被拒絕，自動改走 `/ws`）。要一直維持關閉，就把 `"TABLE_OBJECTS": "off"` 加進 `wrangler.jsonc` 的 `vars` 開 PR（否則下一次 CI 部署會再打開）；拿掉這個值再部署，牌桌會再搬出去。**不要**刪掉 `TableObject` 類別或 migration `v2`：Cloudflare 會拒絕部署，要刪得另外加一個 `deleted_classes` 的 migration（會連資料一起刪）。

## 4.4 每日備份與還原（淡江橋譜 e10-t08、e11-t12）

每天台灣時間 03:00（`wrangler.jsonc` 的 `triggers.crons`：`0 19 * * *` UTC），Worker 把帳號與淡江橋譜的資料匯出到 R2 bucket `tku-bridge-backups`，檔名 `daily/<台灣日期>.jsonl`，保留 **30 天**（每次備份成功後刪掉更舊的；最新的一份永遠保留，名稱不是 `daily/YYYY-MM-DD.jsonl` 的物件不會被刪）。程式在 `worker/backup.ts`。

- **範圍**：key 開頭是下面這些的全部資料：
  - 淡江橋譜：`book`（線上特約、`bookpart:` 分段、版本紀錄、分類、匯入草稿）、`profile`（制度集）、`article`（文章）、`team:`／`pair:`／`userteam:`／`userpair:`（隊伍與搭檔）。
  - 帳號（兩站共用）：`user:`（帳號、密碼雜湊、權限、頭像版本）、`app:`（等待核准的註冊申請）、`avatar:`（頭像圖片）。帳號與頭像在同一份備份、同一個時間點匯出，還原後每個人的頭像版本一定對得上圖片。
  - 淡江橋館的討論區（2026-10-30 起）：Durable Object SQLite 的五張表 `forum_boards`、`forum_posts`、`forum_comments`、`forum_reactions`、`forum_reports`（看板、貼文、留言、反應、檢舉）。圖片本身在 R2 `bridgebook-files`，不在備份裡（R2 不會跟著還原而消失），備份只有圖片的擁有者紀錄 `file:meta:`。討論區的文字不大：一篇貼文最多幾 KB，一千篇加留言約幾 MB，每天一份、留 30 天仍遠低於 R2 免費的 10 GB；日誌的 `bytes` 可以看實際大小。
  - **不在裡面**：`session:`（登入狀態，還原後大家重新登入）、`meta:settings`（邀請碼與人數上限：沒有時用 `wrangler.jsonc` 的值，而且還原不該把換掉的邀請碼帶回來；遺失的話在管理頁重新設定）、好友與封鎖、私訊、牌局紀錄與紀錄索引的 SQL 表（之後的 e11-t12）。
- **格式**：JSON Lines。第一行是 `{"format":"tku-bridge-backup","version":3,"createdAt":…,"prefixes":[…],"keys":N,"tables":[…],"rows":M}`，之後每個 key 一行 `{"k":"<key>","v":<值>}`，key 之後是 SQL 表的每一列 `{"t":"forum_posts","r":{欄位: 值}}`（照寫入的順序），值與 Durable Object 裡存的一樣；只有位元組（頭像圖片的 `Uint8Array`）寫成 `{"$bytes":"<base64>"}`，讀回來時還原成位元組（剛好叫 `$bytes` 的欄位名稱會多加一個 `$` 跳脫，讀回來一樣）。舊的 `version: 1` 備份（只有淡江橋譜）照樣可以還原，而且只還原它自己的範圍（`prefixes`），不會動到帳號；`version: 1`、`2` 沒有 SQL 表，還原時討論區不動。
- **只有正式站**：staging 與 PR 預覽（§2.1）沒有 `BACKUPS` binding、cron 也關掉（`wrangler.jsonc` 的 `env.*.triggers`），不會寫到正式站的 bucket；在那裡呼叫管理 API 會回 503（`backupUnavailable`）。
- **日誌**：每次備份記一筆 `event = backup`（`ok`、`name`、`keys`、`rows`（SQL 表的列數）、`bytes`、`deleted`；失敗時 `error`）。

### 第一次啟用（部署這個版本**之前**）

R2 bucket 不存在時 `wrangler deploy` 會失敗，而 PR 合併到 `main` 就會自動部署，所以**先建 bucket 再合併**：

1. Cloudflare Dashboard → R2：第一次使用要先啟用 R2（免費額度 10 GB；Cloudflare 可能要求綁定付款方式，免費額度內不收費）。
2. 在專案資料夾：

   ```bash
   npx wrangler r2 bucket create tku-bridge-backups
   npx wrangler r2 bucket list         # 確認有 tku-bridge-backups
   ```

3. 合併、部署後：Dashboard → Workers & Pages → `tku-bridge-table` → Settings → Triggers，確認 Cron Triggers 有 `0 19 * * *`。
4. 不等到半夜，先手動備份一次（見下面的管理 API），確認 R2 裡出現當天的檔案。

### 管理 API（只有管理員）

先用管理員帳號登入淡江牌桌，在瀏覽器的開發者工具 Console（同一個網域，cookie 會自動帶上）執行：

```js
const call = (method, path, body) =>
  fetch('/api/admin' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json())

await call('GET', '/backups')                     // 列出備份（新的在前）與保留天數
await call('POST', '/backups')                    // 立刻備份一次（同一天再跑會覆蓋當天的檔）
await call('POST', '/backups/restore', { name: 'daily/2026-10-25.jsonl' })   // 預演：只回報會寫入幾筆、刪除幾筆
await call('POST', '/backups/restore', { name: 'daily/2026-10-25.jsonl', dryRun: false, confirm: 'daily/2026-10-25.jsonl' })  // 真的還原
```

沒有綁定 bucket 時這些 API 回 503（`backupUnavailable`）。

### 還原

還原會讓**備份範圍內**（那份備份標頭的 `prefixes` 與 `tables`）的資料變回備份當時的樣子：備份之後新增的特約、版本紀錄、草稿都會被刪掉；牌局紀錄不受影響。

`version: 3` 的備份也把**討論區**還原到那一天：五張表先清空、再寫回備份的列（同一個 transaction，失敗就全部不變）；備份之後的貼文、留言、反應、檢舉都會消失，改過的看板名稱回到那天。寫入前先檢查每張表與欄位現在都還在，對不上就整個拒絕（`badBackup`），帳號與特約也不會動。備份之後上傳的討論區圖片仍在 R2，但引用它的貼文消失了，就沒人看得到；之後若要清理再另外處理。預演的回應多了 `tables` 與 `rows`。`book:ticket:`（匯入用的一次性憑證）不還原。`book:version` 會設成比現在和備份都大的數字，讓所有瀏覽器重新下載內容。

還原 `version: 2` 的備份時，帳號也回到那一天：

- 備份之後註冊的帳號、送出的申請、上傳的頭像都會被刪掉；被刪掉的帳號照刪除帳號的方式處理（離開牌桌、從挑戰與邀請裡移除、好友與通知清掉）。備份之後才刪掉的帳號會回來；改過的密碼、權限、頭像回到備份那天。
- **所有人都要重新登入**：登入狀態不在備份裡，還原後全部登入失效、所有連線斷開（包括執行還原的管理員自己）。社團的物件會重新讀取帳號，大廳不會顯示舊的社員。邊緣通行證（§4.5）最多還會再認得 10 分鐘，之後一律要登入。
- 還原前先在社團公告，避免有人在牌桌中途被登出。

1. 決定要還原到哪一天：`GET /backups`。
2. **先備份現況**：`POST /backups`（還原錯了還能回來；注意同一天會覆蓋當天的檔，要保留今天稍早的版本就先下載：`npx wrangler r2 object get tku-bridge-backups/daily/<日期>.jsonl --remote --file before-restore.jsonl`）。
3. 預演：`POST /backups/restore { name }`，看 `puts`、`deletes` 合不合理。
4. 還原：`POST /backups/restore { name, dryRun: false, confirm: name }`。
5. 到淡江橋譜重新整理，確認特約內容與分類是備份那天的樣子；重新登入淡江牌桌，確認社員名單與頭像是備份那天的樣子；打開淡江橋館的討論區，確認最新的貼文是備份那天的。

要看備份內容：`npx wrangler r2 object get tku-bridge-backups/daily/<日期>.jsonl --remote --file backup.jsonl`，用文字編輯器打開（每行一個 key）。

### 還原演練（上線後做一次，AC-10.5）

演練要真實環境，部署後由人執行一次，結果記在這裡：

1. [ ] 啟用後隔天確認 R2 有自動產生的 `daily/<日期>.jsonl`，日誌有 `event = backup`、`ok = true`。
2. [ ] 用編輯帳號在橋譜改一個特約的摘要（例如加上「演練」兩字）並儲存，記下 `GET /api/book/manifest` 的版本號。
3. [ ] 預演還原前一天的備份：`puts`、`deletes` 數量合理（`deletes` 應該包含剛剛那筆版本紀錄）。
4. [ ] 真的還原；`GET /api/book/manifest` 的版本號變大，橋譜重新整理後那個特約的摘要回到改之前，版本紀錄裡沒有剛剛那一筆。
5. [ ] 牌局紀錄不受影響；所有人被登出，重新登入後帳號與頭像是備份那天的樣子（演練前一天之後換的頭像會換回去）。
6. [ ] 記錄日期、執行人、備份大小與花的時間：

| 日期 | 執行人 | 備份檔 | keys／大小 | 結果 |
| --- | --- | --- | --- | --- |
| （待部署後執行） | | | | |

## 4.5 紀錄頁由 Worker 從 D1 回答、邊緣通行證（H2a，`e11-t19`、`e11-t20`）

從這一版起，紀錄列表與搜尋由 Worker 直接從 **D1 的副本**回答，牌桌的連線用**簽章的通行證**確認是誰，兩者都不必叫醒社團的物件（`ARCHITECTURE.md` §5.12）。正本仍在社團的物件裡，副本或通行證不能用時一律照舊交給社團。

### 合併**之前**要做的（只做一次）

`wrangler.jsonc` 裡已經填好 2026-10-26 建立的兩個 D1：正式站 `tku-bridge-history`（`0ffccba3-…`）與 staging `tku-bridge-history-staging`（`0f2e0cc8-…`）。之後要重建時（id 換了就要更新 `wrangler.jsonc`，否則部署會失敗）：

1. 在專案資料夾建兩個資料庫（免費方案最多 10 個）：

   ```bash
   npx wrangler d1 create tku-bridge-history
   npx wrangler d1 create tku-bridge-history-staging
   ```

   每個指令會印出 `database_id`（一串 UUID）。**兩個 id 不要搞混**：正式站的貼到 `wrangler.jsonc` 最上層 `d1_databases` 的 `database_id`，staging 的貼到 `env.staging.d1_databases`。PR 預覽沒有 D1，不用建。貼好 commit 到這個 PR 的分支（或把兩個 id 貼在 PR 留言，由 AI 協作者幫你改）。

   表不用自己建：社團的物件第一次載入時會建（`CREATE TABLE IF NOT EXISTS`），也不需要 `wrangler d1 migrations`。

2. 設定通行證的 secret（正式站與 staging 各一個、**不要相同**；值是一串隨機字，不必記住，換掉只是讓所有通行證失效、自動改問社團）：

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # 產生一串，複製
   npx wrangler secret put EDGE_AUTH_SECRET                                      # 貼上（正式站）
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # 再產生一串
   npx wrangler secret put EDGE_AUTH_SECRET --name tku-bridge-table-staging      # 貼上（staging）
   ```

   `secret put` 會立刻讓目前的版本拿到這個值；舊程式不認得它，沒有影響。沒設也可以合併：只是不發通行證，Worker 什麼都問社團（跟 H1 一樣）。PR 預覽每次部署自動產生一個（`.github/workflows/preview.yml`）。

### 部署與檢查

1. 合併後 CI 綠了自動部署。不用挑時間：沒有新的 Durable Object migration，部署本身跟平常一樣只會讓連線斷一下再自動接回。
2. 社團的物件載入後開始填副本：每秒 20 副，一萬副約 8–10 分鐘。填完之前紀錄頁照舊由社團回答。
3. 檢查：
   - Logs 搜尋 `event = replica`：應該看到 `{"event":"replica","step":"fill","ok":true}`；`ok: false` 的話看 `error`（常見：id 貼錯）。
   - 副本完整、筆數對：

     ```bash
     npx wrangler d1 execute tku-bridge-history --remote --command "SELECT value FROM index_meta WHERE key = 'ready'"
     npx wrangler d1 execute tku-bridge-history --remote --command "SELECT COUNT(*) FROM boards_index"
     ```

     `ready` 是 `1`；筆數等於社團的紀錄數（管理頁、或任一社員紀錄頁「全部」的總數，加上沒公開的挑戰／隊制賽牌局）。
   - 登入後打開紀錄頁，Logs 搜尋 `event = edge`：有 `status: 200` 就是 Worker 從 D1 回答的；`fallback: notReady` 表示還在填，`fallback: error` 表示 D1 出錯（交給社團了，使用者看不出來）。
   - 瀏覽器開發者工具 → Application → Cookies 有 `tbt_pass`（設了 secret 才會有）。開一桌，Logs 裡不應該每次連上桌都出現社團的 `http` 紀錄。
4. 打一副，十秒內出現在紀錄頁（副本約晚 1–2 秒）。

### 出問題時（切回去）

```bash
npx wrangler deploy --var HISTORY_D1:off   # 紀錄頁改回社團回答，社團停止寫 D1，並告訴 D1「副本不完整」
npx wrangler deploy --var EDGE_AUTH:off    # 不發也不認通行證，Worker 什麼都問社團
```

兩個互不影響，資料都不會掉（正本在社團）。要一直維持關閉，就把 `"HISTORY_D1": "off"` 或 `"EDGE_AUTH": "off"` 加進 `wrangler.jsonc` 的 `vars` 開 PR（否則下一次 CI 部署會再打開）。拿掉再部署：副本從頭重填，填完才讓 Worker 讀。

要整個拿掉 D1：先照上面關掉、部署，再從 `wrangler.jsonc` 刪掉 `d1_databases`、部署，最後 `npx wrangler d1 delete tku-bridge-history`。**不要直接刪資料庫而不先關掉**：Worker 會一直讀不到而改問社團（不會壞，但日誌會一直有 `fallback: error`）。

### 額度

D1 免費額度（每天讀 500 萬列、寫 10 萬列、5 GB）的估算在 `ARCHITECTURE.md` §5.12「免費方案」：社團現在的量遠低於上限。Dashboard → Storage & Databases → D1 → `tku-bridge-history` → Metrics 可以看每天讀寫的列數。超過時紀錄頁自動改由社團回答，寫入隔天補上。

## 4.6 每場挑戰一個 Durable Object（H2b，`e11-t18`）

從這一版起，每場挑戰**可以**在自己的 Durable Object（`EventObject`）裡跑：狀態、12 小時前的提醒、截止結算都在那一場的物件，社團的物件（`Club`）留一份副本給所有頁面讀，並負責通知、收桌與公開牌（`ARCHITECTURE.md` §5.12「H2b」）。`wrangler.jsonc` 多了 `EVENT` binding（三個環境各一份）與 migration `v3`（`new_sqlite_classes: ["EventObject"]`，只新增類別，部署時自動套用）。隊制賽還在社團裡（H2c）。

**開關 `EVENT_OBJECTS`，預設關**：只有值是 `on` 才用 `EventObject`。正式站的 `vars` 沒有它，所以**合併、部署這一版之後正式站的行為不變**：挑戰照舊在社團的物件裡，社團第一次載入時只多建兩個表（`event_homes` 空的；`challenge_settled` 把已經結束或已經提醒的舊挑戰標成做過，不會重發通知）。staging 與 PR 預覽在 `wrangler.jsonc` 已經設成 `on`，可以先在那裡試。**正式站什麼時候打開由社長決定。**

### 先在 staging 試（已預設開）

1. `https://<staging 網域>/api/health` 的 `events` 是 `{"objects":N,"unconfirmed":0}`：N 是住在物件裡的挑戰數，`unconfirmed` 不是 0 表示有物件還沒收下（60 秒後重試，看 Logs 的 `crash`，`where` 是 `moveEventsOut` 或 `adoptChallenge`）。
2. 建一場挑戰、對方接受、各打一副：挑戰頁的進度與名次正確；Dashboard → Durable Objects 出現 `EventObject`。
3. 取消一場、或等一場到期（可以建 1 天的）：大家收到該收的通知、只收一次；挑戰的牌之後在紀錄頁對所有人公開。

### 正式站打開（社長決定之後）

1. 挑沒有挑戰快要截止的時候。開一個 PR，把 `"EVENT_OBJECTS": "on"` 加進 `wrangler.jsonc` 最上層的 `vars`，CI 綠了合併自動部署（只用 `npx wrangler deploy --var EVENT_OBJECTS:on` 也可以，但下一次 CI 部署會把它關回去）。
2. 社團的物件重新載入時，把每場**還開著**的挑戰一場一場搬進各自的物件（`meta:events` 1 → 2），已經結束的留在社團。中途被回收或某一場失敗都沒關係：失敗的 60 秒後再搬，重做不會重複；搬到一半時那一場照樣能用（物件第一次被呼叫時會拿社團的副本）。
3. 檢查：
   - `/api/health` 的 `events.objects` 等於開著的挑戰數、`unconfirmed` 是 0。
   - Logs 搜尋 `eventsMoved`：`{"event":"eventsMoved","to":"objects","moved":N,"failed":0}`（沒有開著的挑戰就沒有這一行）；`failed` 不是 0 時看同一時間的 `crash`（`where: "moveEventsOut"`）。
   - 打開一場進行中的挑戰：進度、名次跟搬之前一樣；再打一副，結果有算進去。
   - 等下一次提醒或截止（或在 staging 先試過）：通知只來一次。

### 出問題時（切回去）

把 `vars` 裡的 `EVENT_OBJECTS` 拿掉（或改成 `off`）再部署；急的話先 `npx wrangler deploy --var EVENT_OBJECTS:off`。社團的物件重新載入時把每場挑戰從它的物件拿回來（那一場先停住，不再改、不跑工作、不回報），寫回社團的表、刪掉 `event_homes` 那一列、在社團排好提醒與截止，再清掉那個物件；全部搬完 `meta:events` 回到 1，Logs 有 `{"event":"eventsMoved","to":"club",...}`。拿不回來的那一場繼續在物件裡照常運作，稍後再試。正本只會在一個地方（社團或那一場的物件），所以怎麼切都不會掉挑戰或結果。**不要**刪掉 `EventObject` 類別或 migration `v3`：Cloudflare 會拒絕部署，要刪得另外加一個 `deleted_classes` 的 migration（會連資料一起刪）。

## 4.7 系統狀態、指標與負載測試（H3，`e11-t21`、`e11-t22`）

- **系統狀態**：管理頁最後一個區塊「系統狀態」：在線人數、桌數、正在打牌的人、機器人座位、最近一小時的動作數與 p95 耗時、錯誤率、重連率、機器人思考時間、打完的牌、挑戰物件數。資料是 `/api/health`（不需登入、只有數量），開著時每 30 秒更新。社團的物件重新部署後從上一次寫回的數字接著算（最多差一分鐘）。
- **告警**：有紅色的提示時：
  - 「伺服器錯誤偏多」：Logs 用 `level = error` 或 `event = crash` 篩選，看 `where`。
  - 「重連偏多」：剛部署過（每次部署所有人都會重連一次）就不用管；不然看 Logs 有沒有 `crash`，或 Dashboard 的 Durable Objects 有沒有錯誤。
  - 「動作變慢」：多半是社團的物件太忙（大廳人很多，`docs/LOAD.md` §5）。
  - 「機器人思考變慢」：機器人用的是遠端大腦時才會出現。
- **CPU**：Dashboard → Workers & Pages → `tku-bridge-table` → Observability（Logs）→ 查詢 `$workers.cpuTimeMs`（每次呼叫的 CPU，含 Durable Object）；也可以按 `$workers.scriptName`、`$workers.entrypoint` 分組看 p99。
- **外部監控**（沒有設定，要不要由社長決定）：UptimeRobot 之類的免費服務每 5 分鐘讀一次 `/api/health`、檢查內容有 `"alerts":[]`，一天約 288 個 Worker 請求＋288 個 Durable Object 請求（不到每日額度的 0.3%）。
- **負載測試**：只對本機、staging 或 PR 預覽（指令會拒絕正式站），遠端一次不超過每日額度的 15%（指令會先估算，超過就拒絕）。做法與結果在 `docs/LOAD.md`：

```bash
LOAD_PASSWORD=... LOAD_INVITE_CODE=... npm run load -- --url https://tku-bridge-table-pr-<號>.<子網域>.workers.dev   --users 30 --tables 5 --robot-tables 2 --watchers 6 --minutes 5 --challenge 3 --dry-run   # 先看估算
```

## 4.8 圖片檔案（淡江橋譜 e11-t02，R2 bucket `bridgebook-files`）

討論區貼文與文章的圖片存在 R2 bucket `bridgebook-files`（binding `FILES`，程式在 `worker/files.ts`，規格在 `shared/files.ts`、ARCHITECTURE.md §5.14）。頭像**不在這裡**（仍在 `avatar:`，§4.4）。

**現在的狀態**：2026-10-29 已建 bucket 並打開 `FILES` binding。（binding 指向不存在的 bucket 時 `wrangler deploy` 會失敗；沒有 binding 時圖片 API 一律回 503（`filesOff`），其他功能照常。）

### 啟用（只做一次）

1. 建 bucket：

   ```bash
   npx wrangler r2 bucket create bridgebook-files
   npx wrangler r2 bucket list         # 確認有 bridgebook-files
   ```

2. 開一個 PR，把 `wrangler.jsonc` 裡 `r2_buckets` 的 `FILES` 那一行取消註解（保留前面的逗號），CI 綠了合併；合併即部署。
3. 檢查：登入後 `POST /api/files/ticket` 不再回 503。

- **只有正式站**：staging 與 PR 預覽沒有 `FILES`（`r2_buckets` 不繼承），在那裡上傳圖片回 503。
- **額度**：R2 免費 10 GB；每人每天最多 30 張、每張 ≤ 2 MB、縮圖 ≤ 256 KB；電子書 PDF 每本 ≤ 50 MB（橋館 e5-t09）。超過 8 GB 時管理員會收到通知（`e5-t15`），會超過 10 GB 的上傳一律拒絕。
- **電子書**（橋館 e5-t09，2026-10-29）：沿用同一個 bucket，不用另建；bucket 啟用後橋館的電子書頁才能上傳與閱讀。
- **備份**：每日備份含 `file:meta:`（誰上傳、型別、大小）、`file:secret`（簽網址的金鑰）與 `ebook:`（電子書的資料）；圖片與 PDF 本身只在 R2，不另外備份。

## 4.9 橋館的內建特約（L0，2026-10-29）

橋館的 22 個內建特約原本打包在橋館的靜態網站裡（知道網址就抓得到）；2026-10-29 起存在這個 Worker（`book:builtin:*`，ARCHITECTURE.md §5），只有登入的社員讀得到。**這個 repo 是公開的，內容不放這裡**：特約的原始檔在橋館的 private repo，由它的 `scripts/seed-builtin.ts` 寫入（橋館 `CONTENT_GUIDE.md`）。

- 權杖：`BOOK_SEED_TOKEN`（隨機 32 字以上）。設定：`npx wrangler secret put BOOK_SEED_TOKEN`；同一個值放在橋館本機的 `.env.seed`（不 commit）。沒有權杖時，管理員登入後在瀏覽器 Console 呼叫 `PUT /api/book/builtin` 也可以。
- 寫入一律先預演（橋館 `npm run seed-builtin` 預設就是預演），看報告再 `-- --apply`，最後 `-- --verify` 逐字比對。
- **還原備份之後**：備份範圍含 `book`，所以還原到寫入內建特約之前（2026-10-29 前）的備份會把內建特約一起刪掉，橋館會變成空的。還原後在橋館重跑一次 `npm run seed-builtin -- --apply`。
- PR 預覽與 staging 各有自己的儲存，要看內容就對它們的網址各寫入一次（`--base <網址>`，權杖用那個環境的 secret）。

## 4.10 橋館特約的匯出備份（L1，`e8-t12`）

`GET /api/book/export` 回社員讀到的全部特約（內建層＋線上版本蓋上去，`BookExport`，ARCHITECTURE.md API 表）。橋館的 GitHub Action（`.github/workflows/content-backup.yml`）每天用它把特約備份到一個 **private** repo 的 `content-backup` 分支（橋館 `CONTENT_GUIDE.md` §5）。

- 權杖：`BOOK_EXPORT_TOKEN`（隨機 32 字以上，**和 `BOOK_SEED_TOKEN` 不同值**：它只能讀匯出，不能寫）。設定：`npx wrangler secret put BOOK_EXPORT_TOKEN`；同一個值放在橋館 repo 的 Actions secret `BOOK_EXPORT_TOKEN`。
- 沒有權杖時只有管理員登入後能匯出（瀏覽器 Console `fetch('/api/book/export')`）。
- 這份是 Git 上的文字備份與變更紀錄，不取代 §4.4 的每日備份（那份含帳號、紀錄與所有版本）。

## 4.11 橋館制度卡 PDF（Browser Run，橋館 e3-t13）

橋館制度卡頁的「下載 PDF」把卡頁的列印版面（樣式內嵌、不含程式）送到 `POST /api/book/card-pdf`，Worker 用 Cloudflare **Browser Run**（原名 Browser Rendering）的 `quickAction('pdf')` 印成 A4 PDF 回傳（`worker/card-pdf.ts`）。只給登入的社員。

- **綁定**：`wrangler.jsonc` 的 `"browser": { "binding": "BROWSER" }`，正式站、staging、PR 預覽各一份。Workers 免費方案就有，不用到 Dashboard 開通、不用付款方式。
- **額度**（免費方案，2026-10 Cloudflare 文件）：每天 10 分鐘瀏覽器時間、同時 3 個瀏覽器、每 20 秒開 1 個新的。一張卡約 1–5 秒，一天約一兩百份。Worker 自己再限制：每人一次最多 5 份、之後每 2 分鐘 1 份；全社每天用到 8 分鐘就停（留 2 分鐘給 Dashboard 試用）；同一份內容一小時內直接回記憶體裡的結果。計數都在記憶體，Durable Object 被回收就重算。
- **失敗時**：沒有綁定、Browser Run 失敗回 503 `cardPdfOff`，額度用完回 429 `cardPdfBusy`；橋館都改開瀏覽器的列印視窗（和 L4 之前一樣）。
- **安全**：頁面在 Browser Run 裡不跑 JavaScript、擋掉所有 http(s) 請求，字型用 Browser Run 內建的（Arial、Noto CJK），所以不會去抓任何網址。
- **用量**：Cloudflare Dashboard 的 Browser Run 頁面看每天用掉的時間。
- **關掉**：拿掉 `wrangler.jsonc` 的三個 `browser` 綁定再部署，橋館自動退回瀏覽器列印。

## 5. 費用與限制

- Workers 免費方案：每天 10 萬次請求；WebSocket 訊息以 20:1 計算，一個晚上打牌遠低於上限。
- SQLite Durable Object 免費方案：5 GB 儲存；一副牌的紀錄連同索引約 4 KB，約可存一百萬副以上。紀錄列表一次只讀 50 筆，資料再多也不會變慢。
- 免費方案每次請求的 CPU 時間有限，因此密碼雜湊使用 50,000 次 PBKDF2（`worker/auth.ts`）。
- Browser Run 免費方案：每天 10 分鐘瀏覽器時間，只用在橋館的制度卡 PDF（§4.11）。
- D1 免費方案：每天讀 500 萬列、寫 10 萬列，全部 5 GB。紀錄索引的副本每副約寫 14 列，一天約 7,000 副才到上限（§4.5、`ARCHITECTURE.md` §5.12）。
