'use strict';

/**
 * Compiler plumbing for `.mc` scripts. Nothing here imports `vscode`, so the
 * whole thing can be exercised from a plain Node script (`npm test`).
 *
 * The ProgrammableFurnace compiler front-end (`compiler/lex`, `compiler/syntax`,
 * `compiler/sem`, `base/CompilerAnalyzer`) has no Minecraft imports, so a JDK is
 * enough to run it outside the game. This module:
 *
 *   1. locates the mod checkout from a script path,
 *   2. compiles the front-end once per content hash into the extension storage,
 *   3. runs `McCompileCli` and parses its JSON.
 */

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** Package root of the mod inside `src/main/java`. */
const PACKAGE_PARTS = ['dev', 'programmablefurnace'];

/** Front-end packages (relative to the Java source root). */
const FRONTEND_DIRS = [
  ['compiler', 'lex'],
  ['compiler', 'syntax'],
  ['compiler', 'sem'],
].map((parts) => path.join(...PACKAGE_PARTS, ...parts));

/** Front-end files that live outside those packages. */
const FRONTEND_FILES = [
  ['base', 'CompilerAnalyzer.java'],
  ['base', 'ContentState.java'],
  ['base', 'CodeAnalyzer.java'],
].map((parts) => path.join(...PACKAGE_PARTS, ...parts));

/** The driver living next to this extension. */
const CLI_SOURCE = path.join(__dirname, '..', 'tools', 'McCompileCli.java');

/** Prebuilt front-end + driver, shipped with the extension. */
const BUNDLED_JAR = path.join(__dirname, '..', 'compiler', 'mc-compiler.jar');

/** What the bundled jar was built from; written by `tools/build-compiler.mjs`. */
const PROVENANCE_JSON = path.join(__dirname, '..', 'compiler', 'provenance.json');

/** Human-readable version of the same facts, for the "show provenance" command. */
const PROVENANCE_MD = path.join(__dirname, '..', 'compiler', 'PROVENANCE.md');

const JAVAC_TIMEOUT_MS = 180_000;
const JAVA_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim() || String(stdout || '').trim() || error.message;
          reject(new Error(`${path.basename(file)} failed: ${detail.split(/\r?\n/).slice(0, 12).join('\n')}`));
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
}

/**
 * Walk up from `startDir` until a directory contains
 * `src/main/java/dev/programmablefurnace`; returns that mod root or undefined.
 */
