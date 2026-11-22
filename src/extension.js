'use strict';

/**
 * VS Code glue for `.mc` scripts: compile on open/save, publish diagnostics,
 * and keep the state (EXECUTABLE / DEPENDENCY / FAILED / BLANK) in the status
 * bar. All compiler work lives in `compiler.js`.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const {
  BUNDLED_JAR,
  PROVENANCE_MD,
  checkCompilerDrift,
  compileFiles,
  findModRoot,
  listCompilerJars,
  probeJar,
  toMarkers,
} = require('./compiler');
const { bodyEnd, collectSymbols, findDefinition, positionAt, wordAt } = require('./symbols');
const { jarMeta } = require('./jarmeta.js');

const STATE_TEXT = {
  EXECUTABLE: '可执行',
  DEPENDENCY: '依赖',
  FAILED: '编译失败',
  BLANK: '空白',
  READONLY: '只读',
};

/** Highlights the state of the file in the active editor. */
let statusItem;

/** Last compile result per file path. */
const results = new Map();

/** One diagnostic collection keeps refreshing simple. */
let diagnostics;

/** Everything the user should be able to read after a run. */
let channel;

/** True while a compile is running, so saves do not pile up. */
let running = false;

/** Suffix such as "· 编译器旧于 HEAD", empty while the jar matches the checkout. */
let driftNote = '';

/** Suffix naming a non-bundled compiler, e.g. "· 97444ed". */
let compilerNote = '';

/** Mod root -> { at, value }, so a save does not spawn git on every keystroke. */
const driftCache = new Map();

/** `${jarCommit}|${head}|${status}` keys already shown as a warning. */
const driftWarned = new Set();

const DRIFT_TTL_MS = 30_000;

function config() {
  const settings = vscode.workspace.getConfiguration('mc');
  return {
    compileOnSave: settings.get('compileOnSave', true),
    checkCompilerVersion: settings.get('checkCompilerVersion', true),
    compilerJar: settings.get('compilerJar', '') || '',
    compilerDir: settings.get('compilerDir', '') || '',
    sourceRoot: settings.get('sourceRoot', ''),
    javaBin: settings.get('javaBin', 'java') || 'java',
    javacBin: settings.get('javacBin', '') || undefined,
  };
}

function log(message) {
  channel.appendLine(typeof message === 'string' ? message : String(message));
}

/**
 * Name the active compiler in the status bar, but only when it is not the
 * bundled one — the default should stay quiet.
 */
function refreshCompilerNote() {
  const jar = config().compilerJar;
  if (jar === '') {
    compilerNote = '';
    return;
  }
  const meta = jarMeta(jar);
  compilerNote = `· ${meta.known ? meta.commit : meta.name}`;
}

/** Point the status bar at `document`, or clear it when it is not an .mc file. */
function syncStatus(document) {
  if (document === undefined || document.languageId !== 'mc') {
    statusItem.hide();
    return;
  }
  const result = results.get(document.uri.fsPath);
  if (result === undefined) {
    const suffix = [compilerNote, driftNote].filter((part) => part !== '').join(' ');
    statusItem.text = suffix === '' ? '$(beaker) MC: 未编译' : `$(beaker) MC: 未编译 ${suffix}`;
    statusItem.tooltip = '保存文件或运行 “MC: 编译当前文件”';
    statusItem.command = 'mc.compileFile';
    statusItem.show();
    return;
  }
  const label = STATE_TEXT[result.state] || result.state;
  const errors = result.errors.length;
  const parts = [`$(beaker) MC: ${label}`];
  if (errors > 0) parts.push(`${errors} 个错误`);
  if (result.module) parts.push(result.module);
  if (compilerNote !== '') parts.push(compilerNote);
  if (driftNote !== '') parts.push(driftNote);
  statusItem.text = parts.join(' ');
  statusItem.tooltip =
    errors === 0 ? '编译通过' : result.errors.map((e) => `${e.code} ${e.message}`).join('\n');
  statusItem.command = 'mc.showOutput';
  statusItem.show();
}

