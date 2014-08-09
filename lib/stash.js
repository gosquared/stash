var extend        = require('extend');
var Broadcast     = require('./broadcast');
var Warlock       = require('node-redis-warlock');
var debug         = require('debug')('stash');
var helpers       = require('./helpers');
var debug         = require('debug')('stash');
var memoize       = require('memoizee');
var createMetrics = require('./Metrics');

var timed = helpers.timed;
var slice = Array.prototype.slice;

var Stash = function(createRedisClient, opts) {
  var self = this;

  var conf = {
    redis: {
      wait: true,
      ttl: {
        cache: 600000,
        lock: 10000
      }
    },
    timeout: {
      retry: 1000,
      del: 1000,
      fetch: 10000
    },
    memoize: {
      results: {
        ttl: 600000,
        max: 100000
      },
      errors: {
        ttl: 5000,
        max: 100000
      }
    },
    retryLimit: 5,
    log: debug,
    metrics: createMetrics()
  };

  self.conf = extend(true, conf, opts || {});
  self.log = conf.log;
  self.metrics = conf.metrics;
  self.cacheRedis = createRedisClient();
  self.broadcastRedis = createRedisClient();
  self.warlock = Warlock(self.cacheRedis);

  self.memoize = {};

  // memoization = cache result for given input
  self.memoize.result = memoize(self.getError.bind(self), {
    async: true,
    primitive: true,
    maxAge: self.conf.memoize.results.ttl,
    max: self.conf.memoize.results.max,
    resolvers: [String],
    length: 1
  });

  self.memoize.err = memoize(self.cacheFetch.bind(self), {
    async: true,
    primitive: true,
    maxAge: self.conf.memoize.errors.ttl,
    max: self.conf.memoize.errors.max,
    resolvers: [String],
    length: 1
  });

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
  self.memoize.result(key, dbFetch, cb);
};

/**
 * Result not cached in memory, try to get a cached error
 */
Stash.prototype.getError = function(key, dbFetch, cb) {
  var self = this;
  var retries = 0;

  var done = function unswap(result, err) {
    // flip args back around so err bypasses result cache
    // result gets cached if no error
    result = result || [];
    result.unshift(err);
    cb.apply(cb, result);
  };

  self.memoize.err(key, dbFetch, retries, done);
};

/** Neither result nor error cached in memory, so fetch from cache */
Stash.prototype.cacheFetch = function(key, dbFetch, retries, cb) {
  var self = this;

  var done = function swap(err){
    // masquerade result as an error so it bypasses error cache
    var result = slice.call(arguments, 1);
    if (err) result = null;
    cb(result, err || null);
  };

  self.metrics.increment('fetch');

  if (!self.cacheRedis.connected && !self.conf.redis.wait) {
    return setImmediate(function() {
      done(new Error('redis unavailable'));
    });
  }

  done = timed(self.conf.timeout.fetch, done);

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

      result.unshift(err);
      return done.apply(done, result);
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
      return dbFetch(function() {
        var content;
        var args = slice.call(arguments, 0);
        var err = args[0];
        var result = args.slice(1);

        // Don't save in redis but will still save to memory
        if (err) {
          self.log('db:error');
          debug(err);
          return unlock(function() {
            done.apply(done, args);
          });
        }

        // Store result args as array in cache
        try {
          content = self.encodeContent(result);
        } catch (e) {
          self.log('cache:encode exception');
          err = new Error('encode exception');
          err.exception = e;
          args[0] = err;
          return unlock(function() {
            done.apply(done, args);
          });
        }

        self.cacheRedis.multi()
          .set(key, content)
          .pexpire(key, self.conf.redis.ttl.cache)
          .exec(function(err) {
            if (err) {
              self.log('cache:save failed');
              debug(err);
            } else {
              self.log('cache:saved');
            }

            self.metrics.increment('stored');
            unlock(function() {
              done.apply(done, args);
            });
          });
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
  self.memoize.result.delete(key);
  self.memoize.err.delete(key);
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
  self.memoize.result.clear();
  self.memoize.err.clear();
};

// Override if required
Stash.prototype.encodeContent = JSON.stringify;
Stash.prototype.decodeContent = JSON.parse;

var createStash = function(createRedisClient, opts) {
  return new Stash(createRedisClient, opts);
};

exports.Stash = Stash;
exports.createStash = createStash;
