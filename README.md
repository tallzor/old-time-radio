# 声音时间机器 MVP

面向老年用户的本地可运行 H5 MVP。项目实现游客收听、年代／类型选播、全局播放器、喜欢、反馈、基础分享、分析导出和受控运营流程；微信登录与 SDK 卡片为关闭状态的 P1 能力。

## 本地启动

需要 Node.js 20+ 与 npm（本次开发环境实际只有 Node v24.19.0 和 pnpm 后备命令）。生产不需要也不应使用 PGlite；需改接受管 PostgreSQL、对象存储和受控运营身份。

```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

浏览器打开 `http://localhost:5173`。API 为 `http://127.0.0.1:3001`，健康检查为 `/health`。`db:seed` 只创建 8 条标题含“开发示例”的本地测试节目和一个合成 WAV；它们不是已授权内容，不能用于生产或计入 20 条内容要求。

## 校验命令

```bash
npm run typecheck
npm test
npm run build
```

`apps/api/.env.example` 列出开发配置。微信登录和 SDK 卡片默认关闭；没有真实公众号权限、回调域名和凭证时不要打开。运营 API 需要服务端 `ADMIN_BOOTSTRAP_TOKEN`，开发环境仅用于受控本地验收，生产必须替换为正式运营认证。

详细接口见 [OpenAPI](docs/openapi.yaml)，实施证据和未验证项见 [进度](docs/progress.md)。
