# LLM Office Gateway

多供应商 LLM 网关，让 Claude Office 插件（Excel/Word/PowerPoint/Outlook）接入多种大语言模型供应商，包括 DeepSeek、Moonshot、OpenAI 兼容接口等。

## 工作原理

```
┌─────────────────┐     Anthropic API 格式      ┌──────────────────┐
│  Claude Office   │ ──── POST /v1/messages ────→│                  │
│  插件 (Excel/    │                              │  本地网关         │
│   Word/PPT/      │ ←──── SSE 流式响应 ────────│  (gateway.py)    │
│   Outlook)       │                              │                  │
└─────────────────┘                              └───────┬──────────┘
                                                          │
                          ┌───────────────────────────────┼──────────────┐
                          │ 自动路由 + 格式转换 + 故障转移              │
                          │                               │              │
                    ┌─────┴──────┐             ┌──────────┴──────────┐  │
                    │ DeepSeek   │             │ Moonshot / OpenAI   │  │
                    │ (Anthropic │             │ (Chat Completions)  │  │
                    │  API)      │             │ 格式自动转换)        │  │
                    └────────────┘             └─────────────────────┘  │
                          │                               │              │
                    ┌─────┴──────┐             ┌──────────┴──────────┐  │
                    │ 备用供应商  │             │ 更多供应商...        │  │
                    └────────────┘             └─────────────────────┘  │
                          └─────────────────────────────────────────────┘
```

网关始终以 **Anthropic Messages API 格式** 与客户端通信，无论上游使用何种 API 协议。

## 特性

- **多供应商支持** — DeepSeek（原生 Anthropic API）、Moonshot、OpenAI 兼容接口等
- **自动故障转移** — 按优先级依次尝试供应商，失败自动切换
- **格式自动转换** — Anthropic ↔ OpenAI Chat Completions 双向翻译
- **流式 SSE 转发** — 真正的流式响应，避免超时
- **管理面板** — 网页仪表盘，管理供应商、模型映射、查看日志和统计

## 快速开始

### 环境要求

| 环境 | 要求 |
|------|------|
| Git | 用于克隆仓库 |
| 或 Python 3.10+ | 手动运行时需要 |
| 或 Node.js 20+ | 前端开发时需要 |

### 1. 克隆仓库

```bash
git clone https://github.com/DearMJZ-2U/deepseek-office-gateway.git
cd deepseek-office-gateway
```

### 2. 本机启动

##### 后端

```bash
# 安装 Python 依赖
pip install -r requirements.txt

# 启动服务（默认端口 4000）
python gateway.py
# 或：uvicorn gateway:app --reload --host 0.0.0.0 --port 4000
```

##### 前端（开发模式）

如需修改管理面板页面，可启动 Vite 开发服务器（支持热重载）：

```bash
cd web
npm install
npm run dev     # Vite 开发服务器 :5173
```

生产构建（构建后输出到 `../static/`，由 FastAPI 直接托管）：

```bash
cd web && npm run build
```

### 3. 配置 Office 插件

启动网关后，打开管理面板的“系统设置”→“Claude for Office”。Word、PowerPoint 和 Excel 会分别显示官方 Microsoft Marketplace 安装入口：

