export type Subscriber<T> = (state: T) => void;

export class Store<T extends object> {
    private state: T;
    private subscribers: Set<Subscriber<T>> = new Set();

    constructor(initialState: T) {
        this.state = { ...initialState };
    }

    getState(): T {
        return this.state;
    }

    setState(partial: Partial<T>): void {
        this.state = { ...this.state, ...partial };
        this.notify();
    }

    subscribe(fn: Subscriber<T>): () => void {
        this.subscribers.add(fn);
        return () => {
            this.subscribers.delete(fn);
        };
    }

    private notify(): void {
        for (const fn of this.subscribers) {
            try {
                fn(this.state);
            } catch (err) {
                console.error('[Store] Subscriber error:', err);
            }
        }
    }
}