function findModRoot(startDir) {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(current, 'src', 'main', 'java', ...PACKAGE_PARTS);
    if (fs.existsSync(candidate)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * Resolve the Java source root for a script:
 * explicit setting wins, then the nearest mod checkout, then the raw setting.
 */
function resolveSourceRoot({ scriptPath, configured }) {
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  if (trimmed !== '') return path.resolve(trimmed);
  const modRoot = findModRoot(path.dirname(scriptPath));
  if (modRoot === undefined) {
    throw new Error(
      '找不到 dev/programmablefurnace 源码目录；请把脚本放进模组工程，或设置 mc.sourceRoot。',
    );
  }
  return path.join(modRoot, 'src', 'main', 'java');
}

/** Existing front-end sources, or an empty array. */
async function collectFrontendSources(sourceRoot) {
  const files = [];
  for (const dir of FRONTEND_DIRS) {
    const full = path.join(sourceRoot, dir);
    let entries;
    try {
      entries = await fsp.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.java')) files.push(path.join(full, entry.name));
    }
  }
  for (const rel of FRONTEND_FILES) {
    const full = path.join(sourceRoot, rel);
    if (fs.existsSync(full)) files.push(full);
  }
  files.sort();
  return files;
}

/** Content hash of the front-end + the driver; the build cache key. */
async function sourceHash(sources) {
  const hash = crypto.createHash('sha1');
  for (const source of sources) {
    hash.update(path.basename(source));
    hash.update('\u0000');
    hash.update(await fsp.readFile(source));
    hash.update('\u0000');
  }
  hash.update(await fsp.readFile(CLI_SOURCE));
  return hash.digest('hex').slice(0, 16);
}

/** In-flight builds keyed by classes directory, so parallel saves build once. */
const builds = new Map();

/**
 * Compile the front-end into `<storageDir>/build/<hash>/` when that hash has no
 * marker yet, and return the classes directory.
 */
async function ensureCompiler({ sourceRoot, storageDir, javaBin = 'java', javacBin, log = () => {} }) {
  const sources = await collectFrontendSources(sourceRoot);
  if (sources.length === 0) {
    throw new Error(
      `在 ${sourceRoot} 下找不到编译器前端源码（应有 ${FRONTEND_DIRS.join('、')}）`,
    );
  }
  const key = await sourceHash(sources);
  const outDir = path.join(storageDir, 'build', key);
  const marker = path.join(outDir, '.built');
  if (fs.existsSync(marker)) return outDir;

  const pending = builds.get(outDir);
  if (pending !== undefined) {
    await pending;
    return outDir;
  }

  const build = (async () => {
    log(`编译前端源码 → ${outDir}`);
    await fsp.mkdir(outDir, { recursive: true });
    await run(
      javacBin || javacFor(javaBin),
      ['-encoding', 'UTF-8', '-nowarn', '-d', outDir, '-sourcepath', sourceRoot, ...sources, CLI_SOURCE],
      JAVAC_TIMEOUT_MS,
    );
    await fsp.writeFile(marker, `sources=${sources.length}\n`, 'utf8');
  })();

  builds.set(outDir, build);
  try {
    await build;
  } finally {
    builds.delete(outDir);
  }
  return outDir;
}

/** `javac` next to `java`, or bare `javac` on PATH. */
function javacFor(javaBin) {
  if (typeof javaBin === 'string' && path.isAbsolute(javaBin)) {
    return path.join(path.dirname(javaBin), process.platform === 'win32' ? 'javac.exe' : 'javac');
  }
  return 'javac';
}

/** Parse the CLI's stdout (it may be preceded by JVM warnings). */
function parseOutput(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('[');
  if (start < 0) throw new Error(`编译器没有输出 JSON：${text.slice(0, 400)}`);
  const parsed = JSON.parse(text.slice(start));
  if (!Array.isArray(parsed)) throw new Error('编译器输出不是数组');
  return parsed;
}

/**
 * Pick the classpath for the compiler driver:
 *
 *   1. an explicit jar (`mc.compilerJar`) when the user points at their own build,
 *   2. the jar bundled with the extension (no JDK, no mod checkout needed),
 *   3. the front-end compiled on the fly from `sourceRoot` (dev / fallback).
 */
async function resolveClasspath(options) {
  const explicit = typeof options.compilerJar === 'string' ? options.compilerJar.trim() : '';
  if (explicit !== '') {
    const jar = path.resolve(explicit);
    if (!fs.existsSync(jar)) throw new Error(`mc.compilerJar 指向的文件不存在：${jar}`);
    return jar;
  }
  if (fs.existsSync(BUNDLED_JAR)) return BUNDLED_JAR;
  if (typeof options.sourceRoot === 'string' && options.sourceRoot.trim() !== '') {
    return ensureCompiler(options);
  }
  throw new Error(
    `找不到内置编译器（${BUNDLED_JAR}），也没有可用的源码根目录；` +
      '请设置 mc.sourceRoot 指向模组的 src/main/java，或设置 mc.compilerJar。',
  );
}

/** Compile `.mc` files; returns one result per input, in argument order. */
async function compileFiles(files, options) {
  if (files.length === 0) return [];
  const classpath = await resolveClasspath(options);
  const { stdout } = await run(
    options.javaBin || 'java',
    [
      '-Dfile.encoding=UTF-8',
      '-Dstdout.encoding=UTF-8',
      '-cp',
      classpath,
      'McCompileCli',
      ...files,
    ],
    JAVA_TIMEOUT_MS,
  );
  return parseOutput(stdout);
}

/** Like `run`, but reports the exit code instead of rejecting on non-zero. */
function runStatus(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : 127;
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
}

/** The provenance record of the bundled jar, or undefined when unreadable. */
function readProvenance(file = PROVENANCE_JSON) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data?.commit !== 'string' || data.commit.trim() === '') return undefined;
    return data;
  } catch {
    return undefined;
  }
}

/** `{ head, subject }` of the checkout at `modRoot`, or undefined without git. */
async function gitHead(modRoot) {
  try {
    const head = (await run('git', ['-C', modRoot, 'rev-parse', '--short', 'HEAD'], GIT_TIMEOUT_MS)).stdout.trim();
    if (head === '') return undefined;
    let subject = '';
    try {
      subject = (await run('git', ['-C', modRoot, 'log', '-1', '--format=%s'], GIT_TIMEOUT_MS)).stdout.trim();
    } catch {
      subject = '';
    }
    return { head, subject };
  } catch {
    return undefined;
  }
}

/** True/false when `commit` is reachable from HEAD, undefined when git cannot say. */
async function isAncestor(modRoot, commit) {
  const { code } = await runStatus(
    'git',
    ['-C', modRoot, 'merge-base', '--is-ancestor', commit, 'HEAD'],
    GIT_TIMEOUT_MS,
  );
  if (code === 0) return true;
  if (code === 1) return false;
  return undefined;
}

/** Two abbreviated hashes name the same commit when one is a prefix of the other. */
function sameCommit(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  if (left === '' || right === '') return false;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Pure verdict for the drift question.
 *
 *   match     the jar was built from exactly the checked-out commit
 *   stale     the jar predates HEAD (HEAD descends from the jar's commit)
 *   diverged  neither is an ancestor of the other (branch switch, rebase, stash)
 *   unknown   not enough information (no provenance, no git, git refused)
 */
function compareProvenance({ provenance, head, ancestor } = {}) {
  if (provenance === undefined || !provenance?.commit) {
    return { status: 'unknown', reason: 'no-provenance' };
  }
  if (typeof head !== 'string' || head.trim() === '') {
    return { status: 'unknown', reason: 'no-git' };
  }
  if (sameCommit(provenance.commit, head)) return { status: 'match' };
  if (ancestor === true) return { status: 'stale' };
  if (ancestor === false) return { status: 'diverged' };
  return { status: 'unknown', reason: 'no-ancestry' };
}

/**
 * Compare the bundled jar's provenance with the mod checkout holding `modRoot`.
 * Never throws: a missing checkout or git only degrades the verdict to unknown.
 */
async function checkCompilerDrift({ modRoot, provenance = readProvenance() } = {}) {
  if (provenance === undefined) return { status: 'unknown', reason: 'no-provenance' };
  if (typeof modRoot !== 'string' || modRoot === '') {
    return { status: 'unknown', reason: 'no-mod-root', provenance };
  }
  const info = await gitHead(modRoot);
  if (info === undefined) return { status: 'unknown', reason: 'no-git', provenance };
  const ancestor = sameCommit(provenance.commit, info.head)
    ? undefined
    : await isAncestor(modRoot, provenance.commit);
  const verdict = compareProvenance({ provenance, head: info.head, ancestor });
  return { ...verdict, provenance, head: info.head, subject: info.subject };
}

/** Flatten one result's errors into marker-friendly records (1-based lines/cols). */
function toMarkers(result) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  return errors.map((error) => ({
    code: String(error?.code ?? '?'),
    line: Number(error?.line ?? 1),
    column: Number(error?.col ?? 1),
    message: String(error?.message ?? ''),
  }));
}

module.exports = {
  BUNDLED_JAR,
  CLI_SOURCE,
  FRONTEND_DIRS,
  FRONTEND_FILES,
  PROVENANCE_JSON,
  PROVENANCE_MD,
  checkCompilerDrift,
  collectFrontendSources,
  compareProvenance,
  compileFiles,
  ensureCompiler,
  findModRoot,
  gitHead,
  isAncestor,
  javacFor,
  parseOutput,
  readProvenance,
  resolveClasspath,
  resolveSourceRoot,
  sameCommit,
  sourceHash,
  toMarkers,
};
