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

console.log('\nsmoke: ok');
