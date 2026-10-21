# DEPLOY — 部署與管理

淡江牌桌部署在 Cloudflare Workers（免費方案）。前端靜態檔案、API、WebSocket 與資料庫都在同一個 Worker 底下，網址像 `https://tku-bridge-table.<你的帳號>.workers.dev`。

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
| `INVITE_CODE` | `wrangler secret put INVITE_CODE` | 無 | 註冊時必須輸入；沒設定時任何人都能註冊（直到上限） |

本機開發的值放在 `.dev.vars`（從 `.dev.vars.example` 複製，不會 commit）。

## 4. 管理員與管理頁

**第一個註冊的帳號就是管理員**，頁首會多一個「管理」。管理頁可以：

| 工作 | 做法 |
| --- | --- |
| 社員忘記密碼 | 社員列表 →「重設密碼」，輸入新密碼後告訴他；他在其他裝置的登入會被登出 |
| 新增社員 | 「新增社員」輸入帳號密碼（不需要邀請碼，仍受人數上限限制） |
| 釋出名額 | 「刪除」不用的帳號；他的牌局紀錄會保留 |
| 多一位管理員 | 「設為管理員」；至少要保留一位，不能取消自己 |
| 改人數上限或邀請碼 | 「社團設定」；存在資料庫，優先於 `wrangler.jsonc` 與 secret 的設定 |
| 卡住的牌桌 | 「牌桌」→「關閉」 |

社員自己可以在頁首名字 →「我的帳號」修改密碼與顯示設定。

## 4.1 資料存在哪

所有資料（帳號、密碼雜湊、牌桌、牌局紀錄）都在 Cloudflare 上這個 Worker 的 Durable Object（SQLite 儲存），不在你的電腦或 GitHub。密碼只存 PBKDF2 雜湊，管理員也看不到原文。需要直接查看時：Cloudflare Dashboard → Workers & Pages → `tku-bridge-table` → Durable Objects。

## 5. 費用與限制

- Workers 免費方案：每天 10 萬次請求；WebSocket 訊息以 20:1 計算，一個晚上打牌遠低於上限。
- SQLite Durable Object 免費方案：5 GB 儲存；一副牌的紀錄連同索引約 4 KB，約可存一百萬副以上。紀錄列表一次只讀 50 筆，資料再多也不會變慢。
- 免費方案每次請求的 CPU 時間有限，因此密碼雜湊使用 50,000 次 PBKDF2（`worker/auth.ts`）。
