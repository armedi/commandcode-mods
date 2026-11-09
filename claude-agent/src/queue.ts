export class Queue<T> implements AsyncIterable<T> {
	private items: T[] = [];
	private waiters: Array<(result: IteratorResult<T>) => void> = [];
	private closed = false;
	private failure: unknown;

	push(item: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({value: item, done: false});
		else this.items.push(item);
	}

	fail(error: unknown): void {
		this.failure = error;
		this.close();
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter({value: undefined as never, done: true});
		}
	}

	next(): Promise<IteratorResult<T>> {
		const item = this.items.shift();
		if (item !== undefined) return Promise.resolve({value: item, done: false});
		if (this.closed) {
			if (this.failure) return Promise.reject(this.failure);
			return Promise.resolve({value: undefined as never, done: true});
		}
		return new Promise(resolve => this.waiters.push(resolve));
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this;
	}
}
