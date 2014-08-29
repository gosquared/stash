var assert = require('assert');
var Stash = require('../lib/stash');
var redisConnection = require('./setup/redisConnection');
var redisFlush = require('./setup/redisFlush');
var Warlock = require('node-redis-warlock');
var async = require('async');
var Redis = require('redis');
var createStash = Stash.createStash;

var mockDbFetch = function(cb) {
  setImmediate(function() {
    cb(null, { test: 1 });
  });
};

var dbErrMsg = 'DB AINT COOL RIGHT NOW';
var mockDbFetchErr = function(cb) {
  setImmediate(function() {
    cb(new Error(dbErrMsg));
  });
};

var mockDbFetchHang = function(cb) {
   // basically never call cb :)
};

var createRedisClient = function() {
  return Redis.createClient();
};

describe('Stash', function() {
  var stash = createStash(createRedisClient);
  var redis = stash.cacheRedis;

  describe('get', function() {

    it('errors if no fetch function given', function(done) {
      stash.get('test', null, function(err){
        assert(err);
        done();
      });
    });

    it('no-ops if no cb given', function() {
      stash.get('test');
    });

    it('fetches uncached data', function(done) {
      stash.get('test', mockDbFetch, function(err, data){
        assert(!err);
        assert.equal(1, data.test);
        done();
      });
    });

    it('saved to cache', function(done) {

      redis.get('test', function(err, data) {
        assert(!err);
        assert(data);

        data = stash.decodeContent(data)[0];
        assert.equal(1, data.test);
        done();
      });
    });

    it('fetches cached data', function(done) {
      stash.get('test', function(){
          throw new Error('Fetcher should not be invoked');
        }, function(err, data){
        assert(!err);
        assert(data);

        assert.equal(1, data.test);
        done();
      });
    });
  });

  describe('delete', function() {
    before(function(done) {
      redis.exists('test', function(err, exists) {
        assert(1, exists);

        stash.del('test', done);
      });
    });

    it('should remove from redis', function(done) {
      redis.exists('test', function(err, exists) {
        assert(true, exists);

        done(err);
      });
    });

    it('should clear', function() {
      stash.clear();
    });
  });

  describe('during cache issues', function(done) {
    var stash = createStash(createRedisClient, {
      redis: {
        wait: false
      }
    });

    before(function(done) {
      stash.cacheRedis.end();
      done();
    });

    it('gives error when getting a key', function(done) {
      stash.get('blah', mockDbFetch, function(err, data){
        assert(err);
        assert.equal('redis unavailable', err.message);
        done();
      });
    });

    it('gives error when deleting a key', function(done) {
      stash.del('blah', function(err, data){
        assert(err);
        assert.equal('redis unavailable', err.message);
        done();
      });
    });
  });

  describe('during db issues', function(done) {
    var stash = createStash(createRedisClient);

    it('db error is cached', function(done) {
      var dbFetches = 0;
      var fetch = function(cb) {
        assert.equal(1, (++dbFetches));
        return mockDbFetchErr(cb);
      };

      stash.get('blah1', fetch, function(err1) {
        stash.get('blah1', fetch, function(err2, data){
          assert(!data);
          assert.equal(dbErrMsg, err2.message);
          assert.equal(err2, err1);

          done();
        });
      });
    });
  });

  describe('concurrency', function() {
    var stash = createStash(createRedisClient);
    var redis = stash.cacheRedis;
    var warlock = Warlock(redis);

    it('sets lock when db fetching', function(done){
      stash.get('sheep', function(cb){
        warlock.lock('sheep', stash.conf.redis.ttl.lock, function(err, unlock){
          assert(!err);

          assert.equal(false, !!unlock);
          cb();
          done();
        });
      }, function() {});
    });

    it('stops retrying if locked and retry limit reached', function(done) {

      var stash2 = createStash(createRedisClient, {
        retryLimit: 0,
        timeout: {
          retry: 1
        }
      });

      stash.get('retryLimit', function(cb) { }, function(){});

      stash2.get('retryLimit', function(cb){ }, function(err){
        assert.equal('retry limit reached', err.message);
        done();
      });
    });

    it('many gets on uncached key from a single instance result in only one db fetch', function(done) {
      var numGets = 100;
      var fetches = 0;

      var doGet = function(n, next) {
        stash.get('hotKey', function(cb) {
          assert.equal(1, (++fetches));

          return setImmediate(function() {
            cb(null, { test: 2 });
          });
        }, next);
      };

      async.times(numGets, doGet, function(err, results) {
        assert(!err);

        assert.equal(numGets, results.length);
        done();
      });
    });

    it('gets from multiple separate instances should only fetch from db once', function(done) {
      var instances = [];
      var numInstances = 5;
      var fetches = 0;

      for (var i = 0; i < numInstances; i++) {
        instances.push(createStash(createRedisClient, {
          timeout: {
            retry: 1
          }
        }));
      }

      async.map(instances, function(stash, done) {
        stash.get('multiInstance', function(cb) {
          assert.equal(1, (++fetches));

          return setImmediate(function() {
            cb(null, { test: 2 });
          });
        }, done);
      }, done);
    });
  });

  describe('broadcast', function() {
    var stash = createStash(createRedisClient);
    var redis = stash.cacheRedis;

    var stash2 = createStash(createRedisClient);

    before(function(done) {
      // precache
      stash.get('pizza', mockDbFetch, function(err, data){
        assert(!err);
        assert(data);

        assert.equal(1, data.test);

        // Make sure cache key is actually there
        redis.get('pizza', function(err, data){
          assert(!err);
          assert(data);

          stash2.get('pizza', mockDbFetch, function(err, data) {
            assert.equal(1, data.test);
            return done(err);
          });
        });
      });
    });

    it('should invalidate local cache for all instances', function(done) {
      var numFetches = 0;

      var fetch = function(cb) {
        numFetches += 1;
        setImmediate(cb);
      };

      stash2.broadcast.once('message', function(){
        var purgeTest = function() {
          stash2.get('pizza', fetch, function() {
            assert.equal(1, numFetches);
            return done();
          });
        };

        setImmediate(purgeTest);
      });

      stash.invalidate('pizza');
    });
  });
});
