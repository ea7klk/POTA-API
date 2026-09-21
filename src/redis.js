import net from 'node:net';

const REDIS_ERROR = {};

function encodeCommand(parts) {
  const buffers = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const value = Buffer.from(String(part));
    buffers.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
  }
  return Buffer.concat(buffers);
}

function parseResponse(buffer) {
  const lineEnd = buffer.indexOf('\r\n');
  if (lineEnd < 0) return null;
  const prefix = String.fromCharCode(buffer[0]);
  if (prefix === '$') {
    const length = Number(buffer.subarray(1, lineEnd).toString());
    if (length === -1) return { value: null, bytes: lineEnd + 2 };
    const end = lineEnd + 2 + length + 2;
    if (buffer.length < end) return null;
    return { value: buffer.subarray(lineEnd + 2, lineEnd + 2 + length).toString(), bytes: end };
  }
  if (prefix === '+' || prefix === ':') return { value: buffer.subarray(1, lineEnd).toString(), bytes: lineEnd + 2 };
  if (prefix === '-') throw new Error(`Redis command failed: ${buffer.subarray(1, lineEnd).toString()}`);
  throw new Error(`Unsupported Redis response type: ${prefix}`);
}

function executeCommand(host, port, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    socket.setTimeout(timeoutMs, () => finish(reject, new Error(`Redis operation timed out after ${timeoutMs}ms`)));
    socket.once('error', (error) => finish(reject, error));
    socket.on('data', (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parseResponse(buffer);
        if (parsed) finish(resolve, parsed.value);
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.once('connect', () => socket.write(encodeCommand(command)));
  });
}

export function createRedisCache({ url, timeoutMs = 500, logger = console.error }) {
  if (!url) return null;
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = Number(parsed.port || 6379);

  async function run(command, errorValue = null) {
    try {
      return await executeCommand(host, port, command, timeoutMs);
    } catch (error) {
      logger(`Redis command failed: ${error.message}`);
      return errorValue;
    }
  }

  return {
    get: (key) => run(['GET', key]),
    set: (key, value, ttlMs) => run(['SET', key, value, 'EX', Math.max(1, Math.ceil(ttlMs / 1000))]),
    setIfAbsent: async (key, value, ttlMs) => {
      const result = await run(['SET', key, value, 'NX', 'EX', Math.max(1, Math.ceil(ttlMs / 1000))], REDIS_ERROR);
      return result === REDIS_ERROR ? undefined : result === 'OK';
    },
    del: (key) => run(['DEL', key]),
    close: async () => {},
  };
}
