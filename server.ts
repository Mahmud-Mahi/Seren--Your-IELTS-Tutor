/**
 * Entry point — kept as the thin boot file so the existing npm scripts
 * (dev/build/start) keep working unchanged. All real logic now lives in
 * focused modules under src/server/ (see src/server/index.ts).
 */
import './src/server/index';
