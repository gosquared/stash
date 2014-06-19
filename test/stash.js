var should = require('should');
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

    it('fetches uncached data', function(done) {
      stash.get('test', mockDbFetch, function(err, data){
        should.not.exist(err);
        should.exist(data);

        data.test.should.equal(1);
        done();
      });
    });

    it('saved to cache', function(done) {

      redis.get('test', function(err, data) {
        should.not.exist(err);
        should.exist(data);

        data = stash.decodeContent(data);
        data.test.should.equal(1);
        done();
      });
    });

    it('fetches cached data', function(done) {
      stash.get('test', function(){
          throw new Error('Fetcher should not be invoked');
        }, function(err, data){

        should.not.exist(err);
        should.exist(data);

        data.test.should.equal(1);
        done();
      });
    });

    it('no db fetch caches empty data', function(done) {
      stash.get('noDBFetch', function(err, result) {
        should.not.exist(err);
        should.not.exist(result);
        done();
      });
    });
  });

  describe('delete', function() {
    before(function(done) {
      redis.exists('test', function(err, exists) {
        exists.should.equal(1);

        stash.del('test', done);
      });
    });

    it('should remove from redis', function(done) {
      redis.exists('test', function(err, exists) {
        exists.should.equal(0);

        done(err);
      });
    });

    it('should clear', function() {
      stash.clear();
    });
  });

  describe('during cache issues', function(done) {
    var stash = createStash(createRedisClient, {
      wait: {
        redis: false
      }
    });

    before(function(done) {
      stash.cacheRedis.end();
      done();
    });

    it('gives error when getting a key', function(done) {
      stash.get('blah', mockDbFetch, function(err, data){
        should.exist(err);
        err.message.should.equal('redis unavailable');
        done();
      });
    });

    it('gives error when deleting a key', function(done) {
      stash.del('blah', function(err, data){
        should.exist(err);
        err.message.should.equal('redis unavailable');
        done();
      });
    });
  });

  describe('during db issues', function(done) {
    var stash = createStash(createRedisClient, {
      cacheErrors: true
    });

    it('db error is cached', function(done) {
      var dbFetches = 0;
      var fetch = function(cb) {
        (++dbFetches).should.equal(1);
        return mockDbFetchErr(cb);
      };

      stash.get('blah1', fetch, function() {
        stash.get('blah1', fetch, function(err, data){
          err.message.should.equal(dbErrMsg);

          done();
        });
      });
    });

    it('if db hangs curtail query and cache error', function(done) {
      var stash = createStash(createRedisClient, {
        timeout: {
          get: 1
        },
        wait: {
          redis: true
        }
      });

      stash.get('fetchHang', mockDbFetchHang, function(err, data){
        should.exist(err);

        done();
      });
    });
  });


  describe('concurrency', function() {
    var stash = createStash(createRedisClient);
    var redis = stash.cacheRedis;
    var warlock = Warlock(redis);

    it('sets lock when db fetching', function(done){
      stash.get('sheep', function(cb){
        warlock.lock('sheep', stash.conf.ttl.fetchLock, function(err, unlock){
          should.not.exist(err);

          (!!unlock).should.equal(false);
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
        err.message.should.equal('retry limit reached');
        done();
      });
    });

    it('many gets on uncached key from a single instance result in only one db fetch', function(done) {
      var numGets = 100;
      var fetches = 0;

      var doGet = function(n, next) {
        stash.get('hotKey', function(cb) {
          fetches += 1;
          fetches.should.equal(1);

          return setImmediate(function() {
            cb(null, { test: 2 });
          });
        }, next);
      };

      async.times(numGets, doGet, function(err, results) {
        should.not.exist(err);

        results.length.should.equal(numGets);
        done();
      });
    });

    it('gets from multiple separate instances should only fetch from db once', function(done) {
      var instances = [];
      var numInstances = 5;
      var fetches = 0;

      for (var i = 0; i < numInstances; i++) {
        instances.push(createStash(createRedisClient, {
          wait: {
            redis: true
          },
          timeout: {
            retry: 1
          }
        }));
      }

      async.map(instances, function(stash, done) {
        stash.get('multiInstance', function(cb) {
          fetches += 1;
          fetches.should.equal(1);

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
        should.not.exist(err);
        should.exist(data);

        data.test.should.equal(1);

        // Make sure cache key is actually there
        redis.get('pizza', function(err, data){
          should.exist(data);

          stash2.get('pizza', function(err, data) {
            data.test.should.equal(1);
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
            numFetches.should.equal(1);
            return done();
          });
        };

        setImmediate(purgeTest);
      });

      stash.invalidate('pizza');
    });
  });
});
