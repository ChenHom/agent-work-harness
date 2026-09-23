# 校準標註集人工審閱表設計

日期：2026-09-23

狀態：**使用者已確認。**

## 目的

讓實際人類審閱 `test/fixtures/evaluation/labels.jsonl` 的 12 筆標註，而不是由模型把既有
`fixture-author` 內容自行提升為 `human-review`。審閱結果必須可逐筆追蹤，且未明確核准的 case
維持原 provenance。

## 產出

建立 `docs/calibration-review-2026-09-23.1.md`，依原始 JSONL 順序列出全部 12 筆 case。人類閱讀的
敘述一律使用正體中文，case ID、程式碼、檔名、指令及 schema 值保留原文。每筆包含：

- `caseId` 與 task type。
- criterion 的正體中文忠實翻譯。
- artifact text 的正體中文忠實翻譯。
- 現有 proposed verdict（`pass` 或 `fail`）與 rationale 的正體中文呈現。
- 尚未填入的 human decision 欄位。

審閱表只投影原始 fixture，不修改 JSONL 內的 criterion、artifact、verdict 或 rationale，也不把文件
本身當成完成審閱的 authority。驗證以 case ID、順序、數量及判定值核對結構；翻譯內容另做逐筆校對。

## 使用方式

使用者透過對話回覆「12 筆全部核准」，或列出例外，例如 `code-03 改為 pass` 並提供理由。
不要求使用者直接編輯 JSONL。若回覆有歧義，相關 case 保持未核准。無法判定時必須明確標記
「無法確認」並附原因，不能留白，也不能把 `expected` 改為 schema 不接受的空值或 `unknown`。

收到明確決定後，另一次變更才會：

1. 將獲核准 case 的 expected／rationale 套用人工決定。
2. 把 provenance 改為 `human-review`，以 `author: "workspace-owner"` 記錄本次使用者審閱，並填入審閱日期。
3. 執行 calibration 定點測試與完整 `npm run check`。
4. 更新 follow-up plan 與 acceptance evidence，並獨立提交。

## 安全與驗證

- 模型產生審閱表不等於人工核准；authority 只來自使用者後續明確回覆。
- 12 筆必須與 JSONL case ID 一一對應，不能遺漏、重複或新增。
- 建表後以 script／測試核對 case ID、proposed verdict 與原始 fixture 完全一致。
- Markdown 相對連結與 `git diff --check` 必須通過。

## 非目標

- 不接入真實 provider。
- 不調整 evaluator 或完成判定規則。
- 不把異地備份納入本次人工標註審閱。
