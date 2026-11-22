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
  compileFiles,
  ensureCompiler,
  resolveSourceRoot,
  toMarkers,
} = require('./compiler');

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

function config() {
  const settings = vscode.workspace.getConfiguration('mc');
  return {
    compileOnSave: settings.get('compileOnSave', true),
    sourceRoot: settings.get('sourceRoot', ''),
    javaBin: settings.get('javaBin', 'java') || 'java',
    javacBin: settings.get('javacBin', '') || undefined,
  };
}

function log(message) {
  channel.appendLine(typeof message === 'string' ? message : String(message));
}

/** Point the status bar at `document`, or clear it when it is not an .mc file. */
function syncStatus(document) {
  if (document === undefined || document.languageId !== 'mc') {
    statusItem.hide();
    return;
  }
  const result = results.get(document.uri.fsPath);
  if (result === undefined) {
    statusItem.text = '$(beaker) MC: 未编译';
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
  statusItem.text = parts.join(' ');
  statusItem.tooltip = errors === 0 ? '编译通过' : result.errors.map((e) => `${e.code} ${e.message}`).join('\n');
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
    const sourceRoot = resolveSourceRoot({ scriptPath: paths[0], configured: settings.sourceRoot });
    log(`编译 ${paths.length} 个文件（源码根 ${sourceRoot}）`);
    const output = await compileFiles(paths, {
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
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!config().compileOnSave) return;
      return compileDocument(document);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      return compileDocument(document, { silent: true });
    }),
    vscode.window.onDidChangeActiveTextEditor(() => syncStatus(vscode.window.activeTextEditor?.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      results.delete(document.uri.fsPath);
      syncStatus(vscode.window.activeTextEditor?.document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mc')) syncStatus(vscode.window.activeTextEditor?.document);
    }),
  );

  syncStatus(vscode.window.activeTextEditor?.document);

  // Warm the build cache in the background so the first save is not slow.
  const first = vscode.window.activeTextEditor?.document;
  if (first !== undefined && first.languageId === 'mc') {
    const settings = config();
    resolveSourceRoot({ scriptPath: first.uri.fsPath, configured: settings.sourceRoot });
    ensureCompiler({
      sourceRoot: resolveSourceRoot({ scriptPath: first.uri.fsPath, configured: settings.sourceRoot }),
      storageDir: path.join(storageRoot, 'storage'),
      javaBin: settings.javaBin,
      javacBin: settings.javacBin,
      log,
    }).catch((error) => log(`预热失败：${String(error?.message ?? error)}`));
  }
}

function deactivate() {
  diagnostics?.dispose();
  statusItem?.dispose();
  channel?.dispose();
}

module.exports = { activate, deactivate, compile, compileDocument };
