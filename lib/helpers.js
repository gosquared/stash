var helpers = module.exports = {};

helpers.timed = function(timeLimit, cb) {
  var complete, timer;

  cb = cb || function(){};

  timer = setTimeout(function() {
    if (complete) return;
    complete = true;
    return cb(new Error('timeout'));
  }, timeLimit);

  return function() {
    if (timer) clearTimeout(timer);
    if (complete) return;
    complete = true;

    return cb.apply(null, arguments);
  };

};
