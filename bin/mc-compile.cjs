#!/usr/bin/env node
'use strict';

/**
 * `mc-compile` — compile `.mc` scripts from a terminal.
 *
 *   mc-compile furnace_smelting.mc
 *   mc-compile --all src/main/resources/programmablefurnace/scripts
 *   mc-compile --json *.mc > report.json
 *
 * Uses the jar bundled with the extension (no JDK, no mod checkout); pass
 * `--source-root <mod>/src/main/java` to compile the front-end from sources
 * instead, or `--jar <path>` to point at another build.
 *
 * Exit codes: 0 everything compiled, 1 at least one file failed, 2 usage/IO.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const compiler = require('../src/compiler.js');

const STATE_TEXT = {
  EXECUTABLE: '可执行',
  DEPENDENCY: '依赖',
  BLANK: '空白',
  READONLY: '只读',
  FAILED: '编译失败',
};

/** Directories that never hold sources worth compiling. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.build', 'build', 'out', '.gradle']);

const USAGE = `用法：mc-compile [选项] <文件…>

编译 ProgrammableFurnace 的 .mc 脚本，默认使用扩展内置的编译器（不需要 JDK）。

选项：
  --all [目录]           递归编译目录下所有 .mc（默认当前目录）
  --json                 输出 McCompileCli 的原始 JSON 数组
  --jar <路径>           使用指定的编译器 jar
  --source-root <路径>   从模组的 src/main/java 现编前端，而不是用内置 jar
  --no-color             不输出 ANSI 颜色
  -h, --help             显示本帮助
  -v, --version          显示版本

退出码：0 全部通过；1 有文件编译失败；2 参数或文件错误。

示例：
  mc-compile furnace_smelting.mc
  mc-compile --all "D:/MODS/ProgrammableFurnace/src/main/resources/programmablefurnace/scripts"
  mc-compile --json *.mc > report.json`;

function fail(message, code = 2) {
  process.stderr.write(`mc-compile: ${message}\n`);
  process.exit(code);
}

function parse(argv) {
  const options = {
    files: [],
    all: false,
    allDir: '',
    json: false,
    jar: '',
    sourceRoot: '',
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
    help: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      options.all = true;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        options.allDir = next;
        index += 1;
      }
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--no-color') {
      options.color = false;
    } else if (arg === '--jar') {
      options.jar = argv[index + 1] ?? '';
      index += 1;
      if (options.jar === '') fail('--jar 需要一个路径');
    } else if (arg === '--source-root') {
      options.sourceRoot = argv[index + 1] ?? '';
      index += 1;
      if (options.sourceRoot === '') fail('--source-root 需要一个路径');
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-v' || arg === '--version') {
      options.version = true;
    } else if (arg.startsWith('-')) {
      fail(`未知选项 ${arg}（用 --help 看用法）`);
    } else {
      options.files.push(arg);
    }
  }
  return options;
}

/** Every `.mc` file under `root`, walking in a stable order. */
async function walk(root, found = []) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    fail(`无法读取目录 ${root}：${error.message}`);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mc')) {
      found.push(full);
    }
  }
  return found;
}

function paint(text, code, enabled) {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function report(results, options) {
  const cwd = process.cwd();
  let failed = 0;
  for (const result of results) {
    const state = String(result.state ?? '?');
    const text = STATE_TEXT[state] ?? state;
    const label =
      state === 'FAILED' ? paint(text, '31', options.color) : state === 'EXECUTABLE' ? paint(text, '32', options.color) : text;
    const shown = path.relative(cwd, result.file) || result.file;
    const module = result.module ? `  (${result.module})` : '';
    process.stdout.write(`${label}  ${shown}${module}\n`);
    const errors = Array.isArray(result.errors) ? result.errors : [];
    for (const error of errors) {
      process.stdout.write(`      ${error.code} ${error.message} @ ${error.line}:${error.col}\n`);
    }
    if (state === 'FAILED') failed += 1;
  }
  if (results.length > 1) {
    const runnable = results.filter((r) => r.state === 'EXECUTABLE' || r.state === 'READONLY').length;
    const libraries = results.filter((r) => r.state === 'DEPENDENCY').length;
    const blank = results.filter((r) => r.state === 'BLANK').length;
    process.stdout.write(
      `\n共 ${results.length} 个文件：${runnable} 可执行，${libraries} 依赖库，${blank} 空白，${failed} 失败\n`,
    );
  }
  return failed;
}

async function main() {
  const options = parse(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.version) {
    const pkg = require('../package.json');
    process.stdout.write(`mc-compile ${pkg.version}\n`);
    return 0;
  }

  const files = [...options.files].map((file) => path.resolve(file));
  if (options.all) {
    files.push(...(await walk(path.resolve(options.allDir === '' ? '.' : options.allDir))));
  }
  const unique = [...new Set(files)];
  if (unique.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  for (const file of unique) {
    if (!fs.existsSync(file)) fail(`文件不存在：${file}`);
  }

  let results;
  try {
    results = await compiler.compileFiles(unique, {
      compilerJar: options.jar,
      sourceRoot: options.sourceRoot,
      storageDir: path.join(os.tmpdir(), 'mc-compile-cache'),
      log: () => {},
    });
  } catch (error) {
    fail(String(error?.message ?? error));
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return results.some((r) => r.state === 'FAILED') ? 1 : 0;
  }

  const failed = report(results, options);
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`mc-compile: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  });
