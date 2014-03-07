var Anchorman = require('anchorman');

module.exports = function(cache, opts) {

  var anchorman = Anchorman(opts || {});

  anchorman.on('message', function(name, payload) {
    if (typeof payload !== 'object') return log('invalidateStash:ignored message');

    var key = payload.key;
    if (typeof key !== 'string') return log('invalidateStash:ignored message');

    cache.del(key);
  });
}
