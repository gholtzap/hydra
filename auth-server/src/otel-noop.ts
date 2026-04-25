// Noop shim for @opentelemetry/api — not needed in Cloudflare Workers
const SpanStatusCode = { OK: 0, ERROR: 1, UNSET: 2 } as const;

const noopSpan = {
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  addEvent: () => noopSpan,
  setStatus: () => noopSpan,
  end: () => {},
  isRecording: () => false,
  recordException: () => {},
  updateName: () => noopSpan,
  spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0 }),
};

const noopTracer = {
  startSpan: () => noopSpan,
  startActiveSpan: (_name: string, ...args: any[]) => {
    const fn = args[args.length - 1];
    return typeof fn === "function" ? fn(noopSpan) : noopSpan;
  },
};

const trace = {
  getTracer: () => noopTracer,
  getActiveSpan: () => undefined,
};

export { SpanStatusCode, trace };
