import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';

/**
 * Checks that need a real mod checkout on this machine: the source-compile
 * fallback (javac), path discovery, and the drift verdict against live git.
 * CI skips this file; `npm test` runs it locally and reports a skip when the
 * checkout is missing.
 */

const require = createRequire(import.meta.url);
const compiler = require('../src/compiler.js');
const symbols = require('../src/symbols.js');

const DEFAULT_MOD = 'D:/MODS/ProgrammableFurnace';
const modRoot = process.env.MC_MOD_ROOT || DEFAULT_MOD;
const SAMPLE = path.join(
  modRoot,
  'src/main/resources/programmablefurnace/scripts/furnace_smelting.mc',
);

function step(name) {
  process.stdout.write(`- ${name}\n`);
}

const exists = async (file) => {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(SAMPLE))) {
  console.log(`local: skipped (no mod checkout at ${modRoot})`);
  process.exit(0);
}

// 1. Path discovery walks up from a script to the mod root.
step('findModRoot');
const foundRoot = await compiler.findModRoot(path.dirname(SAMPLE));
assert.ok(foundRoot !== undefined, 'mod root discovered');
assert.equal(path.resolve(foundRoot).toLowerCase(), path.resolve(modRoot).toLowerCase(), 'root matches');

step('resolveSourceRoot');
const sourceRoot = await compiler.resolveSourceRoot({ scriptPath: SAMPLE });
assert.ok(sourceRoot !== undefined, 'source root resolved');
assert.ok((await exists(sourceRoot)).valueOf(), 'source root exists');

// 2. The javac fallback still builds the compiler from sources.
step('ensureCompiler: javac');
const storageDir = path.join(os.tmpdir(), 'mc-compiler-local');
const builds = [];
const classes = await compiler.ensureCompiler({
  sourceRoot,
  storageDir,
  log: (line) => builds.push(line),
});
assert.ok(classes.length > 0, 'a classpath was produced');
assert.ok((await exists(classes)) || classes.includes(path.delimiter), 'classpath points at build output');

// 3. Compiling the real script works through both routes.
step('compileFiles: mod sample');
const [viaSource] = await compiler.compileFiles([SAMPLE], { sourceRoot, storageDir, log: () => {} });
assert.equal(viaSource.state, 'EXECUTABLE', 'sample compiles from sources');
assert.equal(viaSource.module, '冶炼', 'sample module name');

const [viaJar] = await compiler.compileFiles([SAMPLE], { log: () => {} });
assert.equal(viaJar.state, 'EXECUTABLE', 'sample compiles with the bundled jar');
assert.deepEqual(viaJar.errors, [], 'no diagnostics');

// 4. Symbols on the real script (it has helpers the fixture does not).
step('symbols: mod sample');
const text = await fsp.readFile(SAMPLE, 'utf8');
const found = symbols.collectSymbols(text);
assert.equal(found[0].name, '冶炼', 'module first');
assert.ok(found.some((s) => s.name === 'RunLoop'), 'entry present');
assert.ok(found.length >= 5, `expected several symbols, got ${found.map((s) => s.name).join(', ')}`);

// 5. Drift against the live checkout: any verdict is fine, but it must answer.
step('checkCompilerDrift: live git');
const drift = await compiler.checkCompilerDrift({ modRoot });
assert.ok(['match', 'stale', 'diverged', 'unknown'].includes(drift.status), `got ${drift.status}`);
console.log(`  verdict: ${drift.status}${drift.reason ? ` (${drift.reason})` : ''}`);

console.log('\nlocal: ok');
