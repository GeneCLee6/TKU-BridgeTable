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

`wrangler.jsonc` 最上層的 `durable_objects`、`vars` 等綁定**不會**被環境繼承：在最上層加了綁定，`env.staging` 與 `env.preview` 也要各加一份；`migrations` 只寫在最上層，三個環境共用。

### 手動清理

PR 關閉時預覽會自動刪除。若有漏掉的（例如當時還沒設定 secret），在 Cloudflare Dashboard → Workers & Pages 刪除 `tku-bridge-table-pr-<號>`，或執行 `npx wrangler delete --name tku-bridge-table-pr-<號>`。刪除 Worker 會一併刪除它的 Durable Object 資料。**不要刪 `tku-bridge-table`（正式站）。**

## 3. 設定

| 設定 | 位置 | 預設 | 說明 |
| --- | --- | --- | --- |
| `MAX_USERS` | `wrangler.jsonc` 的 `vars` | `10` | 帳號上限，改完重新部署 |
| `INVITE_CODE` | `wrangler secret put INVITE_CODE` | 無 | 註冊與「忘記密碼」時必須輸入；沒設定時任何人都能送出申請 |
| `ANTHROPIC_API_KEY` | `wrangler secret put ANTHROPIC_API_KEY` | 無 | 淡江橋譜「匯入檔案」用的 Claude API 金鑰；沒設定時匯入頁會說明尚未設定，其他功能不受影響 |
| `IMPORT_MODEL` | `wrangler.jsonc` 的 `vars` | `claude-opus-5-5` | 匯入用的模型，通常不用改 |
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
- **健康檢查**：`https://<網域>/api/health` 回 `{"ok":true,...}` 表示 Worker 與資料都正常，可以接外部監控
- **速率限制**：密碼錯太多次（同一 IP 對同一帳號 5 次，或同一 IP 20 次）要等 15 分鐘；社員說「登不進去、說密碼錯誤太多次」時，等 15 分鐘或換網路即可，管理員也可以直接重設他的密碼。打牌動作每秒超過 10 個、聊天每 2 秒超過 1 句會被擋下並提示（社團的連線與每一桌的連線各算各的）

## 4.1 部署順序（與淡江橋譜一起改版時）

橋譜的新功能（登入、線上編輯、匯入）要呼叫這個 Worker 的新 API，所以**先部署淡江牌桌，再合併橋譜**。Worker 部署後，舊版的橋譜照常運作（它還沒用到這些 API）。

AI 匯入的費用：每次分析用 `claude-opus-5-5`，一份幾頁的講義約 US$0.3，整本舊講義約 US$1.5–2（依輸出長度而定）。帳單在你自己的 Anthropic 帳號。

## 4.2 資料存在哪

所有資料（帳號、待審核的申請、密碼雜湊、牌桌、牌局紀錄、淡江橋譜的線上內容與版本紀錄）都在 Cloudflare 上這個 Worker 的 Durable Object（SQLite 儲存），不在你的電腦或 GitHub。密碼只存 PBKDF2 雜湊，管理員也看不到原文。需要直接查看時：Cloudflare Dashboard → Workers & Pages → `tku-bridge-table` → Durable Objects。

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

## 5. 費用與限制

- Workers 免費方案：每天 10 萬次請求；WebSocket 訊息以 20:1 計算，一個晚上打牌遠低於上限。
- SQLite Durable Object 免費方案：5 GB 儲存；一副牌的紀錄連同索引約 4 KB，約可存一百萬副以上。紀錄列表一次只讀 50 筆，資料再多也不會變慢。
- 免費方案每次請求的 CPU 時間有限，因此密碼雜湊使用 50,000 次 PBKDF2（`worker/auth.ts`）。
