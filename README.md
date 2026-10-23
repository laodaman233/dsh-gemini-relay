# gfw-proxy —— Gemini 中转（Render 免费层部署）

单文件 Node 中转，无依赖。两条链路：

- **文本**：转发 Gemini 原生 REST 到 `generativelanguage.googleapis.com`，服务端注入真实 key。
- **画图**：暴露 OpenAI 兼容 `POST /v1/images/generations`（内部走 Antigravity 订阅通道，需自行替换出图 RPC，见 `index.js` 里的 `antigravityGenerateImage`）。

---

## 1. 部署到 Render

1. GitHub 新建一个**私有**仓库，把这三个文件推上去：
   - `index.js`
   - `package.json`
   - `Dockerfile`
2. 打开 <https://dashboard.render.com> → **New → Web Service** → 选这个仓库。
3. 运行时选 **Docker**，实例类型 **Free**，区域 **Singapore**（延迟低）。
4. 在 **Environment** 填下面的环境变量 → 保存（会自动部署）。
5. 部署完拿到地址，形如 `https://你的应用名.onrender.com`。

> Render 免费实例会休眠，闲置后第一次请求要等 40–60 秒才醒，属正常。

---

## 2. 环境变量（Render 后台）

| 变量 | 值 | 说明 |
|---|---|---|
| `TARGET_BASE` | `https://generativelanguage.googleapis.com` | 文本上游 |
| `ALLOW_PATHS` | `/v1beta,/v1` | 只放行这两类路径 |
| `UPSTREAM_KEY` | **你在 AI Studio 申请的 Google API key** | 服务端真 key，只放这里 |
| `PROXY_TOKEN` | `f5eeaf9c65e54761689c296646af7fdaa57563e98f77d1fc` | 文本通行证（已帮你生成） |
| `AG_REFRESH_TOKEN` | 你 `.credentials.yaml` 里 `ANTIGRAVITY_OAUTH_1` 的 `refreshToken` | 订阅刷新令牌 |
| `AG_MODEL` | `gemini-3.1-flash-image` | 出图模型 |
| `AG_TOKEN` | `c2b2522cab1f8b1ffbbfb8fff183f9717242fcc085295846` | 画图通行证（已帮你生成） |
| `AG_CLIENT_ID` | Antigravity 官方客户端 ID（见你文档 4.1 节，不放仓库） | 仅画图线用 |
| `AG_CLIENT_SECRET` | Antigravity 官方客户端密钥（见你文档 4.1 节，不放仓库） | 仅画图线用 |

> ⚠️ `UPSTREAM_KEY` 和 `AG_REFRESH_TOKEN` 是真正的敏感信息，只放 Render 环境变量，别写进代码库。
> ⚠️ `AG_CLIENT_ID` / `AG_CLIENT_SECRET` 是 Antigravity 官方客户端凭据，从你本地文档 4.1 节取，放环境变量，不写进仓库。
> ⚠️ 画图链路（`AG_REFRESH_TOKEN`）目前是**骨架**：`index.js` 里的 `antigravityGenerateImage()` 需要替换成朋友实测过的 `cloudcode-pa.googleapis.com` 出图 RPC。文本链路可直接用。

---

## 3. 验证

```bash
# 健康检查（不带 token）
curl -s https://你的应用名.onrender.com/healthz
# → {"ok":true,"target":"https://generativelanguage.googleapis.com",...}

# 真发一句话（带 token）
curl -s -m 60 "https://你的应用名.onrender.com/v1beta/models/gemini-3.8-flash:generateContent" \
  -H "x-proxy-token: f5eeaf9c65e54761689c296646af7fdaa57563e98f77d1fc" \
  -H "content-type: application/json" \
  -d '{"contents":[{"parts":[{"text":"say OK"}]}]}'
```

返回里有 `"OK"` 即成。
