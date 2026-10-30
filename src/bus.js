import { EventEmitter } from 'node:events';
// Internal event bus: 'message.created', 'message.updated', 'message.deleted',
// 'reaction', 'group.updated', 'connection'
export const bus = new EventEmitter();
bus.setMaxListeners(100);
