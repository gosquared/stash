var should = require('should');
var Stash = require('../lib/stash');
var redisConnection = require('./setup/redisConnection');
var redisFlush = require('./setup/redisFlush');
var Warlock = require('node-redis-warlock');
var async = require('async');

var mockDbFetch = function(cb) {
  setImmediate(function() {
    cb(null, { test: 1 });
  });
};

var mockDbFetchErr = function(cb) {
  setImmediate(function() {
    cb('DB AINT COOL RIGHT NOW');
  });
};

var mockDbFetchHang = function(cb) {
   // basically never call cb :)
};

describe('Stash', function() {
  var stash = Stash();
  var redis = stash.redis;

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
  });

  describe('delete', function() {
    before(function(done) {
      stash.objectCache.lru.has('test').should.equal(true);
      redis.exists('test', function(err, exists) {
        exists.should.equal(1);

        stash.del('test', done);
      })
    });

    it('should remove from lru', function() {
      stash.objectCache.lru.has('test').should.equal(false);
    });

    it('should remove from redis', function(done) {
      redis.exists('test', function(err, exists) {
        exists.should.equal(0);

        done(err);
      });
    });
  });

  describe('during cache issues', function(done) {
    var stash = Stash({
      wait: {
        redis: false
      }
    });

    before(function(done) {
      stash.redis.end();
      done();
    });

    it('gives error when getting a key', function(done) {
      stash.get('blah', mockDbFetch, function(err, data){
        err.should.equal('redis unavailable');
        done();
      });
    });

    it('gives error when deleting a key', function(done) {
      stash.del('blah', function(err, data){
        err.should.equal('redis unavailable');
        done();
      });
    });
  });

  describe('during db issues', function(done) {
    var stash = Stash();
    var dbErr;

    it('db error is cached in lru', function(done) {
      stash.get('blah1', mockDbFetchErr, function(err, data){
        should.exist(err);

        (stash.objectCache.errLru.has('blah1')).should.equal(true);

        done();
      });
    });

    it('if db hangs curtail query and cache error in lru', function(done) {
      var stash = Stash({
        timeout: {
          dbFetch: 1
        },
        wait: {
          redis: true
        }
      });

      stash.get('fetchHang', mockDbFetchHang, function(err, data){
        should.exist(err);

        (stash.objectCache.errLru.has('fetchHang')).should.equal(true);

        done();
      });
    });
  });


  describe('concurrency', function() {
    var stash = Stash();
    var redis = stash.redis;
    var warlock = Warlock(redis);

    it('sets lock when db fetching', function(done){
      stash.get('sheep', function(cb){
        warlock.lock('sheep', stash.conf.ttl.fetchLock, function(err, unlock){
          should.not.exist(err);

          (!!unlock).should.equal(false);
          cb();
          done();
        })
      }, function() {});
    });

    it('stops retrying if locked and retry limit reached', function(done) {

      var stash2 = Stash({
        retryLimit: 0,
        timeout: {
          retry: 1
        }
      });

      stash.get('retryLimit', function(cb) { }, function(){});

      stash2.get('retryLimit', function(cb){ }, function(err){
        err.should.equal('retry limit reached');
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
        }, next)
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
        instances.push(Stash({
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
    var stash = Stash();
    var redis = stash.redis;

    var stash2 = Stash();

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
            stash2.objectCache.lru.has('pizza').should.equal(true);

            return done(err);
          });
        });
      });
    });

    it('should invalidate local cache for all instances', function(done) {
      stash2.broadcast.once('message', function(){
        stash2.objectCache.lru.has('pizza').should.equal(false);

        return done();
      });
      stash.invalidate('pizza');
    });
  });
});
