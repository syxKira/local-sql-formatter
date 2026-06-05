# SQL 格式化与字段解析

## 本机使用

```bash
pnpm dev
```

访问：

```text
http://127.0.0.1:8765/
```

## 局域网共享给其他人

先构建静态产物：

```bash
pnpm build
```

再启动共享服务：

```bash
pnpm share
```

查看你的 Mac 局域网 IP：

```bash
ipconfig getifaddr en0
```

如果你连的是有线网，也可以试：

```bash
ipconfig getifaddr en1
```

然后把下面这个地址发给同一网络内的其他人：

```text
http://你的局域网IP:8765/
```

例如：

```text
http://192.168.1.23:8765/
```

注意：共享服务只适合同一局域网或公司内网访问。SQL 格式化和字段解析都在访问者自己的浏览器里执行，不会把 SQL 发回服务器。

## 公网部署

本项目已经内置 GitHub Pages 自动部署配置：

```text
.github/workflows/deploy-pages.yml
```

推送到 GitHub 仓库的 `main` 分支后，GitHub Actions 会自动执行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

并把 `dist/` 发布到 GitHub Pages。

首次使用时需要在 GitHub 仓库的 Settings -> Pages 中确认 Source 为 GitHub Actions。
