import { createBootstrap } from "../src/bootstrap/index.js";

const handlesBefore = new Set(process._getActiveHandles());
const bootstrap = createBootstrap({ loggerOptions: { sink: { log() {} } } });

await bootstrap.start();
await bootstrap.stop();
await new Promise((resolve) => setImmediate(resolve));

const leakedHandles = process._getActiveHandles().filter((handle) => !handlesBefore.has(handle));
if (leakedHandles.length > 0) {
  throw new Error(`Bootstrap leaked ${leakedHandles.length} active handle(s).`);
}

console.log("Bootstrap started and stopped without leaking handles.");
