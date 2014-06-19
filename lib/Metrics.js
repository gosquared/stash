var Metrics = function() {
  this.counters = {};
};

Metrics.prototype.increment = function(key, inc) {
  if (typeof this.counters[key] === 'undefined') this.counters[key] = inc;
  else this.counters[key] += inc;
};

var createMetrics = function() {
  return new Metrics();
};

module.exports = createMetrics;