- [Claude by Anthropic for Word](https://marketplace.microsoft.com/en-us/product/office/WA200010453)
- [Claude by Anthropic for PowerPoint](https://marketplace.microsoft.com/en-us/product/office/WA200010001)
- [Claude by Anthropic for Excel](https://marketplace.microsoft.com/en-us/product/office/WA200009404)

这些是 Office Marketplace 加载项页面，不是 Windows Store EXE 下载。点击对应入口后，仍需在微软页面登录并确认安装。Claude for Office 还需要符合 Anthropic 官方的订阅或组织授权条件。

返回管理面板后，网关会自动检测官方加载项，并仅为刚安装的应用写入本机 Gateway 配置。如果 Office 应用正在运行，关闭并重新打开对应的 Word、PowerPoint 或 Excel 后配置才会生效。

手动连接时，Office 客户端使用以下配置：

| 配置项 | 值 |
|--------|-----|
| Gateway URL | `http://127.0.0.1:4000` |
| API Token | 在配置界面设置的值|

连接成功后即可使用。安装官方 Marketplace 加载项和连接本地 Gateway 是两个连续步骤；Marketplace 会要求用户确认，网页不能静默完成安装。

#### 修复 Developer 注册冲突

如果管理面板在“系统设置”中提示 Word、PowerPoint 或 Excel 存在 Developer 注册冲突，可使用“修复冲突并配置”。确认后，网关只清除列出的外部 Developer 注册并为目标应用安装 Gateway 配置；官方 Marketplace 加载项不会被删除。

> **注意**：被清除的外部 Developer 注册不会保留，“恢复官方插件”也不会还原这些注册。请仅在确认不再需要原开发者加载项时执行修复。远程访问管理面板不能修改本机 Office 注册表，安装和配置操作必须从本机管理页面执行。

## 支持的供应商

| 供应商 | API 格式 | 适配器 | 说明 |
|--------|---------|--------|------|
| DeepSeek | Anthropic Messages | `AnthropicAdapter` | 原生支持，透明代理 |
| Moonshot | Anthropic Messages | `AnthropicAdapter` | 兼容接口 |
| OpenAI | Chat Completions | `OpenAIChatAdapter` | 自动格式转换 |
| OpenAI 兼容 | Chat Completions | `OpenAIChatAdapter` | 任意兼容接口 |

## 模型映射

Claude Office 插件只识别包含 `sonnet`、`opus`、`haiku` 的模型 ID，因此需要通过管理面板配置映射规则。

示例：

| 客户端模型 | 上游模型 | 供应商 |
|-----------|---------|--------|
| `claude-sonnet-4-5-20250929` | `deepseek-chat` | DeepSeek |
| `claude-opus-4-5-20250929` | `deepseek-reasoner` | DeepSeek |
| `claude-haiku-4-5-20251001` | `moonshot-v1-8k` | Moonshot |

> **注意**：`client_model` 必须包含 `sonnet`、`opus` 或 `haiku` 之一，这是 Claude Office 插件的硬性要求。

## 配置说明

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GATEWAY_TOKEN` | API 访问令牌 | `123` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | — |
| `PORT` | 服务端口 | `4000` |

### 管理面板

启动后访问 `http://localhost:4000/`（生产模式）或 `http://localhost:5173/`（开发模式），即可直接进入本机管理面板。远程访问管理 API 仍需使用 `GATEWAY_TOKEN` 鉴权。

#### 供应商管理
- 添加/编辑/删除供应商
- 配置 base_url、API Key、超时时间
- 设置默认供应商

#### 模型映射
- 添加客户端模型 ↔ 上游模型映射
- 设置优先级（故障转移顺序）
- 每个客户端模型可以映射到多个供应商

#### 仪表盘
- 请求总数、错误率、Token 用量统计
- 小时级趋势图
- 缓存命中率统计

#### 日志
- 实时请求日志查看
- 按时间、状态、模型筛选
- 展开查看详细信息（Token 明细、缓存统计、错误详情）

## 项目结构

```
├── gateway.py                  # FastAPI 入口
├── app/
│   ├── db.py                   # SQLite 数据库
│   ├── auth.py                 # 认证
│   ├── cache.py                # 内存缓存
│   ├── config.py               # 配置
│   ├── schemas.py              # Pydantic 模型
│   ├── providers/              # 供应商适配器
│   │   ├── base.py             # 抽象接口
│   │   ├── anthropic.py        # Anthropic API 适配器
│   │   ├── openai_chat.py      # OpenAI Chat 适配器
│   │   └── url_adaptive.py     # URL 自适应适配器
│   ├── routes/
│   │   ├── proxy.py            # /v1/* 代理路由
│   │   └── admin.py            # /admin/* 管理路由
│   └── translation/
│       ├── __init__.py         # Anthropic → OpenAI 请求转换
│       └── o2a.py              # OpenAI → Anthropic 响应转换
├── web/                        # React 前端
│   └── src/
│       ├── pages/              # Dashboard, Providers, Mappings, Logs
│       ├── components/         # Layout, ProviderForm, ThemeToggle
│       └── lib/                # API 请求、工具函数
├── static/                     # 前端构建产物
├── data/                       # SQLite 数据文件
└── requirements.txt            # Python 依赖
```

## 开发

### 依赖

- Python 3.10+
- Node.js 20+（前端开发）

### 安装

```bash
pip install -r requirements.txt
cd web && npm install
```

### 调试

后端使用 `uvicorn --reload` 支持热重载，前端 Vite 支持 HMR。开发时确保同时运行后端和前端服务器。

## 常见问题

**Q: 提示 "Connection error"？**

A: 确认网关服务正在运行，且 Office 插件配置的 Gateway URL 和 Token 正确。

**Q: 能聊天但不能读写文档？**

A: 确认已配置正确的模型映射，且供应商 API 支持文档处理能力。

**Q: "StreamFirstByteTimeoutError"？**

A: 检查网络连接和供应商 API 可用性，可在管理面板减小超时时间。

**Q: 如何添加新供应商？**

A: 在管理面板的"供应商管理"中添加，选择对应的 API 格式，然后配置模型映射。

## 未来开发方向

### P1 — OpenAI Responses API 支持
适配 OpenAI 最新的 [Responses API](https://platform.openai.com/docs/api-reference/responses)，在现有 Chat Completions 转换器之外增加新的适配器，使网关能够将 Anthropic 格式请求转发到 OpenAI 的 Responses 端点并正确转换响应。

### P2 — 客户端桌面应用
将网关打包为跨平台桌面客户端（Electron / Tauri），集成内嵌浏览器与 Office 插件配置向导，实现零命令行的一键启动体验。用户无需安装 Python、Node.js 或 Docker，下载即用。

### P3 — [CC Switch](https://ccswitch.io/) 集成
[CC Switch](https://ccswitch.io/) 是一款 Claude Code 模型切换工具，支持在不同模型供应商和模型规格之间快速切换。与之集成后，用户可在 Claude Code 中通过 CC Switch 直接调用本网关，实现编码场景与 Office 文档写作场景的模型供应商统一管理。

## 致谢

- 本项目参考了 [DearMJZ-2U/deepseek-office-gateway](https://github.com/DearMJZ-2U/deepseek-office-gateway) 的思路与实现，特此致谢。
- 本项目的代码由 [Claude Code](https://claude.ai/code) 与开发者共同创作完成。

## License

GNU General Public License v3.0 — 详见 [LICENSE](LICENSE) 文件
