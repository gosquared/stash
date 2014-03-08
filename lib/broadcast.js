var Anchorman = require('node-anchorman');
var debug     = require('debug')('stash');

module.exports = function(objectCache, opts) {

  var log = opts.log || debug;
  var anchorman = Anchorman(opts || {});

  var ignore = function(name) {
    return log('broadcast:'+name+':ignored message');
  };

  var invalidateStash = function(name, payload) {
    if (name !== 'invalidateStash') return ignore();
    if (typeof payload !== 'object') return ignore();

    var key = payload.key;
    if (typeof key !== 'string') return ignore();

    log('broadcast:invalidation');
    objectCache.del(key);
  };

  anchorman.on('message', invalidateStash);

  return anchorman;
}
