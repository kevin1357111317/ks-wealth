# KS財富管理 V2p0

私人家庭財務 PWA。前端部署於 Vercel，正式資料儲存在 Supabase。

## 安全架構
- 每位家庭成員使用自己的 Supabase Auth 帳號。
- 兩人加入同一 household 後共享財務資料。
- 資產、負債、現金流與歷史資料不存放於 GitHub / 前端原始碼。
- 前端只有 Supabase publishable key；真正資料存取由 JWT + Row Level Security 控制。
- 未登入者無權讀取財務資料。

## 檔案
- index.html：App shell / metadata
- style.css：手機優先 UI
- app.js：Auth、家庭加入、財務 CRUD、Realtime、現金流與趨勢

## 部署
Vercel static deployment。將三個檔案放在 repository 根目錄即可。

GitHub `main` 已連接 Vercel Production，自此 push 到 `main` 會觸發自動部署。
