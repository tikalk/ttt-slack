var assert = require('assert');
var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');

var routeIndex = require('./routes/index');
var routeSlack = require('./routes/slack');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// uncomment after placing your favicon in /public
//app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(routeIndex.preferredBase, routeIndex);
app.use(routeSlack.preferredBase, routeSlack);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: {}
  });
});

// setup mongodb/monk
app.set('dbURI', process.env.MONGOLAB_URI || 'localhost:27017/ttt-slack');
app.set('db', require('monk')(app.get('dbURI')));

// post to the anuko proxy
assert(process.env.TTT_PROXY_URI != null, 'must set TTT_PROXY_URI in the environment');
app.set('ttt-proxy-uri', process.env.TTT_PROXY_URI);

// configure the slack token
assert(process.env.SLACK_TOKEN != null, 'must set SLACK_TOKEN in the environment');
app.set('slack-token', process.env.SLACK_TOKEN);

module.exports = app;
