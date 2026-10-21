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

## 2. 自動部署（GitHub Actions，選用）

`.github/workflows/deploy.yml` 會在 `main` 有新 commit、CI 通過後自動部署。要啟用：

1. Cloudflare Dashboard → My Profile → API Tokens → Create Token → 範本「Edit Cloudflare Workers」。
2. GitHub repo → Settings → Secrets and variables → Actions，新增：
   - `CLOUDFLARE_API_TOKEN`：上一步的 token
   - `CLOUDFLARE_ACCOUNT_ID`：Cloudflare Dashboard 右側的 Account ID

沒有設定這兩個 secret 時，部署步驟會自動略過，不會讓 CI 失敗。

## 3. 設定

| 設定 | 位置 | 預設 | 說明 |
| --- | --- | --- | --- |
| `MAX_USERS` | `wrangler.jsonc` 的 `vars` | `10` | 帳號上限，改完重新部署 |
| `INVITE_CODE` | `wrangler secret put INVITE_CODE` | 無 | 註冊時必須輸入；沒設定時任何人都能註冊（直到上限） |

本機開發的值放在 `.dev.vars`（從 `.dev.vars.example` 複製，不會 commit）。

## 4. 常見管理工作

目前沒有管理後台，以下用 Cloudflare Dashboard → Workers & Pages → `tku-bridge-table` → Durable Objects 的資料瀏覽器處理：

| 工作 | 做法 |
| --- | --- |
| 社員忘記密碼 | 刪除該社員的 `user:<id>`，請他重新註冊（舊的牌局紀錄仍保留，以名字顯示） |
| 釋出名額 | 同上，刪除不用的 `user:<id>` |
| 卡住的牌桌 | 刪除 `table:<id>`，請大家重新整理 |

## 5. 費用與限制

- Workers 免費方案：每天 10 萬次請求；WebSocket 訊息以 20:1 計算，一個晚上打牌遠低於上限。
- SQLite Durable Object 免費方案：5 GB 儲存；一副牌的紀錄約 3 KB。
- 免費方案每次請求的 CPU 時間有限，因此密碼雜湊使用 50,000 次 PBKDF2（`worker/auth.ts`）。
