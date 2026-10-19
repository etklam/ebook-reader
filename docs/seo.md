# 公開網址與可索引性（SEO）

2026-10-16 將 UUID 網址改為帶關鍵字的 slug 網址，並補上每頁 title／description／canonical／Open Graph、`robots.txt` 與動態 `sitemap.xml`。

## 網址規則

```
/works/劍來-a1b2c3d4
/read/劍來-a1b2c3d4/第一章-落雨-7f3e9b21
```

- 格式為 `<slug>-<publicId>`。**slug 只是裝飾**，辨識只靠結尾的 public id；slug 過期（改標題後）仍可開啟，載入後再改寫成目前的正規網址。因此已發布的連結永不失效。
- `publicId` 是資料庫 generated column：`left(replace(id::text,'-',''), 8)`，由該列自己的 uuid 推導（migration `0012_seo_public_ids`）。選 generated 而非由程式指派，是因為新增章節／作品有三條 insert 路徑（匯入 commit、增量 apply、管理後台新增章節）加上所有測試 fixture，任何一條忘記填就會壞；由 DB 推導則連既有資料都自動補齊。
- 作品的 public id 全域唯一；章節的 public id **只在同一作品內唯一**（`chapters_work_public_id_uq`），因為章節網址永遠巢狀在作品之下。所以 `GET /api/reader/chapters/:id` 用 public id 查詢時必須帶 `?work=<ref>`；用 uuid 則不需要。
- **刻意不用章號／`editorial_position`**：中間插章會整段位移（見 `schema.ts` 的 deferrable unique constraint），那會讓插入點之後每一條已發布的章節網址靜默指向別章。
- 舊的 uuid 網址（`/works/<uuid>`、`/read/<uuid>/<uuid>`）仍然可解析，載入後改寫為正規網址。書籤深連結 `#p=<段落>&rev=<修訂>` 不受影響。
- 繁體中文直接進網址（UTF-8 percent-encoding）。不轉拼音：拼音需要額外依賴、同音字會模糊書名，而讀者搜尋的就是書名本身。slug 上限 40 字，超過在分隔符處截斷。

規則實作在 `server/src/lib/slug.ts` 與 `apps/web/src/lib/slug.ts`——**兩份刻意重複**（兩個 package 沒有共用套件），由 `server/src/lib/slug.test.ts` 的 drift guard 逐字比對共用區塊：若兩邊分歧，sitemap 公告的網址會和前端立刻改寫成的網址不同，等於同一頁有兩個網址，正是 canonical 要避免的事。

## 每頁 head

`apps/web/src/lib/head.ts` 依路由改寫 `<title>`、`description`、`<link rel="canonical">`、Open Graph。在此之前每個路由都共用 `index.html` 的 `<title>書庫`，任何一本小說的搜尋結果標題都是「書庫」。

- 作品頁：`<書名> - <作者> · 書庫`，description 取簡介。
- 章節頁：`<章標籤> <章名> - <書名> · 書庫`，description 取正文開頭兩段。
- `/login`、`/register`、`/me/*`、`/admin`：`noindex, follow`（私人或個人化頁面）。
- `draft` 與 `unlisted` 作品：`noindex`。`unlisted` 的定義是「知道網址就能讀，但永不列出」，進索引就違反這個承諾。

## robots.txt 與 sitemap

`server/src/routes/sitemap.ts`，掛在站台根目錄（不在 `/api/` 之下），由 nginx 轉發對應路徑（`ops/nginx/ebook.conf`）。

- 放在 API 而非靜態 bundle：網址集合就是書庫本身，每次發布都會變；build 時產生的檔案在管理員發布下一章的瞬間就過期了。
- `/sitemap.xml` 是 sitemap index → `/sitemap-pages.xml`、`/sitemap-works-<n>.xml`、`/sitemap-chapters-<n>.xml`，每頁 10,000 筆（協議上限 50,000／50 MB；CJK percent-encode 後約 9 bytes 一字，取較低上限同時守住位元組上限）。
- **只收 `public` 作品**，章節網址取自 `release_items`（公眾實際讀到的快照），不是 `app.chapters`——後者會公告尚未發布的編輯 head。
- 這裡用 offset 分頁是刻意的：書庫列表禁止 offset（CAT-03，發布會位移讀者的視窗而漏書），但爬蟲是整份重抓，跨頁位移的那一列下次爬就會看到。
- `SITE_ORIGIN` 提供 sitemap 需要的絕對網址；未設時改用請求自身的 Host（dev 方便，正式站應設定，否則偽造的 Host 會被寫進 sitemap）。

## 已知限制（尚未處理）

1. **沒有 server-side rendering。** head 是載入後由 JS 寫入：Googlebot 會執行 JS 所以看得到，**Baidu 與多數社群卡片抓取器看不到**，它們只拿到 `index.html` 的靜態 title。若要 Baidu 流量，需要 SSR 或 prerender，這是另一件工作。
2. **站內連結幾乎都是 `<button>` 而非 `<a href>`。** 書庫卡片、章節列表、目錄、排行榜、相似作品都用 JS 導航，爬蟲無法跟隨，因此目前的站內連結圖對搜尋引擎等於不存在。sitemap 能補上「發現」這一半，但傳不了連結權重。把這些主要連結面改成真正的 `<a>`（保留 onClick 做 SPA 導航）是最有價值的下一步。
3. 會員頁的 DTO（書庫、書籤、閱讀統計）尚未帶 `publicId`，所以那裡的連結仍是 uuid 形式，進入頁面後才改寫為正規網址。這些頁面本身是 `noindex`，只影響站內觀感。
4. 沒有結構化資料（`Book`／`Chapter` 的 JSON-LD）、沒有 `og:image`。
