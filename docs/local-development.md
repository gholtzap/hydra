# Local Development

## Electron app

```bash
npm install
npm start
```

This is now the active desktop implementation path.

## Legacy Swift shell

The earlier Swift shell remains in the repo as reference material while the Electron version takes over:

```bash
./scripts/build-app.sh
./scripts/run-app.sh
```

## Notes

- The active terminal stack is Electron + `xterm.js` with a Node PTY host process.
- The Swift app is no longer the long-term implementation path.
- Product requirements and future ideas live in [product-memory.md](/Users/gmh/dev/dot/claude-code-workspace/docs/product-memory.md).
