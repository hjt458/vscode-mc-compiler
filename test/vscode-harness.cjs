'use strict';

/**
 * Headless harness for the extension's vscode-facing code: stub the `vscode`
 * module, activate the extension, and drive the providers directly.
 *
 * Run with: node test/vscode-harness.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const SAMPLE = 'D:/MODS/ProgrammableFurnace/src/main/resources/programmablefurnace/scripts/furnace_smelting.mc';

/* ---------- vscode stub ---------- */

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
  }
}

class Position {
  constructor(line, character) {
    Object.assign(this, { line, character });
  }
}

class Location {
  constructor(uri, range) {
    Object.assign(this, { uri, range });
  }
}

class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    Object.assign(this, { name, detail, kind, range, selectionRange });
  }
}

class Diagnostic {
  constructor(range, message, severity) {
    Object.assign(this, { range, message, severity });
  }
}

const registered = { commands: new Map(), symbolProviders: [], definitionProviders: [] };

const vscode = {
  Range,
  Position,
  Location,
  DocumentSymbol,
  Diagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  SymbolKind: { Function: 11, Module: 1 },
  StatusBarAlignment: { Left: 1 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }) },
  ThemeColor: class ThemeColor {},
  languages: {
    createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, dispose: () => {} }),
    registerDocumentSymbolProvider: (selector, provider) => {
      assert.equal(selector, 'mc');
      registered.symbolProviders.push(provider);
      return { dispose: () => {} };
    },
    registerDefinitionProvider: (selector, provider) => {
      assert.equal(selector, 'mc');
      registered.definitionProviders.push(provider);
      return { dispose: () => {} };
    },
  },
  commands: {
    registerCommand: (id, run) => {
      registered.commands.set(id, run);
      return { dispose: () => {} };
    },
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    activeTextEditor: undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    findFiles: async () => [],
    onDidSaveTextDocument: () => ({ dispose: () => {} }),
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
    onDidCloseTextDocument: () => ({ dispose: () => {} }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
};

const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return load.call(this, request, parent, isMain);
};

/* ---------- drive the extension ---------- */

const extension = require('../src/extension.js');

const text = fs.readFileSync(SAMPLE, 'utf8');
const lines = text.split('\n');
const document = {
  languageId: 'mc',
  uri: { fsPath: SAMPLE, scheme: 'file', toString: () => `file://${SAMPLE}` },
  getText: () => text,
  lineAt: (n) => ({ text: lines[n] ?? '', lineNumber: n }),
  lineCount: lines.length,
};

const context = {
  subscriptions: [],
  globalStorageUri: { fsPath: path.join(process.cwd(), '.test-storage') },
};

extension.activate(context);

/* 1. registrations */
process.stdout.write('- activate registers providers and commands\n');
assert.equal(registered.symbolProviders.length, 1, 'one symbol provider');
assert.equal(registered.definitionProviders.length, 1, 'one definition provider');
assert.ok(registered.commands.has('mc.compileFile'), 'compileFile command');
assert.ok(registered.commands.has('mc.compileAll'), 'compileAll command');
assert.ok(context.subscriptions.length >= 8, 'subscriptions pushed for disposal');

/* 2. outline */
process.stdout.write('- DocumentSymbolProvider: module + functions\n');
const symbols = registered.symbolProviders[0].provideDocumentSymbols(document);
assert.deepEqual(
  symbols.map((s) => s.name),
  ['冶炼', 'refillFuel', 'refillInput', 'sortInput', 'hasInput', 'smelt', 'returnItem', 'RunLoop'],
  'outline names',
);
assert.equal(symbols[0].kind, vscode.SymbolKind.Module, 'module kind');
assert.equal(symbols.at(-1).detail, 'RunLoop 入口', 'entry detail');
const smelt = symbols.find((s) => s.name === 'smelt');
assert.equal(lines[smelt.selectionRange.startLine].trim().startsWith('void smelt('), true, 'smelt selection');

/* 3. definition of a call site inside RunLoop */
process.stdout.write('- DefinitionProvider: call -> declaration\n');
const callLine = lines.findIndex((line) => line.trim() === 'refillFuel();');
assert.ok(callLine > 0, 'call site exists');
const provider = registered.definitionProviders[0];
provider
  .provideDefinition(document, new Position(callLine, lines[callLine].indexOf('refillFuel') + 3))
  .then((location) => {
    assert.ok(location instanceof Location, 'returns a Location');
    const declLine = lines[location.range.startLine];
    assert.ok(declLine.includes('void refillFuel('), `points at declaration, got "${declLine}"`);
    assert.equal(location.range.startCharacter, declLine.indexOf('refillFuel'), 'range covers the name');

    /* 4. unknown names and non-.mc documents resolve to nothing */
    process.stdout.write('- DefinitionProvider: unknown name -> undefined\n');
    return provider.provideDefinition(document, new Position(callLine, 4));
  })
  .then(async (unknown) => {
    assert.equal(unknown, undefined, 'unknown identifier');
    const markdown = { ...document, languageId: 'markdown' };
    process.stdout.write('- DefinitionProvider: ignores other languages\n');
    assert.equal(await provider.provideDefinition(markdown, new Position(0, 0)), undefined);
    console.log('\nharness: ok');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
