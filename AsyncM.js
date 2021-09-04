/*
 *  1. utility 
 */

const unit = undefined;
 
/*
 *  2. Progress 
 */

class Progress {
	constructor(parent) {
		if (parent) {
			this.parent = parent; 
			parent.children.push(this);
		}
	}

	cancelled = false;
	paused = false;
	pending = [];
	children = [];
	cancellers = [];
	
	unlink () { 
		if (this.parent) {
			this.parent.children = this.parent.children.filter(c => c != this); 
		}
	}

	addCanceller = c => this.cancellers.push(c)

	removeCanceller = c1 => { this.cancellers = this.cancellers.filter(c => c != c1) }

	isAlive () { return ! this.cancelled; }

	cancel () { 
		if (! this.cancelled) { 
			this.cancelled = true; 
			this.cancellers.forEach(c => setTimeout(c, 0)); 
			this.children.forEach(c => c.cancel());

			this.cancellers = [];
		} 
	}

	pause () { this.paused = true; }

	resume() { 
		this.paused = false;
		let l = this.pending
		this.pending = [] 
		if (this.isAlive()) l.forEach(k => k()); 
	}

	isPaused (k) { 
		if (this.paused) { 
			this.pending.push(k)
			return true;
		}
		else if (this.parent) {
			return this.parent.isPaused(k); 
		}
		else {
			return false;
		}
	}
}

/*
 *  3. AsyncM 
 */

class AsyncM {
	// run :: Progress -> Promise a 
	constructor (run) {
		this.run = run;
	}

	seq = a => this.bind(_ => a)

	loop = _ => new AsyncM (async p => { while(true) { await this.run(p) } })

	while = f => new AsyncM (async p => { while (f()) { await this.run(p) } })

	if = f => new AsyncM (async p => (f())? this.run(p) : unit)

	block = _ => new AsyncM(_ => this.run(new Progress()))

	start = (p = new Progress()) => { AsyncM.timeout(0).bind(_=>this).run_(p); return p; } 

	run_ = p => this.run(p).catch(e => { if (e != "interrupted") throw e; else console.log(e); }); 

	// catch exception in 'this' with handler 'h'
	// AsyncM a -> (e -> a) -> AsyncM a
	catch = h => new AsyncM(p => this.run(p).catch(h))

	// f <$> this
	fmap = f => new AsyncM (p => this.run(p).then(f)); 

	// this >>= f
	bind = f => new AsyncM (p => this.run(p).then(x => { let r = f(x); return (r && r.run) ? r.run(p) : r })); 

	// flatten an AsyncM of AsyncM
	join = _ => this.bind(m => m)

	// this <*> mx
	app = mx => this.bind(f => mx.bind(x => AsyncM.pure(f(x))))

	// return an AsyncM of AsyncM to wait for the result of 'this'
	// AsyncM a -> _ -> AsyncM (AsyncM a)
	spawn = _ => new AsyncM (async p => new AsyncM(_ => this.run_(p)));


	// fork 'this' as a thread and return its progress 
	fork = _ => new AsyncM (async p => {
			const p1 = new Progress(p);
			AsyncM.timeout(0)
				.bind(_=>this)
				.run_(p1)
				.finally(_ => p1.unlink()); // unlink parent to child reference after completion
			return p1; 
		    })

	// fork a list of threads
	static fork = lst => new AsyncM (async p => 
			lst.map(m => {
				const p1 = new Progress(p);
				AsyncM.timeout(0)
					.bind(_=>m)
					.run_(p1)
					.finally(_ => p1.unlink());
				return p1;
			}))

	// pure value as AsyncM
	static pure = x => new AsyncM ( p => Promise.resolve(x) )  

	static throw = e => new AsyncM( p => Promise.reject(e) )

	// liftIO :: ((a -> IO ()) -> IO ()) -> AsyncM a
	static liftIO = cont => new AsyncM (p => new Promise((k, r) => {
		let c1 = _ => r("interrupted"); 
		if (p.isAlive()) { 
			p.addCanceller(c1);

			let k1 = x => {
				p.removeCanceller(c1)	
				if (!p.isPaused(_ => k(x))) k(x); 
			}
			cont(k1)
		}
		else c1();
	}))

