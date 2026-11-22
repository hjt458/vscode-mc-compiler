# Bundled compiler provenance

`mc-compiler.jar` is the ProgrammableFurnace compiler front-end plus the JSON CLI
driver, compiled ahead of time so the extension does **not** need the mod checkout
(or a JDK) at runtime.

| | |
| --- | --- |
| Upstream project | `D:\MODS\ProgrammableFurnace` |
| Commit | `97444ed` — fix: 空白文件按无组件规范形存储（修复编译产物无法与合成空白堆叠） |
| Built with | `javac 25.0.1` / `jar 25.0.1`, `--release 17` (class file 61 → runs on JRE 17+) |
| Jar | `compiler/mc-compiler.jar` |
| SHA-256 | `8fdaae9d5fb03a0ce354f607961a49a174c8634b9ddc98624e936c53636461e2` |
| Size | 95638 bytes |

## Sources compiled into the jar (22 files)

`src/main/java/dev/programmablefurnace/`

- `compiler/lex/`: CompileError.java, ErrorCode.java, LexException.java, Lexer.java, SourcePos.java, Token.java, TokenType.java
- `compiler/syntax/`: Ast.java, Parser.java
- `compiler/sem/`: ImportOptimizer.java, ImportResolver.java, ModuleRegistry.java, NameMangler.java, StorageBuilder.java, StorageTable.java, Symbol.java, SymbolBinder.java, TypeChecker.java
- `base/`: CodeAnalyzer.java, CompilerAnalyzer.java, ContentState.java
- driver (this repository): `tools/McCompileCli.java`

The front-end imports only `java.*`, so nothing else from the mod is pulled in:
compiling the list above with `-sourcepath` produces exactly these packages, no
extra `base` or `net`/`recipe` classes.

## Rebuild

```bash
node tools/build-compiler.mjs                       # uses D:/MODS/ProgrammableFurnace/src/main/java
node tools/build-compiler.mjs --source-root <path>  # any checkout of src/main/java
```

The script recompiles with `--release 17`, rewrites the jar, and regenerates this
file (commit, versions, hash) so the provenance never drifts from the binary.
