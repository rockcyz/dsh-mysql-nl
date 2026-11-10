---
name: jwgl-education
description: 教务管理域查询（jwgl 库）：学生、课程、选课、成绩、学分、绩点、班级、系部。当问题涉及学生名单、某系人数、课程选课人数、考试成绩、平均分、及格率、学分、绩点、先行课时使用。只查 jwgl 库，不处理城市/国家/影片/银行等其它业务。
license: MIT
compatibility: 需要 Node.js >= 20 与 mysql-nl 技能（命令行底座）；只读执行
---

# 教务管理域（jwgl 库）

本技能是**业务语义层**：它不描述表结构（那由 `schema` 实时读），它记录
**模型猜不到的业务事实**——哪些表是垃圾、系名存的是中文、口径怎么算、哪些关联会踩坑。

## 底座：命令怎么来

需要一个命令行工具。按下表找到它（本技能与 `mysql-nl` 技能共用同一个 CLI）：

```bash
# bash
MYSQL_NL=$(ls .agents/skills/mysql-nl/bin/mysql-nl.mjs \
              ~/.agents/skills/mysql-nl/bin/mysql-nl.mjs 2>/dev/null | head -1)
```

```powershell
# PowerShell
$MYSQL_NL = @("$PWD/.agents/skills/mysql-nl/bin/mysql-nl.mjs",
              "$HOME/.agents/skills/mysql-nl/bin/mysql-nl.mjs") |
            Where-Object { Test-Path $_ } | Select-Object -First 1
```

只用三条命令：`schema`（读真实结构）、`query`（执行只读语句）、`dbs`（列库）。
`query` 会自动做语句分级、加 LIMIT、加超时，并输出**执行步骤 / SQL / 语句讲解 / 结果**四段。
遇到改数据的请求（增删改、建表改表），`query` **不会执行**，而是给出语句、讲解和交接指引——
把它们转述给学生，让他复制到 DBeaver / Workbench 自己运行，并说明插件没有动数据。

## 作用域（第一件事）

- **库**：`jwgl`
- **连接**：配置里的默认连接（如有多个，用 `--connection <id>`）
- 所有语句都写全限定名 `jwgl.<表>`，避免落到连接默认库上

```bash
node "$MYSQL_NL" dbs                      # 确认 jwgl 存在
node "$MYSQL_NL" schema --db jwgl --brief  # 看这个库有哪些表
```

## 铁律（违反就会出静默错误）

### 1. 只碰三张表，其余全是垃圾

| 可用 | 含义 |
|---|---|
| `jwgl.student` | 学生表 |
| `jwgl.course` | 课程表 |
| `jwgl.sc` | 学生选课表（成绩在这） |

**`jwgl.city` / `jwgl.country` / `jwgl.countrylanguage` 是 world 示例库的副本**
（行数、内容与 `world` 完全一致），与教务毫无关系。`schema` 命令会把它们正常列出来、
不带任何警告 —— 这是本领域最容易被模型误用的地方。**任何教务问题都不要引用这三张表。**

### 2. 系名和性别存的是中文

```sql
-- ❌ 静默返回 0 行，不报错
WHERE Sdept = 'CS'      WHERE Ssex = 'M'
-- ✅
WHERE Sdept = '计算机'   WHERE Ssex = '男'
```

当前系名只有 `计算机`、`会计`、`管理`；性别只有 `男`、`女`。
不要硬编码枚举判断，新增系会直接出现新值。

### 3. 姓名不是标识符；重名必须先消歧

`Sname` **不唯一**：本库里有两位学生同名（示例记作「某重名学生」，学号以 `Sno-A`、`Sno-B` 代指，
实际值请跑下面的消歧 SQL 现查）。

凡是要**认定身份**的场合，一律用 `Sno`：

| 场合 | 用什么 |
|---|---|
| `WHERE` 筛选 | `Sno` |
| `JOIN ON` | `Sno` |
| `GROUP BY` / `DISTINCT` | `Sno` |
| 结果展示 | `Sno` **必须带上**，否则两行同名学生用户分不清 |

**用户用姓名提问时必须先消歧**，不要自己挑一个：

```sql
-- 先查候选（这一步只读，安全）；把 ? 换成用户问的姓名
SELECT Sno, Sname, Sdept FROM jwgl.student WHERE Sname = '?';
```

命中多行 → 停下来把候选列给用户，等确认后再用 `Sno` 查：

```
「某某」在库里有 2 位，你查哪一位？
1. <Sno-A>（计算机系）
2. <Sno-B>（会计系）
```

命中 0 行 → 可能是记错或错别字，先 `LIKE '%…%'` 找近似值让用户确认，**不要直接回答"查无此人"**。
用户明确说「两个人一起查」时才返回多行，且每行都要带学号。

同理适用于所有**非唯一**的文本列：`Sdept` 只有几个值（不能当身份）、`Cname` 课程名可能重复。
真正唯一的只有 `student.Sno`、`course.Cno`、`sc.(Sno,Cno)`。

