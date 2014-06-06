var extend            = require('extend');
var Broadcast         = require('./broadcast');
var Warlock           = require('node-redis-warlock');
var debug             = require('debug')('stash');
var helpers           = require('./helpers');
var Redis             = require('redis');
var debug             = require('debug')('stash');
var memoize           = require('memoizee');

var encodeContent = JSON.stringify;
var decodeContent = JSON.parse;
var timed = helpers.timed;

var argToArray = Array.prototype.slice;

var createStash = function(opts){
  var conf = {
    ttl: {
      memory: 5000,
      cache: 600000,
      fetchLock: 10000
    },
    timeout: {
      fetch : 1000,
      fetchLock: 1000,
      dbFetch: 5000,
      retry : 1000,
      del   : 1000
    },
    wait: {
      redis: true
    },
    cacheErrors: false,
    retryLimit: 5,
    log: debug,
    redisConfig: {
      port: 6379,
      host: 'localhost',
      database: 0
    },
    redis: null,
    log: debug
  };

  conf = extend(true, conf, opts || {});

  var log = conf.log;
  var redis = conf.redis;

  if (!redis) {
    redis = Redis.createClient(conf.redisConfig.port, conf.redisConfig.host);
    redis.select(conf.redisConfig.database);
  }

  var stash = {};

  var log = conf.log;
  var warlock = Warlock(redis);

  /**
   * Try fetching from redis cache.
   * If not in redis cache, fetch from db.
   * After successful DB fetch, cache in redis.
   * @param  {string}     key     Cache key
   * @param  {function}   dbFetch Function to fetch fresh data from store
   * @param  {function}   done    Callback with results
   */
  var stashFetch = function(key, dbFetch, done) {
    var retries = 0;

    if (typeof done !== 'function') {
      done = dbFetch;
      dbFetch = null;
    }

    done = done || function(){};

    var doDbFetch = function(cb){
      log('db:fetch');
      var timedCb = timed(conf.timeout.dbFetch, cb)

      dbFetch(timedCb);
    };

    var cacheError = function(err) {
      log('cache:error');
      if (err.message === 'timeout') log('cache:timeout');
      debug(err.message);
      return err;
    };

    var lockCb = function(err, unlock){

      if (err) return cacheError(err);

      if (unlock) {
        log('cache:lockAcquired');

        // We are now responsible for saving to the cache
        return doDbFetch(function(err, result) {
          var content;

          // Don't save in redis but will still save to LRU
          if (err){
            log('db:error');
            debug(err);
            return done(err, result);
          }

          try {
            content = encodeContent(result);
          } catch (e) {
            log('cache:encode exception');
            return done(err, result);
          }

          // No need to wait for cache saving
          done(err, result);

          redis.multi()
            .set(key, content)
            .pexpire(key, conf.ttl.cache)
            .exec(function(err){
              if (err) {
                log('cache:save failed');
                debug(err);
              } else {
                log('cache:saved');
              }

              unlock(function(err) {
                log('cache:unlocked');
                if (err) debug(err);
              });
            });
        });
      } else {
        log('cache:locked');
        if (retries++ >= conf.retryLimit){
          log('cache:retry limit reached');
          return done(new Error('retry limit reached'));
        }

        log('cache:retry');

        // Try fetching from redis cache again after a short pause
        // Hopefully the data will be cached by the time we retry
        return setTimeout(function() {
          cacheFetch(key, done);
        }, conf.timeout.retry);
      }
    };

    var cacheFetch = function(key, done) {

      var fetchComplete = function(err, result) {

        // If we're caching errors, shift the result args so err is null
        if (err && conf.cacheErrors) {
          if (!(err instanceof Error)) err = new Error(err);
          return done.apply(done, argToArray.call(arguments).unshift(null));
        }

        return done(err, result);
      };

      var cb = function(err, content) {
        if (err) return fetchComplete(cacheError(err));

        if (content) {
          log('cache:hit');
          try {
            content = decodeContent(content);
          } catch (e) {
            log('cache:decode exception');
            err = e;
          }

          return fetchComplete(err, content);
        } else {
          log('cache:miss');

          if (typeof dbFetch !== 'function') return fetchComplete();

          log('cache:locking');
          var timedCb = timed(conf.timeout.fetchLock, lockCb);
          warlock.lock(key, conf.ttl.fetchLock, timedCb);
        }
      };

      if (!redis.connected && !conf.wait.redis) {
        return fetchComplete(cacheError(
          new Error('redis unavailable')
        ));
      }

      var timedCb = timed(conf.timeout.fetch, cb);
      redis.get(key, timedCb);
    };

    log('cache:get');
    cacheFetch(key, done);
  };

  var get = memoize(stashFetch, {
    async: true,
    primitive: true,
    maxAge: conf.ttl.memory,
    resolvers: [String],
    length: 1
  });

  var broadcast = Broadcast(get, {
    redis: redis,
    log: log,
    redisConfig: conf.redisConfig
  });

  var stashDel = function(key, cb) {

    redis.del(key, function(err) {

      if (err){
        log('cache:del failed');
        debug(err);
        return cb(err);
      } else {
        log('cache:del success');
        return cb(err);
      }
    });
  };

  stash.redis = redis;
  stash.encodeContent = encodeContent;
  stash.decodeContent = decodeContent;
  stash.conf = conf;
  stash.broadcast = broadcast;

  stash.get = function(key, dbFetch, done) {
    get(key, dbFetch, function(err, result) {
      if (conf.cacheErrors && result instanceof Error) {
        // Err result is cached, shift args back into original position
        return done.apply(done, argToArray.call(arguments).shift());
      }

      return done(err, result);
    });
  };

  stash.del = function(key, cb) {
    cb = cb || function(){};
    log('cache:del');

    if (!redis.connected && !conf.wait.redis) {
      log('cache:del failed');
      return cb(new Error('redis unavailable'));
    }

    var timedCb = timed(conf.timeout.del, function(err) {

      if (err) return cb(err);

      get.delete(key);
      cb();
    });

    stashDel(key, timedCb);
  };

  stash.invalidate = function(key, cb) {
    stash.del(key, function(err) {
      if (err) return cb(err);

      broadcast.publish('invalidateStash', { key: key }, cb);
    });
  };

  stash.reset = function() {
    get.clear();
  };

  return stash;
};

module.exports = createStash;
