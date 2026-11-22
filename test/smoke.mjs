import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiler = require('../src/compiler.js');

const SAMPLE = 'D:/MODS/ProgrammableFurnace/src/main/resources/programmablefurnace/scripts/furnace_smelting.mc';
const storageDir = path.join(os.tmpdir(), 'mc-compiler-smoke');

function step(name) {
  process.stdout.write(`- ${name}\n`);
}

// 1. Locate the mod checkout from the script path.
step('findModRoot');
const modRoot = compiler.findModRoot(path.dirname(SAMPLE));
assert.equal(modRoot, path.resolve('D:/MODS/ProgrammableFurnace'), 'mod root');

// 2. Resolve the Java source root.
step('resolveSourceRoot');
const sourceRoot = compiler.resolveSourceRoot({ scriptPath: SAMPLE, configured: '' });
assert.equal(sourceRoot, path.join(modRoot, 'src', 'main', 'java'), 'source root');

// 3. Build the front-end once (cached by content hash).
step('ensureCompiler');
const classes = await compiler.ensureCompiler({ sourceRoot, storageDir, log: () => {} });
assert.ok(classes.includes(path.join('build')), 'classes dir under build cache');

// 4. Compile the sample: it is a runnable smelting script.
step('compileFiles: sample');
const [sample] = await compiler.compileFiles([SAMPLE], { sourceRoot, storageDir, log: () => {} });
assert.equal(sample.state, 'EXECUTABLE', 'sample state');
assert.equal(sample.module, '冶炼', 'sample module');
assert.deepEqual(sample.errors, [], 'sample has no errors');

// 5. A broken script reports diagnostics with 1-based positions.
step('compileFiles: broken');
const broken = path.join(os.tmpdir(), 'smoke_broken.mc');
await (await import('node:fs/promises')).writeFile(
  broken,
  'MODULE("坏")\nRunLoop() {\n  int a = 1;\n  return;\n}\nMODULE("重复")\n',
  'utf8',
);
const [bad] = await compiler.compileFiles([broken], { sourceRoot, storageDir, log: () => {} });
assert.equal(bad.state, 'FAILED', 'broken state');
assert.ok(bad.errors.length > 0, 'broken has diagnostics');
const markers = compiler.toMarkers(bad);
assert.ok(markers.every((m) => m.line >= 1 && m.column >= 1), 'positions are 1-based');

// 6. parseOutput tolerates JVM chatter before the JSON payload.
step('parseOutput');
const noisy = compiler.parseOutput('Picked up JAVA_TOOL_OPTIONS: -Dfoo=1\n[{"file":"x.mc","state":"BLANK","errors":[]}]');
assert.equal(noisy[0].state, 'BLANK', 'noise skipped');

// 7. Empty input does not start a JVM.
step('compileFiles: empty');
assert.deepEqual(await compiler.compileFiles([], { sourceRoot, storageDir }), [], 'empty input');

// 8. Lexical symbols: module + functions, with positions that survive masking.
step('symbols: collect');
const symbols = require('../src/symbols.js');
const fs = await import('node:fs/promises');
const sampleText = await fs.readFile(SAMPLE, 'utf8');
const found = symbols.collectSymbols(sampleText);
const names = found.map((s) => s.name);
assert.deepEqual(
  names,
  ['冶炼', 'refillFuel', 'refillInput', 'sortInput', 'hasInput', 'smelt', 'returnItem', 'RunLoop'],
  `symbols in document order, got ${names.join(', ')}`,
);
assert.equal(found[0].kind, 'module', 'first symbol is the module');
assert.equal(found.at(-1).kind, 'entry', 'RunLoop is the entry point');

const masked = symbols.mask('MODULE("x") // c\nint a = "b // not a comment";\n');
assert.equal(masked.length, 'MODULE("x") // c\nint a = "b // not a comment";\n'.length, 'mask keeps offsets');
assert.ok(!masked.includes('not a comment'), 'string/comment content is blanked');
assert.ok(masked.includes('int a ='), 'code is kept');

step('symbols: wordAt');
assert.deepEqual(symbols.wordAt('  refillFuel();', 4), { word: 'refillFuel', start: 2, end: 11 });
assert.equal(symbols.wordAt('  // 燃料 ++', 6).word, '燃料', 'Chinese identifiers are words');

step('symbols: findDefinition');
const decl = symbols.findDefinition(sampleText, 'smelt');
assert.ok(decl !== undefined, 'smelt resolves');
const declLine = sampleText.split('\n')[decl.line];
assert.ok(declLine.includes('void smelt('), `definition points at the declaration, got "${declLine}"`);
assert.equal(symbols.findDefinition(sampleText, 'nope'), undefined, 'unknown names resolve to nothing');

// 9. The bundled jar compiles without any mod checkout or source root.
step('bundled jar: classpath ordering');
assert.equal(
  await compiler.resolveClasspath({}),
  compiler.BUNDLED_JAR,
  'defaults to the bundled jar',
);
assert.equal(
  await compiler.resolveClasspath({ compilerJar: compiler.BUNDLED_JAR }),
  path.resolve(compiler.BUNDLED_JAR),
  'explicit jar wins',
);
await assert.rejects(
  () => compiler.resolveClasspath({ compilerJar: path.join(os.tmpdir(), 'missing.jar') }),
  /mc\.compilerJar/,
  'missing explicit jar is reported',
);

step('bundled jar: compile without mod sources');
const standalone = path.join(os.tmpdir(), 'smoke_standalone.mc');
await fs.writeFile(
  standalone,
  'MODULE("独立")\nvoid tickOnce() {\n  int 次数 = 0;\n  return;\n}\n',
  'utf8',
);
const [alone] = await compiler.compileFiles([standalone], { log: () => {} });
assert.equal(alone.state, 'DEPENDENCY', 'a script without RunLoop is a dependency');
assert.equal(alone.module, '独立', 'module name survives without the mod tree');
assert.deepEqual(alone.errors, [], 'compiles from the jar alone');

console.log('\nsmoke: ok');
