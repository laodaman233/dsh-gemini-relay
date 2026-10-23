'use strict'

// gfw-proxy —— 单文件 Node 中转，无第三方依赖（只用内置 http/https/url）。
// 两条链路：
//   线 A（文本）：把 DSH 的 Gemini 原生 REST 请求转发到 generativelanguage.googleapis.com，
//               服务端注入真实 Google key，客户端只持有通行证 PROXY_TOKEN。
//   线 C（画图）：暴露 OpenAI 兼容的 POST /v1/images/generations，内部用 Antigravity
//               OAuth 刷新令牌换取 access_token 后调用 Google 订阅通道出图。

const http = require('http')
const https = require('https')
const { URL } = require('url')

// ---------------------------------------------------------------- config ----
const PORT = Number(process.env.PORT || 3000)
const TARGET_BASE = (process.env.TARGET_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
const ALLOW_PATHS = (process.env.ALLOW_PATHS || '/v1beta,/v1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || ''
const PROXY_TOKEN = process.env.PROXY_TOKEN || ''

const AG_REFRESH_TOKEN = process.env.AG_REFRESH_TOKEN || ''
const AG_MODEL = process.env.AG_MODEL || 'gemini-3.1-flash-image'
const AG_TOKEN = process.env.AG_TOKEN || ''
const AG_CLIENT_ID = process.env.AG_CLIENT_ID || ''
const AG_CLIENT_SECRET = process.env.AG_CLIENT_SECRET || ''
const AG_TARGET = (process.env.AG_TARGET || 'https://cloudcode-pa.googleapis.com').replace(/\/+$/, '')

// ---------------------------------------------------------------- helpers ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 32 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// 客户端通行证可能来自多个头或查询参数（兼容 Gemini 原生的 x-goog-api-key、
// OpenAI 的 Authorization Bearer，以及本中转约定的 x-proxy-token）。
function extractClientToken(req, url) {
  const h = (name) => req.headers[name]
  if (h('x-proxy-token')) return h('x-proxy-token')
  if (h('x-goog-api-key')) return h('x-goog-api-key')
  const auth = h('authorization') || ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  if (url.searchParams.get('key')) return url.searchParams.get('key')
  return ''
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

// 单次请求（http/https 自适应，可带 body），返回 { status, headers, stream }。
function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'http:' ? http : https
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers,
    }
    const req = mod.request(opts, (res) => {
      resolve({ status: res.statusCode || 0, headers: res.headers, stream: res })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ------------------------------------------------- 线 A：文本转发 ----------
async function handleTextForward(req, res, url) {
  const pathname = url.pathname

  const allowed = ALLOW_PATHS.some((p) => pathname === p || pathname.startsWith(p.replace(/\/$/, '') + '/'))
  if (!allowed) {
    return sendJson(res, 403, { error: 'path not allowed', path: pathname })
  }

  if (PROXY_TOKEN && extractClientToken(req, url) !== PROXY_TOKEN) {
    return sendJson(res, 401, { error: 'invalid proxy token' })
  }
  if (!UPSTREAM_KEY) {
    return sendJson(res, 500, { error: 'server missing UPSTREAM_KEY' })
  }

  // 转发目标：去掉客户端可能带的 ?key=，其余 query 原样保留。
  url.searchParams.delete('key')
  const upstream = TARGET_BASE + pathname + url.search

  const fwdHeaders = {}
  for (const k of Object.keys(req.headers)) {
    const lk = k.toLowerCase()
    if (['host', 'authorization', 'x-goog-api-key', 'x-proxy-token', 'content-length', 'connection'].includes(lk)) continue
    fwdHeaders[k] = req.headers[k]
  }
  fwdHeaders['x-goog-api-key'] = UPSTREAM_KEY

  const body = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' ? await readBody(req) : null

  try {
    const up = await request(upstream, { method: req.method, headers: fwdHeaders, body })
    res.writeHead(up.status, { ...up.headers, 'access-control-allow-origin': '*' })
    up.stream.pipe(res)
    up.stream.on('error', () => res.destroy())
  } catch (err) {
    sendJson(res, 502, { error: 'upstream error', detail: String(err.message || err) })
  }
}

// ------------------------------------------------- 线 C：画图 --------------
let cachedAccessToken = null
let cachedExpiry = 0

async function antigravityAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiry - 60 * 1000) return cachedAccessToken
  if (!AG_REFRESH_TOKEN) throw new Error('server missing AG_REFRESH_TOKEN')

  const body = new URLSearchParams({
    client_id: AG_CLIENT_ID,
    client_secret: AG_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: AG_REFRESH_TOKEN,
  }).toString()

  const up = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
    body,
  })
  const data = await new Promise((resolve, reject) => {
    const chunks = []
    up.stream.on('data', (c) => chunks.push(c))
    up.stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    up.stream.on('error', reject)
  })

  let parsed
  try {
    parsed = JSON.parse(data)
  } catch {
    throw new Error('oauth token response not JSON: ' + data.slice(0, 200))
  }
  if (!parsed.access_token) throw new Error('oauth token missing access_token: ' + data.slice(0, 200))

  cachedAccessToken = parsed.access_token
  cachedExpiry = Date.now() + (Number(parsed.expires_in) || 3600) * 1000
  return cachedAccessToken
}

