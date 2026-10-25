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
- **速率限制**：密碼錯太多次（同一 IP 對同一帳號 5 次，或同一 IP 20 次）要等 15 分鐘；社員說「登不進去、說密碼錯誤太多次」時，等 15 分鐘或換網路即可，管理員也可以直接重設他的密碼。打牌動作每秒超過 10 個、聊天每 2 秒超過 1 句會被擋下並提示

## 4.1 部署順序（與淡江橋譜一起改版時）

橋譜的新功能（登入、線上編輯、匯入）要呼叫這個 Worker 的新 API，所以**先部署淡江牌桌，再合併橋譜**。Worker 部署後，舊版的橋譜照常運作（它還沒用到這些 API）。

AI 匯入的費用：每次分析用 `claude-opus-5-5`，一份幾頁的講義約 US$0.3，整本舊講義約 US$1.5–2（依輸出長度而定）。帳單在你自己的 Anthropic 帳號。

## 4.2 資料存在哪

所有資料（帳號、待審核的申請、密碼雜湊、牌桌、牌局紀錄、淡江橋譜的線上內容與版本紀錄）都在 Cloudflare 上這個 Worker 的 Durable Object（SQLite 儲存），不在你的電腦或 GitHub。淡江橋譜的資料每天另外備份到 R2（§4.3）。密碼只存 PBKDF2 雜湊，管理員也看不到原文。需要直接查看時：Cloudflare Dashboard → Workers & Pages → `tku-bridge-table` → Durable Objects。

## 4.3 每日備份與還原（淡江橋譜 e10-t08）

每天台灣時間 03:00（`wrangler.jsonc` 的 `triggers.crons`：`0 19 * * *` UTC），Worker 把淡江橋譜的資料匯出到 R2 bucket `tku-bridge-backups`，檔名 `daily/<台灣日期>.jsonl`，保留 **30 天**（每次備份成功後刪掉更舊的；最新的一份永遠保留，名稱不是 `daily/YYYY-MM-DD.jsonl` 的物件不會被刪）。程式在 `worker/backup.ts`。

- **範圍**：key 開頭是 `book`（線上特約、`bookpart:` 分段、版本紀錄、分類、匯入草稿）、`profile`（制度集）、`article`（文章）的全部資料。**帳號、牌局紀錄與 SQL 表不在裡面**（之後的 e11-t12）。
- **格式**：JSON Lines。第一行是 `{"format":"tku-bridge-backup","version":1,"createdAt":…,"prefixes":[…],"keys":N}`，之後每個 key 一行 `{"k":"<key>","v":<值>}`，值與 Durable Object 裡存的一模一樣。
- **日誌**：每次備份記一筆 `event = backup`（`ok`、`name`、`keys`、`bytes`、`deleted`；失敗時 `error`）。

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

還原會讓**備份範圍內**（`book*`、`profile*`、`article*`）的資料變回備份當時的樣子：備份之後新增的特約、版本紀錄、草稿都會被刪掉；帳號、牌局不受影響。`book:ticket:`（匯入用的一次性憑證）不還原。`book:version` 會設成比現在和備份都大的數字，讓所有瀏覽器重新下載內容。

1. 決定要還原到哪一天：`GET /backups`。
2. **先備份現況**：`POST /backups`（還原錯了還能回來；注意同一天會覆蓋當天的檔，要保留今天稍早的版本就先下載：`npx wrangler r2 object get tku-bridge-backups/daily/<日期>.jsonl --remote --file before-restore.jsonl`）。
3. 預演：`POST /backups/restore { name }`，看 `puts`、`deletes` 合不合理。
4. 還原：`POST /backups/restore { name, dryRun: false, confirm: name }`。
5. 到淡江橋譜重新整理，確認特約內容與分類是備份那天的樣子。

要看備份內容：`npx wrangler r2 object get tku-bridge-backups/daily/<日期>.jsonl --remote --file backup.jsonl`，用文字編輯器打開（每行一個 key）。

### 還原演練（上線後做一次，AC-10.5）

演練要真實環境，部署後由人執行一次，結果記在這裡：

1. [ ] 啟用後隔天確認 R2 有自動產生的 `daily/<日期>.jsonl`，日誌有 `event = backup`、`ok = true`。
2. [ ] 用編輯帳號在橋譜改一個特約的摘要（例如加上「演練」兩字）並儲存，記下 `GET /api/book/manifest` 的版本號。
3. [ ] 預演還原前一天的備份：`puts`、`deletes` 數量合理（`deletes` 應該包含剛剛那筆版本紀錄）。
4. [ ] 真的還原；`GET /api/book/manifest` 的版本號變大，橋譜重新整理後那個特約的摘要回到改之前，版本紀錄裡沒有剛剛那一筆。
5. [ ] 社員登入、牌局紀錄都不受影響。
6. [ ] 記錄日期、執行人、備份大小與花的時間：

| 日期 | 執行人 | 備份檔 | keys／大小 | 結果 |
| --- | --- | --- | --- | --- |
| （待部署後執行） | | | | |

## 5. 費用與限制

- Workers 免費方案：每天 10 萬次請求；WebSocket 訊息以 20:1 計算，一個晚上打牌遠低於上限。
- SQLite Durable Object 免費方案：5 GB 儲存；一副牌的紀錄連同索引約 4 KB，約可存一百萬副以上。紀錄列表一次只讀 50 筆，資料再多也不會變慢。
- 免費方案每次請求的 CPU 時間有限，因此密碼雜湊使用 50,000 次 PBKDF2（`worker/auth.ts`）。
