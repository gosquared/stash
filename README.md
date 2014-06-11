stash
=====

Distributed cache using Redis and in-memory memoization.

Requires Redis >= v2.6.0

## Install

    npm install node-stash

## Usage

```javascript

var Stash = require('node-stash');
var Redis = require('redis');
var stash = Stash.createStash(redis.createClient, {
  ttl: {
    memory: 5000,
    cache: 30000
  }
});

var fetch = function(cb) {
  // Fetch data from somewhere
  var data = { some: 'stuff' };
  // If there was an error fetching stuff it'd go in the err argument
  var err = null;

  // Invoke cb to give stash an error and data.
  // If error, stash will cache in lru for a short time
  // Data is cached in redis and lru
  return cb(err, data);
};

stash.get('key', fetch, function(err, data) {
  // err is present if there was a problem somewhere along the line
  // data could be fresh from db or from cache
});

```

## API

Create an instance of stash:

```javascript
var Stash = require('node-stash');
var stash = Stash.createStash(createRedisClient, { /* options... optional :) */ });
```

`createRedisClient` must be a function that creates and returns an instance of [node-redis](https://github.com/mranney/node_redis) compatible with `v0.8`. This way your app can still have control over instantiating and handling errors on the redis client.

Do not simply return an existing redis client, as this will be placed into pub-sub mode. Stash needs to be able to create distinct redis clients for its pub-sub and non-pub sub Redis functionality.

### stash.get(key, fetchFn, cb)

Retrieve a key. If the key has been previously retrieved, and time is within the memory TTL, it will be loaded from memory, resulting in extremely fast access. If not, it will attempt to load the key from Redis. If the key is not in Redis, it will invoke `fetchFn`, which is a function you define to retrieve the value. Stash caches the result of `fetchFn` in Redis.

Stash is designed to run in a distributed architecture. As such, you might have multiple instances of an app running stash, with many processes attempting to retrieve values from the database and cache. Stash has in-built concurrency control around your `fetchFn`, which ensures that only one instance of your app will be able to execute `fetchFn` at a time. This helps prevent stampeding your data source when keys expire from the cache.

If the `fetchFn` invokes its callback with an error, you can control whether the error is cached or not. See the `cacheErrors` option.

`fetchFn` signature: `function (cb) {}`

Example `fetchFn`:

```javascript
var fetch = function(cb) {
  mysql.query('SELECT something FROM somewhere', cb);
};
```

When multiple calls to `stash.get` are made before a key is retrieved and cached, stash will transparently queue callbacks until the single fetch & cache operation is completed, at which time the callback queue is invoked with the result. In this way, Stash abstracts concurrency complexity, so you only need to worry about a single function call to retrieve a value for your distributed app.

### stash.del(key, [cb])

Remove a value from the memory and Redis cache. Once this is complete, the value will need to be fetched.

Note that the key is only deleted from the memory cache of the current process, so if you're running many distributed instances of stash, their memory caches might still contain the key. Use `stash.invalidate` to perform cluster-wide purges.

### stash.clear()

Empty the memory cache for all keys.

### stash.invalidate(key, [cb])

Invalidate a key from the cache. This is similar to `stash.del`, but goes one step further and ensures that all other instances of stash in other processes also delete the key from their memory caches. An invalidation is a cluster-wide purge.

## Options

```javascript

var opts = {
  // TTL = time to live = milliseconds before deletion
  ttl: {
    memory: 5000, // in-memory cache
    cache: 600000, // redis cache
    fetchLock: 10000 // fetchFn lock
  },
  timeout: {
    fetch: 1000, // max redis key fetch duration
    fetchLock: 1000, // max setting redis lock duration
    dbFetch: 5000, // max fetchFn duration
    retry: 1000, // retry delay
    del: 1000 // max delete duration
  },
  wait: {
    redis: true // error if redis connection down
  },
  cacheErrors: false, // Cache fetchFn errors in memory & redis.
  retryLimit: 5, // times to retry cache fetch if lock in place
  log: debug, // settable to your own logging function
  metrics: createMetrics() // settable to your own metrics library
};
```

### Logging

Supply your own logging function:
