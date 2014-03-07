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
      fetch : 200,
      fetchLock: 200,
      dbFetch: 5000,
      retry : 1000,
      del   : 200
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

  var objectCache = createObjectCache(conf.objectCache);
  var log = conf.log;
  var broadcast = Broadcast(objectCache, {
    redis: redis
  });
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

    var doDbFetch = function(cb){
      log('db:fetch');
      var timedCb = timed(conf.timeout.dbFetch, cb)

      dbFetch(timedCb);
    }

    var cacheError = function(err) {
      log('cache:error');

      if (err === 'timeout') log('cache:timeout');

      debug(err);

      // Cache is useless, so fail back to db fetch
      return doDbFetch(done);
    };

    var cacheFetch = function(cb) {
      if (!redis.connected) return cacheError('redis unavailable');

      var timedCb = timed(conf.timeout.fetch, cb);

      redis.get(key, timedCb);
    };

    var cacheFetchDone = function(err, content) {
      var lockKey;

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
      }

      log('cache:miss');

      var lockCb = function(err, unlock){
        if (err) return cacheError(err);

        if (unlock) {
          // We are now responsible for saving to the cache
          return doDbFetch(function(err, result) {
            var content;

            // Don't save in redis but will still save to LRU
            if (err) return done(err, result);

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
                }
                unlock();
              });
          });
        } else {
          if (retries++ >= conf.retryLimit){
            log('cache:retry limit reached');
            return done('retry limit reached');
          }

          log('cache:retry');

          // Try fetching from dist cache again after a short pause
          // Hopefully the data will be cached by the time we retry
          return setTimeout(function() {
            cacheFetch(cacheFetchDone);
          }, conf.timeout.retry);
        }
      }

      var timedCb = timed(conf.timeout.fetchLock, lockCb);

      lockKey = warlock.lock(key, conf.ttl.fetchLock, timedCb);
    }

    cacheFetch(cacheFetchDone);
  };

  var stashDel = function(key, cb) {

    if (!redis.connected){
      log('cache:del failed');
      return cb('redis unavailable');
    }

    redis.del(key, function(err) {
      if (err) return log('cache:del failed');

      log('cache:del success');
      return cb(err);
    });
  };

  var stash = {};

  stash.redis = redis;
  stash.objectCache = objectCache;
  stash.encodeContent = encodeContent;
  stash.decodeContent = decodeContent;
  stash.conf = conf;

  stash.get = function(key, dbFetch, cb) {
    log('cache:get');
    cb = cb || function(){};
    objectCache.lockedFetch(key, stashFetch.bind(this, key, dbFetch), cb);
  };

  stash.del = function(key, cb){
    cb = cb || function(){};
    log('cache:del');

    var timedCb = timed(conf.timeout.del, function(err){
      objectCache.del(key);
      broadcast.publish('invalidateStash', { key: key });
      return cb(err);
    });

    stashDel(key, timedCb);
  };

  return stash;
};

module.exports = createStash;
