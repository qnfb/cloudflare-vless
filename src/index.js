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

const process = async (request, server, uuid) => {
  const stream = new ReadableStream({
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
          console.log(`connection closed: ${event.reason}`);
        }
        controller.close();
      });
    },
  });

  const { promise, resolve, reject } = Promise.withResolvers();
  let version;
  let port;
  let address;
  let socket;
  stream.pipeTo(new WritableStream({
    write: (chunk) => {
      let byteOffset = 0;
      if (!socket) {
        try {
          ({
            version, port, address, byteOffset,
          } = decodeRequestHeader(chunk, uuid));
          console.log(`connection to ${address}:${port}`);
          socket = connect({ hostname: address, port });
        } catch (e) {
          console.log(e);
          reject();
          return;
        }
      }
      const writer = socket.writable.getWriter();
      writer.write(chunk.slice(byteOffset));
      writer.releaseLock();
      resolve();
    },
    close: () => {
      if (socket) {
        socket.close();
      }
    },
  }));
  await promise;

  let response;
  socket.readable.pipeTo(new WritableStream({
    write: async (chunk) => {
      if (!response) {
        response = await new Blob([new Uint8Array([version, 0]), chunk]).arrayBuffer();
      } else {
        response = chunk;
      }
      server.send(response);
    },
  }));
};

export default {
  async fetch(request, env) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response(null, { status: 426 });
    }

    const [client, server] = new WebSocketPair();
    server.accept();
    process(request, server, env.UUID);
    return new Response(null, { status: 101, webSocket: client });
  },
};
