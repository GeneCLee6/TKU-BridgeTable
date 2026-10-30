# 安全：標頭、session 與安全審查

> `e11-t23`（CSP 與安全標頭、session 列表與「登出其他裝置」）、`e11-t24`（對照 OWASP ASVS Level 1 的安全審查）。2026-10-30 第一次審查。
> 改了驗證、session、可見性、上傳或標頭，回來對照這份文件，並更新 §3 的狀態。

## 1. 範圍與做法

- **範圍**：這個 Worker（`worker/`）、它的 Durable Object（`Club`、`TableObject`、`EventObject`）、牌桌的前端（`src/`），以及淡江橋館經 Vercel 轉發來呼叫的 `/api/book/*`。不含 Cloudflare 本身與淡江橋館的前端（那邊另做）。
- **標準**：[OWASP ASVS 4.0.3](https://github.com/OWASP/ASVS/tree/v4.0.3) Level 1。逐章讀程式碼與測試對照，不做滲透測試。
- **結果分三種**：✅ 已符合（附在哪裡）、🔧 這個 PR 修好、📋 待辦（§4 每項一個 task）。

## 2. 安全標頭與 CSP（`e11-t23`）

兩個地方送標頭，內容都定義在 `worker/security-headers.ts`：

| 回應 | 從哪裡送 | 標頭 |
| --- | --- | --- |
| 網頁與它的檔案（`index.html`、`/assets/*`、圖示） | 靜態資產不經過 Worker，由 `public/_headers` 給（`headersFile()` 產生，`tests/worker/account-security.test.ts` 檢查兩邊一致） | `PAGE_HEADERS`：CSP、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、HSTS 兩年、`Cross-Origin-Opener-Policy: same-origin`、`Permissions-Policy`（關掉相機、麥克風、定位、付款、USB） |
| `/api/*`、`/ws` | `worker/index.ts` 的 `withSecurityHeaders` | `API_HEADERS`：`default-src 'none'; frame-ancestors 'none'; sandbox`、`X-Frame-Options: DENY`、nosniff、Referrer-Policy、HSTS。回應自己設的不覆蓋；WebSocket 升級（101）不動 |
| `/api/files/*`（簽名網址的圖片與電子書 PDF） | 同上 | 只有 nosniff、Referrer-Policy、HSTS：淡江橋館的 PDF 閱讀器可能把它放進自己的框架 |

**網頁的 CSP**（`PAGE_CSP`）只允許這個網站用到的東西：

| 指令 | 值 | 為什麼 |
| --- | --- | --- |
| `default-src` | `'self'` | 其他沒列的都只能來自本站 |
| `script-src` | `'self' 'wasm-unsafe-eval'` | Vite 產物都是外部檔案（`index.html` 沒有行內 script）；DDS（`bridge-dds`）在 Web Worker 裡用 `WebAssembly.instantiate` 編譯內嵌的 WASM，需要 `'wasm-unsafe-eval'`（不是 `'unsafe-eval'`） |
| `style-src` | `'self' 'unsafe-inline'` | styled-components 插 `<style>`、React 的 `style` 屬性；只開給樣式，script 沒有 `'unsafe-inline'` |
| `img-src` | `'self' data: blob:` | 頭像與圖片都是本站的 `/api/avatar/`、`/api/files/`；裁切頭像、分享卡用 `blob:` |
| `font-src` | `'self' data:` | Noto Sans TC 隨網站打包；小檔可能被 Vite 內嵌成 `data:` |
| `connect-src` | `'self'` | API 與 WebSocket 都在本站（CSP Level 3 的 `'self'` 也涵蓋同主機的 `wss:`）；淡江橋館走它自己的網域（Vercel 轉發），不需要放行 |
| `worker-src` | `'self' blob:` | DDS 的 Web Worker、Service Worker（`sw.js`） |
| `object-src`／`base-uri`／`form-action`／`frame-ancestors` | `'none'`／`'self'`／`'self'`／`'none'` | 不能嵌入別的網站、不能被別的網站框住 |

**開發模式不受影響**：`@cloudflare/vite-plugin` 在 `npm run dev` 只有開實驗選項才套用 `_headers`，所以 Vite 的行內 HMR script 照常；`npm run build` 後 `dist/client/_headers` 才生效（`vite preview`、預覽站、正式站）。

**檢查方式**：PR 預覽站或正式站

```bash
curl -sI https://<網站>/ | grep -iE 'content-security|x-frame|strict-transport|referrer|permissions'
curl -sI https://<網站>/api/health | grep -iE 'content-security|x-frame|nosniff'
```

再用瀏覽器開大廳、開一桌打幾張牌、開紀錄頁的雙明手分析（DDS）、上傳頭像、下載我的資料，開發者工具的 Console 不應有 `Content Security Policy` 的錯誤。新加外部資源（字型 CDN、分析工具）時要先改 `PAGE_CSP` 並重新產生 `public/_headers`：

```bash
npx tsx -e "import {headersFile} from './worker/security-headers.ts'; process.stdout.write(headersFile())" > public/_headers
```

## 3. ASVS Level 1 對照

### V2 驗證

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 2.1.1 密碼至少 12 字 | 📋 | 目前 `LIMITS.passwordMin` 6。改成 12 會讓社員改密碼時被擋，要社長決定（§4 `e11-t29`） |
| 2.1.2 允許至少 64 字、最多 128 字 | 🔧 | 新增 `LIMITS.passwordMax` 128（`longPassword`），之前沒有上限 |
| 2.1.7 檢查外洩密碼 | 📋 | 沒有檢查（`e11-t29`） |
| 2.2.1 防暴力猜測 | ✅ | `worker/rate-limit.ts`：同一來源＋帳號 15 分鐘 5 次、同一來源 20 次（`tooManyLogins`） |
| 2.4.1 密碼雜湊 | ⚠️📋 | PBKDF2-SHA-256 加鹽、50,000 次（`worker/auth.ts`），格式可升級。OWASP 現在建議 600,000 次；受免費方案 CPU 限制，要量測（`e11-t30`） |
| 2.5.x 忘記密碼 | ⚠️📋 | 知道社團邀請碼就能重設任何**一般社員**的密碼（管理員不行，重設後全部登出、管理頁看得到）。邀請碼是全社共用的，等於社員可以接管彼此的帳號。H5 的 Email 綁定與重設（`e1-t29`）完成後改成只能用 Email |
| 2.7／2.8 多因素 | 📋 | 沒有。ASVS L1 對管理介面要求多因素（4.3.1），排在 H5 之後（`e11-t31`） |

### V3 Session

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 3.2.1／3.2.2 登入後換新 token、128 bit 以上隨機 | ✅ | 每次登入新的 256 bit token（`randomId(32)`，`crypto.getRandomValues`） |
| 3.3.1 登出讓 session 失效 | ✅ | `POST /api/logout` 刪掉 `session:<token>` 並清 cookie |
| 3.3.3 改密碼後可以登出其他 session | 🔧 | 新的「登入中的裝置」卡（`GET /api/account/sessions`、`DELETE /api/account/sessions/:id`、`POST /api/account/sessions/others`）；改密碼時也自動登出其他裝置（之前不會） |
| 3.4.1～3.4.3 cookie 屬性 | ✅ | `tbt_session`、`tbt_pass` 都是 HttpOnly、SameSite=Lax、Path=/，HTTPS 時加 Secure |
| 3.4.4 `__Host-` 前綴 | 📋 | 沒用；改名會讓全部人重新登入，與 `e11-t28` 一起做 |
| 3.7.1 重要操作再驗證 | ✅ | 改密碼要目前的密碼；刪除帳號要密碼＋確認 |
| 邊緣通行證的撤銷窗口 | 📋 | 登出其他裝置或改密碼後，對方手上的 `tbt_pass` 最多再有效 10 分鐘（只能讀紀錄列表、連自己所在那一桌，ARCHITECTURE.md §5.12）。要讓通行證帶 session 的雜湊、撤銷時通知那一桌（`e11-t28`） |

### V4 存取控制

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 4.1.1～4.1.3 伺服器端檢查、最小權限 | ✅ | 規則與權限只在 `ClubService`／`worker/roles.ts`；前端只看 `legalCalls`／`legalCards`；管理路由 `adminRouteNeed` |
| 4.2.1 不能用 id 讀別人的東西 | ✅ | 可見性集中在 `worker/views.ts`，`tests/worker/visibility/` 回歸測試；session 列表與登出只看自己的（`endSession` 對別人的 id 一律 404） |
| 4.3.1 管理介面多因素 | 📋 | 見 2.7（`e11-t31`） |

### V5 輸入驗證與輸出編碼

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 5.1.x 輸入驗證 | ✅ | WebSocket：`shared/message-guard.ts`（型別、8 KB 上限）；HTTP：各 `parse*`（個人檔案、練習設定、牌桌設定…）、未知欄位擋掉 |
| 5.1.4 本文大小 | ⚠️📋 | `BODY_MAX_BYTES`（2 MB）只看 `Content-Length`；沒有長度的串流本文會被整個讀進來（Cloudflare 上限 100 MB）。改成邊讀邊算（`e11-t32`） |
| 5.3.x 輸出編碼、XSS | ✅ | React 自動跳脫；全站沒有 `dangerouslySetInnerHTML`；新的 CSP 再擋一層 |
| 5.5.x 反序列化 | ✅ | 只有 `JSON.parse`，結果再經型別守衛 |

### V7 錯誤與日誌

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 7.1.1 不記密碼與 token | ✅ | `worker/log.ts` 的結構化日誌只有事件、路徑（不含查詢字串）、狀態與代碼；刪帳號只記 `accountDeleted`，不記是誰 |
| 7.4.1 錯誤不洩漏內部資訊 | ✅ | 未預期的錯誤一律回 `serverError`，細節只進日誌 |

### V8 資料保護

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 8.2.1 敏感回應不快取 | ✅ | API 的 JSON 一律 `Cache-Control: no-store` |
| 8.3.1 敏感資料不放網址 | ✅ | session 在 cookie；上傳憑證與簽名網址是一次性、有期限 |
| 8.3.2 使用者可以匯出、刪除自己的資料 | 🔧 | `e11-t27`：`GET /api/account/export`、`POST /api/account/delete`（§5） |

### V9 傳輸

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 9.1.1 全站 TLS | ✅ | Cloudflare 只走 HTTPS；🔧 加上 HSTS |

### V10 惡意程式碼／V14 設定

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 10.3.2 第三方資源 | ✅ | 沒有 CDN、沒有分析或廣告程式；字型隨網站打包 |
| 14.2.1 相依套件 | ✅ | 2026-10-30 `npm audit --omit=dev`：0 個漏洞 |
| 14.4.x 安全標頭 | 🔧 | §2 |
| 14.5.3 CORS | ✅ | 只有不靠 cookie 的路由開 `Access-Control-Allow-Origin: *`：簽名上傳、AI 匯入（帶一次性憑證）、簽名的檔案網址；其餘 API 沒有 CORS，淡江橋館經 Vercel 同網域轉發 |
| 祕密 | ✅ | `INVITE_CODE`、`ANTHROPIC_API_KEY`、`EDGE_AUTH_SECRET` 等都是 `wrangler secret`，staging 與預覽站各自一套（DEPLOY.md） |

### V12 檔案／V13 API

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| 12.1.1 上傳大小 | ✅ | 頭像 64 KB、圖片 2 MB、縮圖 256 KB、電子書 50 MB，超過 413 |
| 12.2.1 檔案型別 | ✅ | 看檔頭的 magic bytes，不信 `Content-Type`；Worker 不解碼圖片 |
| 13.2.3 CSRF | ✅ | cookie 是 SameSite=Lax，跨站的 POST／PUT／DELETE 不帶 cookie；`workers.dev` 在 Public Suffix List 上，別人的 `*.workers.dev` 不算同站 |
| 跨站 WebSocket（CSWSH） | 🔧 | `/ws` 與 `/ws/table/*` 的 `Origin` 必須是本站（`worker/routing.ts`），別的網站的頁面開不了；沒有 `Origin` 的非瀏覽器用戶端（負載測試）照舊 |
| 速率限制 | ✅ | 每個連線的動作、聊天、錯誤回報、使用統計各有 token bucket（`worker/rate-limit.ts`） |

## 4. 待辦清單

每項都在 `docs/PRD/e11-platform-ops-scale.md` 開了 task：

| Task | 內容 | 風險 | 需要決定 |
| --- | --- | --- | --- |
| `e11-t28` | 邊緣通行證帶 session 的雜湊；登出、登出其他裝置、改密碼、刪帳號時讓通行證與那一桌的連線立刻失效；順便把 cookie 改成 `__Host-` 前綴 | 中 | — |
| `e11-t29` | 密碼政策：最短長度（ASVS 要 12）與常見／外洩密碼檢查 | 中 | 社長：最短幾個字、要不要擋常見密碼 |
| `e11-t30` | 提高 PBKDF2 次數或換演算法，登入時把舊雜湊升級 | 低 | 量測免費方案 CPU 後決定 |
| `e11-t31` | 管理員的多因素驗證（TOTP） | 中 | 排在 H5（Email）之後 |
| `e11-t32` | HTTP 本文邊讀邊算大小，不靠 `Content-Length` | 低 | — |
| （H5 `e1-t29`） | 忘記密碼改用 Email，不再用全社共用的邀請碼 | **高** | 已排在 H5 |

## 5. 個人資料：匯出與刪除（`e11-t27`）

- **匯出**：「我的帳號」→「下載我的資料」，`GET /api/account/export` 回一個 JSON 檔（`format: 'tku-bridge-table-account'`、`version`）：帳號與設定（不含密碼雜湊）、登入中的裝置、好友與封鎖、通知、私訊、練習設定、收藏與筆記、打過的每副牌的摘要（完整紀錄在 `/history/<id>`）。不含別人的 session 或任何 token。
- **刪除**：「我的帳號」→「刪除帳號」，要密碼與確認；`POST /api/account/delete` 走與管理員刪帳號相同的 `removeMember`：帳號、頭像、session、好友與封鎖、通知、私訊、收藏、練習設定、閱讀與學習進度立即刪除，所有連線關閉。社團唯一的管理員不能刪（`lastAdminLeaving`）。
- **保留的**：打過的牌局紀錄是同桌其他人的紀錄，保留帳號名稱；論壇與淡江橋館的文章與留言保留（隱私權政策請社員先自己刪）；備份裡的帳號在 30 天內隨備份到期消失。
- **政策頁**：`/privacy`、`/terms`（不用登入，`src/pages/LegalPage.tsx`，文字在 `strings.ts` 的 `legal`，六種語言）。登入頁與「我的帳號」底下有連結；註冊時寫「註冊即表示同意」。內容改了要改 `LEGAL_UPDATED`。
