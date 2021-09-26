
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
			// TODO: The thread cancellation is blocking like what Haskell does now
			this.cancellers.forEach(c => c()); // setTimeout(c, 0)); 
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

	start = (p = new Progress()) => { AsyncM.timeout(0).bind(_=>this)._run(p); return p; } 

	_run = p => this.run(p).catch(e => { if (e != "interrupted") throw e; else console.log(e); }); 

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
	spawn = _ => new AsyncM (async p => new AsyncM(_ => this._run(p)));


	// fork 'this' as a thread and return its progress 
	fork = _ => new AsyncM (async p => {
			const p1 = new Progress(p);
			AsyncM.timeout(0)
				.bind(_=>this)
				._run(p1)
				.finally(_ => p1.unlink()); // unlink parent to child reference after completion
			return p1; 
		    })

	// fork a list of threads
	static fork = lst => new AsyncM (async p => 
			lst.map(m => {
				const p1 = new Progress(p);
				AsyncM.timeout(0)
					.bind(_=>m)
					._run(p1)
					.finally(_ => p1.unlink());
				return p1;
			}))

	// pure value as AsyncM
	static pure = x => new AsyncM ( p => Promise.resolve(x) )  

	static throw = e => new AsyncM( p => Promise.reject(e) )

	/*
	// lift :: ((a -> ()) -> ()) -> AsyncM a
        static lift = f => new AsyncM (p => new Promise((k, r) => {
		let c = _ => r("interrupted"); 
		if (p.isAlive()) { 
			p.addCanceller(c);

			let k1 = x => {
				p.removeCanceller(c)	
				if (!p.isPaused(_ => k(x))) k(x); 
			}
			f(k1)
		}
		else c();
	}))
	*/

	// f :: (a -> (), e -> ()) -> ()
	// h :: (a -> ()) -> ()
	// lift :: (f, h) -> AsyncM a
	static lift = (f, h) => new AsyncM (p => new Promise((k, r) => {
		// run 'f' only if 'p' is alive
		if (p.isAlive()) { 
			let c = _ => { 
				if (h) h(k1) 
				r('interrupted') 
			} 
			let k1 = x => {
				p.removeCanceller(c)	
				if (!p.isPaused(_ => k(x))) k(x) 
			}
			let r1 = x => {
				p.removeCanceller(c)	
				r(x)
			}

			p.addCanceller(c);
			f(k1, r1)
		}
		else r('interrupted')
	}))


	// lift :: Promise a -> AsyncM a
        static _lift = promise => AsyncM.lift(k => promise.then(k))

	// an AsyncM that never completes 
	static never = new AsyncM (p => new Promise(_ => {}))

	// completes after 'n' millisecond timeout
	static timeout = n => {
		let timer
		let f = k => { timer = setTimeout(k, n) }
		let h = _ => { if (timer) clearTimeout(timer) }
		return AsyncM.lift(f, h)
	}

	static from = (elem, evt) => {
		elem = $(elem)
		return AsyncM.lift(k => elem.one(evt, k), 
				     k => elem.off(evt, k)) 
	}

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
		return Promise.race(lst.map(m => m._run(p1)))
			.finally(_ => { p1.cancel(); p1.unlink(); }); 
	});

	// race two AsyncM and the winner is the one completes first.
	static any = lst => new AsyncM (p => {
		let p1 = new Progress(p);
		return Promise.any(lst.map(m => m._run(p1)))
			.finally(_ => { p1.cancel(); p1.unlink(); }); 
	});

	// run two AsyncM and wait for both of their results
	static all = lst => new AsyncM (p => Promise.all(lst.map(m => m.run(p))));

	/*
 	 * for testing purpose -- run 'f' for 'n' times at 'dt' interval
 	 */
	static interval = (n, dt, f) => {
		const h = i => AsyncM.ifAlive.bind(_ => new AsyncM(async p => {
			if (i <= n) {
				AsyncM.timeout(dt)
				.bind(_ => AsyncM.lift(k => k(f(i))).bind(_ => h(i+1)))
				.run(p);
		}}));
		return h(1);
	}
}


/*
 *  4. MVar and Channel
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
	})
}
 