	// liftIO :: Promise a -> AsyncM a
        static liftIO_ = promise => AsyncM.liftIO(k => promise.then(k))

	// an AsyncM that never completes 
	static never = new AsyncM (p => new Promise(_ => {}))

	// completes after 'n' millisecond timeout
	static timeout = n => AsyncM.liftIO(k => setTimeout(k, n))

	// cancel the current progress
	static cancel = new AsyncM (p => new Promise(k => { p.cancel(); k() }));

	// continues only if 'p' is still alive 
	static ifAlive = new AsyncM (p => new Promise((k, r) => { 
		if (p.isAlive()) { 
			k();
		}
		else {
			r("interrupted"); 
		}
	}));

	// if alive, then cancel
	static commit = AsyncM.ifAlive.bind(_ => AsyncM.cancel);

	// race two AsyncM and the winner is the one completes or throws exception first.
	static race = lst => new AsyncM (p => {
		let p1 = new Progress(p);
		return Promise.race(lst.map(m => m.run_(p1)))
			.finally(_ => { p1.cancel(); p1.unlink(); }); 
	});

	// race two AsyncM and the winner is the one completes first.
	static any = lst => new AsyncM (p => {
		let p1 = new Progress(p);
		return Promise.any(lst.map(m => m.run_(p1)))
			.finally(_ => { p1.cancel(); p1.unlink(); }); 
	});

	// run two AsyncM and wait for both of their results
	static all = lst => new AsyncM (p => Promise.all(lst.map(m => m.run(p))));

}


/*
 *  4. MVar
 */

class MVar {
	constructor() {
		this.value = undefined;
		this.isEmpty = true;
		this.readers = []; // pending readers
		this.pending = []; // pending putters or takers 
	}

	// a -> AsyncM ()
	putAsync = x => new AsyncM(p => new Promise((k, r) => {
		if (! this.isEmpty) { 
			let k1 = _ => {
				p.removeCanceller(c1);
				this._put(x);
				setTimeout(k, 0);
			}
			let c1 = _ => {
				this.pending = this.pending.filter(writer => writer != k1);		
				r("interrupted");
			}
			p.addCanceller(c1)
			// run 'k' after timeout to simulate waking up a thread
			this.pending.push(k1) 
		}
		else {
			this._put(x);
			k();
		}
	}))

	_put = x => {
		this.isEmpty = false;
		this.value = x;

		if (this.readers.length > 0) {
			for(let i = 0; i < this.readers.length; i++ ) { this.readers[i](); }
			this.readers = [];
		}
		if (this.pending.length > 0) { this.pending.shift()(); }
	}

	// AsyncM a
	takeAsync = new AsyncM(p => new Promise((k, r) => { 
		if (this.isEmpty) { 
			let k1 = _ => {
				p.removeCanceller(c1)	
				setTimeout(_=>k(this._take()), 0)
			}
			let c1 = _ => {
				this.pending = this.pending.filter(taker => taker != k1)
				r("interrupted");
			}
			p.addCanceller(c1)
			// run 'k' after timeout to simulate waking up a thread 
			this.pending.push(k1)
		} 
		else k(this._take())
	}))

	_take = _ => { 
		this.isEmpty = true; 
		let x = this.value;

		if (this.pending.length > 0) { this.pending.shift()(); }

		return x;	
	} 

	// AsyncM a
	readAsync = new AsyncM(p => new Promise((k, r) => { 
		if (this.isEmpty) { 
			let k1 = _ => {
				p.removeCanceller(c1)	
				setTimeout(_ =>k(this.value), 0)
			}
			let c1 = _ => {
				this.readers = this.readers.filter(reader => reader != k1)
				r("interrupted")
			}
			p.addCanceller(c1)
			// run 'k' after timeout to simulate waking up a thread  
			this.readers.push(k1)
		} 
		else k(this.value)  
	}))
}


/*
 *  5. Channels
 */

// unbounded buffer, not cancellable
class Channel {
	constructor() {
		this.data = [];			// data buffer
		this.listeners = [];		// reader queue
	}

	// read :: (a -> IO()) -> IO()
	read = k => {
		const d = this.data;
		if(d.length > 0) { 
			k(d.shift()); 		// read one data
		} else { 
			this.listeners.push(k); // add reader to the queue
		}
	};

