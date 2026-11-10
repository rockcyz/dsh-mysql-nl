# 多业务领域架构说明（以教务管理为例）

> 这份文档回答一个问题：**一个 MySQL 里有多套完全不同的业务，怎么让 agent 每次都查得准？**
> 结论是三层架构。下面全部基于你已经有的 `jwgl` 库真实数据，可以逐条复核。

---

## 一、先说结论：分批的不是"表结构"，是"业务语义"

你最初的想法是"写多个 skill 描述业务逻辑"。方向对，但有个关键区别要先掰开：

| 知识类型 | 例子 | 谁负责 | 为什么 |
|---|---|---|---|
| **结构事实** | `student` 表有 `Sno/Sname/Ssex/Sage/Sdept` | **插件实时读** | 会变。写进 skill 就会腐烂 |
| **业务语义** | 系名存的是「计算机」不是 `CS`；`Cpno` 是字符串 | **领域 skill** | 数据库里**根本没有这个信息**，模型只能猜 |

插件已经把"模型不知道有哪些表"解决了。真正会出错的是**业务语义**——这一类东西
`INFORMATION_SCHEMA` 查不到，只能人写下来。

所以领域 skill 不是"表结构说明书"，是**语义层**。

---

## 二、三层架构长什么样

```
┌─────────────────────────────────────────────────────────────┐
│ 第 3 层  路由（本次没做，领域 >3 个才需要）                       │
│          由 skill 的 description 互斥词承担选择                  │
├─────────────────────────────────────────────────────────────┤
│ 第 2 层  领域 skill ×N        ← 本次新增                        │
│          .agents/skills/jwgl-education/                       │
│            SKILL.md      3877 字符，agent 一进来就加载           │
│            semantic.json  按需读取：口径/字典/陷阱/示例           │
│          职责：业务词汇、口径、关联路径、垃圾表清单                │
│          不含代码                                             │
├─────────────────────────────────────────────────────────────┤
│ 第 1 层  内核（已有）            ← 这次只加了 verify 子命令        │
│          .agents/skills/mysql-nl/                             │
│            bin/mysql-nl.mjs   命令行（唯一一份）                │
│            lib/core/*         连接/真实schema/只读守卫/教学输出   │
│          职责：连接管理、结构接地、安全执行、教学四段输出           │
└─────────────────────────────────────────────────────────────┘
```

**关键约束：第 1 层永远只有一份。** 领域 skill 里没有任何代码，它调用的是同一个 CLI。
如果每个领域各自复制一份 `bin/` + `lib/core/`，你就会有 N 份互相同步的只读守卫代码 ——
这正是这套架构要避免的漂移。

---

## 三、教务领域里到底写了什么

`semantic.json` 里 8 类内容，全部用你的真实数据核实过：

### 3.1 库里有三张垃圾表（最重要的一条）

```
jwgl.city             4079 行  ≡ world.city
jwgl.country           239 行  ≡ world.country
jwgl.countrylanguage   984 行  ≡ world.countrylanguage
```

已用行数比对确认**与 world 库完全一致**。它们是历史遗留副本，和教务毫无关系。

危险之处：`schema` 命令会**正常列出它们、不带任何警告**。agent 看到 `jwgl.country`
会以为这是"学生国籍"，写出完全成立的 SQL、返回完全无意义的数据：

```sql
-- 这条 SQL 语法完全正确、能跑通，但业务上是胡说
SELECT c.Name FROM jwgl.country c LIMIT 3;   -- → Aruba | Afghanistan | Angola
```

**MySQL 不会拦你，只有语义层会。** 所以 `forbidden` 列表是第一优先级内容。

### 3.2 八个会静默咬人的陷阱

