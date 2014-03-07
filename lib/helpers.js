var helpers = module.exports = {};

helpers.timed = function(timeLimit, cb) {
  var tooLate, timer;

  cb = cb || function(){}

  timer = setTimeout(function() {
    tooLate = true;
    return cb('timeout');
  }, timeLimit);

  return function() {
    if (timer) clearTimeout(timer);
    if (tooLate) return;

    return cb.apply(null, arguments);
  };

};
