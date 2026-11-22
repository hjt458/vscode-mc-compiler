# Compiler jars

Drop any `mc-compiler.jar` build here and it becomes selectable in VS Code:

1. run **MC: 选择编译器…** from the command palette,
2. pick the file (each entry shows the commit, build date and size baked into
   its `META-INF/MANIFEST.MF`),
3. the choice is written to `mc.compilerJar`.

The folder is scanned one level deep for `*.jar`; the bundled
`compiler/mc-compiler.jar` is always listed first. Only jars that answer a
zero-file compile (`java -cp <jar> McCompileCli`) are accepted.

Build one from a mod checkout with:

```bash
node tools/build-compiler.mjs --source-root <path-to-mod>/src/main/java
```

This directory is intentionally empty in git.