/** Publish markers for one file, clearing them when it compiled cleanly. */
function publish(uri, result) {
  const markers = toMarkers(result);
  if (markers.length === 0) {
    diagnostics.set(uri, []);
    return;
  }
  diagnostics.set(
    uri,
    markers.map((marker) => {
      const line = Math.max(0, marker.line - 1);
      const start = Math.max(0, marker.column - 1);
      const range = new vscode.Range(line, start, line, start + 1);
      const item = new vscode.Diagnostic(
        range,
        marker.message,
        vscode.DiagnosticSeverity.Error,
      );
      item.code = marker.code;
      item.source = 'mc';
      return item;
    }),
  );
}

/**
 * Compile the given files and refresh diagnostics + status. Compilation errors
 * that are not per-file (missing JDK, missing sources) surface as one dialog so
 * they are not hidden inside the output channel.
 */
async function compile(paths, { silent = false } = {}) {
  if (paths.length === 0) return;
  if (running) {
    log('上一次编译还没结束，跳过本次请求。');
    return;
  }
  running = true;
  statusItem.text = '$(sync~spin) MC: 编译中…';
  statusItem.show();
  try {
    const settings = config();
    const storageDir = path.join(storageRoot, 'storage');
    const sourceRoot = settings.sourceRoot.trim();
    log(
      `编译 ${paths.length} 个文件（${sourceRoot === '' ? '内置编译器' : `源码根 ${sourceRoot}`}）`,
    );
    const output = await compileFiles(paths, {
      compilerJar: settings.compilerJar,
      sourceRoot,
      storageDir,
      javaBin: settings.javaBin,
      javacBin: settings.javacBin,
      log,
    });

    for (const result of output) {
      const uri = vscode.Uri.file(result.file);
      const errors = Array.isArray(result.errors) ? result.errors : [];
      results.set(uri.fsPath, { state: result.state, module: result.module, errors });
      publish(uri, { ...result, errors });
      log(
        `${path.basename(result.file)}  ${result.state}${result.module ? ` (${result.module})` : ''}` +
          (errors.length === 0 ? '' : `\n${errors.map((e) => `  ${e.code} ${e.message} @ ${e.line}:${e.col}`).join('\n')}`),
      );
    }

    const active = vscode.window.activeTextEditor?.document;
    syncStatus(active);
    void refreshDrift(active);
  } catch (error) {
    const message = String(error?.message ?? error);
    log(`编译失败：${message}`);
    statusItem.text = '$(error) MC: 编译出错';
    statusItem.tooltip = message;
    statusItem.command = 'mc.showOutput';
    statusItem.show();
    if (!silent) {
      const choice = await vscode.window.showErrorMessage(`MC 编译失败：${message}`, '查看日志');
      if (choice === '查看日志') channel.show(true);
    }
  } finally {
    running = false;
  }
}

/** Human-readable identity of a jar: commit, build date, size. */
function describeJar(meta) {
  const bits = [];
  bits.push(meta.known ? meta.commit : '来源未知');
  if (meta.builtAt) bits.push(meta.builtAt.slice(0, 10));
  bits.push(`${Math.round(meta.bytes / 1024)} KB`);
  return bits.join(' · ');
}

