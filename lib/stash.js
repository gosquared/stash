var extend        = require('extend');
var Broadcast     = require('./broadcast');
var Warlock       = require('node-redis-warlock');
var Rush          = require('node-rush');
var debug         = require('debug')('stash');

var metrics = { increment: function() {} };
var slice = Array.prototype.slice;

var Stash = function(createRedisClient, opts) {
  var self = this;

  var conf = {
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
      retry: 1000          // optimistic lock retry delay
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

  self.conf = extend(true, conf, opts || {});
  self.log = conf.log;
  self.metrics = conf.metrics;
  self.cacheRedis = self.conf.redis.clients.cache || createRedisClient();
  self.broadcastRedis = self.conf.redis.clients.broadcast || createRedisClient();
  self.warlock = Warlock(self.cacheRedis);
  self.lru = Rush(self.conf.lru);

  self.broadcast = Broadcast(self, {
    redis: self.cacheRedis,
    subscriberRedis: self.broadcastRedis,
    log: self.log,
    metrics: self.metrics
  });
};

Stash.prototype.get = function(key, dbFetch, cb) {
  var self = this;

  if (typeof cb !== 'function') {
    // no callback given so not sure exactly what arguments have been
    // supplied. Safest to no-op than to assume dbFetch is actually
    // a fetch function.
    return self.log('stash.get requires callback');
  }

  if (typeof dbFetch !== 'function') {
    var err = new Error('no fetch function given');
    setImmediate(function() {
      cb(err);
    });
    return;
  }

  self.metrics.increment('get');

  function cacheFetch(cb) {
    self.cacheFetch(key, dbFetch, 0, cb);
  }

  self.lru.get(key, cacheFetch, cb);
};

/** Neither result nor error cached in memory, so fetch from cache */
Stash.prototype.cacheFetch = function(key, dbFetch, retries, cb) {
  var self = this;

  var done = function fetchComplete(err, result){
    cb.apply(null, [err].concat(result));
  };

  self.metrics.increment('fetch');

  if (!self.cacheRedis.connected && !self.conf.redis.wait) {
    return setImmediate(function() {
      done(new Error('redis unavailable'));
    });
  }

  self.cacheRedis.get(key, function(err, content) {
    if (err) return done(self.reportCacheErr(err));
    var result;

    if (content) {
      self.log('cache:hit');
      self.metrics.increment('hit');
      try {
        result = self.decodeContent(content);
      } catch (e) {
        self.log('cache:decode exception');
        err = e;
      }

      return done(err, result);
    }

    self.log('cache:miss');
    self.metrics.increment('miss');

    var lock = function(done) {
      self.log('cache:locking');
      self.warlock.lock(
        key,
        self.conf.redis.ttl.lock,
        done
      );
    };

    // Before invoking the db fetch, set a lock
    lock(function(err, unlock) {
      if (err) return done(self.reportCacheErr(err));

      if (typeof unlock !== 'function') {
        // No unlock function given so we didn't obtain a lock
        self.log('cache:locked');

        if (retries++ >= self.conf.retryLimit) {
          self.log('cache:retry limit reached');
          return done(new Error('retry limit reached'));
        }
        self.log('cache:retry');

        // Try fetching from redis cache again after a short pause
        // Hopefully the data will be cached by the time we retry
        setTimeout(function() {
          self.cacheFetch(key, dbFetch, retries, cb);
        }, self.conf.timeout.retry);

        return;
      }

      // Lock in place. We are now responsible for fetching
      // from DB and saving to the cache
      self.log('cache:lockAcquired');

      self.log('db:fetch');
      return dbFetch(function(err) {
        var content;
        var result = slice.call(arguments, 1);

        if (err) {
          // Don't save err in redis but will still save to memory
          self.log('db:error');
          debug(err);
          return unlock(function() {
            done(err, result);
          });
        }

        // Store result args as array in cache
        try {
          content = self.encodeContent(result);
        } catch (e) {
          self.log('cache:encode exception');
          err = new Error('encode exception');
          err.exception = e;
          return unlock(function() {
            // only cache results, not encode error
            done(null, result);
          });
        }

        self.cacheRedis.set(
          key, content,
          'PX', self.conf.redis.ttl.cache,
          function(err) {
            if (err) {
              self.log('cache:save failed');
              debug(err);
            } else {
              self.log('cache:saved');
            }

            self.metrics.increment('stored');
            unlock(function() {
              // cache result even if failed to save to cache
              done(null, result);
            });
          }
        );
      });
    });
  });
};

Stash.prototype.reportCacheErr = function(err) {
  var self = this;
  self.log('cache:error');

  if (err.message === 'timeout') {
    self.metrics.increment('cache.timeout');
    self.log('cache:timeout');
  }

  self.metrics.increment('cache.error');
  return err;
};

Stash.prototype.del = function(key, cb) {
  var self = this;
  cb = cb || function() {};
  self.log('cache:del');
  self.metrics.increment('del');

  if (!self.cacheRedis.connected && !self.conf.redis.wait) {
    self.log('cache:del failed');
    return setImmediate(function() {
      cb(new Error('redis unavailable'));
    });
  }

  self.cacheDel(key, function(err) {
    if (err) return cb(err);

    self.memDel(key);
    cb();
  });
};

Stash.prototype.memDel = function(key) {
  var self = this;
  self.lru.del(key);
};

Stash.prototype.cacheDel = function(key, cb) {
  var self = this;
  self.cacheRedis.del(key, function(err) {

    if (err) {
      self.log('cache:del failed');
      debug(err);
      return cb(err);
    } else {
      self.log('cache:del success');
      self.metrics.increment('deleted');
      return cb(err);
    }
  });
};

Stash.prototype.invalidate = function(key, cb) {
  var self = this;
  cb = cb || function() {};

  self.metrics.increment('invalidate');
  self.del(key, function(err) {
    if (err) return cb(err);

    self.broadcast.publish('invalidateStash', {
      key: key
    }, cb);
  });
};

Stash.prototype.clear = function() {
  var self = this;

  self.metrics.increment('clear');
  self.lru.reset();
};

// Override if required
Stash.prototype.encodeContent = JSON.stringify;
Stash.prototype.decodeContent = JSON.parse;

var createStash = function(createRedisClient, opts) {
  return new Stash(createRedisClient, opts);
};

exports.Stash = Stash;
exports.createStash = createStash;
