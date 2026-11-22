# MC Compiler for VS Code

[![CI](https://github.com/hjt458/vscode-mc-compiler/actions/workflows/ci.yml/badge.svg)](https://github.com/hjt458/vscode-mc-compiler/actions/workflows/ci.yml)

给 ProgrammableFurnace 的 `.mc` 脚本用的最小 VS Code 扩展：语法高亮、保存即编译、行内诊断、状态栏显示脚本状态。

不重新实现语言，直接复用模组自己的编译器前端（`compiler/lex`、`compiler/syntax`、`compiler/sem`、`base/CompilerAnalyzer`），并把它**预编译成 93 KB 的 jar 放进扩展里**——装好即用，既不需要模组工程，也不需要 JDK。

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

- **JRE 17+**：`java` 在 PATH 上，或在 `mc.javaBin` 里写绝对路径。jar 用 `--release 17` 编的，17 及以上都能跑。
- **模组源码不需要了**：编译器已经内置。只有两种情况会回头用源码：内置 jar 被删、或你要从自己的 checkout 重新生成 jar（见下节）。

## 编译器从哪来

```
compiler/mc-compiler.jar     ← 前端 21 个类 + McCompileCli，预编译（--release 17）
compiler/PROVENANCE.md       ← 来源项目、commit、javac 版本、22 个文件清单、SHA-256
compiler/provenance.json     ← 同一份出处的机器可读版（扩展用它做版本一致性检查）
```

扩展启动编译时按这个顺序找 classpath（`src/compiler.js` 的 `resolveClasspath`）：

1. `mc.compilerJar` 指定的 jar；
2. 内置的 `compiler/mc-compiler.jar`；
3. 都没有时，才用 `mc.sourceRoot`（或从 `.mc` 向上自动发现）的源码现场 `javac` 编译，产物缓存在全局存储里。

升级编译器（模组改了前端之后）：

```bash
node tools/build-compiler.mjs                       # 默认读 D:/MODS/ProgrammableFurnace
node tools/build-compiler.mjs --source-root <path>  # 任意 checkout 的 src/main/java
```

脚本会用 `--release 17` 重编、覆盖 jar，并重写 `PROVENANCE.md`（commit / 版本 / 哈希），所以出处不会和二进制脱节。

## 编译器出处与版本一致性

内置 jar 不是「一份不知道哪来的二进制」：`compiler/provenance.json` 记着它的来源 commit、构建时间、javac 版本与 SHA-256，`tools/build-compiler.mjs` 每次重建都会一起刷新。

工作时扩展会比对这个 commit 与脚本所在工程（向上找到的 git 检出）的 `HEAD`：

| 判定 | 含义 | 表现 |
| --- | --- | --- |
| `match` | jar 就是 HEAD 构建的 | 状态栏不变 |
| `stale` | jar 的 commit 是 HEAD 的祖先，即 jar 旧了 | 状态栏加「· 编译器旧于 HEAD」+ 一次警告 |
| `diverged` | 两边不同源（换分支 / rebase / 用了别人的 jar） | 状态栏加「· 编译器与 HEAD 分叉」+ 一次警告 |
| `unknown` | 没有 git、没有 provenance、或 git 拒绝回答 | 静默，不打扰 |

警告里的「查看出处」会打开 `PROVENANCE.md`；`MC: 查看编译器出处` 命令随时可以打开它。检查结果同时写进 MC Compiler 输出面板，结果是按工程根缓存的（30 秒），不会每次保存都跑 git。

不想被提醒就把 `mc.checkCompilerVersion` 关掉——但那样编辑器诊断与游戏内行为可能出现「编辑器说没事、进游戏却报错」的错位。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `mc.compileOnSave` | `true` | 保存时编译 |
| `mc.compilerJar` | `""` | 自定义编译器 jar；留空用内置的 |
| `mc.sourceRoot` | `""` | 仅在内置 jar 不可用时从源码现编：模组 `src/main/java`；留空自动发现 |
| `mc.checkCompilerVersion` | `true` | 比较内置编译器的构建提交与工程 HEAD，不一致时提示 |
| `mc.javaBin` | `"java"` | `java` 可执行文件 |
| `mc.javacBin` | `""` | 仅源码现编时用到；留空取 `javaBin` 同目录，再退回 PATH |

## 安装（不打包 vsix）

```bash
cp -r "D:/Visual Studio Code WorkDir/vscode-mc-compiler" \
      "C:/Users/<你>/.vscode/extensions/hjt458.mc-compiler-0.1.0"
```

然后在 VS Code 里 `Ctrl+Shift+P` → `Developer: Reload Window`。目录名必须是 `<publisher>.<name>-<version>` 的形式，VS Code 才会把它当扩展加载。

## 终端命令 mc-compile

不想开编辑器也能编译，同一条流水线（同一个内置 jar）：

```bash
mc-compile furnace_smelting.mc                       # 一个文件
mc-compile --all src/main/resources/.../scripts      # 目录下所有 .mc（递归）
mc-compile --json *.mc > report.json                 # 原始 JSON，给脚本用
mc-compile --source-root <mod>/src/main/java a.mc    # 用源码现编而不是内置 jar
```

输出与退出码：

```
可执行  furnace_smelting.mc  (冶炼)
```

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部通过（`EXECUTABLE` / `READONLY` / `DEPENDENCY` / `BLANK`） |
| `1` | 至少一个文件 `FAILED`，诊断逐行打印 |
| `2` | 参数错、文件不存在、找不到编译器 |

所以可以直接进 `&&` 链或 CI：`mc-compile --all scripts || exit 1`。

命令装在哪：`package.json` 里声明了 `bin.mc-compile`，`npm link` 或用下面三个转发脚本（已在 PATH 的 `%APPDATA%\npm`）：

- `mc-compile.cmd`（cmd / PowerShell）
- `mc-compile.ps1`（PowerShell 显式调用）
- `mc-compile`（Git Bash / MSYS）

三个文件都只是转发到 `bin/mc-compile.cjs`。仓库搬家后把它们里的路径改一下，或者删掉重新 `npm link`。

## 开发

```bash
npm test              # 全部：自包含测试 + 扩展 harness + 本机模组工程检查
npm run test:ci       # CI 用：只用 Node + JRE + 内置 jar
node test/smoke.mjs            # 编译、诊断、符号表、内置 jar、CLI 退出码
node test/vscode-harness.cjs   # stub 掉 vscode，驱动真实 provider
node test/local.mjs            # 需要 D:/MODS/ProgrammableFurnace：路径发现、javac 现编、真实脚本、漂移判词
```

`smoke.mjs` 与 `vscode-harness.cjs` 只依赖仓库里的 `test/fixtures/*.mc` 和 `compiler/mc-compiler.jar`，**不需要模组工程、不需要 JDK、不需要 git**，所以 GitHub Actions 的干净机器能直接跑（`.github/workflows/ci.yml`）。`local.mjs` 找不到模组工程时会打印 `local: skipped` 并以 0 退出，CI 上也照跑，用来证明跳过路径没问题。

`smoke.mjs` 里最后一组用例只给 jar、不给 `sourceRoot`，证明扩展在完全没有模组工程的机器上也能编译。

前端源码只在第 3 种情况（jar 缺失）下才现编，产物在 `context.globalStorageUri` 下的 `storage/build/<源码哈希>/`；改了编译器源码哈希就变，自动重建。

## 与 DSH 插件的关系

同一个编译器前端，两个宿主：

- `D:\Visual Studio Code WorkDir\dsh-mc-compiler` —— DeepSeek Harness 插件（侧边栏面板 + `mc_compile` 工具）；
- 本仓库 —— VS Code 扩展（编辑器内高亮 + 诊断）。

两者的 `tools/McCompileCli.java` 是同一份驱动，只负责把 `CompilerAnalyzer.compile(...)` 的结果序列化成 JSON。

## 已知限制

- 只暴露编译器前端能给出的信息：`ContentState` + 编译期诊断；不做「`RunLoop` 是否可能死循环」这类运行时语义检查。
- 跳转与大纲是**词法级**的（`src/symbols.js`：按声明行找 `类型 名(`），不做类型推导；重名的不同作用域函数会跳到第一个声明。
- 编译在扩展宿主进程里串行执行，保存很快时后来的保存会被跳过（日志里会说「上一次编译还没结束」）。
