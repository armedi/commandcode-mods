type Waiter<T> = {resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void};

export class Queue<T> implements AsyncIterable<T> {
	private items: T[] = [];
	private waiters: Array<Waiter<T>> = [];
	private closed = false;
	private failed = false;
	private failure: unknown;

	push(item: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({value: item, done: false});
		else this.items.push(item);
	}

	/** Ends the queue with an error: items already queued are still read, then every reader rejects. */
	fail(error: unknown): void {
		if (this.closed) return;
		this.closed = true;
		this.failed = true;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter.resolve({value: undefined as never, done: true});
		}
	}

	next(): Promise<IteratorResult<T>> {
		if (this.items.length > 0) return Promise.resolve({value: this.items.shift()!, done: false});
		if (this.closed) {
			if (this.failed) return Promise.reject(this.failure);
			return Promise.resolve({value: undefined as never, done: true});
		}
		return new Promise((resolve, reject) => this.waiters.push({resolve, reject}));
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this;
	}
}
