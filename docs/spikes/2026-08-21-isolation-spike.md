# Isolation / Sandbox Spike（§39.2 三項 Implementation Blocker）

日期：2026-08-21
環境：Linux 6.8、codex-cli 0.148.0、node v24.19.0、bwrap（`/usr/bin/bwrap`）

設計文件 §39.2 要求「以實際 probe 結果決定 Codex Driver 與 Verification Runner 的實作，
不可只依賴文件假設」。以下是實測結果與據此定案的設定。

## 1. Codex sandbox / network 行為

`codex sandbox` 子命令在本版本無法使用（vendored bwrap 找不到 `codex-linux-sandbox` helper），
因此改以實際會用到的 `codex exec` 路徑 probe。方法：以 `--output-schema` 要求 agent 回報
五個 shell 動作的結果。

### 1.1 未加隔離設定（僅 `-s workspace-write`）

| 探測 | 結果 |
|---|---|
| workspace 內寫檔 | 允許 |
| workspace 外寫檔（`/home/hom/code/harness/.spike/`） | **DENIED**（read-only file system） |
| `curl https://example.com` | **200 — 網路沒有被擋** |
| `printenv HOME` | `/home/hom` — 操作者 HOME |
| `ls -a $HOME` | **看得到 `.ssh`、`.secrets`、`.codex`、`.claude`…** |

結論：`-s workspace-write` 只提供檔案系統邊界。**network 與 HOME 必須另外處理**，
否則 §39.2 的 blocker 2 為真實可利用的洩漏。

### 1.2 加上隔離設定後（定案設定）

- 專用 `CODEX_HOME`，其中 `config.toml`：
  - `[sandbox_workspace_write] network_access = false`
  - `exclude_tmpdir_env_var = true`、`exclude_slash_tmp = true`
  - `[shell_environment_policy] inherit = "core"`
- 以 `env -i` 傳入最小環境，`HOME` 指向專用 agent home。

| 探測 | 結果 |
|---|---|
| workspace 內寫檔 | 允許 |
| workspace 外寫檔 | DENIED |
| `curl` | **DENIED**（`Could not resolve host`） |
| `printenv HOME` | 專用 agent home |
| `ls -a $HOME` | 只有 `.`、`..` |

`-s read-only` 另行 probe：workspace 內寫檔 → **DENIED**。

### 1.3 已知限制

- `CODEX_HOME` **不能放在 `/tmp`**：codex 拒絕在暫存目錄建立 helper binaries
  （`Refusing to create helper binaries under temporary dir`）。因此 state dir 預設為
  `~/.local/share/agent-work-harness`。
- codex 需要自己的 `auth.json`，該檔位於專用 `CODEX_HOME` 內，agent 仍可讀取（見 DECISIONS D-08）。

## 2. Verification execution isolation（§20.3）

Verification 會執行 repository 內的程式碼（`npm test` 等），必須與 agent 同等隔離。

第一版嘗試 `bwrap --unshare-all --ro-bind / /`：

```
secrets: export OPENAI_KEY=sk-proj-…     ← 洩漏
```

`--ro-bind / /` 會把操作者 HOME 一併帶進沙箱。**定案改為白名單 bind + `--tmpfs /home`**：

```
bwrap --unshare-all --die-with-parent --new-session \
  --ro-bind /usr /usr --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin \
  --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 --ro-bind /etc /etc \
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run --tmpfs /home \
  --ro-bind-try <toolchain> <toolchain> \
  --bind <verification-home> <verification-home> \
  --bind <workspace> <workspace> \
  --setenv HOME <verification-home> --chdir <workspace> -- <argv>
```

| 探測 | 結果 |
|---|---|
| `cat /home/hom/.secrets` | No such file |
| `ls /home/hom/.ssh` | No such file |
| `ls -a $HOME` | 只有 `.`、`..` |
| workspace 寫入 | OK（測試需要） |
| `node -v` | v24.19.0（toolchain ro-bind 有效） |
| `curl` | DENIED |

`harness doctor` 會重跑這組 probe，任何洩漏跡象（`sk-`、private key、HTTP 狀態碼）
都會讓它以 exit code 4 失敗。

## 3. Codex CLI 介面（Driver 定案）

```
codex exec -s <read-only|workspace-write> -C <workspace> \
  --skip-git-repo-check --ephemeral --ignore-rules \
  -c project_doc_max_bytes=0 \
  --output-schema <schema.json> -o <last-message.json> --color never
```

- prompt 由 **stdin** 傳入（位置參數會被當成字面 prompt 文字）。
- `--output-schema` 讓模型的最後訊息被強制為 RuntimeResult v1 形狀。
  注意：OpenAI structured outputs 要求 `required` 涵蓋所有 properties，
  optional 欄位必須寫成 nullable（`type: ["array", "null"]`），否則整個 request 會 400。
- `--ignore-rules` 阻止 repository 的 `.rules` execpolicy 影響 authority。
- `project_doc_max_bytes=0` 阻止 repository `AGENTS.md` 被當成 instruction（§30.1）。
