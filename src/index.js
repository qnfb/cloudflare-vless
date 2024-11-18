// eslint-disable-next-line import/no-unresolved
import { connect } from 'cloudflare:sockets';

const { log } = console;

const base64toArrayBuffer = (base64) => {
  if (!base64) return null;
  const basic = base64.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(basic), (ch) => ch.charCodeAt(0)).buffer;
};

const decode0RTT = (request, server) => new ReadableStream({
  start: (controller) => {
    const earlyData = request.headers.get('Sec-WebSocket-Protocol');
    if (earlyData) controller.enqueue(base64toArrayBuffer(earlyData));

    server.addEventListener('message', (event) => {
      controller.enqueue(event.data);
    });

    server.addEventListener('close', (event) => {
      if (!event.wasClean) {
        log(`inbound connection closed: ${event.reason}`);
      }
      controller.close();
    });
  },
});

const decodeVLESSHeader = (header, uuid) => {
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
  let hostname;
  if (af === 1) { // IPv4
    addressLen = 4;
    hostname = new Uint8Array(header, byteOffset, addressLen).join('.');
  } else if (af === 2) { // FQDN
    [addressLen] = new Uint8Array(header, byteOffset, 1);
    byteOffset += 1;
    hostname = new TextDecoder().decode(header.slice(byteOffset, byteOffset + addressLen));
  } else if (af === 3) { // IPv6
    addressLen = 16;
    const view = new DataView(header.slice(byteOffset, byteOffset + addressLen));
    const ipv6 = [];
    for (let i = 0; i < 8; i += 1) {
      ipv6.push(view.getUint16(i * 2).toString(16));
    }
    hostname = ipv6.join(':');
  } else {
    throw new Error(`unknow address family: ${af}`);
  }
  byteOffset += addressLen;

  return {
    version,
    port,
    hostname,
    byteOffset,
  };
};

const decodeVLESS = (vless, UUID) => new Promise((resolve, reject) => {
  let isDecoded;
  // need identity stream here to let Promise resolved
  const identity = new TransformStream();
  const body = identity.readable;
  vless.pipeThrough(new TransformStream({
    transform: (chunk, controller) => {
      try {
        if (!isDecoded) {
          const {
            version, port, hostname, byteOffset,
          } = decodeVLESSHeader(chunk, UUID);

          resolve({
            version, port, hostname, body,
          });

          controller.enqueue(chunk.slice(byteOffset));
          isDecoded = true;
        } else {
          controller.enqueue(chunk);
        }
      } catch (e) {
        reject(e);
      }
    },
  })).pipeTo(identity.writable);
});

const encodeResponse = (server, version, socket) => {
  let isEncoded;
  // avoid socket closed by reading
  const [r1, r2] = socket.readable.tee();
  r2.cancel();
  return r1.pipeTo(new WritableStream({
    write: (chunk) => {
      if (server.readyState !== 1) return;
      if (!isEncoded) {
        isEncoded = true;
        new Blob([new Uint8Array([version, 0]), chunk]).arrayBuffer()
          .then(server.send.bind(server));
      } else {
        server.send(chunk);
      }
    },
  })).then(() => isEncoded);
};

const processSocket = (server, version, body, hosts) => {
  log(`outbound connection to ${hosts[0].hostname}:${hosts[0].port}`);
  // backup for retry
  const [bodyTeed, backup] = body.tee();
  // close of writable is controlled by pipeTo, do not close by itself
  const socket = connect(hosts[0], { allowHalfOpen: true });
  let isEncoded;
  // prevent internal error when connect failed
  bodyTeed.pipeTo(socket.writable, { preventCancel: true });
  encodeResponse(server, version, socket).then((value) => {
    isEncoded = value;
  }).finally(() => {
    if (server.readyState === 1 && !isEncoded && hosts.length > 1) {
      processSocket(server, version, backup, hosts.slice(1));
    }
  });
  socket.closed.catch((reason) => log(`outbound connection closed: ${reason.message}`));
};

const process = (request, env) => {
  log(`inbound connection from: ${request.headers.get('CF-connecting-IP')}`);
  // eslint-disable-next-line no-undef
  const [client, server] = new WebSocketPair();
  server.accept();

  decodeVLESS(decode0RTT(request, server), env.UUID).then(({
    version, port, hostname, body,
  }) => {
    const hosts = [{ hostname, port }];
    const [proxyHostname, proxyPort = 443] = env.PROXY.split(':');
    if (hostname) hosts.push({ hostname: proxyHostname, port: proxyPort });
    processSocket(server, version, body, hosts);
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
