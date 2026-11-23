# dsh-key-managment

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的分提供商 API 密钥池插件：为每个提供商维护多个 API 密钥，支持手动切换当前使用的密钥，并提供后台可达性探测与套餐用量展示。

## 功能

- **密钥池**：按提供商配置多把 API 密钥，随时手动切换生效密钥；列表把有效密钥排在前面（生效密钥在有效组内优先），无效、限流冷却中、未探测与密钥值缺失的密钥排在后面。列表顺序只影响展示，自动/手动轮换仍按池内存储顺序进行；列表分页展示，每次追加 50 条，滚动到列表底部自动追加下一页（切换供应商时回到第一页）
- **失效兜底**：调用遇密钥无效/额度不足时自动切到池内下一把并重放本次请求（可在设置中关闭）
- **后台探测（公平调度）**：开关开启后从启动起持续探测，每次探完一把等 n 秒再探下一把（间隔可配置，默认 10 秒）；探测完成的密钥回队尾、新纳管的密钥插队首，无效与冷却中的密钥自动跳过
- **用量展示**：内置多家服务商的套餐余量适配器（DeepSeek 余额、Kimi Coding、MiniMax、智谱 / Z.ai、OpenRouter、Command Code、OpenCode Go、Magpie 等）；明细弹层标题展示订阅套餐等级（如 lite / pro），Magpie 多账号窗口按额度池标注 pool
- **Web 设置界面**：在 DSH 浏览器端提供配置与切换入口
- **密钥脱敏**：界面与日志中自动脱敏展示密钥
- **WebDAV 备份**：定时把密钥池快照加密（AES-256-GCM）上传到 WebDAV，手动选版本覆盖恢复；每设备各保留 N 份自动轮转

## 安装

```sh
dsh plugin --profile web add dsh-key-managment
```

或通过 DSH 设置 → 插件 / 插件市场搜索 `dsh-key-managment` 安装。

## 使用

安装后在插件设置中为各提供商添加密钥，选择当前生效密钥即可；弹窗分「密钥池 / 设置」两个页签，探测间隔与开关、自动轮换、WebDAV 备份均在「设置」页签调整。

## 开发

```sh
pnpm install
node --test core.test.mjs
```

## License

[MIT](LICENSE)