| # | 陷阱 | 错误写法 | 正确写法 |
|---|---|---|---|
| 1 | 三张 world 副本表 | 用 `jwgl.country` | 只用 `student/course/sc` |
| 2 | 系名是中文 | `Sdept='CS'` → **0 行** | `Sdept='计算机'` → 3 |
| 3 | 性别是中文 | `Ssex='M'` → **0 行** | `Ssex='男'` → 4 |
| 4 | 姓名会重名 | 用 `Sname` 关联/去重 | 一律用 `Sno` |
| 5 | `Sno` 是整数 | 当字符串处理 | 数值比较 |
| 6 | `Cpno` 是 varchar，`Cno` 是 int | `ON p.Cno=c.Cpno` | `ON p.Cno=CAST(c.Cpno AS UNSIGNED)` |
| 7 | `Grade` 可为 NULL | 及格率用 `COUNT(*)` 做分母 | 用 `COUNT(Grade)` |
| 8 | 学生总数 ≠ 选课人数 | `COUNT(*) FROM student` → 7 | `COUNT(DISTINCT s.Sno)` → 5 |

第 4 条的证据：「葛波」在库里有两个不同的人，`Sno` 分别是 `2000014` 和 `2000020`。
第 8 条的证据：7 个学生里「张三」`2000015` 和另一个「葛波」`2000020` 一门课都没选。

### 3.3 口径：8 个指标，含"约定"明确的标注

```json
{ "name": "及格率",
  "sql": "ROUND(SUM(CASE WHEN sc.Grade>=60 THEN 1 ELSE 0 END)/NULLIF(COUNT(sc.Grade),0)*100,1)",
  "note": "分母必须是 COUNT(sc.Grade)，用 COUNT(*) 会把未录成绩的算进分母" }
```

有一条特别值得看 —— **绩点**：

```json
{ "name": "课程绩点",
  "sql": "CASE WHEN sc.Grade >= 60 THEN (sc.Grade - 50) / 10 ELSE 0 END",
  "note": "**本库没有绩点字段，这是本领域约定的换算口径**，不是数据库里的事实" }
```

`jwgl` 里**没有绩点字段**。任何算出绩点的 SQL，其换算规则都是人约定的。
所以语义层明确标注"这是约定不是事实"，agent 会据此提示学生「如果学校换算规则不同要改」——
而不是把 3.90 当成数据库里查出来的客观事实。

### 3.4 其余内容

- **实体映射** 3 条（学生/课程/选课记录，含主键）
- **关联路径** 3 条，每条带一条 `verifySql` 证明它能跑
- **字典** 4 项（性别、系名、`Cpno` 的 NULL 含义、成绩的及格线/满分）
- **示例** 6 条"问题 → 已验证 SQL → 期望结果"

---

## 四、三个机制保证它不会腐烂

### 4.1 `verify`：把"skill 过期"变成构建失败

```bash
node bin/mysql-nl.mjs verify --semantic domains/jwgl/semantic.json
```

实际输出（全绿，退出码 0）：

```
领域：教务管理    库：jwgl · 连接：local    已读取真实结构：6 张表

【表与列】     ✓ 表 student（7 行）  ✓ 列 student.Sno int  …（共 15 项）
【禁用表】     ✓ city / country / countrylanguage 存在且已标记禁止
【指标引用】   ✓ 8 个指标引用的列全部存在
【关联路径】   ✓ 3 条关联都可执行（含 CAST 自连接）
【禁用表未被引用】 ✓ 语义层内部没有引用垃圾表
【示例可执行】 ✓ 6/6 → 计算机系 3 人 / 数据库原理平均分 84.00 / …

结果：6/6 个示例可执行，失败 0 项，警告 0 项
```

它检查：库是否存在 → 表是否存在 → **列是否存在** → **列类型是否变了** →
禁用表是否还在 → 指标引用的列是否还在 → 关联 SQL 能否执行 → **示例能否执行**。

示例直接用真实 SQL 跑 `LIMIT 1`，所以标识符解析由 **MySQL 自己**验证，
而不是我手写一个脆弱的 SQL 解析器。

