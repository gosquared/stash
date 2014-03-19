stash
=====

Distributed cache using Redis and in-memory LRU.

Requires Redis >= v2.6.0

### Usage

```javascript

var Stash = require('node-stash');

var stash = Stash();

var fetch = function(cb) {
  // Fetch data from somewhere
  var data = { some: 'stuff' };
  // If there was an error fetching stuff it'd go in the err argument
  var err = null;

  // Invoke cb to give stash an error and data.
  // If error, stash will cache in lru for a short time
  // Data is cached in redis and lru
  return cb(err, data);
};

stash.get('key', fetch, function(err, data) {
  // err is present if there was a problem somewhere along the line
  // data could be fresh from db or from cache
});

```
