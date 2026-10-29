# DSH 远程账号登录插件

**中文** · [English](README.en.md)

在另一台设备的浏览器中使用 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 时，这个插件帮助你完成 DeepSeek **账号登录**。它适用于通过局域网、Tailscale 或反向代理访问 DSH 的场景。

登录过程中，你需要把一次打不开的回调页面地址粘贴回 DSH 页面。插件会自动显示粘贴框。使用 API Key 不需要这一步。

## 什么时候需要它

DSH 运行在服务器或 NAS 上，而浏览器运行在你的电脑或其他设备上时，账号登录可能在打开登录页之前失败。当前 DeepSeek 账号授权要求回调地址使用本机地址；远程浏览器和 DSH 服务器的“本机”不是同一台机器。

如果你使用 [dsh-docker 容器镜像](https://github.com/MeiXu6693/dsh-docker)，镜像已包含本插件，默认开启，无需再次安装。通过 Unraid 的 DSH 应用安装时也是如此。

## 怎么使用

1. 在远程浏览器打开 DSH，选择 **使用 DeepSeek 账号登录**。
2. 在打开的 DeepSeek 登录页面完成登录。
3. 浏览器会跳转到一个以 `http://127.0.0.1:47821/` 开头、通常打不开的地址。复制地址栏中的完整地址。
4. 回到原来的 DSH 页面，将地址粘贴到自动出现的面板中，按提示提交。
5. DSH 自己验证并完成登录。登录请求通常约 10 分钟后过期；超时或容器重建后，请重新发起登录。

回调地址包含敏感的登录信息，只粘贴到你自己 DSH 页面上的面板，不要分享或提交到日志、工单。默认的 `47821` 端口不需要开放；请确保本机没有其他程序占用它，避免回调被其他程序接收。

## 安装与关闭

**dsh-docker 镜像：** 插件已经安装，`REMOTE_SIGNIN` 默认为 `on`。设为 `off` 并重建容器可关闭插件；这时远程账号登录回到上游行为。使用其他镜像时，请先确认镜像是否已集成该插件。

**其他 DSH 安装：** 将插件安装到 DSH 的 web profile：

```bash
dsh plugin --profile web add github:MeiXu6693/dsh-remote-signin
```

也可以在插件已安装且可被 Node 解析时，以 patch overlay 加载：

```bash
dsh --profile web --patch "$(node -p "require.resolve('dsh-remote-signin/cordis.patch.yml')")"
```

## 常见问题

| 现象 | 处理方法 |
|---|---|
| 点击账号登录后仍然报错 | 确认插件已安装并开启；检查 `docker logs <容器名> \| grep remote-signin` 是否显示 active，或是否说明插件未加载。 |
| 登录后停在打不开的本机地址，不知道下一步 | 回到原来的 DSH 标签页，把地址栏中的完整地址粘贴到自动出现的面板。 |
| DSH 页面没有粘贴面板 | 检查插件是否 active；面板未加载时不能通过本插件完成回传，可暂用 API Key 或 SSH 隧道。 |
| 面板提示没有等待中的登录或 state 不匹配 | 登录可能已过期、容器已重建，或复制的是另一次请求的地址。在当前 DSH 页面重新发起登录并使用新地址。 |

## 工作原理与安全

插件向 DeepSeek 注册一个回环地址，让远程账号登录请求能够开始。登录后，面板从粘贴的地址中提取 `code` 和 `state`，仅发送到当前 DSH 站点自己的 `/oauth/callback`。DSH 原有的一次性 state 检查和 PKCE 校验继续负责验证及令牌交换；插件不保存或记录授权码、state 和令牌。

插件不启动监听端口。已通过 `127.0.0.1` 访问的本机浏览器保持原有行为；插件所需服务或资源缺失时会记录提示并回退到上游行为，DSH 仍可启动。

2026-10-16 的平台测试中，`http://127.0.0.1:47821/oauth/callback` 被接受，而公网 HTTPS 回调被拒绝。这是当时的上游行为，平台规则可能改变。

## 高级配置

默认声明地址是 `http://127.0.0.1:47821`，通常无需修改。patch 条目的 `config.claimOrigin` 优先；没有该项时读取 `REMOTE_SIGNIN_ORIGIN`。地址必须使用 `http://`、回环主机（`127.0.0.1`、`localhost` 或 `[::1]`）和显式端口。不要选择本机已有程序使用的端口。

通过 patch 条目按包名加载时，插件必须能从 DSH 安装的依赖或 profile 的 `node_modules` 解析。安装在其他位置时，可以使用插件入口的绝对 `file://` 地址；dsh-docker 镜像使用这种方式。

## 开发与兼容性检查

```bash
node --test
```

单元测试使用 Node 内置测试工具和 DOM 桩，不需要网络、浏览器或安装依赖。CI 同时定期拉取 `ghcr.io/meixu6693/dsh:latest`，验证镜像内置插件和当前仓库代码与最新镜像是否兼容，包括加载、认证门禁、面板注入及资源、空闲回调、禁用和 edge 来源校验。CI 不使用真实 DeepSeek 账号，也不完成平台授权；浏览器交互由本仓库的无依赖单元测试覆盖。

检查每小时调度一次，也会在 push、PR 和手动运行时执行。GitHub 定时任务可能延迟；通知依赖仓库现有的 Actions 通知设置。测试结果可在 [Actions](https://github.com/MeiXu6693/dsh-remote-signin/actions) 查看。

MIT 许可；版本历史见 [CHANGELOG.md](CHANGELOG.md)。