### 4.2 它真的能抓到漂移（实测）

我故意造了一份"旧版"语义文件（列改名 + 类型改了 + 引用了垃圾表），`verify` 报出 4 个错误：

```
✗ 列 sc.teacher_id 不存在（现有：Sno, Cno, Grade）
✗ 列 sc.Grade 类型不符：语义层写 varchar(10)，实际 int
✗ 指标「学生国籍分布」 引用了禁用表 country
✗ 示例「各国学生人数」 引用了禁用表 country

结果：1/1 个示例可执行，失败 4 项        ← 退出码 1
```

注意最后两行并列出现这个现象：**示例执行成功了，但仍被判违规**。
这正是语义层的价值 —— MySQL 认为它合法，业务上它是错的。

这个命令可以直接进 CI：`npm run verify:domain`，失败即中断。

### 4.3 构建脚本守住格式红线

```bash
node scripts/build-domains.mjs
# ✓ jwgl-education（3877 字符 · 3 表 · 8 口径 · 6 示例） — 更新 2 个文件
```

它强制校验三件容易让 skill **静默消失**的事：

1. `SKILL.md` frontmatter 的 `name` 必须等于目录名，且是 kebab-case
2. `SKILL.md` 不得超过 **8192 字符**（DSH 会裁剪超出部分）
3. `semantic.json` 必须是合法 JSON（**含 BOM 容忍**）

第 3 条是实测踩出来的：Windows 的 PowerShell 5.1 `Set-Content -Encoding UTF8` 会写 BOM，
`JSON.parse` 直接报 `Unexpected token`。已复用内核里连接文件那套 `stripByteOrderMark`。

---

## 五、有 skill 和没 skill，差别有多大（真实实测）

用同一个库、同一个 CLI，只换"有没有语义层"：

| 问题 | 无 skill（模型会写的 SQL） | 结果 | 有 skill | 结果 |
|---|---|---|---|---|
| 计算机系有多少学生 | `WHERE Sdept='CS'` | **0** ❌ | `WHERE Sdept='计算机'` | **3** ✅ |
| 男生有多少 | `WHERE Ssex='M'` | **0** ❌ | `WHERE Ssex='男'` | **4** ✅ |
| 有多少学生选了课 | `COUNT(*) FROM student` | **7** ❌ | `COUNT(DISTINCT s.Sno)` | **5** ✅ |
| 学生国籍分布 | `FROM jwgl.country` | 能跑，但没意义 ❌ | 语义层直接禁止 | ✅ |

前两行是**最危险的一类错误**：SQL 语法完全正确、执行成功、不报错，返回 `0`。
学生看到一个"0"会以为真的没人，而实际上是被静默误导。

后两行是 skill 才能提供的东西 —— 约定口径（绩点 / 加权平均绩点 / 已获得学分），
这些在数据库里根本不存在：

```
| 学号    | 姓名   | 加权平均绩点 | 已获得学分 |
| 2000113 | 张大民 | 3.90        | 6          |
| 2000014 | 葛波   | 3.86        | 14         |
| 2000012 | 王林   | 2.73        | 18         |
```

---

## 六、怎么加第二个领域（照这个抄）

假设要加 `bank`（银行）领域：

```bash
# 1. 建目录
mkdir dsh-mysql-nl/domains/bank

# 2. 照抄一份 semantic.json，改这些字段
#    domain / title / database / entities / tables / forbidden / joins
#    dictionary / metrics / traps / examples
#    ★ 重点：forbidden 和 traps 是价值所在，不要留空

# 3. 照抄一份 SKILL.md，改 name/description/scope/铁律
#    ★ description 必须写互斥触发词：银行、账户、交易、转账、bank
#    ★ 不要把 mysql-nl 的文档整段复制进来，只要「找到 CLI + 三条命令」

# 4. 校验 + 构建
node dsh-mysql-nl/bin/mysql-nl.mjs verify --semantic dsh-mysql-nl/domains/bank/semantic.json
node dsh-mysql-nl/scripts/build-domains.mjs

# 5. 确认 agent 能发现（无需重启）
#    在对话里问一个银行域的问题，看它是否加载 bank 域 skill
```

