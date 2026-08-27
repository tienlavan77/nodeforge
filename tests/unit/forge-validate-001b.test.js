import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

const requiredModules = [
  'src/modules/agent/agent-runtime.js',
  'src/modules/agent/agent-gateway.js',
  'src/modules/verification/orchestrator.js',
  'src/modules/workflows/state-machine-executor.js',
  'src/transport/http/server.js',
];

test('required runtime modules are present', async () => {
  await Promise.all(
    requiredModules.map(async (relativePath) => {
      const absolutePath = path.join(projectRoot, relativePath);
      await assert.doesNotReject(
        access(absolutePath),
        `expected ${relativePath} to exist`,
      );
    }),
  );
});
