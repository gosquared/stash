Changelog
---

# v0.4.0

* Upgrade deps.

# v0.3.3

* Remove leaky default metrics handler.

# v0.3.2

* Upgrade [`node-redis-warlock`](https://www.npmjs.org/package/node-redis-warlock) to `^v0.1`.

# v0.3.1

* Replace multi with equivalent SET args.
* Change Redis requirement to `v2.6.12`.
* Options for passing created redis clients for stash to use as an alternative to stash creating its own for each instance.

# v0.3.0

* New lru cache internals.
* `memoize` options changed to `lru`.
* Removed all callback timeouts. Timeouts should be handled by the application when fetching from its resource.

# v0.2.0

* All arguments to `stash.get(key, fetchFn, cb)` are now mandatory.
* Added separate memory cache for errors, allowing for different `ttl` and `max` settings.
* Rearrange options.
