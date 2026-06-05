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

当前项目通过 GitHub Pages 对外发布，线上地址：

```text
https://syxkira.github.io/local-sql-formatter/
```

仓库地址：

```text
https://github.com/syxKira/local-sql-formatter
```

### 首次部署流程

1. 在 GitHub 创建仓库，例如：

```text
syxKira/local-sql-formatter
```

2. 本地初始化 Git 仓库并推送到 GitHub：

```bash
git init -b main
git add .
git commit -m "Set up SQL formatter app deployment"
git remote add origin git@github.com:syxKira/local-sql-formatter.git
git push -u origin main
```

3. 在 GitHub 仓库中打开 Pages 设置：

```text
Settings -> Pages -> Build and deployment -> Source
```

选择：

```text
GitHub Actions
```

4. 项目已经内置 GitHub Pages 自动部署配置：

```text
.github/workflows/deploy-pages.yml
```

推送到 `main` 分支后，GitHub Actions 会自动执行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

并把 `dist/` 发布到 GitHub Pages。

5. 部署成功后，在 Actions 页面可以看到 `Deploy Pages` 成功记录：

```text
https://github.com/syxKira/local-sql-formatter/actions
```

最终用户访问：

```text
https://syxkira.github.io/local-sql-formatter/
```

### 后续更新部署

每次修改代码后，只需要提交并推送：

```bash
git add .
git commit -m "Describe your change"
git push
```

GitHub Actions 会自动重新构建并发布，用户继续访问同一个 URL 即可使用最新版。

### 说明

这个网页不依赖本地电脑运行。部署到 GitHub Pages 后，即使本机关闭，用户也可以继续访问。SQL 格式化和字段解析都在用户自己的浏览器中执行，不会把 SQL 发回服务器。