**领域划分按业务，不按 schema。** 一个领域可以跨多个库（教务可能横跨 `jwgl` 和
`student_management`），一个库里也可能混多个领域（`jwgl` 就混了 world 副本）。

### 什么时候该改结构（重要）

| 领域数 | 推荐形态 | 理由 |
|---|---|---|
| 1–3 | **每个领域一个 skill**（现在这样） | 互斥明显、各自独立演进 |
| 4–6 | 合并成**一个 skill + `references/<领域>.md`** | 目录里只留一个技能，**彻底消除选错风险** |
| 7+ | 单 skill + 路由表 + 分类目录 | 平铺 skill 的选错率会明显上升 |

原因：DSH / OpenCode 给 agent 看的技能列表**只有 name + description**。
5 个 skill 都自称"查数据库"时，agent 只能靠描述猜，会选错、漏选、或同时加载两个互相污染。
到那时应该改成单入口 + 按需读 reference。

---

## 七、现在的工作流（三件事，别漏）

```bash
# 日常：改完 domains/ 之后
node dsh-mysql-nl/scripts/build-domains.mjs        # 同步到 .agents/skills/
node dsh-mysql-nl/bin/mysql-nl.mjs verify --semantic dsh-mysql-nl/domains/jwgl/semantic.json
node dsh-mysql-nl/scripts/build-domains.mjs --check # CI 用，不同步就退出 1
```

**数据库结构变了怎么办？** 先跑 `verify`，它会告诉你哪条语义已经过期；
改 `semantic.json` 直到全绿。不要跳过这一步 —— 跳过就意味着 agent 会拿着过期的说明写 SQL，
而且它不会报错。

---

## 八、这套方案的边界（说清楚，免得踩坑）

**能解决的：**
- 业务词汇歧义（「系」= `Sdept` 且值是中文）
- 口径不一致（及格率的分母、学分算不算不及格的）
- 垃圾表误用（world 副本）
- 关联路径错误（`Cpno` 的类型陷阱、自连接）
- 无法验证的约定（绩点换算 —— 明确标注是"约定"）
- 语义层随库漂移（`verify`）

**不能解决的：**
- **不能保证模型一定遵守**。语义层是强约束的文档 + 校验工具，不是编译器级的强制。
  agent 仍可能忽略它。缓解办法是把最强硬的规则放进 SKILL.md 的「铁律」段，
  并让 `verify` 覆盖示例 —— 但这仍是概率问题，不是确定性保证。
- **不能替代复杂 ETL 口径**。如果业务口径涉及多表窗口函数、时区、币种换算，
  光靠 `sql` 片段表达不了，要写完整的视图或存储过程。
- **没有做的**：第 3 层路由（领域 ≤3 个时不需要）；跨领域联合查询（那需要路由层仲裁）。

---

## 九、文件清单

```
dsh-mysql-nl/
├── bin/mysql-nl.mjs                    ← 新增 verify 子命令
├── domains/
│   └── jwgl/
│       ├── SKILL.md                    ← 3877 字符（上限 8192）
│       └── semantic.json               ← 3 表 / 8 口径 / 3 关联 / 8 陷阱 / 6 示例
├── scripts/build-domains.mjs           ← 新增：构建 + 格式校验
└── DOMAINS.zh.md                       ← 本文档

.agents/skills/
├── mysql-nl/                           ← 第 1 层（已有）
└── jwgl-education/                     ← 第 2 层（本次生成，agent 已能发现）
    ├── SKILL.md
    └── semantic.json
```

`jwgl-education` 已经出现在当前会话的技能目录里（构建后自动发现，无需重启）。
