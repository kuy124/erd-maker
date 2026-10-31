/**
 * The Node socket factory: ws, claiming the origin the relay allowlists.
 *
 * Kept apart from live.ts so a Workers build can bundle the room logic without
 * pulling in ws, which has no Worker equivalent.
 */

import NodeWebSocket from 'ws';
import type { SocketFactory } from './live';

/**
 * A socket that claims an origin.
 *
 * The relay allowlists browser origins and Node sends none, so the socket has to
 * state one or the relay refuses the handshake.
 */
export const nodeSocketFactory: SocketFactory = (origin) => {
  class OriginSocket extends NodeWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { origin });
    }
  }
  return OriginSocket as unknown as typeof WebSocket;
};
