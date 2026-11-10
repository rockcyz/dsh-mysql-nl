# 怎么把这个插件分享给别人

## 先看对方用什么

这个项目现在有**两种载体，共用同一份内核**：

| 载体 | 给谁用 | 怎么工作 |
|---|---|---|
| **DSH 插件**（`lib/plugin-mysql.js`） | 用 DeepSeek Harness 的人 | 通过 `ctx.tools.register` 注册 3 个原生工具，模型直接调用 |
| **Agent Skill**（`skill/` + `bin/`） | 用 OpenCode / Claude Code / Cursor / Codex 的人，或任何能跑 shell 的 agent | skill 负责"告诉 agent 该干什么"，`bin/mysql-nl.mjs` 命令行负责真正干活 |

关键点：**skill 本身不能注册工具**。它只是一份按需加载的说明书加一批附带文件。agent 真正调用的是附带的命令行程序。所以"把插件打包成一个 skill"能成立，前提是**必须一起带上 CLI**——光有 `SKILL.md` 是个空壳。

## 三条分发路线

| 路线 | 对方需要 | 体验 | 适合 |
|---|---|---|---|
| **A. DSH bundle** | 装了 DSH | 原生工具，模型直接调 | 同学也用 DSH |
| **B. Agent Skill**（推荐） | 任意能跑 shell 的 agent + Node ≥ 20 | agent 自己写 SQL，CLI 兜底只读安全 | 跨 agent 通用 |
| **C. MCP server** | 支持 MCP 的 agent | 工具级集成，最顺滑 | 后续增强，尚未实现 |

---

## 方式 A：对方也用 DSH

对方拿到 `dsh-mysql-nl` 整个目录后：

```
plugin_manager(action: "install_bundle",
               target: "<插件目录绝对路径>")
```

或者手工在 profile 的 `package.json` 里加：

```json
"dependencies": { "dsh-mysql-nl": "link:<插件目录绝对路径>" }
```

并在 profile 的 `dsh.profile.bundles` 里加上 `dsh-mysql-nl`。

> 注意：`link:` 要求对方的机器上真的存在这个目录。跨机器分发建议先推到 Git 仓库或 npm，再让对方装。

---

## 方式 B：Agent Skill（推荐，跨 agent 通用）

### 1. 你这边打包

```bash
# 同步内核 + 确保 mysql2 就绪 + 打出可直接分发的 zip
node dsh-mysql-nl/scripts/build-skill.mjs --zip
```

产物：

- `.agents/skills/mysql-nl/` —— 本机直接可用的 skill 目录（DSH 会**实时发现，不用重启**）
- `dist/mysql-nl-skill.zip` —— 约 1.2 MB，**自带 mysql2**，收件人不需要 `npm install`

### 2. 对方怎么装

解压后把 `mysql-nl/` **整个目录**放进任一扫描路径：

| Agent | 扫描路径 |
|---|---|
| DSH / OpenCode | `<项目>/.agents/skills/mysql-nl/` |
| DSH / OpenCode | `~/.agents/skills/mysql-nl/` |
| OpenCode | `.opencode/skills/mysql-nl/` |
| OpenCode | `~/.config/opencode/skills/mysql-nl/` |
| Claude Code | `~/.claude/skills/mysql-nl/` |

**`.agents/skills/` 是 DSH 和 OpenCode 的共同扫描路径** —— 放这里一份，两个 agent 都能发现。Claude Code 再软链到 `~/.claude/skills/` 即可。

目录名必须**正好等于** `SKILL.md` 里 frontmatter 的 `name`（`mysql-nl`），且只匹配一层：`<根>/<名字>/SKILL.md`。嵌套更深的 `**/SKILL.md` 不会被发现。

### 3. 对方怎么用

有 agent 时，直接说人话：

> 查询 world 库里每个国家的城市数量，按数量倒序取前 10 个

agent 会自动加载这个 skill，先跑 `schema` 拿真实结构，自己写 SQL，再跑 `query` 执行。

没 agent 时当普通 CLI 用：

```bash
node mysql-nl/bin/mysql-nl.mjs list
node mysql-nl/bin/mysql-nl.mjs schema --db world --tables city,country
node mysql-nl/bin/mysql-nl.mjs query --sql "SELECT * FROM city LIMIT 5"
```

`query` 默认输出**教学四段**：`执行步骤 → SQL 语句 → 语句讲解 → 查询结果`。
讲解由 `bin/` 里的确定性分析器生成，不需要模型，所以对方没有 agent 也能看到 SQL 的逐子句解释
（见 README 的「教学输出」一节）。只想要数据时加 `--quiet`，要机器可读就加 `--json`。

> `SKILL.md` 里把这份四段格式写成了**硬性要求**，并要求 agent 在结构讲解之外补上语义解释
> （"为什么这条 SQL 能回答学生的问题"）。这是它作为教学工具和普通查数工具的区别所在。

### 4. 对方要建连接文件

在**工作目录**建 `mysql-nl.json`（也兼容原来的 `.dsh-mysql.json`）：

```json
{
  "version": 1,
  "default": "local",
  "connections": [
    {
      "id": "local",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "${env:MYSQL_PWD}",
      "database": "world",
      "readOnly": true,
      "maxRows": 200
    }
  ]
}
```

`password` 用 `${env:变量名}` 就不会把口令写进文件。

---

## 方式 C：MCP server（尚未实现）

想要"工具级"而不是"shell 级"的集成，可以把同一份 `lib/core` 再包一个 MCP stdio server，暴露 `mysql_list_connections` / `mysql_schema` / `mysql_query` 三个工具（和 DSH 插件里的三个一一对应）。OpenCode 原生支持 MCP。

注意：**不要把 `mysql_nl_query` 那个"插件自己调模型"的工具搬过去**。宿主 agent 本身就是模型，再调一次要额外配 provider/key、多一跳延迟，而且和 agent 的上下文脱节。正确切分是：schema 和只读执行由工具提供，**选表和写 SQL 交给宿主 agent**。

---

## 维护：改内核之后

`lib/core/**` 是**唯一真源**。你只改这里，然后重新构建：

```bash
node dsh-mysql-nl/scripts/build-skill.mjs        # 同步内核到 skill 目录
node dsh-mysql-nl/scripts/build-skill.mjs --check # 校验是否同步（可放进 CI）
node dsh-mysql-nl/scripts/build-skill.mjs --zip   # 打包分发
```

`--check` 会在 skill bundle 与 `lib/core` 不一致时**以非零码退出**——防止插件修了 bug、skill 却停留在旧版本这种漂移。

---

## 别做的事

- **别只发 `SKILL.md`。** 没有 `bin/` 和 `lib/`，agent 读到的只是一段"我有这些命令"的文字，一条也跑不了。
- **别把 `.dsh-mysql.json` 一起发出去。** 里面是明文口令。分发前确认 zip 里只有 `mysql-nl.json` 的**模板**，没有真实配置。
- **别为了让别人"能用"就把 `readOnly` 改成 `false`。** 学生写错一条 `DELETE` 就没有后悔药了。默认只读是保命的。
  注意：NL 路径无论这个配置怎么设都不会执行写语句——写操作一律"生成 + 讲解 + 交接"，由用户在自己的
  DBeaver / Workbench 里执行。`readOnly: false` 只放开你自己手写 SQL 的通道，别把它当成"功能开关"发给别人。
- **别把 `node_modules` 从 zip 里删掉。** 看起来臃肿（1.2 MB），但这是"解压即用、不用联网装依赖"的代价，对教学场景很值。
