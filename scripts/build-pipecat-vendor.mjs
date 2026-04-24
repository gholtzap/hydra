import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const vendorDir = path.join(projectRoot, "electron", "renderer", "vendor");

const bundles = [
  {
    outfile: "pipecat-client.js",
    sourcefile: "pipecat-client-entry.js",
    contents: `
      import { PipecatClient } from "@pipecat-ai/client-js";

      window.PipecatClient = PipecatClient;
    `,
  },
  {
    outfile: "pipecat-webrtc.js",
    sourcefile: "pipecat-webrtc-entry.js",
    contents: `
      import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

      window.SmallWebRTCTransport = SmallWebRTCTransport;
    `,
  },
];

await mkdir(vendorDir, { recursive: true });

await Promise.all(
  bundles.map((bundle) =>
    build({
      stdin: {
        contents: bundle.contents,
        loader: "js",
        resolveDir: projectRoot,
        sourcefile: bundle.sourcefile,
      },
      outfile: path.join(vendorDir, bundle.outfile),
      bundle: true,
      format: "iife",
      minify: true,
      platform: "browser",
      target: "es2022",
      legalComments: "none",
      sourcemap: false,
    })
  )
);
