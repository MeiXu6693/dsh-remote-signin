[English](README.md) · **中文**

# dsh-remote-signin

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：
**让"用 DeepSeek 账号登录"在你手边的浏览器里也能走完** —— 用局域网地址、域名反代、
Tailscale 打开 DSH 都算。装好之后你只会多看到一步：把打不开的那个地址粘回页面，
而粘贴框会自己出现。

## 你会遇到的现象

你在**不是 DSH 那台机器**上打开 DSH —— `http://192.168.0.20:8080`、
`https://dsh.example.com`、`http://100.x.y.z:8080` 都算 —— 然后：

1. 打开账号面板，点 **使用 DeepSeek 账号登录**；
2. **登录页根本不会出现**：弹窗直接报错，提示类似
   「操作未完成，请重试。」（英文界面是 *Could not complete the operation. Try again.*），
   有时是「操作未完成，可能是网络异常，请检查你的网络状况后重试」；
3. 换成在**那台机器本机**开浏览器，或者先 `ssh -L` 把端口隧道到本机、用
   `http://127.0.0.1:…` 打开，同样的操作就一切正常；
4. 用 **API Key** 登录不受影响。

所以"能用"的变通办法一直是：改用 API Key，或者每次登录都先开一次隧道。这个插件就是
为这一步存在的。

## 这个插件做什么

装上之后，远程打开 DSH 也能正常走完账号登录：

```
1. 浏览器（https://dsh.example.com）  你点「使用 DeepSeek 账号登录」
2. DSH 宿主 + 本插件                 把要注册的回调地址换成 127.0.0.1 上的一个口子
3. platform.deepseek.com             接受，返回登录页地址
4. 浏览器                            登录页正常打开（这一步以前就失败在这里），你完成登录
5. 浏览器                            平台把你送回 127.0.0.1:47821 —— 这个页面打不开，
                                     但地址栏里带着授权码（`code` 与 `state`）
6. DSH 页面                          右下角已经自动出现粘贴框：把那个地址粘进去
7. DSH 宿主                          完成授权 —— 校验与换取凭据都是 DSH 原生的流程
                                     → 对话框变成已登录
```

**为什么第 6 步不能全自动**：授权码必须由**你自己的浏览器**送到那个 `127.0.0.1` 地址上，
而你的浏览器此刻打不开它（能打开就说明你本来就在那台机器上，也就不需要这个插件了）。
能省掉的都省掉了 —— 不用记地址、不用另开界面、不用改 hosts，粘贴框在你需要它的时候
自己出现在页面上。

## 为什么不装就不行

DSH 会把**「你此刻打开界面的地址」**原样交给 DeepSeek 平台，让平台把登录结果送回那里；
而平台只接受 `127.0.0.1` 这类"本机地址"。于是请求在登录页打开之前就被平台拒了 ——
**跟你的网络、防火墙、反向代理配置都没有关系**，这是上游当前的限制。

实测（2026-10-16，直接请求平台的 `POST /auth-api/v0/dsh/auth_init`）：

| 交给平台的回调地址 | 平台返回 |
|---|---|
| `http://127.0.0.1:47821/oauth/callback` | `{"code":0, … "authorize_url": …}`，`expires_in: 600` |
| `https://dsh.example.com/oauth/callback` | `{"code":50005,"msg":"PAYLOAD_SCHEMA_MISMATCH"}` |

插件做的就是把这两件事分开：平台校验的只是一个**字符串**，而真正需要访问到那个地址的
只有**浏览器**。字符串由插件提供（`127.0.0.1` 上的一个端口，**没有任何东西监听它**），
授权码则由你粘回来。

## 安装

**Unraid / `dsh-unraid` 镜像**：不用做任何事 —— 镜像会安装本插件，并由 `REMOTE_SIGNIN`
控制（默认 `on`；设 `off` 回到上游行为）。

**任意 DSH profile**：装进 profile 即可（包的 `dsh.bundle` 声明会让它带上
`cordis.patch.yml`）：

```bash
dsh plugin --profile web add github:MeiXu6693/dsh-remote-signin
```

**或以 patch overlay 方式加载**（不动 profile）：

```bash
dsh --profile web --patch "$(node -p "require.resolve('dsh-remote-signin/cordis.patch.yml')")"
```

## 设置

只有一项：声明用哪个 `127.0.0.1` 地址。默认值可用，一般不用改。

| 来源 | 含义 |
|---|---|
| patch 条目里的 `config.claimOrigin` | 优先级最高。 |
| 环境变量 `REMOTE_SIGNIN_ORIGIN` | 兜底。必须是 `http://` + `127.0.0.1` / `localhost` / `[::1]` + 显式端口。 |
| 默认 | `http://127.0.0.1:47821` |

