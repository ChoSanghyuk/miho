import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@orch/shared';

type Listener = (event: ServerEvent) => void;

/** In-process event bus. WebSocket clients and the Telegram module subscribe here. */
export class EventBus {
  private emitter = new EventEmitter().setMaxListeners(0);

  emit(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
