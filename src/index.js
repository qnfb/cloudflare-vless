// eslint-disable-next-line import/no-unresolved
import { connect } from 'cloudflare:sockets';

const base64toArrayBuffer = (base64) => {
  if (!base64) return null;
  const basic = base64.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(basic), (ch) => ch.charCodeAt(0)).buffer;
};

const decodeRequestHeader = (header, uuid) => {
  let byteOffset = 0;

  const [version] = new Uint8Array(header, byteOffset, 1);
  byteOffset += 1;

  const id = (new Uint8Array(header, byteOffset, 16)).reduce(
    (previousValue, currentValue, currentIndex) => previousValue.toString(16)
      + ([4, 6, 8, 10].indexOf(currentIndex) !== -1 ? '-' : '')
      + currentValue.toString(16),
  );
  if (id !== uuid) {
    throw new Error(`unknow UUID: ${id}`);
  }
  byteOffset += 16;

  const [addonsLen] = new Uint8Array(header, byteOffset, 1);
  byteOffset += 1 + addonsLen;

  const [command] = new Uint8Array(header, byteOffset, 1);
  byteOffset += 1;

  if (command !== 1) { // TCP
    throw new Error(`unknow command ${command}`); // 2 UDP 3 MUX
  }

  const port = new DataView(header, byteOffset, 2).getUint16(0);
  byteOffset += 2;

  const [af] = new Uint8Array(header, byteOffset, 1);
  byteOffset += 1;

  let addressLen;
  let address;
  if (af === 1) { // IPv4
    addressLen = 4;
    address = new Uint8Array(header, byteOffset, addressLen).join('.');
  } else if (af === 2) { // FQDN
    [addressLen] = new Uint8Array(header, byteOffset, 1);
    byteOffset += 1;
    address = new TextDecoder().decode(header.slice(byteOffset, byteOffset + addressLen));
  } else if (af === 3) { // IPv6
    addressLen = 16;
    const view = new DataView(header.slice(byteOffset, byteOffset + addressLen));
    const ipv6 = [];
    for (let i = 0; i < 8; i += 1) {
      ipv6.push(view.getUint16(i * 2).toString(16));
    }
    address = ipv6.join(':');
  } else {
    throw new Error(`unknow address family: ${af}`);
  }
  byteOffset += addressLen;

  return {
    version,
    port,
    address,
    byteOffset,
  };
};

const { log } = console;

const tproxy = async ({
  server, stream, version, socket,
}) => {
  stream.pipeTo(socket.writable);
  let response;
  await socket.readable.pipeTo(new WritableStream({
    write: async (chunk) => {
      if (!response) {
        response = await new Blob([new Uint8Array([version, 0]), chunk]).arrayBuffer();
      } else {
        response = chunk;
      }
      server.send(response);
    },
  }));

  socket.close();
  socket.closed.catch(({ message }) => {
    log(`outbound connection closed: ${message}`);
  });

  return response;
};

const process = (request, env) => {
  log(`inbound connection from: ${request.headers.get('CF-connecting-IP')}`);

  // eslint-disable-next-line no-undef
  const [client, server] = new WebSocketPair();
  server.accept();

  // 0-RTT
  const stream1 = new ReadableStream({
    start: (controller) => {
      const earlyData = request.headers.get('Sec-WebSocket-Protocol');
      if (earlyData) {
        controller.enqueue(base64toArrayBuffer(earlyData));
      }

      server.addEventListener('message', (event) => {
        controller.enqueue(event.data);
      });

      server.addEventListener('close', (event) => {
        if (!event.wasClean) {
          log(`inbound connection closed: ${event.reason}`);
        }
        try {
          controller.close();
        } catch (e) {
          log(e);
        }
      });
    },
  });

  // get rid of header
  const { promise, resolve, reject } = Promise.withResolvers();
  let version;
  let port;
  let address;
  const stream2 = new ReadableStream({
    start: async (controller) => {
      try {
        server.addEventListener('close', () => controller.close());
        // eslint-disable-next-line no-restricted-syntax
        for await (const chunk of stream1) {
          let byteOffset = 0;
          if (!port) {
            ({
              version, port, address, byteOffset,
            } = decodeRequestHeader(chunk, env.UUID));
            resolve();
          }
          controller.enqueue(chunk.slice(byteOffset));
        }
      } catch (e) {
        reject(e);
      }
    },
  });
  const [teedOff1, teedOff2] = stream2.tee();

  promise.then(async () => {
    log(`outbound connection to ${address}:${port}`);
    const response = await tproxy({
      server, stream: teedOff1, version, socket: connect({ hostname: address, port }),
    });
    if (response) return;

    const [hostname, port1] = env.PROXY.split(':');
    if (!hostname) return;
    const port2 = port1 || 443;
    log(`proxy connection to ${hostname}:${port2}`);
    tproxy({
      server, stream: teedOff2, version, socket: connect({ hostname, port: port2 }),
    });
  }).catch(log);

  return new Response(null, { status: 101, webSocket: client });
};

export default {
  async fetch(request, env) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response(null, { status: 426 });
    }
    return process(request, env);
  },
};