端口刻意取生僻值：万一你本机真有个服务在监听，授权码就有被它收到的风险 —— 所以别改成
常用端口。

## 它刻意不做的事

* **不放松任何校验。** 结束登录的是 DSH 自己的回调路由，用它自己的一次性 `state` 校验和
  内存里的 PKCE verifier；本插件只决定「注册哪个回环**字符串**」。
* **不改动已经在 `127.0.0.1` 上的浏览器**（`ssh -L`、桌面端）：这些地址原样放行，行为与
  上游完全一致。
* **不自造视觉风格。** 面板完全用 harness 自己的设计令牌（`--dsw-*`：surface、圆角、投影、
  文字与状态色、主按钮填充色）来写样式，因此会跟随应用主题（包括你自己选的深色模式）与
  将来的重构；一旦有人写回硬编码颜色，测试就会失败。
* **不保存、不打印授权码 / state / token。** 每次尝试只写一行日志：本次声明用的地址。
  粘贴的地址在浏览器里解析，只有 `code` 与 `state` 被重新编码后发到**本 origin 自己的**
  `/oauth/callback`，不发给任何其它地方 —— 所以面板不可能被当成跳板。
* **不开放任何端口。** 声明只是一个字符串：服务器和你本机都没有任何东西监听它。
* **绝不会成为容器起不来的原因。** 资源缺失、声明不可用、或将来上游改名，都只会退回
  上游行为并在日志里留一行。

## 排障

| 现象 | 含义 |
|---|---|
| 仍然是「操作未完成，请重试。」 | 插件没生效：`docker logs <容器名> \| grep remote-signin` 会说明原因（`off`、包缺失、`INACTIVE`）。 |
| 登录页打开了，但登录完停在打不开的 `127.0.0.1` 页面，页面上没有粘贴框 | 面板没注入成功 —— 同上，看那行日志；面板是唯一的回传入口，它不出现就没法完成。 |
| 面板说**没有正在等待的登录**（`404`） | 这次登录已过期（约 10 分钟），或者它属于**另一个 DSH 实例** —— 重建容器会作废它，而前一个实例遗留的标签页看上去还停在"等待登录"。请在**你正在用的那个标签页**里重新点一次登录。 |
| 面板说 state 不匹配（`400`） | 地址来自另一次尝试，或这个授权码已经被用掉了。 |
| 想回到上游行为 | 移除插件（`dsh-unraid` 镜像上设 `REMOTE_SIGNIN=off`），然后照旧用 API Key 或隧道。 |

## 开发

```bash
node --test        # 16 个测试，零依赖，不需要浏览器
```

| 文件 | 作用 |
|---|---|
| `src/index.js` | 服务端插件：包装 `deepseekAccount.startSignIn`（把非回环的浏览器 origin 换成声明的回环 origin）、提供面板脚本、把它注入 DSH 文档。 |
| `src/claim.js` | 纯函数：声明的解析与校验规则，不启动 DSH 就能测。 |
| `assets/inpage.js` | 面板：仅在"有登录在等待"时出现 —— 靠 `GET /oauth/callback` 的返回码判断（`400` = 有等待，`404` = 空闲），不新增任何接口。 |
| `test/`、`test-support/` | `node --test` 套件与它们共用的小 DOM 桩（面板的探测节奏、关闭行为、地址提取、每一种状态都有用例）。 |

### 装到别处时才需要注意的一点

patch 条目的 `name` 只从两个锚点解析：`@deepseek-ai/dsh` **安装**所携带的包（它的依赖
闭包），以及 **profile** 目录（`$DSH_HOME/profiles/<name>/node_modules`）。装在别处的包
（你自己 runtime manifest 的依赖、或镜像里的一份拷贝）两个锚点都不占，于是
`name: dsh-remote-signin` 会报 `ERR_MODULE_NOT_FOUND`。两条出路：

* 装进 profile（上面的 `dsh plugin … add …`），名字就能解析；
* 或者让条目直接指向文件 —— `dsh-unraid` 镜像就是这么做的：

  ```yaml
  - insert:
      - id: remote-signin
        name: file:///app/node_modules/dsh-remote-signin/src/index.js
  ```

上游处于开发者预览阶段。插件只依赖两个契约 —— `deepseekAccount.startSignIn` 与 web server
的路由/index API —— 任一变化时它都只降级、不致命。

MIT 许可，见 [CHANGELOG.md](CHANGELOG.md)。
