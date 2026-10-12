# 點擊排行榜

入口：書庫的「點擊排行榜」或底部「排行」，網址 `/rankings`。

- 周榜、月榜、年榜採最近 7、30、365 個日期（含今日），以 Asia/Taipei 分日。
- 計數事件為讀者成功開啟公開作品頁；不計每章閱讀或閱讀器翻頁。
- 同一瀏覽器裝置、同一作品、同一天最多計一次；管理員操作不計入。
- 只列目前公開、有發布版本、期間內有點擊的作品，最多 50 部。
- 同分按作品名稱及 ID 排序。清除 Cookie 或更換裝置會視為不同訪客。
- 歷史點擊未有紀錄，功能啟用後開始累積。

## 資料庫更新

先啟動本機 OrbStack／Docker，再沿用專案更新命令：

```sh
pnpm db:up
pnpm db:migrate
```

新增 migration：`server/drizzle/0008_work_click_rankings.sql`。

現有 `pnpm maintenance` 的 all 模式會額外清理超過 365 日的點擊紀錄，每次最多 10,000 筆；也可使用 `pnpm maintenance --only=clicks`。

## API

- `GET /api/rankings?period=week|month|year`：取得排行。
- `POST /api/works/:workId/click`：記錄點擊，資料庫唯一鍵保證每日去重。

訪客由 HttpOnly 隨機 Cookie 辨識，資料庫只存作品範圍的雜湊，不存帳戶 ID 或 IP。API 有每來源地址每分鐘 60 次的速率限制；這是一般流量統計，並非抵禦換裝置、清 Cookie 的完整防作弊系統。
