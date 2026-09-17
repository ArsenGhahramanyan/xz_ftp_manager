import { getVsCodeApi } from './vscodeApi';

export type MessageHandler = (message: any) => void;

export class MessageBus {
    private handlers: Set<MessageHandler> = new Set();
    private listener: ((event: MessageEvent) => void) | null = null;

    constructor() {
        this.listener = (event: MessageEvent) => {
            const message = event.data;
            for (const handler of this.handlers) {
                try {
                    handler(message);
                } catch (err) {
                    console.error('[MessageBus] Handler error:', err);
                }
            }
        };
        window.addEventListener('message', this.listener);
    }

    send(message: any): void {
        getVsCodeApi().postMessage(message);
    }

    onMessage(handler: MessageHandler): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    dispose(): void {
        if (this.listener) {
            window.removeEventListener('message', this.listener);
            this.listener = null;
        }
        this.handlers.clear();
    }
}