	// write :: a -> IO()
	write = x => {
		const l = this.listeners;
		if(l.length > 0) {
			const k = l.shift(); 	// wake up one reader in FIFO order
			k(x);
		}
		else {
			this.data.push(x); 	// buffer if no reader in the queue
		}
	}

	readAsync = new AsyncM(p => new Promise(this.read))
	writeAsync = x => new AsyncM(p => new Promise(k => { this.write(x); k() })) 
}

// bounded channel with circular buffer
// there will be either 
// 	pending readers (buffer empty) or 
// 	pending writers (buffer full) 
// 	but not both
class BChannel {
	constructor(size) {
		if (!size || size < 1) size = 1; // minimum size is 1

		this.data = [];   this.readers = [];  this.writers = []
		this.size = size; this.readIndex = 0; this.writeIndex = 0; this.n = 0
	}

	isEmpty = _ => this.n <= 0
	isFull = _ => this.n >= this.size

	// read :: (a -> IO()) -> IO()
	read = k => {
		// if buffer is empty, then push this reader into the pending readers list
		if (this.isEmpty()) this.readers.push(_ => this._read(x => setTimeout(_=>k(x), 0)))
		else this._read(k) 
	}

	_read = k => {
		let d = this.data[this.readIndex]
		this.readIndex = (this.readIndex + 1) % this.size
		this.n = this.n - 1

		// if there are pending writers, then run the first one
		if (this.writers.length > 0) { this.writers.shift()(); }

		k(d) // return the data
	}

	// write :: a -> (() -> IO()) -> IO ()
	write = x => (k => {
		// if channel is full, then push this writer into the pending writers list
		if (this.isFull()) this.writers.push(_ => this._write(x)(_ => setTimeout(_=>k(unit), 0)))
		else this._write(x)(k)
	});

	_write = x => k => {
		this.data[this.writeIndex] = x // write data
		this.writeIndex = (this.writeIndex + 1) % this.size
		this.n = this.n + 1

		// if there are pending readers, then run the first one
		if (this.readers.length > 0) { this.readers.shift()() }

		k() // return
	}

	readAsync = new AsyncM(p => new Promise((k, r) => {
		// if buffer is empty, then push this reader into the pending readers list
		if (this.isEmpty()) {
			let k1 = _ => { 
				p.removeCanceller(c1)
				this._read(x => setTimeout(_=>k(x), 0)) 
			}
			let c1 = _ => {
				this.readers = this.readers.filter(reader => reader != k1)
				r("interrupted")
			}
			p.addCanceller(c1)
			this.readers.push(k1)
		}
		else this._read(k) 
	}))

	writeAsync = x => new AsyncM(p => new Promise((k, r) => {
		// if channel is full, then push this writer into the pending writers list
		if (this.isFull()) { 
			let k1 = _ => {
				p.removeCanceller(c1)
				this._write(x)(_ => setTimeout(_=>k(unit), 0)) 
			}
			let c1 = _ => {
				this.writers = this.writers.filter(writer => writer != k1)
				r("interrupted")
			}
			p.addCanceller(c1)
			this.writers.push(k1)
		}
		else this._write(x)(k)
	}))
}

// MVar-based bounded channel
class MChannel {
	constructor(size) { 
		this.size = size; // max size
		this.data = [];
		this.n = 0; // current size
		this.m = new MVar();
	}

	isEmpty = _ => this.n <= 0
	isFull = _ => this.n >= this.size

	readAsync = new AsyncM(async p => {
		let ret

		if (this.isEmpty()) {
			ret = await this.m.takeAsync.run(p)
		}
		else {
			ret = this.data.shift();
			
			if (!this.m.isEmpty) { // has pending data or writers
				let x = await this.m.takeAsync.run(p)
				this.data.push(x)
			}
			else {
				this.n = this.n - 1;
			}
		}
		return ret;
	})

	writeAsync = x => new AsyncM(async p => {
		if (this.isFull() || 
			this.m.pending.length > 0) {  // has pending readers
			await this.m.putAsync(x).run(p)
		}
		else {
			this.n = this.n + 1;
			this.data.push(x);
		}
		return
	})
}