### 4. 学号 `Sno` 是整数（int），不是字符串

按数值比较。当前是 7 位纯数字无前导零；若将来学校改用带前导零的学号，列类型必须改，
否则前导零会丢。

### 5. 先行课 `Cpno` 是 varchar，而 `Cno` 是 int

```sql
-- ❌ 能跑，但依赖隐式类型转换，大表上索引失效
JOIN jwgl.course p ON p.Cno = c.Cpno
-- ✅
JOIN jwgl.course p ON p.Cno = CAST(c.Cpno AS UNSIGNED)
```

`Cpno` 为 `NULL` 表示没有先行课。**它没有外键约束**，可能指向不存在的课号，
统计先行关系时用 `LEFT JOIN` 而不是 `JOIN`，否则会静默丢行。

### 6. `Grade` 可以为 `NULL`（已选课未录成绩）

当前 11 条记录恰好都有成绩，但列允许 `NULL`。统计口径必须区分：

- 平均分：`AVG(Grade)` —— 自动忽略 NULL，分母是「有成绩的记录数」
- 及格率：分母用 `COUNT(Grade)`，**不要用 `COUNT(*)`**

### 7. 「学生总数」≠「选课人数」

7 个学生里有 2 个一门课都没选（用 `SELECT s.Sno FROM student s LEFT JOIN sc ON sc.Sno=s.Sno WHERE sc.Sno IS NULL` 现查）。
要「选过课的学生数」请用 `COUNT(DISTINCT sc.Sno)`，或先 JOIN。

## 实体与关联（已验证）

```
student.Sno ──< sc.Sno      多对一：一次选课属于一个学生（有外键）
course.Cno  ──< sc.Cno      多对一：一次选课属于一门课（有外键）
course.Cpno ──> course.Cno  自连接：课程的先行课（无外键，需 CAST）
sc 主键 = (Sno, Cno)        复合主键，不存在重复选课，不需要 DISTINCT
```

## 口径（本领域的「精准」来源）

完整定义（含 SQL 片段、注意事项、陷阱清单、已验证示例）在：

**`semantic.json`**（与本 SKILL.md 同目录）

调用任何统计前**先读它**，特别是这几个容易算错的：

| 说法 | 口径要点 |
|---|---|
| 平均分 | `ROUND(AVG(sc.Grade), 2)`，只按已录成绩算 |
| 及格率 | 分子 `Grade>=60`，**分母 `COUNT(Grade)`** |
| 学分 | 「选中学分」与「已获得学分」是两个口径，先确认 |
| 绩点 | **本库没有绩点字段**，是约定换算：`≥60 时 (Grade-50)/10`，<60 记 0 |
| 加权平均绩点 | 按学分加权，分母是选中学分 |

> 绩点那条尤其重要：它是**约定**不是数据库事实。如果学校用的换算规则不同，
> 必须先问用户，不能默默套用。

## 工作流

1. `dbs` / `schema --db jwgl --brief` 确认库和表还在（结构可能变）
2. 读 `semantic.json` 找相关口径与陷阱
3. 需要字段细节时 `schema --db jwgl --tables student,course,sc`
4. **消歧**：用户用姓名/课程名等非唯一值提问时，先查候选（见铁律 3），
   多行就停下来问用户，0 行就先 `LIKE` 找近似值。**不要自己挑一个就往下走**
5. **自己写 SQL**，只用 `student` / `course` / `sc`，身份条件用 `Sno` / `Cno`
6. `query --sql "..."` 执行
7. 报错就读错误、必要时重查 schema、改完再跑，不要重试同一句

## 输出格式（硬性，教学工具）

这是给计算机专业学生用的。**只报数字不合格。** 每次查询必须按四段输出：

1. **执行步骤** —— `query` 的 stdout 已给出，原样保留
2. **SQL 语句** —— 原样保留
3. **语句讲解** —— 保留命令给出的逐子句说明，**再补一两句业务语义**：
   为什么这样 JOIN、这个口径对应学校哪条规则、踩了哪个陷阱
4. **查询结果** —— 原样保留表格

额外要求：

- 涉及业务规则时，明确说清「这是库里的事实」还是「这是本域约定的口径」（比如绩点换算）
- 学生写错方向的 SQL（如 `Sdept='CS'`）是好的教学素材，要指出**为什么返回 0 行**
- 命令输出的「教学提示」必须转述

## 不要做的事

- 不要查 `city` / `country` / `countrylanguage`
- 不要用 `Sname` 关联或去重
- 不要用英文字段值（`'CS'` / `'M'`）
- 不要凭记忆写列名，`Sno/Sname/Ssex/Sage/Sdept`、`Cno/Cname/Cpno/Ccredit`、
  `Sno/Cno/Grade` —— 拿不准就 `schema`
- 不要把「已获得学分」和「选中学分」混用
- 不要为了「更准」而加 `DISTINCT`：`sc` 是复合主键，本来就不重复
