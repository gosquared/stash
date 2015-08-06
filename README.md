# stash

[![Join the chat at https://gitter.im/gosquared/stash](https://badges.gitter.im/Join%20Chat.svg)](https://gitter.im/gosquared/stash?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)

[![Travis](https://api.travis-ci.org/gosquared/stash.svg)](https://travis-ci.org/gosquared/stash)
[![Dependencies](https://david-dm.org/gosquared/stash.svg)](https://david-dm.org/gosquared/stash)
[![Join the chat at https://gitter.im/gosquared/stash](https://img.shields.io/badge/gitter-join%20chat-blue.svg)](https://gitter.im/gosquared/stash)

[![NPM](https://nodei.co/npm/node-stash.png?downloads=true&downloadRank=true&stars=true)](https://www.npmjs.com/package/node-stash)

Distributed cache using Redis as cache store and memory lru for fast access to loaded data.

Requires Redis >= v2.6.12 and `node-redis` client `^0.8`

## Install

    npm install node-stash

## Usage

```javascript

var Stash = require('node-stash');
var Redis = require('redis');
var stash = Stash.createStash(redis.createClient, {
  lru: {
    max: 100000,          // max number of cached results
    maxAge: 600000,       // max age of cached results
    errTTL: 5000,         // max age of cached error results
    timeout: 5000         // min time before callback queue reset
  }
});

var fetchRow = function(id, cb) {
  var fetch = function(done) {
    /**
     * This is our function to fetch data from a resource.
     * The results of this function are cached by stash.
     *
     * It is wise to set a timeout on your fetch, so that
     * it calls `done` with an error if it takes too long
     * to complete. This is useful in case your external
     * resource is overloaded and being slow. If configured,
     * stash will cache this error and prevent overloading the
     * resource with more fetches.
     */
    // Example: querying a mysql db
    mysql.query({
      sql: 'SELECT thing FROM things WHERE id = ? LIMIT 1',
      timeout: 5000
    }, [id], done);
  };

  var key = 'appName:component:'+id;
  stash.get(key, fetch, cb);
};

// get a row
fetchRow(1, function(err, row) {
  // called async with cached or
  // freshly fetched data
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

Retrieve a key. If the key has been previously retrieved, and not older than the LRU maxAge, it will be loaded from memory, resulting in extremely fast access. If not, it will attempt to load the key from Redis. If the key is not in Redis, it will invoke `fetchFn`, which is a function you define to retrieve the value. Stash caches the result of `fetchFn` in Redis.

Stash is designed to run in a distributed architecture. As such, you might have multiple instances of an app running stash, with many processes attempting to retrieve values from the database and cache. Stash has in-built concurrency control around your `fetchFn`, which ensures that only one instance of your app will be able to execute `fetchFn` at a time. This helps prevent stampeding your data source when keys expire from the cache.

If the `fetchFn` invokes its callback with an error, you can configure a different ttl for cached error results. See the `lru.errTTL` option.

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

Empty the memory cache for all keys. Does not touch Redis cache.

### stash.invalidate(key, [cb])

Invalidate a key from the cache. This is similar to `stash.del`, but goes one step further and ensures that all other instances of stash in other processes also delete the key from their memory caches. An invalidation is a cluster-wide purge.

## Options

```javascript

// example handlers
var debug = console.log;
var metrics = {
  increment: function(name, inc) {
    // name is the counter name, inc is the increment number
  }
};

var opts = {
  redis: {
    wait: true,           // when false, errors if redis connection is down, otherwise queues commands
    ttl: {
      cache: 600000,      // redis cache key ttl
      lock: 10000         // in-case unlock does not work, ttl of redis-based fetchFn lock
    },
    clients: {
      // Clients passed here will be used instead of createRedisClient()
      // This is useful if you want to share redis clients across
      // many instances of stash. It is recommended to create clients
      // solely for use with stash instances.
      cache: null,
      broadcast: null // This client is placed in pub/sub mode.
      // It is recommended to call client.setMaxListeners(0) on this client if
      // you intend to share it across more than 10 instances of stash.
    }
  },
  timeout: {
    retry: 1000           // optimistic lock retry delay
  },
  lru: {
    max: 100000,          // max number of cached results
    maxAge: 600000,       // max age of cached results
    errTTL: 5000,         // max age of cached error results
    timeout: 5000         // min time before callback queue reset
  },
  retryLimit: 5,          // max retry times for optimistic locking
  log: debug,             // set to your own logging handler
  metrics: metrics        // set to your own metrics handler
};
```
