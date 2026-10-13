# 收藏與點擊排行榜

入口：書庫的「排行榜」或底部「排行」，網址 `/rankings`。

- 周榜、月榜、年榜採最近 7、30、365 個日期（含今日），以 Asia/Taipei 分日。
- 收藏榜按期間內加入、目前仍保留的收藏數排序；總榜計所有現存收藏。同一帳戶同一作品計一次，取消收藏後不再計入，重複收藏不會變更加入日期。
- 總榜計所有留存點擊，不限制日期。
- 計數事件為讀者成功開啟公開作品頁；不計每章閱讀或閱讀器翻頁。
- 同一瀏覽器裝置、同一作品、同一天最多計一次；管理員操作不計入。
- 只列目前公開、有發布版本、期間內有收藏或點擊的作品，最多 50 部。
- 可依連載狀態與有效分類篩選，條件保存於網址。
- 同分按作品名稱及 ID 排序。清除 Cookie 或更換裝置會視為不同訪客。
- 歷史點擊未有紀錄，功能啟用後開始累積。

## 資料庫更新

先啟動本機 OrbStack／Docker，再沿用專案更新命令：

```sh
pnpm db:up
pnpm db:migrate
```

新增 migration：`server/drizzle/0008_work_click_rankings.sql`。

點擊紀錄保留供總榜累計，`pnpm maintenance` 不再清除超過一年的點擊；`--only=clicks` 僅提示保留。先前已清除的點擊無法回補。無新增 migration。

## API

- `GET /api/rankings?type=clicks|favorites&period=week|month|year|all`（可另加 `serialStatus=ongoing|completed|paused`、`categoryId=<UUID>`）：取得排行，預設點擊周榜；回傳 `type`、`period`、`days`（總榜為 null），各作品包含 `clicks` 與 `favorites`（非當前類型的數值為 0）。
- `POST /api/works/:workId/click`：記錄點擊，資料庫唯一鍵保證每日去重。

訪客由 HttpOnly 隨機 Cookie 辨識，資料庫只存作品範圍的雜湊，不存帳戶 ID 或 IP。API 有每來源地址每分鐘 60 次的速率限制；這是一般流量統計，並非抵禦換裝置、清 Cookie 的完整防作弊系統。
