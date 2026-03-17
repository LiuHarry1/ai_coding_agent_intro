# 02-basic

在 01-basic 基础上新增 **结构化文件工具**。

## 和 01-basic 对比：新增了什么？

```
01-basic/                          02-basic/
  agent.js    ← 一样                 agent.js           ← 一样
  tools.js    ← 只有 bash            tools.js           ← 重新导出
  prompts.js  ← 一样                 prompts.js         ← 一样
                                     tools/
                                       index.js         ← 新：组装所有工具
                                       utils.js         ← 新：共享工具函数
                                       bash.js          ← 提取自 01-basic
                                       read_file.js     ← 新
                                       write_file.js    ← 新
                                       edit_file.js     ← 新
```

## 解决什么问题？

01-basic 只有一个 bash 工具，所有文件操作都要靠模型手写 shell 命令：

```
读文件：  bash → cat -n src/index.js
写文件：  bash → cat > src/config.js << 'EOF' ... EOF
改几行：  bash → sed -i 's/old/new/' src/index.js
搜代码：  bash → grep -rn 'TODO' src/
```

问题：
- 模型要生成 shell 语法（浪费 token）
- 引号嵌套、特殊字符转义容易出错
- 没有统一的错误信息格式

02-basic 为高频操作提供专用工具，模型只需填 JSON 字段：

```
读文件：  read_file  → { "file_path": "src/index.js" }
写文件：  write_file → { "file_path": "src/config.js", "content": "..." }
改几行：  edit_file  → { "file_path": "...", "old_string": "...", "new_string": "..." }
其他：    bash 仍然保留（安装依赖、跑测试、git 等）
```

## 新增工具说明

### read_file — 读文件

| 功能 | 为什么需要 |
|---|---|
| 行号前缀 `  42│code` | 模型能精确引用位置 |
| `offset` / `limit` 参数 | 大文件不用全读，省 token |
| 负数 offset（如 -20） | 从末尾读，看日志/错误很方便 |
| 路径沙箱检查 | 防止读取项目外的文件 |
| 二进制检测 | 不把乱码塞进上下文 |
| 大文件拒绝（>2MB） | 防止撑爆内存 |

### write_file — 写文件（全量）

| 功能 | 为什么需要 |
|---|---|
| 自动创建父目录 | 不用先 `mkdir -p` |
| 区分 Created / Overwrote | 模型知道自己做了什么 |
| 内容不变检测 | 避免无意义写入 |
| 路径沙箱检查 | 防止写到项目外 |

### edit_file — 编辑文件（局部替换）

为什么不用 write_file 改几行？改 500 行文件里的 2 行，write_file 要重新输出 498 行没变的代码——浪费 token 且容易丢行。

| 功能 | 为什么需要 |
|---|---|
| `old_string` → `new_string` 替换 | 用内容定位，比行号更可靠 |
| 唯一性检查 | 多个匹配时报错，防止改错地方 |
| `replace_all` 选项 | 批量重命名变量 |
| 模糊匹配（缩进容差） | 模型缩进写错了也能匹配上 |

### 工具文件拆分

01-basic 所有逻辑在一个 `tools.js`（103 行）。02-basic 拆成每个工具一个文件：

```
tools/
  index.js    ← 组装点：导入所有工具，导出 createTools(cwd)
  utils.js    ← 共享函数：truncate（截断输出）、resolvePath（路径解析+沙箱）
  bash.js     ← bash 工具
  read_file.js
  write_file.js
  edit_file.js
```

好处：加新工具只需创建文件 + 在 index.js 加一行 import。

## 启动

```bash
node start.js 02-basic
```
