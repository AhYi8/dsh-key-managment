# dsh-key-managment

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的分提供商 API 密钥池插件：为每个提供商维护多个 API 密钥，支持手动切换当前使用的密钥，并提供后台可达性探测与套餐用量展示。

## 功能

- **密钥池**：按提供商配置多把 API 密钥，随时手动切换生效密钥
- **后台探测**：按可配置的间隔对密钥做可达性探测，启动即跑一轮
- **用量展示**：内置多家服务商的套餐余量适配器（DeepSeek 余额、Kimi Coding、MiniMax、智谱 / Z.ai、OpenRouter、Command Code、OpenCode Go、Magpie 等）
- **Web 设置界面**：在 DSH 浏览器端提供配置与切换入口
- **密钥脱敏**：界面与日志中自动脱敏展示密钥

## 安装

```sh
dsh plugin --profile web add dsh-key-managment
```

或通过 DSH 设置 → 插件 / 插件市场搜索 `dsh-key-managment` 安装。

## 使用

安装后在插件设置中为各提供商添加密钥，选择当前生效密钥即可；探测间隔与开关均在设置页调整。

## 开发

```sh
pnpm install
node --test core.test.mjs
```

## License

[MIT](LICENSE)
