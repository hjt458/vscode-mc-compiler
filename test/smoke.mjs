import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Hermetic test suite: everything here runs with only Node and a JRE.
 * No mod checkout, no `javac`, no git — so CI can run it on a clean machine.
 * The mod-dependent checks live in `test/local.mjs`.
 */

const require = createRequire(import.meta.url);
const compiler = require('../src/compiler.js');
const symbols = require('../src/symbols.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const SMELTER = path.join(FIXTURES, 'smelter.mc');
const LIBRARY = path.join(FIXTURES, 'library.mc');
const BROKEN = path.join(FIXTURES, 'broken.mc');
const CLI = path.join(HERE, '..', 'bin', 'mc-compile.cjs');
const storageDir = path.join(os.tmpdir(), 'mc-compiler-smoke');

function step(name) {
  process.stdout.write(`- ${name}\n`);
}

// 1. One JVM run covers the three content states.
step('compileFiles: fixtures');
const results = await compiler.compileFiles([SMELTER, LIBRARY, BROKEN], { log: () => {} });
const [smelter, library, broken] = results;
assert.equal(smelter.state, 'EXECUTABLE', 'a script with RunLoop is executable');
assert.equal(smelter.module, '冶炼', 'module name is decoded');
assert.deepEqual(smelter.errors, [], 'clean script has no errors');
assert.equal(library.state, 'DEPENDENCY', 'no RunLoop means a dependency library');
assert.equal(library.module, '工具库', 'library module name');
assert.equal(broken.state, 'FAILED', 'syntax errors fail the file');
assert.ok(broken.errors.some((e) => e.code === 'S05'), 'S05 reported for a missing expression');

// 2. Diagnostics carry 1-based positions for the editor.
step('toMarkers');
const markers = compiler.toMarkers(broken);
assert.ok(markers.length >= 2, 'more than one diagnostic');
assert.ok(markers.every((m) => m.line >= 1 && m.column >= 1), 'positions are 1-based');
assert.ok(markers.every((m) => /^[A-Z]\d\d$/.test(m.code)), 'codes look like S05/M02');

// 3. JVM chatter before the JSON payload is skipped.
step('parseOutput');
const noisy = compiler.parseOutput(
  'Picked up JAVA_TOOL_OPTIONS: -Dfoo=1\n[{"file":"x.mc","state":"BLANK","errors":[]}]',
);
assert.equal(noisy[0].state, 'BLANK', 'noise skipped');

// 4. No files means no JVM at all.
step('compileFiles: empty');
assert.deepEqual(await compiler.compileFiles([], { storageDir }), [], 'empty input');

// 5. Lexical symbols: order, kinds, positions that survive masking.
step('symbols: collect');
const smelterText = await fsp.readFile(SMELTER, 'utf8');
const found = symbols.collectSymbols(smelterText);
assert.deepEqual(
  found.map((s) => s.name),
  ['冶炼', 'refillFuel', 'countItems', 'RunLoop'],
  `symbols in document order, got ${found.map((s) => s.name).join(', ')}`,
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
const decl = symbols.findDefinition(smelterText, 'countItems');
assert.ok(decl !== undefined, 'countItems resolves');
assert.ok(
  smelterText.split('\n')[decl.line].includes('int countItems('),
  'definition points at the declaration',
);
assert.equal(symbols.findDefinition(smelterText, 'nope'), undefined, 'unknown names resolve to nothing');

// 6. Classpath resolution prefers an explicit jar, then the bundled one.
step('classpath ordering');
assert.equal(await compiler.resolveClasspath({}), compiler.BUNDLED_JAR, 'defaults to the bundled jar');
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

// 7. A script outside any mod checkout still compiles from the jar alone.
step('bundled jar: no mod checkout');
const standalone = path.join(os.tmpdir(), 'smoke_standalone.mc');
await fsp.writeFile(standalone, 'MODULE("独立")\nvoid tickOnce() {\n  int 次数 = 0;\n}\n', 'utf8');
const [alone] = await compiler.compileFiles([standalone], { log: () => {} });
assert.equal(alone.state, 'DEPENDENCY', 'a script without RunLoop is a dependency');
assert.equal(alone.module, '独立', 'module name survives without the mod tree');

// 8. Provenance is readable and the verdict is pure (git is covered in local.mjs).
step('provenance: read');
const provenance = compiler.readProvenance();
assert.ok(provenance !== undefined, 'bundled provenance is readable');
assert.match(provenance.commit, /^[0-9a-f]{7,40}$/i, 'commit is a hash');
assert.equal(provenance.sha256.length, 64, 'sha256 recorded');
assert.ok(provenance.size > 0, 'size recorded');

step('provenance: compare');
assert.deepEqual(compiler.compareProvenance({ provenance, head: provenance.commit }), { status: 'match' });
assert.deepEqual(
  compiler.compareProvenance({ provenance, head: 'abcdef1', ancestor: true }),
  { status: 'stale' },
  'jar commit is an ancestor of HEAD',
);
assert.deepEqual(
  compiler.compareProvenance({ provenance, head: 'abcdef1', ancestor: false }),
  { status: 'diverged' },
  'jar commit is not reachable from HEAD',
);
assert.deepEqual(
  compiler.compareProvenance({ provenance, head: 'abcdef1' }),
  { status: 'unknown', reason: 'no-ancestry' },
  'no ancestry answer stays unknown',
);
assert.deepEqual(
  compiler.compareProvenance({ provenance: undefined, head: 'abcdef1' }),
  { status: 'unknown', reason: 'no-provenance' },
  'missing provenance stays unknown',
);

// 9. The terminal command answers the same questions as exit codes.
step('cli: exit codes');
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const okRun = cli(SMELTER);
assert.equal(okRun.status, 0, `clean file exits 0, got ${okRun.status}: ${okRun.stderr}`);
assert.match(okRun.stdout, /可执行/, 'human readable state');
assert.match(okRun.stdout, /smelter\.mc/, 'file name printed');

const badRun = cli(BROKEN);
assert.equal(badRun.status, 1, 'a FAILED file exits 1');
assert.match(badRun.stdout, /编译失败/, 'failure is reported');
assert.match(badRun.stdout, /S05/, 'diagnostic code printed');

assert.equal(cli(path.join(os.tmpdir(), 'definitely-missing.mc')).status, 2, 'missing file exits 2');
assert.equal(cli().status, 2, 'no arguments exits 2');

const jsonRun = cli('--json', '--all', FIXTURES);
assert.equal(jsonRun.status, 1, '--all with a broken fixture exits 1');
const parsed = JSON.parse(jsonRun.stdout);
assert.equal(parsed.length, 3, 'json payload lists every fixture');
assert.deepEqual(
  parsed.map((r) => r.state).sort(),
  ['DEPENDENCY', 'EXECUTABLE', 'FAILED'],
  'json states match the fixtures',
);

// 10. A jar describes itself, and the bundled copy still matches provenance.
step('jarmeta: the jar names its own build');
const bundled = compiler.BUNDLED_JAR;
const jarMeta = require('../src/jarmeta.js').jarMeta;
const meta = jarMeta(bundled);
assert.equal(meta.known, true, 'bundled jar carries a manifest');
assert.equal(meta.commit, provenance.commit, 'manifest commit equals provenance commit');
assert.equal(meta.release, String(provenance.release), 'manifest release equals provenance release');
assert.equal(Number(meta.sources), provenance.sources ?? Number(meta.sources), 'source count agrees');

const digest = crypto
  .createHash('sha256')
  .update(await fsp.readFile(bundled))
  .digest('hex');
assert.equal(digest, provenance.sha256, 'jar bytes match the recorded sha256');

// 11. Compiler candidates: bundled first, then anything in the scan directory.
step('compilers: bundled first, then the scan dir');
const listed = await compiler.listCompilerJars({});
assert.equal(listed.jars[0].role, 'bundled', 'the bundled jar is offered first');
assert.equal(listed.jars[0].path, bundled, 'bundled entry points at the shipped jar');
assert.ok(
  listed.dir.endsWith(path.join('compiler', 'jars')),
  `default scan dir is compiler/jars, got ${listed.dir}`,
);
assert.equal(compiler.probeJar(bundled).ok, true, 'the bundled jar answers a zero-file compile');

const junk = path.join(os.tmpdir(), 'mc-compiler-not-a-jar.jar');
await fsp.writeFile(junk, 'not a zip');
const badJar = compiler.probeJar(junk);
assert.equal(badJar.ok, false, 'a file that is not a jar is rejected');
assert.ok(typeof badJar.reason === 'string' && badJar.reason.length > 0, 'rejection explains why');

console.log('\nsmoke: ok');
