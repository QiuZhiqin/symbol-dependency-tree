# C/C++ Symbol Reference Tree

一个在 VS Code 底部面板中以 Source Insight 风格横向关系图展示 C/C++ 上级调用和符号引用关系的扩展。每次查询都会在底部视图内部创建独立标签，标签标题就是完整目标符号名。

## 功能

- 调用查询只读取插件自己的持久化调用数据库，不调用 VS Code Call Hierarchy、References 或工作区全文搜索。
- 工作区启动后自动加载已有数据库；没有数据库时才在后台建立新索引。
- 保存源码后增量更新单个文件，也可运行 **Rebuild C/C++ Call Index** 强制重建。
- VS Code 最底部的原生状态栏常驻显示索引状态和构建百分比；鼠标悬停可查看文件数、函数数、引用数及详细进度，点击状态栏项可重建索引。
- 节点按需加载并从左向右展开多级上级调用。
- 关系图固定以 100% 比例显示，支持拖拽和滚轮平移。
- 每个节点只显示完整函数名，并按实际内容自适应方框宽高；不显示参数、符号类型、目录、文件名或默认行号。
- 同一调用者存在多个调用位置时显示可点击行号。
- 单击调用者函数名跳转到它调用父节点函数的位置；双击节点跳转到函数定义。
- 数据库保存精确调用偏移，文件内 `static` 函数按定义文件约束。
- 除 `target()` 直接调用外，也索引 `INIT_WORK(..., target)`、`register_callback(target)`、`&target` 和函数指针赋值。
- 枚举值、对象式宏以及函数体内的其他标识符也保存为精确引用，可按所在函数生成上级关系。
- 局部变量按声明、代码块、函数和文件限定作用域；同名成员按 `.`、`->`、`::` 接收者或成员函数所属类型分别索引。
- 查询另一个符号时在底部视图中新建同名标签，原有关系图、展开状态和平移位置保持不变。

## 使用

1. 在 VS Code 中打开 C/C++ 工作区。
2. 插件会在后台加载已有索引；首次使用或没有数据库时会自动建库。
3. 把光标放在目标函数或符号名上，从编辑器右键菜单选择 **Generate Symbol Reference Tree**。
4. 可在 VS Code 最底部查看索引工作情况，悬停查看详情，点击该状态栏项重建索引；在目标符号标签中使用 `+` 逐层展开调用者。

## 命令

| 命令 | 作用 |
| --- | --- |
| `symbolDependencyTree.show` | 从活动编辑器和光标生成调用树 |
| `symbolDependencyTree.refresh` | 清除查询缓存并从原位置重新查询 |
| `symbolDependencyTree.clear` | 关闭当前关系图标签 |
| `symbolDependencyTree.collapseAll` | 折叠全部节点 |
| `symbolDependencyTree.rebuildIndex` | 强制重建持久化 C/C++ 调用数据库 |

## 配置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `symbolDependencyTree.persistentIndex.fileExtensions` | 常见 C/C++ 扩展名 | 调用数据库包含的文件扩展名 |

数据库默认保存在第一个 VS Code 工作区文件夹中：

```text
.symbol-dependency-tree/call-index-<工作区哈希>.json
```

同时打开多个文件夹时，数据库仍放在工作区列表的第一个文件夹中，但文件名哈希包含全部工作区文件夹，避免不同组合互相覆盖。没有打开工作区文件夹时才回退到 VS Code 扩展全局存储。升级后首次使用会把兼容的旧全局索引复制到新位置，但不会自动删除旧文件。

建议在源码仓库的 `.gitignore` 中加入：

```gitignore
.symbol-dependency-tree/
```

数据库不依赖 CodeGraph。

## 开发与验证

```bash
npm install
npm run check
npm run test:integration
npm run package
```

可以通过 `TEST_WORKSPACE_PATH` 让集成测试在真实源码工作区运行。例如，Windows PowerShell：

```powershell
$env:TEST_WORKSPACE_PATH = 'D:\code\linux-5.10.220\net'
npm run test:integration
```

## 已知边界

- 数据库使用轻量级 C/C++ 词法扫描器，不是完整 Clang AST。
- 宏和枚举按源码中的精确标识符建立引用，不执行预处理器展开。
- 编译条件、复杂宏展开、标识符拼接、跨函数传递的函数指针、模板实例化和动态分派可能漏报。
- 成员所属类型通过源码中的声明和接收者表达式推断；复杂模板、链式临时对象和宏生成的声明可能无法确定所属类型。
- 跨文件同名全局函数和 C++ 重载目前按函数名合并；文件内 `static` 函数可精确区分。