// OpenAI 兼容响应体：{ data: [{ url }] } 或 { data: [{ b64_json }] }。
// 具体 Antigravity 出图 RPC 的路径 / 请求体 / 响应体，随 Google 客户端协议而定；
// 下方实现为「可替换的骨架」，拿到朋友实测过的那份 gfw-proxy 后可直接替换此函数体。
async function antigravityGenerateImage(accessToken, prompt, model) {
  // TODO(替换点)：这里替换成朋友实测过的 cloudcode-pa.googleapis.com 出图调用。
  // 返回 Promise<string>，值为图片 URL 或 base64。
  //
  // 示例（需按实测协议调整）：
  //   const up = await request(AG_TARGET + '/v1/internal/generateImage', {
  //     method: 'POST',
  //     headers: { 'authorization': 'Bearer ' + accessToken, 'content-type': 'application/json' },
  //     body: JSON.stringify({ model, prompt }),
  //   })
  //   ... 解析响应，取图片 URL / base64 ...
  throw new Error('antigravityGenerateImage 尚未接入：请替换成朋友实测过的出图 RPC')
}

async function handleImageGenerations(req, res, url) {
  if (PROXY_TOKEN && extractClientToken(req, url) !== AG_TOKEN && extractClientToken(req, url) !== PROXY_TOKEN) {
    return sendJson(res, 401, { error: 'invalid token' })
  }

  let payload
  try {
    payload = JSON.parse((await readBody(req)).toString('utf8') || '{}')
  } catch {
    return sendJson(res, 400, { error: 'invalid json body' })
  }

  const prompt = payload.prompt
  const model = payload.model || AG_MODEL
  if (!prompt) return sendJson(res, 400, { error: 'prompt required' })
  const n = Math.min(Math.max(Number(payload.n) || 1, 1), 4)

  try {
    const accessToken = await antigravityAccessToken()
    const results = []
    for (let i = 0; i < n; i++) {
      const img = await antigravityGenerateImage(accessToken, prompt, model)
      results.push(img.startsWith('data:') || /^[A-Za-z0-9+/=]+$/.test(img) ? { b64_json: img } : { url: img })
    }
    sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: results })
  } catch (err) {
    sendJson(res, 502, { error: 'image generation failed', detail: String(err.message || err) })
  }
}

// ---------------------------------------------------------------- server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      target: TARGET_BASE,
      allowPaths: ALLOW_PATHS,
      hasUpstreamKey: Boolean(UPSTREAM_KEY),
      hasImageRefreshToken: Boolean(AG_REFRESH_TOKEN),
    })
  }

  if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
    return handleImageGenerations(req, res, url)
  }

  return handleTextForward(req, res, url)
})

server.listen(PORT, () => {
  console.log(`gfw-proxy listening on :${PORT}`)
  console.log(`  text  -> ${TARGET_BASE}`)
  console.log(`  image -> ${AG_TARGET} (AG_MODEL=${AG_MODEL}, refresh_token=${AG_REFRESH_TOKEN ? 'set' : 'MISSING'})`)
})
