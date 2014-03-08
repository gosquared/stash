var extend            = require('extend');
var createObjectCache = require('rush');
var Broadcast         = require('./broadcast');
var Warlock           = require('node-redis-warlock');
var debug             = require('debug')('stash');
var helpers           = require('./helpers');
var Redis             = require('redis');
var debug             = require('debug')('stash');

var encodeContent = JSON.stringify;
var decodeContent = JSON.parse;
var timed = helpers.timed;

var createStash = function(opts){
  var conf = {
    ttl: {
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

  stash.objectCache = createObjectCache(conf.objectCache);

  var log = conf.log;
  var warlock = Warlock(redis);
  var broadcast = Broadcast(stash.objectCache, {
    redis: redis,
    log: log
  });

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

    var doDbFetch = function(cb){
      log('db:fetch');
      var timedCb = timed(conf.timeout.dbFetch, cb)

      dbFetch(timedCb);
    }

    var cacheError = function(err) {
      log('cache:error');

      if (err === 'timeout') log('cache:timeout');

      debug(err);

      return done(err);
    };

    var cacheFetch = function(cb) {
      if (!redis.connected && !conf.wait.redis) return cacheError('redis unavailable');

      var timedCb = timed(conf.timeout.fetch, cb);

      redis.get(key, timedCb);
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
          return done('retry limit reached');
        }

        log('cache:retry');

        // Try fetching from redis cache again after a short pause
        // Hopefully the data will be cached by the time we retry
        return setTimeout(function() {
          cacheFetch(cacheFetchDone);
        }, conf.timeout.retry);
      }
    }

    var cacheFetchDone = function(err, content) {

      if (err) return cacheError(err);

      if (content) {
        log('cache:hit');
        try {
          content = decodeContent(content);
        } catch (e) {
          err = 'decode exception';
          log('cache:'+err);
        }

        return done(err, content);
      } else {
        log('cache:miss');

        if (typeof dbFetch !== 'function') return done();

        log('cache:locking');
        var timedCb = timed(conf.timeout.fetchLock, lockCb);
        warlock.lock(key, conf.ttl.fetchLock, timedCb);
      }
    }

    cacheFetch(cacheFetchDone);
  };

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

  stash.get = function(key, dbFetch, cb) {
    log('cache:get');

    if (typeof cb !== 'function') {
      cb = dbFetch;
      dbFetch = null;
    }

    cb = cb || function(){};
    stash.objectCache.lockedFetch(key, stashFetch.bind(this, key, dbFetch), cb);
  };

  stash.del = function(key, cb) {
    cb = cb || function(){};
    log('cache:del');

    if (!redis.connected && !conf.wait.redis) {
      log('cache:del failed');
      return cb('redis unavailable');
    }

    var timedCb = timed(conf.timeout.del, function(err) {

      if (err) return cb(err);

      stash.objectCache.del(key);
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
    stash.objectCache = createObjectCache(conf.objectCache);
  };

  return stash;
};

module.exports = createStash;
