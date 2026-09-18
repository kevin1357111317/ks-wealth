## 變更摘要

<!-- 用 1–3 點說明這個 PR 改了什麼。 -->

## Version impact

**Version impact:** <!-- 必填：none / patch / minor / major -->

**判級理由：**
<!-- 依 VERSIONING.md 說明為什麼是這個等級。不要只寫「改很小」或「改很多」。 -->

### 相容性檢查

- [ ] 我已檢查舊資料是否能繼續正確使用。
- [ ] 我已檢查既有 client／操作流程是否仍相容。
- [ ] 我已檢查核心財務／健康計算與欄位語意是否改變。
- [ ] 若有 breaking change，已選 `major` 並說明 migration／不相容點。
- [ ] 若只是純 docs / test / CI / repo tooling 且不改正式產品，已選 `none`。

> 判級順序：breaking change → **major**；向後相容新功能 → **minor**；向後相容 bug fix → **patch**；無產品行為變更 → **none**。同一 PR 取最高等級。

## 出貨檢查

- [ ] 已閱讀最新 `AGENTS.md`、相關 `README.md` 與 `VERSIONING.md`。
- [ ] 已跑 `node --test --test-concurrency=1 tests/*.test.mjs`，或在下方說明無法執行的原因。
- [ ] 若 Version impact 不是 `none`，已同步 `app-version.js`、`VERSIONING.md` 與 `index.html` 三處正式版號。
- [ ] 若動到前端 runtime，已更新必要的 `?v=` cache-bust。
- [ ] 若動到 `supabase/functions/`，合併後已部署對應 Edge Function（Vercel 不含它），並比對線上原始碼、確認畫面數字已更新 —— 不只看 App 版號。
- [ ] 若動到金額／計算邏輯，已重新核對原始資料且確認 regression test 能抓到錯誤。

## 驗證結果

<!-- 測試結果、手動驗證路徑、已知限制。 -->
