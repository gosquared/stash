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

  describe('when cache unavailable', function(done) {
    before(function(done) {
      stash.redis.end();
      done();
    });

    it('bypasses cache when fetching', function(done) {
      stash.get('blah', mockDbFetch, function(err, data){
        should.not.exist(err);
        should.exist(data);

        data.test.should.equal(1);
        done();
      });
    });
  });

  describe('when db unavailable', function(done) {
    var stash = Stash();

    before(function(done) {
      stash.redis.end();

      stash.get('blah1', mockDbFetchErr, function(err, data){
        should.exist(err);

        done();
      });
    })

    it('caches error in lru', function() {
      (!!stash.objectCache.errLru.peek('blah1')).should.equal(true);
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

    it('many gets on uncached key result in only one db fetch', function(done) {
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

            return done(err);
          });
        });
      });
    });

    it('delete should invalidate local cache for all instances', function(done) {
      stash.del('pizza', function(err){
        should.not.exist(stash2.objectCache.get('pizza'));

        return done(err);
      });
    });
  });
});
