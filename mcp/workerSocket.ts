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
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = WorkerWebSocket.CONNECTING;
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
      const response = await fetch(url, {
        headers: { Upgrade: 'websocket', Origin: origin, Connection: 'Upgrade' },
      });
      const socket = response.webSocket;
      if (!socket) throw new Error('The relay did not upgrade the connection.');
      this.socket = socket;
      socket.accept();
      socket.addEventListener('message', (event) => {
        this.onmessage?.({ data: (event as MessageEvent).data });
      });
      socket.addEventListener('close', (event) => {
        this.readyState = WorkerWebSocket.CLOSED;
        this.onclose?.(event);
      });
      socket.addEventListener('error', (event) => {
        this.onerror?.(event);
      });
      this.readyState = WorkerWebSocket.OPEN;
      this.onopen?.({});
      for (const data of this.queued.splice(0)) this.send(data);
    } catch (error) {
      this.readyState = WorkerWebSocket.CLOSED;
      this.onerror?.(error);
    }
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== WorkerWebSocket.OPEN || !this.socket) {
      this.queued.push(data);
      return;
    }
    this.socket.send(data as string | ArrayBuffer);
  }

  close(): void {
    this.readyState = WorkerWebSocket.CLOSING;
    this.socket?.close();
    this.readyState = WorkerWebSocket.CLOSED;
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
