#!/usr/bin/env node
/**
 * Inspects an electron-builder output folder so you can answer "did the thing I
 * just changed actually make it into the app?" without unpacking anything.
 *
 * Checks that the files the app needs are present, that every runtime
 * dependency shipped, that dev-only packages did NOT ship, and that no local
 * secrets or large local state (settings, .env, Whisper models, README
 * screenshots) were packaged by accident.
 *
 * Usage:  npm run app:inspect
 * Exit code is non-zero when something is missing or leaked.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');

/** Files the server/window cannot run without. */
const REQUIRED_FILES = [
  'package.json',
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/splash.html',
  'electron/startup-error.html',
  'dist/server.cjs',
  'dist/stt-whisper.cjs',
  'dist/index.html',
  'dist/icons/icon-512.png',
];

/** Required at runtime by dist/server.cjs (built with esbuild
 *  --packages=external). Vite, by contrast, is development-only and must NOT
 *  ship — see the note in the forbidden list below. */
const REQUIRED_MODULES = ['express', 'dotenv', 'msedge-tts', 'sherpa-onnx'];

/** Build-time only — shipping these is wasted size, and `vite` in particular
 *  is a hard failure: it used to be imported at the top of src/server/index.ts
 *  and crashed the packaged server whenever it was missing. */
const FORBIDDEN_MODULES = [
  'electron',
  'electron-builder',
  'typescript',
  'tsx',
  'esbuild',
  'vite',
];

/** Harmless if present (transitive extras), but worth knowing about. */
const NOTEWORTHY_MODULES = ['tailwindcss', '@tailwindcss', '@types'];

/** Local state / secrets that must never end up inside an installer. */
const FORBIDDEN_PATHS = [
  '.env',
  'seren-settings.json',
  'models',
  path.join('dist', 'Preview'),
  path.join('node_modules', '.cache'),
];

const exists = (target) => fs.existsSync(target);
const ok = (label) => console.log(`  \u2713 ${label}`);
const bad = (label) => console.log(`  \u2717 ${label}`);
const warn = (label) => console.log(`  ! ${label}`);

function directorySize(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function findAppDirs() {
  if (!exists(RELEASE)) return [];
  return fs
    .readdirSync(RELEASE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('unpacked'))
    .map((entry) => path.join(RELEASE, entry.name, 'resources', 'app'))
    .filter((appDir) => exists(appDir));
}

function inspect(appDir) {
  console.log(`\nApp directory: ${path.relative(ROOT, appDir)}`);
  console.log(`Size: ${mb(directorySize(appDir))}\n`);

  let problems = 0;

  console.log('Required files');
  for (const relative of REQUIRED_FILES) {
    if (exists(path.join(appDir, relative))) ok(relative);
    else {
      bad(`MISSING ${relative}`);
      problems += 1;
    }
  }

  console.log('\nRuntime dependencies');
  for (const name of REQUIRED_MODULES) {
    const modulePath = path.join(appDir, 'node_modules', name);
    if (exists(modulePath)) ok(name);
    else {
      bad(`MISSING ${name} — add it to "dependencies" and rebuild`);
      problems += 1;
    }
  }

  console.log('\nBuild-only packages (should be absent)');
  for (const name of FORBIDDEN_MODULES) {
    if (!exists(path.join(appDir, 'node_modules', name))) ok(`${name} not shipped`);
    else {
      warn(`${name} is inside the app — check the "files" rules`);
      problems += 1;
    }
  }

  console.log('\nTransitive extras (informational)');
  for (const name of NOTEWORTHY_MODULES) {
    if (!exists(path.join(appDir, 'node_modules', name))) ok(`${name} not shipped`);
    else warn(`${name} shipped as a transitive dependency — harmless, only costs size`);
  }

  console.log('\nLocal secrets & state (must be absent)');
  for (const relative of FORBIDDEN_PATHS) {
    if (!exists(path.join(appDir, relative))) ok(`${relative} excluded`);
    else {
      bad(`LEAKED ${relative} — fix the "files" rules in electron-builder.yml`);
      problems += 1;
    }
  }

  const launch = fs.existsSync(path.join(appDir, '..', '..', 'seren'))
    ? path.relative(ROOT, path.join(appDir, '..', '..', 'seren'))
    : null;
  if (launch) console.log(`\nRun it without installing:  ./${launch}`);

  return problems;
}

const appDirs = findAppDirs();
if (appDirs.length === 0) {
  console.log('No packaged app found. Build one first:  npm run app:dist');
  process.exit(1);
}

let totalProblems = 0;
for (const appDir of appDirs) totalProblems += inspect(appDir);

console.log(
  totalProblems === 0
    ? '\nAll checks passed.\n'
    : `\n${totalProblems} problem(s) found — see above.\n`
);
process.exit(totalProblems === 0 ? 0 : 1);
