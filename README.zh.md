# MySQL 自然语言查询插件（dsh-mysql-nl）

[English](README.md) | [简体中文](README.zh.md)

一个 DeepSeek Harness（DSH）插件：**连接 MySQL → 读取真实数据表结构 → 把你的自然语言查询需求生成准确的
SQL → 执行并把数据返回给你**。你在对话框里直接说需求即可，不需要自己写 SQL。

```
你说：  「查询每个国家的城市数量，按数量倒序取前 10 个」
插件做：读取 world 库真实结构 → 交给模型生成 SQL → 只读校验 → 执行 → 返回表格
你得到：SELECT c.Name, COUNT(*) AS city_count
        FROM city c JOIN country k ON c.CountryCode = k.Code
        GROUP BY c.Name ORDER BY city_count DESC LIMIT 10
        （以及 10 行真实数据）
```

## 目录

- [它解决什么问题](#它解决什么问题)
- [安装](#安装)
- [配置数据库连接](#配置数据库连接)
- [插件配置项](#插件配置项)
- [三个工具](#三个工具)
- [使用示例](#使用示例)
- [教学输出（面向数据库课）](#教学输出面向数据库课)
- [安全设计](#安全设计)
- [工作原理](#工作原理)
- [开发与测试](#开发与测试)

## 它解决什么问题

模型本身并不知道你的库里有哪些表、字段叫什么、外键怎么连。直接让它"写一条 SQL"通常会编造字段名
（`SELECT title FROM movies` 而真实表是 `film`）或者漏掉 JOIN 条件。

这个插件在生成 SQL **之前**先把真实的表结构读出来喂给模型，所以生成的是能直接跑通的语句：

1. **真实结构接地**：从 `INFORMATION_SCHEMA` 读取表、字段名、类型、是否可空、主键、自增、注释、
   索引、外键。
2. **按需加载**：表少时整库结构一次给模型；表多时先用"表名 + 注释"清单让模型选表，再只取这些表的
   完整字段，避免提示词爆炸。
3. **报错自愈**：SQL 执行失败时，把失败的语句和数据库返回的错误一起交回模型重写一次。
4. **安全兜底**：只读模式、单语句、超时、行数上限、结果截断。

## 安装

直接从本仓库安装（推荐，任何人可用）：

```
plugin_manager(action: "install_bundle",
               target: "github:rockcyz/dsh-mysql-nl")
```

或命令行：

```sh
dsh plugin --profile <profile> add github:rockcyz/dsh-mysql-nl
```

本地 checkout 安装则填绝对路径：

```
plugin_manager(action: "install_bundle",
               target: "/绝对路径/dsh-mysql-nl")
```

安装会：

1. 把包写进本 profile 的 `package.json` 依赖并选中 bundle；
2. 通过 `cordis.patch.yml` 插入 `mysql-nl` 这一行（`lib/index.js`）；
3. 由 HMR 立刻生效。

> **注意**：如果这个包之前已经加载过一次并且加载失败，宿主会缓存那份**失败的模块记录**。修改文件后
> 单独开关插件不会重新导入代码，需要重启 Harness（或重新生成模块 URL）才会加载新的 JavaScript 代。

验证：

```
cordis_inspect_query(platform: "host", provider: "Config", method: "listConfigs",
                    input: { name: "dsh-mysql-nl" })
```

看到这一行 `fiberPhase: "active"` 即表示已加载（`cordis_inspect_query` 不需要审批）。

## 配置数据库连接

连接信息放在**工作目录**的 `.dsh-mysql.json` 里。插件会从当前工作目录逐级向上查找
`.dsh-mysql.json`、`dsh-mysql.json`、`.dsh-mysql/connections.json`，再查用户主目录和 `~/.dsh`。

```json
{
  "version": 1,
  "default": "local",
  "connections": [
    {
      "id": "local",
      "label": "本机 MySQL",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "${env:MYSQL_PWD}",
      "database": "world",
      "readOnly": true,
      "maxRows": 200,
      "maxQueryMs": 15000,
      "charset": "utf8mb4"
    },
    {
      "id": "prod-report",
      "label": "生产只读账号",
      "host": "10.0.0.12",
      "port": 3306,
      "user": "report",
      "password": "${env:REPORT_DB_PASSWORD}",
      "database": "sakila",
      "readOnly": true,
      "maxRows": 100
    }
  ]
}
```

要点：

- **密码优先写 `${env:变量名}`**，从进程环境变量取值，避免把口令写进文件。变量缺失时会直接报错，
  不会静默用空密码连接。写字面量密码也能用，但它会以明文留在磁盘上；务必把这类文件排除在版本库外
  （本仓库的 `.gitignore` 已经忽略 `.dsh-mysql.json`）。
- `default` 指定默认连接；只有一个连接时可以省略。也可以用连接里的 `"isDefault": true`。
- 也接受**只写一个连接**的最简形式（不需要 `connections` 数组和 `id`），或把内容包在 `"mysql": {...}` 里。
- `readOnly` 默认就是 `true`。想要写操作必须显式写 `"readOnly": false`。
- 键名写错（例如把 `password` 写成 `passwd`）会被直接拒绝并提示，而不是被忽略。

## 插件配置项

在 profile 的 `cordis.patch.yml` 里给 `mysql-nl` 这一行加 `config` 即可：

```yaml
- id: mysql-nl
  name: "dsh-mysql-nl"
  config:
    connectionsFile: C:/path/to/.dsh-mysql.json
    profile: local
    readOnly: true
    maxRows: 200
    maxQueryMs: 15000
    inlineCharBudget: 60000
    maxTables: 12
    llmProvider: deepseek-account
    llmModel: deepseek-flash
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `connectionsFile` | 自动查找 | 连接配置文件路径 |
| `profile` | 文件里的 `default` | 默认连接 id |
| `readOnly` | 跟随连接 | `true` 强制只读；`false` 允许写 |
| `maxRows` | 200 | 单次查询最多返回行数（1–10000） |
| `maxQueryMs` | 15000 | 单条 SQL 超时毫秒数（100–600000） |
| `maxCellChars` | 400 | 单个单元格保留的最大字符数 |
| `inlineCharBudget` | 60000 | 表结构直接入提示词的字符预算；超出则先让模型选表 |
| `maxTables` | 12 | 参与生成 SQL 的表数量上限 |
| `llmProvider` / `llmModel` | 会话默认模型 | 生成 SQL 用的模型；不配置就跟随当前会话 |

配置项写错（未知键名、类型不对、数值越界）会在插件激活时报错，不会静默使用默认值。

## 三个工具

### `mysql_nl_query` — 主入口

把用户原话放进 `question` 即可。

| 参数 | 必填 | 说明 |
|---|---|---|
| `question` | ✅ | 自然语言查询需求 |
| `connection` | | 连接 id，默认用默认连接 |
| `database` | | 数据库名，默认用连接的默认库 |
| `tables` | | 提示用到的表，可跳过"模型选表"这一步，提高准确率 |
| `execute` | | 默认 `true`；设 `false` 只生成 SQL 不执行 |
| `max_rows` | | 本次最多返回行数，优先于连接配置 |
| `show_sql` | | 默认 `true`，在结果里显示真正执行的 SQL |

返回：生成的 SQL、语句类型、风险等级、涉及的表、行数、耗时、是否截断、markdown 表格，以及一段
直接给用户看的结论（`reply`）。

### `mysql_schema` — 看真实结构

参数：`connection`、`database`、`tables`（可选，指定则只看这些表）。

返回压缩过的结构文本（表、字段、类型、主键、自增、注释、索引、外键），适合直接读或放进上下文。
当你想确认"字段到底叫什么"时用它，避免瞎猜。

### `mysql_list_connections` — 看有哪些连接

参数：`ping`（默认 `false`，设 `true` 会探测连通性并附带服务器版本和可访问的数据库列表）。

返回连接清单（**永远不含密码明文**）和连接配置文件路径。

## 使用示例

在对话框里直接说：

- 「查一下 world 库里人口最多的 5 个国家」
- 「sakila 库中每个影片分类各有多少部电影？」
- 「哪些客户租过的电影种类最多？给我前 20 个」
- 「上个月的订单总金额按天统计」

想先看 SQL 再决定是否执行：

> 「帮我生成查询语句，先别执行：统计每个国家的城市数量」→ 模型会传 `execute: false`。

想指定库和连接：

> 「在 company 这个库（用 prod-report 连接）里查出员工数最多的 3 个部门」

## 教学输出（面向数据库课）

学生要学的不只是答案，而是**这条 SQL 是怎么来的**。所以每次查询的输出固定为四段，
插件和命令行**完全一致**：

```
### 执行步骤      连的哪台库、只读校验结果、涉及哪些表、自动补了什么、耗时多久
### SQL 语句      完整语句（学生写的那句，不含插件注入的超时提示）
### 语句讲解      逐子句结构说明 + 教学提示
### 查询结果      数据表格
```

`语句讲解` 由一个**不依赖大模型的确定性分析器**（`lib/core/explain.js`）生成。这样做的原因是：
命令行那一侧（Agent Skill）根本没有模型可用 —— 写 SQL 的是调用它的 agent —— 如果讲解依赖模型，
两种载体的输出就会不一致。确定性讲解永远在场、不会编错、可以单元测试。

它会逐子句说明 `SELECT / FROM / JOIN / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT` 各自在做什么，
并识别这些典型错误：

| 教学提示 | 触发条件 |
|---|---|
| `WHERE` 在分组前执行，聚合要放 `HAVING` | `WHERE` 里出现 `COUNT()` 等聚合函数 |
| JOIN 缺 `ON` 会产生笛卡尔积 | 有 `JOIN` 但没有 `ON` |
| `SELECT *` 会取出所有列 | `SELECT *` |
| 排序不减少行数 | 有 `ORDER BY` 但没有 `LIMIT` |

**查询失败时同样输出步骤、SQL 和讲解** —— 报错的语句是最有教学价值的例子。

## 安全设计

| 机制 | 行为 |
|---|---|
| 只读默认 | 连接 `readOnly` 默认 `true`；写语句在执行前被拒绝并说明原因 |
| 危险语法拦截 | 只读模式下拒绝 `FOR UPDATE`、`LOCK IN SHARE MODE`、`INTO OUTFILE/DUMPFILE`、`LOAD_FILE()`、`LOAD DATA`、`BENCHMARK()`、`SLEEP()` |
| 单语句 | 一次只允许一条语句，禁止 `SELECT 1; DROP TABLE t` |
| 字面量感知 | 判断语句类型时会屏蔽字符串与注释，`SELECT 'delete from x'` 不会被误判为写操作 |
| 超时 | `maxQueryMs`（默认 15 秒），同时用 `MAX_EXECUTION_TIME` 提示和硬性连接销毁 |
| 行数/长度上限 | 行数按 `maxRows` 截断并如实告知；单元格超长截断 |
| 结构接地 | 只允许使用真实存在的表名和字段名 |

> 说明：插件自身的检查是"防误伤"而不是权限边界。真正的安全边界应该是**数据库账号权限**——
> 给查询用的账号只授予 `SELECT`。

## 工作原理

```
用户提问
   │
   ├─ 1. 读配置，解析连接（config.js）
   ├─ 2. 读 INFORMATION_SCHEMA：库/表/字段/索引/外键（catalog.js）
   │     表少 → 整库结构入提示词
   │     表多 → 先让模型按表名+注释选表，再取这些表的完整字段
   ├─ 3. 组装提示词（真实结构 + 规则），调用模型生成 SQL（nl.js → ctx.llm.stream）
   ├─ 4. 清洗 SQL（去 markdown 围栏/多余语句）并做安全检查（sql.js）
   ├─ 5. 执行；失败则带上错误让模型重写一次（client.js + nl.js）
   └─ 6. 渲染 markdown 表格与结论（format.js）
```

模块划分：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 包入口，转出 Cordis 插件 |
| `lib/plugin-mysql.js` | Cordis 插件：注册三个工具、解析配置、调用 `ctx.llm` |
| `lib/config-schema.js` | 配置校验（Standard Schema + JSON Schema 投影） |
| `lib/core/config.js` | 连接文件查找、`${env:...}` 替换、默认连接解析 |
| `lib/core/client.js` | mysql2 连接池、单语句执行、超时、值归一化 |
| `lib/core/catalog.js` | `INFORMATION_SCHEMA` 读取与结构文本渲染 |
| `lib/core/sql.js` | SQL 清洗、语句分类、只读守卫、`LIMIT` 兜底、结构分析 |
| `lib/core/nl.js` | 两阶段接地：选表 → 生成 SQL → 修复 |
| `lib/core/format.js` | 结果表格、摘要、连接信息渲染 |

**这个插件不 import 任何 `@deepseek-ai/*` 包**，只依赖 `mysql2`。工具通过 Cordis 的
`ctx.tools.register` 直接注册原始定义，模型路由从宿主的 `agentDefaultModel` / `llm` 服务读取。

## 命令行与跨 agent 分发

`lib/core/**` 只依赖 `mysql2`，没有任何宿主 API，所以同一份内核除了当 DSH 插件，还可以当
**命令行工具**和 **Agent Skill** 用：

```powershell
node bin/mysql-nl.mjs list                       # 列出连接（不显示密码）
node bin/mysql-nl.mjs schema --db world --brief  # 紧凑表结构
node bin/mysql-nl.mjs query --sql "SELECT 1"     # 只读执行
```

构建成可分发、自带 `mysql2`、解压即用的 skill 包：

```powershell
node scripts/build-skill.mjs --zip   # 产出 .agents/skills/mysql-nl/ 和 dist/mysql-nl-skill.zip
node scripts/build-skill.mjs --check # 校验 skill 包与 lib/core 是否同步（可放进 CI）
```

这份 skill 放在 `<项目>/.agents/skills/` 或 `~/.agents/skills/` 下，DSH 和 OpenCode 都能发现。
**怎么分享给别人、对方怎么装**，见 [SHARING.md](SHARING.md)。

## 开发与测试

```powershell
# 依赖
pnpm install --node-linker=hoisted      # 或 npm install（需要扁平 node_modules）

# 全量测试（必须加 --test-isolation=none：默认的 --test 会为每个文件 spawn 子进程）
node --test-isolation=none --test "test/*.test.mjs"
```

测试需要本机 MySQL；用环境变量指向别的实例（默认 `127.0.0.1:3306`、`root/root`、`world` 库）：

```
DSH_TEST_MYSQL_HOST / DSH_TEST_MYSQL_PORT / DSH_TEST_MYSQL_USER
DSH_TEST_MYSQL_PASSWORD / DSH_TEST_MYSQL_DATABASE
```

测试套件：

| 文件 | 覆盖内容 |
|---|---|
| `test/sql.test.mjs` | 清洗、分类、只读守卫、LIMIT、结构分析（含"注释里带分号""字符串里带 FOR UPDATE"等对抗用例） |
| `test/format.test.mjs` | 表格渲染、单元格转义与截断、摘要、连接信息不泄露密码 |
| `test/config.test.mjs` | 连接文件发现、`${env:}`、各种配置形态与错误 |
| `test/client.test.mjs` / `test/catalog.test.mjs` | **真实 MySQL**：连接池、超时、值归一化、库/表/字段/索引/外键、结构文本 |
| `test/nl.test.mjs` | 两阶段生成、提示词内容、修复路径、异常分支（注入假模型） |
| `test/e2e.test.mjs` | **真实 MySQL 端到端**：配置 → 结构 → 生成 → 执行 → 表格 |
| `test/plugin-integration.test.mjs` | **真实 MySQL + 脚本化 `llm.stream`**：工具层完整链路与返回结构 |
| `test/plugin.test.mjs` | 工具注册、定义形状、配置校验 |
| `test/contract.test.mjs` | 用**宿主自己的 schema 编译器**校验参数/输出 schema（见下） |

`test/_vendor/dsh-json-schema.mjs` 是从当前安装的 DSH 里提取出来的 JSON Schema 子集校验器
（`_vendor/build-oracle.mjs` 负责提取）。它保证工具 schema 的形状错误在测试阶段就被发现——这一检查是
真的有价值的：本插件最早两次安装失败，就是因为把 `parameters`（属性映射）和 `output.schema`
（原始 JSON Schema）两种形态用错了位置。
