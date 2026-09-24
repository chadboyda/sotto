// WebSocket constructor adapter (SPEC §0.2 #4). Node 22's global WebSocket
// (undici) accepts a non-standard {headers} option, verified in probe P9.
// If it ever proves flaky, swap in the `ws` package here and nowhere else.
export const WebSocketImpl = globalThis.WebSocket;
