#!/usr/bin/env node
'use strict';

/**
 * Rebuild `compiler/mc-compiler.jar` from a ProgrammableFurnace checkout and
 * rewrite `compiler/PROVENANCE.md` so the recorded commit/hash always matches
 * the binary that ships with the extension.
 *
 * Usage:
 *   node tools/build-compiler.mjs [--source-root <mod>/src/main/java] [--no-provenance]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXT_ROOT = path.join(__dirname, '..');
const JAR_PATH = path.join(EXT_ROOT, 'compiler', 'mc-compiler.jar');
const PROVENANCE_PATH = path.join(EXT_ROOT, 'compiler', 'PROVENANCE.md');
/** Same facts as PROVENANCE.md, but machine-readable (the extension reads this). */
const PROVENANCE_JSON_PATH = path.join(EXT_ROOT, 'compiler', 'provenance.json');
const CLI_SOURCE = path.join(EXT_ROOT, 'tools', 'McCompileCli.java');

/** Where each compiled package lives, relative to the Java source root. */
const PACKAGE_DIRS = [
  'dev/programmablefurnace/compiler/lex',
  'dev/programmablefurnace/compiler/syntax',
  'dev/programmablefurnace/compiler/sem',
];

/** Individual files that live outside those packages. */
const PACKAGE_FILES = [
  'dev/programmablefurnace/base/CodeAnalyzer.java',
  'dev/programmablefurnace/base/CompilerAnalyzer.java',
  'dev/programmablefurnace/base/ContentState.java',
];

const DEFAULT_SOURCE_ROOT = 'D:/MODS/ProgrammableFurnace/src/main/java';
const RELEASE = '17';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return true;
  return value;
}

function firstLine(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return 'unknown';
  }
}

async function collectSources(sourceRoot) {
  const files = [];
  for (const dir of PACKAGE_DIRS) {
    const entries = await fsp.readdir(path.join(sourceRoot, dir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.java')) {
        files.push(path.join(sourceRoot, dir, entry.name));
      }
    }
  }
  for (const rel of PACKAGE_FILES) {
    const full = path.join(sourceRoot, rel);
    if (!fs.existsSync(full)) throw new Error(`missing ${full}`);
    files.push(full);
  }
  files.push(CLI_SOURCE);
  return files.sort();
}

/** The mod root, for the commit hash in the provenance header. */
function modRootOf(sourceRoot) {
  let current = path.resolve(sourceRoot);
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function main() {
  const sourceRoot = path.resolve(arg('source-root', process.env.MCC_SOURCE_ROOT || DEFAULT_SOURCE_ROOT));
  if (!fs.existsSync(sourceRoot)) throw new Error(`source root not found: ${sourceRoot}`);

  const sources = await collectSources(sourceRoot);
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-compiler-jar-'));
  const metaDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-compiler-meta-'));

  // Everything that identifies this build is known before packaging, so it can
  // be stamped into the jar itself: a jar copied to another machine can still
  // say which mod commit it came from.
  const modRoot = modRootOf(sourceRoot);
  const commit =
    modRoot === undefined ? 'unknown' : firstLine('git', ['rev-parse', '--short', 'HEAD'], modRoot);
  const subject = modRoot === undefined ? '' : firstLine('git', ['log', '-1', '--format=%s'], modRoot);
  const javacVersion = firstLine('javac', ['-version']);
  const jarVersion = firstLine('jar', ['--version']);
  const builtAt = new Date().toISOString();

  const manifestPath = path.join(metaDir, 'MANIFEST.MF');
  await fsp.writeFile(
    manifestPath,
    [
      'Manifest-Version: 1.0',
      'Compiler-Creator: build-compiler.mjs',
      `Compiler-Commit: ${commit}`,
      `Compiler-Built-At: ${builtAt}`,
      `Compiler-Release: ${RELEASE}`,
      `Compiler-Sources: ${sources.length}`,
      '',
    ].join('\r\n'),
    'utf8',
  );

  process.stdout.write(`javac --release ${RELEASE}: ${sources.length} sources → ${outDir}\n`);
  execFileSync(
    'javac',
    ['--release', RELEASE, '-encoding', 'UTF-8', '-nowarn', '-d', outDir, '-sourcepath', sourceRoot, ...sources],
    { stdio: 'inherit' },
  );
  execFileSync('jar', ['--create', '--file', JAR_PATH, '--manifest', manifestPath, '-C', outDir, '.'], {
    stdio: 'inherit',
  });
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.rm(metaDir, { recursive: true, force: true });

  const bytes = await fsp.readFile(JAR_PATH);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  process.stdout.write(`jar: ${path.relative(EXT_ROOT, JAR_PATH)} (${bytes.length} bytes)\n${hash}\n`);

  if (arg('no-provenance', false) === true) return;

  const listing = (prefix) =>
    sources
      .filter((file) => file.replace(/\\/g, '/').includes(prefix))
      .map((file) => path.basename(file))
      .join(', ');

  const provenance = `# Bundled compiler provenance

\`mc-compiler.jar\` is the ProgrammableFurnace compiler front-end plus the JSON CLI
driver, compiled ahead of time so the extension does **not** need the mod checkout
(or a JDK) at runtime.

| | |
| --- | --- |
| Upstream project | \`${modRoot ?? sourceRoot}\` |
| Commit | \`${commit}\`${subject === '' ? '' : ` — ${subject}`} |
| Built with | \`${javacVersion}\` / \`${jarVersion}\`, \`--release ${RELEASE}\` (class file 61 → runs on JRE ${RELEASE}+) |
| Jar | \`compiler/mc-compiler.jar\` |
| SHA-256 | \`${hash}\` |
| Size | ${bytes.length} bytes |

## Sources compiled into the jar (${sources.length} files)

\`src/main/java/dev/programmablefurnace/\`

- \`compiler/lex/\`: ${listing('/compiler/lex/')}
- \`compiler/syntax/\`: ${listing('/compiler/syntax/')}
- \`compiler/sem/\`: ${listing('/compiler/sem/')}
- \`base/\`: ${listing('/base/')}
- driver (this repository): \`tools/McCompileCli.java\`

The front-end imports only \`java.*\`, so nothing else from the mod is pulled in:
compiling the list above with \`-sourcepath\` produces exactly these packages, no
extra \`base\` or \`net\`/\`recipe\` classes.

## Rebuild

\`\`\`bash
node tools/build-compiler.mjs                       # uses ${DEFAULT_SOURCE_ROOT}
node tools/build-compiler.mjs --source-root <path>  # any checkout of src/main/java
\`\`\`

The script recompiles with \`--release ${RELEASE}\`, rewrites the jar, and regenerates this
file (commit, versions, hash) so the provenance never drifts from the binary.
`;

  await fsp.writeFile(PROVENANCE_PATH, provenance, 'utf8');

  const provenanceJson = {
    source: modRoot ?? sourceRoot,
    commit,
    commitSubject: subject,
    builtAt,
    javac: javacVersion,
    release: Number(RELEASE),
    jar: 'compiler/mc-compiler.jar',
    size: bytes.length,
    sha256: hash,
  };
  await fsp.writeFile(PROVENANCE_JSON_PATH, `${JSON.stringify(provenanceJson, null, 2)}\n`, 'utf8');

  process.stdout.write(`provenance: ${path.relative(EXT_ROOT, PROVENANCE_PATH)}\n`);
  process.stdout.write(`provenance: ${path.relative(EXT_ROOT, PROVENANCE_JSON_PATH)}\n`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
