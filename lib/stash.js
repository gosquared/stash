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
    ttl: {
      memory: 5000,
      cache: 600000,
      fetchLock: 10000
    },
    timeout: {
      retry: 1000,
      del: 1000,
      get: 10000
    },
    wait: {
      redis: true
    },
    cacheErrors: false,
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

  self.memGet = memoize(self.fetch.bind(self), {
    async: true,
    primitive: true,
    maxAge: self.conf.ttl.memory,
    resolvers: [String],
    length: 1
  });

  self.broadcast = Broadcast(self.memGet, {
    redis: self.cacheRedis,
    subscriberRedis: self.broadcastRedis,
    log: self.log,
    metrics: self.metrics
  });
};

Stash.prototype.get = function(key, dbFetch, cb) {
  var self = this;

  if (typeof cb !== 'function') {
    cb = dbFetch;
    dbFetch = null;
  }

  cb = timed(self.conf.timeout.get, (cb || function() {}));

  self.metrics.increment('get');
  self.memGet(key, dbFetch, function(err, result) {

    if (self.conf.cacheErrors && result instanceof Error) {
      // Err result is cached, shift args back into original position
      return cb.apply(cb, slice.call(arguments, 1));
    }

    return cb.apply(cb, arguments);
  });
};

Stash.prototype.fetch = function(key, dbFetch, cb) {
  var self = this;
  var retries = 0;

  if (!self.cacheRedis.connected && !self.conf.wait.redis) {
    return setImmediate(function() {
      cb(self.cacheError(
        new Error('redis unavailable')
      ));
    });
  }

  self.metrics.increment('fetch');
  self.cacheFetch(key, dbFetch, retries, function(err, result) {
    // If we're caching errors, shift the result args so err is null
    if (err && self.conf.cacheErrors) {
      if (!(err instanceof Error)) err = new Error(err);
      var args = slice.call(arguments);
      args.unshift(null);
      return cb.apply(cb, args);
    }

    return cb.apply(cb, arguments);
  });
};

Stash.prototype.del = function(key, cb) {
  var self = this;
  cb = cb || function() {};
  self.log('cache:del');
  self.metrics.increment('del');

  if (!self.cacheRedis.connected && !self.conf.wait.redis) {
    self.log('cache:del failed');
    return cb(new Error('redis unavailable'));
  }

  self.cacheDel(key, function(err) {
    if (err) return cb(err);

    self.memGet.delete(key);
    cb();
  });
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
  self.memGet.clear();
};

Stash.prototype.cacheError = function(err) {
  var self = this;
  self.log('cache:error');

  if (err.message === 'timeout') {
    self.metrics.increment('cache.timeout');
    self.log('cache:timeout');
  }

  self.metrics.increment('cache.error');
  return err;
};

Stash.prototype.cacheFetch = function(key, dbFetch, retries, cb) {
  var self = this;

  self.cacheRedis.get(key, function(err, content) {
    if (err) return cb(self.cacheError(err));

    if (content) {
      self.log('cache:hit');
      self.metrics.increment('hit');
      try {
        content = self.decodeContent(content);
      } catch (e) {
        self.log('cache:decode exception');
        err = e;
      }

      return cb(err, content);
    }

    self.log('cache:miss');
    self.metrics.increment('miss');
    if (typeof dbFetch !== 'function') return cb();

    var lock = function(done) {
      self.log('cache:locking');
      self.warlock.lock(
        key,
        self.conf.ttl.fetchLock,
        done
      );
    };

    // Before invoking the db fetch, set a lock
    lock(function(err, unlock) {
      if (err) return cb(self.cacheError(err));

      if (typeof unlock !== 'function') {
        // No unlock function given so we didn't obtain a lock
        self.log('cache:locked');

        if (retries++ >= self.conf.retryLimit) {
          self.log('cache:retry limit reached');
          return cb(new Error('retry limit reached'));
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
      return dbFetch(function(err, result) {
        var content;

        // Don't save in redis but will still save to memory
        if (err) {
          self.log('db:error');
          debug(err);
          return unlock(function() {
            cb(err, result);
          });
        }

        try {
          content = self.encodeContent(result);
        } catch (e) {
          self.log('cache:encode exception');
          err = new Error('encode exception');
          err.exception = e;
          return unlock(function() {
            cb(err, result);
          });
        }

        self.cacheRedis.multi()
          .set(key, content)
          .pexpire(key, self.conf.ttl.cache)
          .exec(function(err) {
            if (err) {
              self.log('cache:save failed');
              debug(err);
            } else {
              self.log('cache:saved');
            }

            self.metrics.increment('stored');
            unlock(function() {
              cb(err, result);
            });
          });
      });
    });
  });
};

// Override if required
Stash.prototype.encodeContent = JSON.stringify;
Stash.prototype.decodeContent = JSON.parse;

var createStash = function(createRedisClient, opts) {
  return new Stash(createRedisClient, opts);
};

exports.Stash = Stash;
exports.createStash = createStash;
