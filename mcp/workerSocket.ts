/**
 * A WebSocket a Worker can actually open.
 *
 * `y-websocket` builds its socket with `new WebSocket(url)`, which a Worker
 * cannot do: there is no global WebSocket constructor that takes a URL. What a
 * Worker can do is `fetch` with an Upgrade header and read the socket off the
 * response. This adapter has the shape `y-websocket` expects and performs that
 * fetch underneath, so live rooms work when hosted.
 */

import type { SocketFactory } from './live';

/** The events y-websocket listens for, in the order a socket fires them. */
type Handler = ((event: unknown) => void) | null;

class WorkerWebSocket {
  /*
   * These are instance fields, not static ones, and that is load-bearing.
   *
   * y-websocket decides whether it may send with
   * `ws.readyState === ws.OPEN`, where `ws` is the socket instance. A static
   * field is not on the instance, so `ws.OPEN` was undefined, the comparison
   * was always false, and every update was dropped in silence: the socket
   * connected, the handshake completed, and nothing the assistant drew ever
   * reached the room.
   */
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  onmessage: Handler = null;

  private socket: WebSocket | null = null;
  private readonly queued: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

  constructor(url: string, origin: string) {
    void this.open(url, origin);
  }

  private async open(url: string, origin: string): Promise<void> {
    try {
      /*
       * fetch() in a Worker speaks http(s), not ws(s).
       *
       * y-websocket builds a wss:// URL, and fetch rejects that scheme outright
       * ("Fetch API cannot load"). The upgrade is requested by the headers, so
       * the scheme only has to be one fetch accepts.
       */
      const target = url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      const response = await fetch(target, {
        // Only Upgrade is set. Connection is a forbidden header name in the
        // fetch spec, and Workers rejects a request that tries to set it;
        // the runtime adds the upgrade itself.
        headers: { Upgrade: 'websocket', Origin: origin },
      });
      const socket = response.webSocket;
      if (!socket) {
        throw new Error(`The relay did not upgrade the connection (HTTP ${response.status}).`);
      }
      this.socket = socket;
      socket.accept();
      socket.addEventListener('message', (event) => {
        /*
         * Deliver a Uint8Array, not the raw ArrayBuffer.
         *
         * lib0, which y-websocket decodes every frame with, reads a
         * Uint8Array or a plain array. Handed an ArrayBuffer it throws
         * "Unexpected end of array", so the sync reply that tells the
         * provider its write landed was dropped and the room stayed empty.
         */
        const data = (event as MessageEvent).data;
        this.onmessage?.({
          data: data instanceof ArrayBuffer ? new Uint8Array(data) : data,
        });
      });
      socket.addEventListener('close', (event) => {
        this.readyState = this.CLOSED;
        this.onclose?.(event);
      });
      socket.addEventListener('error', (event) => {
        this.onerror?.(event);
      });
      this.readyState = this.OPEN;
      this.onopen?.({});
      for (const data of this.queued.splice(0)) this.send(data);
    } catch (error) {
      this.readyState = this.CLOSED;
      console.error('erd-maker: relay socket failed:', error instanceof Error ? error.message : error);
      this.onerror?.(error);
    }
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== this.OPEN || !this.socket) {
      this.queued.push(data);
      return;
    }
    this.socket.send(data as string | ArrayBuffer);
  }

  close(): void {
    this.readyState = this.CLOSING;
    this.socket?.close();
    this.readyState = this.CLOSED;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    if (type === 'open') this.onopen = handler;
    else if (type === 'close') this.onclose = handler;
    else if (type === 'error') this.onerror = handler;
    else if (type === 'message') this.onmessage = handler;
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    if (type === 'open' && this.onopen === handler) this.onopen = null;
    else if (type === 'close' && this.onclose === handler) this.onclose = null;
    else if (type === 'error' && this.onerror === handler) this.onerror = null;
    else if (type === 'message' && this.onmessage === handler) this.onmessage = null;
  }
}

/** The socket factory a hosted run hands to `live.ts`. */
export const workerSocketFactory: SocketFactory = (origin) => {
  class Bound extends WorkerWebSocket {
    constructor(url: string | URL) {
      super(String(url), origin);
    }
  }
  return Bound as unknown as typeof WebSocket;
};
