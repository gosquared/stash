stash
=====

Distributed cache using Redis as cache store and memoization for fast access to loaded data.

Requires Redis >= v2.6.0 and `node-redis` client `^0.8`

## Install

    npm install node-stash

## Usage

```javascript

var Stash = require('node-stash');
var Redis = require('redis');
var stash = Stash.createStash(redis.createClient, {
  memoize: {
    result: {
      ttl: 600000
    },
    error: {
      ttl: 5000
    }
  }
});

var fetch = function(cb) {
  // Fetch data from somewhere
  fetchData(function(err, data) {
    // Invoke cb to give stash an error or data.
    // If no error, stash will cache the results in memory
    // and serve them to other .get requests on the same key
    // until the key outlives its ttl or the cache is cleared
    //
    // If err is given, cache will only cache the error and
    // serve to other .get requests in a similar fashion to
    // cached results.
    return cb(err, data);
  });
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

If the `fetchFn` invokes its callback with an error, you can control whether the error is cached or not, and how long for. See the `memoize.error` option.

`fetchFn` signature: `function (cb) {}`

Example `fetchFn`:

```javascript
var fetch = function(cb) {
  mysql.query('SELECT something FROM somewhere', cb);
};
```

When multiple calls to `stash.get` are made before a key is retrieved and cached, stash will transparently queue callbacks until the first single fetch & cache operation is completed, at which point the callbacks in the queue are invoked with the result. In this way, Stash abstracts concurrency complexity, so you only need to worry about a single function call to retrieve a value for your distributed app.

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
  redis: {
    wait: true,           // when false, errors if redis connection is down, otherwise queues commands
    ttl: {
      cache: 600000,      // redis cache key ttl
      lock: 10000         // in-case unlock does not work, ttl of redis-based fetchFn lock
    }
  },
  timeout: {
    retry: 1000,          // optimistic lock retry delay
    del: 1000,            // time limit for deletes
    fetch: 10000          // time limit for total cache & db fetch trip
  },
  memoize: {              // in-memory cache options
    result: {
      ttl: 600000,        // ttl of results cache
      max: 100000         // max number of items in results cache. Set to 0 to disable the result cache
    },
    error: {
      ttl: 5000,          // ttl of errors cache
      max: 100000         // max number of items in error cache. Set to 0 to disable the error cache.
    }
  },
  retryLimit: 5,          // max retry times for optimistic locking
  log: debug,             // set to your own logging function
  metrics: createMetrics()// set to your own metrics function
};
```