/** Choose which compiler jar to use, remembering the choice in settings. */
async function selectCompiler() {
  const settings = vscode.workspace.getConfiguration('mc');
  const current = settings.get('compilerJar', '') || '';
  const listed = await listCompilerJars({ compilerDir: settings.get('compilerDir', '') || '' });

  const items = listed.jars.map((jar) => ({
    label: jar.role === 'bundled' ? `${jar.name}（内置）` : jar.name,
    description: describeJar(jar),
    detail: jar.role === 'dir' ? jar.path : '随扩展一起发布',
    jarPath: jar.role === 'bundled' ? '' : jar.path,
    picked: (jar.role === 'bundled' ? '' : jar.path) === current,
  }));
  if (listed.dir && items.every((item) => !item.picked) && current !== '') {
    items.unshift({
      label: path.basename(current),
      description: '当前设置（不在扫描目录里）',
      detail: current,
      jarPath: current,
      picked: true,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: '选择 .mc 编译器',
    placeHolder: current === '' ? '当前：内置 jar' : `当前：${current}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (picked === undefined) return;

  const target = picked.jarPath === '' ? BUNDLED_JAR : picked.jarPath;
  const probe = probeJar(target, { javaBin: config().javaBin });
  if (!probe.ok) {
    void vscode.window.showErrorMessage(`这个 jar 用不了：${probe.reason}`);
    return;
  }
  await settings.update('compilerJar', picked.jarPath, vscode.ConfigurationTarget.Global);
  log(`编译器切换到：${picked.jarPath === '' ? '内置 jar' : picked.jarPath}`);
  const document = vscode.window.activeTextEditor?.document;
  driftCache.clear();
  await refreshDrift(document);
  if (document !== undefined && document.languageId === 'mc') {
    await compileDocument(document, { silent: true });
  }
  void vscode.window.showInformationMessage(
    `编译器已切换为 ${picked.label}（${picked.description}）`,
  );
}

/** Open the human-readable provenance of the bundled jar. */
async function showProvenance() {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(PROVENANCE_MD));
  await vscode.window.showTextDocument(document, { preview: true });
}

/**
 * Compare the bundled jar's build commit with the checkout holding `document`
 * and remember the verdict for the status bar. A mismatch is worth one warning
 * per (jar commit, HEAD) pair: the editor would otherwise disagree with the game.
 */
async function refreshDrift(document) {
  driftNote = '';
  if (!config().checkCompilerVersion || document === undefined || document.languageId !== 'mc') {
    syncStatus(document);
    return;
  }
  const modRoot = findModRoot(path.dirname(document.uri.fsPath));
  if (modRoot === undefined) {
    syncStatus(document);
    return;
  }
  const cached = driftCache.get(modRoot);
  let verdict;
  if (cached !== undefined && Date.now() - cached.at < DRIFT_TTL_MS) {
    verdict = cached.value;
  } else {
    verdict = await checkCompilerDrift({ modRoot });
    driftCache.set(modRoot, { at: Date.now(), value: verdict });
  }

  if (verdict.status === 'stale' || verdict.status === 'diverged') {
    driftNote = verdict.status === 'stale' ? '· 编译器旧于 HEAD' : '· 编译器与 HEAD 分叉';
  }
  log(
    `编译器出处：${verdict.status}` +
      (verdict.provenance === undefined
        ? ''
        : `（jar ${verdict.provenance.commit} / HEAD ${verdict.head ?? '?'}）`),
  );
  // Paint the status bar before the dialog: the warning waits for the user, and
  // the suffix should not wait with it.
  syncStatus(document);

  if (driftNote === '') return;
  const key = `${verdict.provenance.commit}|${verdict.head}|${verdict.status}`;
  if (driftWarned.has(key)) return;
  driftWarned.add(key);
  const what = verdict.status === 'stale' ? '落后于' : '与当前分支分叉，不同源';
  const text =
    `内置编译器基于 ${verdict.provenance.commit}，${what}工程 HEAD ${verdict.head}。` +
    '游戏内行为可能与编辑器诊断不一致，可运行 node tools/build-compiler.mjs 重建。';
  void vscode.window.showWarningMessage(text, '查看出处', '知道了').then((choice) => {
    if (choice === '查看出处') return showProvenance();
    return undefined;
  });
}

/** Range covering `name` at a 0-based position. */
function nameRange(position, name) {
  return new vscode.Range(
    position.line,
    position.character,
    position.line,
    position.character + name.length,
  );
}

/**
 * Outline for the Explorer pane and breadcrumbs: the module plus every
 * function, with the body range so folding and "go to symbol" work.
 */
function provideDocumentSymbols(document) {
  const source = document.getText();
  return collectSymbols(source).map((symbol) => {
    const start = positionAt(source, symbol.offset);
    const lastLine = bodyEnd(source, start.line);
    const lastText = document.lineAt(lastLine).text.trimEnd();
    const end = lastText.endsWith('}')
      ? { line: lastLine, character: lastText.length }
      : { line: start.line, character: start.character + symbol.name.length };
    const kind = symbol.kind === 'module' ? vscode.SymbolKind.Module : vscode.SymbolKind.Function;
    const detail = symbol.kind === 'module' ? '模块' : symbol.kind === 'entry' ? 'RunLoop 入口' : '';
    return new vscode.DocumentSymbol(
      symbol.name,
      detail,
      kind,
      new vscode.Range(start.line, start.character, end.line, end.character),
      nameRange(start, symbol.name),
    );
  });
}

/**
 * Ctrl+Click / F12: resolve a name to its declaration. Same file first, then
 * the sibling `.mc` files in the same folder (how a second script would import
 * a helper from the first).
 */
async function provideDefinition(document, position) {
  if (document.languageId !== 'mc' || document.uri.scheme !== 'file') return undefined;
  const hit = wordAt(document.lineAt(position.line).text, position.character);
  if (hit === undefined) return undefined;

  const source = document.getText();
  const local = findDefinition(source, hit.word);
  if (local !== undefined) {
    return new vscode.Location(document.uri, nameRange(local, hit.word));
  }

  const folder = path.dirname(document.uri.fsPath);
  const entries = await fsp.readdir(folder).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith('.mc')) continue;
    const file = path.join(folder, entry);
    if (file === document.uri.fsPath) continue;
    const text = await fsp.readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const found = findDefinition(text, hit.word);
    if (found !== undefined) {
      return new vscode.Location(vscode.Uri.file(file), nameRange(found, hit.word));
    }
  }
  return undefined;
}

/** The preview / normal open path: compile a document once. */
function compileDocument(document, options) {
  if (document === undefined || document.languageId !== 'mc') return;
  if (document.uri.scheme !== 'file') return;
  return compile([document.uri.fsPath], options);
}

/** Storage root for the compiled front-end; the extension's global storage. */
let storageRoot = '';

function activate(context) {
  storageRoot = context.globalStorageUri.fsPath;
  channel = vscode.window.createOutputChannel('MC Compiler');
  diagnostics = vscode.languages.createDiagnosticCollection('mc');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  context.subscriptions.push(
    channel,
    diagnostics,
    statusItem,
    vscode.commands.registerCommand('mc.compileFile', () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document === undefined || document.languageId !== 'mc') {
        vscode.window.showInformationMessage('当前编辑器不是 .mc 文件。');
        return;
      }
      return compileDocument(document, { silent: true });
    }),
    vscode.commands.registerCommand('mc.compileAll', async () => {
      const found = await vscode.workspace.findFiles('**/*.mc', '**/{node_modules,.git}/**', 200);
      if (found.length === 0) {
        vscode.window.showInformationMessage('工作区里没有 .mc 文件。');
        return;
      }
      return compile(found.map((uri) => uri.fsPath), { silent: true });
    }),
    vscode.commands.registerCommand('mc.showOutput', () => channel.show(true)),
    vscode.commands.registerCommand('mc.showProvenance', () => showProvenance()),
    vscode.commands.registerCommand('mc.selectCompiler', () => selectCompiler()),
    vscode.languages.registerDocumentSymbolProvider('mc', { provideDocumentSymbols }),
    vscode.languages.registerDefinitionProvider('mc', { provideDefinition }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!config().compileOnSave) return;
      return compileDocument(document);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      return compileDocument(document, { silent: true });
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      syncStatus(editor?.document);
      void refreshDrift(editor?.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      results.delete(document.uri.fsPath);
      syncStatus(vscode.window.activeTextEditor?.document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mc')) syncStatus(vscode.window.activeTextEditor?.document);
    }),
  );

  refreshCompilerNote();
  syncStatus(vscode.window.activeTextEditor?.document);

  // A reload re-opens the old editors without firing onDidOpenTextDocument, so
  // compile whatever is in front right away instead of showing "未编译".
  const first = vscode.window.activeTextEditor?.document;
  if (first !== undefined && first.languageId === 'mc') {
    compileDocument(first, { silent: true });
  }
}

function deactivate() {
  diagnostics?.dispose();
  statusItem?.dispose();
  channel?.dispose();
}

module.exports = { activate, deactivate, compile, compileDocument };
