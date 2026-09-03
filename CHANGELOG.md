# Changelog

## 0.3.2

- 修复 Chrome／Edge 页面加载时将 SillyTavern USER 密码自动填入并保存到代理密码的问题。
- 从 SillyTavern 已加载的设置快照恢复代理密码，并加强直接编辑、代理预设切换与 Responses 请求的密码保护。

## 0.3.1

- 以官方 `v0.3.0` 为基础合并本 Fork 的修复。
- 仅转换当前主 OpenAI 端点的请求，避免狐裁、JS-Slash-Runner 等扩展的自定义 API 被错误改写为 Responses 协议。
- 防止浏览器密码管理器自动填充并覆盖代理密码。

## 0.3.0

- 最低支持版本调整为 SillyTavern 1.14.0。
- 增加旧版自动启动兼容层：SillyTavern 1.14-1.16 无扩展激活钩子时也能初始化。
- 初始化流程改为幂等，兼容 SillyTavern 1.17-1.18 的 `activate` 钩子且不会重复添加界面和事件。
- Node.js 最低要求调整为 18，与 SillyTavern 1.14-1.16 保持一致。

## 0.2.0

- 支持 SillyTavern `requestProxy` 出站代理。
- 支持 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 环境变量。
- Windows 下自动读取系统手动代理、绕过列表与 PAC 地址，切换代理后无需重启插件。
- 服务端请求改用 SillyTavern 已包含的 `node-fetch` 和 `proxy-agent`，普通响应与 SSE 流式响应均经过同一代理链。

## 0.1.0

- 首次发布，支持 OpenAI Responses 普通与流式生成。
