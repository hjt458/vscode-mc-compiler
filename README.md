# MC Compiler for VS Code

给 ProgrammableFurnace 的 `.mc` 脚本用的最小 VS Code 扩展：语法高亮、保存即编译、行内诊断、状态栏显示脚本状态。

不重新实现语言，直接复用模组自己的编译器前端（`compiler/lex`、`compiler/syntax`、`compiler/sem`、`base/CompilerAnalyzer`）——它们只依赖 JDK，所以不开游戏也能编译。

## 功能

| 功能 | 说明 |
| --- | --- |
| 语法高亮 | `source.mc`：注释、字符串、`MODULE("名")`、`RunLoop`、类型、函数声明/调用、`tag::xxx`，`+=` `++` 这类非法运算符标红 |
| 诊断 | 打开/保存时编译，把 `S02 if 条件应以 ) 结尾 @ 4:15` 变成 Problems 面板里带行列的错误 |
| 状态栏 | 左下角显示 `$(beaker) MC: 可执行 冶炼` / `编译失败 3 个错误` |
| 命令 | `MC: 编译当前文件`、`MC: 编译全部 .mc`、`MC: 显示编译日志`；`.mc` 文件标题栏有编译按钮 |
| 中文标识符 | `wordPattern` 含 `\u4e00-\u9fa5`，双击选中「燃料」「数量」这类名字是整词 |
| 大纲与跳转 | Outline 面板/面包屑列出 `MODULE` 与所有函数；`F12` / `Ctrl+Click` 跳到声明（同文件优先，再找同目录的其它 `.mc`） |

状态来自模组的 `ContentState`：`EXECUTABLE`（可执行）、`DEPENDENCY`（依赖库）、`FAILED`（编译失败）、`BLANK`（空白）、`READONLY`（只读）。

## 要求

- JDK：`javac` 与 `java` 在 PATH 上（实测 25.0.1），或在设置里指定绝对路径。
- 模组源码：扩展需要找到 `src/main/java/dev/programmablefurnace` 下的编译器前端。
  - 自动发现：`.mc` 文件放在模组工程里时，向上找 12 层即可定位；
  - 否则在设置里写 `mc.sourceRoot`。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `mc.compileOnSave` | `true` | 保存时编译 |
| `mc.sourceRoot` | `""` | 模组的 `src/main/java` 绝对路径；留空则自动发现 |
| `mc.javaBin` | `"java"` | `java` 可执行文件 |
| `mc.javacBin` | `""` | `javac`；留空则取 `javaBin` 同目录，再退回 PATH |

## 安装（不打包 vsix）

```bash
cp -r "D:/Visual Studio Code WorkDir/vscode-mc-compiler" \
      "C:/Users/<你>/.vscode/extensions/hjt458.mc-compiler-0.1.0"
```

然后在 VS Code 里 `Ctrl+Shift+P` → `Developer: Reload Window`。目录名必须是 `<publisher>.<name>-<version>` 的形式，VS Code 才会把它当扩展加载。

## 开发

```bash
node test/smoke.mjs   # 走一遍：定位工程 → 编译前端（按内容哈希缓存）→ 编译样例 → 诊断坏脚本
```

前端只编译一次，产物在 `context.globalStorageUri` 下的 `storage/build/<源码哈希>/`；改了编译器源码哈希就变，自动重建。

## 与 DSH 插件的关系

同一个编译器前端，两个宿主：

- `D:\Visual Studio Code WorkDir\dsh-mc-compiler` —— DeepSeek Harness 插件（侧边栏面板 + `mc_compile` 工具）；
- 本仓库 —— VS Code 扩展（编辑器内高亮 + 诊断）。

两者的 `tools/McCompileCli.java` 是同一份驱动，只负责把 `CompilerAnalyzer.compile(...)` 的结果序列化成 JSON。

## 已知限制

- 只暴露编译器前端能给出的信息：`ContentState` + 编译期诊断；不做「`RunLoop` 是否可能死循环」这类运行时语义检查。
- 跳转与大纲是**词法级**的（`src/symbols.js`：按声明行找 `类型 名(`），不做类型推导；重名的不同作用域函数会跳到第一个声明。
- 编译在扩展宿主进程里串行执行，保存很快时后来的保存会被跳过（日志里会说「上一次编译还没结束」）。
