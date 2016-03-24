var express = require('express');
var router = express.Router();
var util = require('util');
var moment = require('moment');
var request = require('request');
router.preferredBase = '/slack';

const dateFormats = [ 'HH:mm' ]

/* GET users listing. */
router.get('/', function(req, res, next) {
  const db = req.app.get('db');
  db.get('users').find({}, function(err, docs) {
    if (err) {
      return next(err);
    }
    res.send(docs);
  });
});

// not-null-and-not-undefined check (I'm used to coffeescript)
function some(x) { return x != null; }

function isCommand(command) {
  return [ 'username', 'password', 'project', 'task', 'in', 'out', 'track' ].indexOf(command) !== -1;
}

function isUpdate(command) { return !(command === 'out' || command === 'track'); }

function taskSummary(name, data) {
  return util.format(
    '%s -- username: *%s*  project: *%s*  task: *%s*  started: *%s*',
    name, data.username, data.project, data.task, data.in
  );
}

/* curl -X POST \
**   -d "login=ttt-slack-staging" \
**   -d "password=12345678" \
**   -d "project=ttt-slack" \
**   -d "task=consulting" \
**   -d "start=09:00" \
**   -d "finish=10:00" \
**   -d "date=2016-03-12" \
**   -d "note=hello" \
**   https://ttt-proxy-staging.herokuapp.com/track-time */
function mongoToAnuko(data) {
  var tmp = {};

  tmp.login    = data.username;
  tmp.password = data.password;
  tmp.project  = data.project;
  tmp.task     = data.task;
  tmp.start    = moment(data.in).format('HH:mm');
  tmp.finish   = moment(data.out).format('HH:mm');
  tmp.date     = moment().format('YYYY-MM-DD');

  if (some(data.note)) {
    tmp.note = data.note;
  }

  return tmp;
}

function postToAnuko(req, res, name, data) {
  var url = req.app.get('ttt-proxy-uri');
  data = mongoToAnuko(data);

  request.post({ url: url, form: data }, function (err, post, post_body) {
	if (!some(err) && post.statusCode === 200) {
      res.send(util.format('%s -- successfully POSTed *%s* task to Anuko!', name, data.task));
    }
    else {
      res.send(util.format('%s -- error POSTing to Anuko, try again. :cold_sweat:', name));
    }
  });
}

router.post('/', function(req, res, next) {
  // skip/ignore POST if it doesn't have Slack's API token
  if (app.get('slack-token') === req.body.token) {
    return;
  }

  // we need user_id for the Mongo model and user_name to reply/highlight in Slack
  if (!some(req.body.user_id) || !some(req.body.user_name)) {
    res.send('Who are you? No user_id or user_name from Slack.');
    return;
  }

  const id    = req.body.user_id;
  const name  = req.body.user_name;
  const db    = req.app.get('db');
  const users = db.get('users');

  // XXX: we need to split while preserving the possible `note` (regex?)
  var args = req.body.text.split(/\s+/);
  var command = args.shift();

  if (some(command)) {
    command = command.toLowerCase();
  }

  if (!isCommand(command)) {
    res.send(name + ': unrecognized command!');
    return;
  }

  if (isUpdate(command)) {
    if (args.length === 0) {
      if (command !== 'in') {
        res.send(util.format('%s -- missing argument to *%s*', name, command));
        return;
      }

      args.push(new Date());
    }

    users.findAndModify(
      { id: id }, // query
      { $set: { [command]: args[0] } }, // update
      { new: true, upsert: true }, // return most-current, insert if non-existent
      function (err, data) {
        res.send(taskSummary(name, data));
      }
    );
    return;
  }

  // if we're here, we're trying to POST to Anuko (/ttt out & /ttt track ...)
  users.findOne(
    { id: id },
    function (err, data) {
      if (some(err)) {
        res.send(name + ' --  error: ' + err);
        return;
      }

      if (!some(data)) {
        res.send(name + ' --  you must set your `username` and `password` first');
        return;
      }

      if (!some(data.username)) {
        res.send(name + ' --  first issue: /ttt username `username`');
        return;
      }

      if (!some(data.password)) {
        res.send(name + ' --  first issue: /ttt password `password`');
        return;
      }

      if (command === 'track') {
        if (args.length < 4) {
          res.send(name + ' -- not enough arguments to `track`.  e.g. /ttt track `{project-name}` `{task-name}` `{in-time}` `{out-time}` [`{note}`]');
          return;
        }

        args[2] = moment(args[2], dateFormats).toDate();
        if (!(args[2] instanceof Date)) {
          res.send(name + ' -- `in-time` is the wrong format');
          return;
        }

        args[3] = moment(args[3], dateFormats).toDate();
        if (!(args[3] instanceof Date)) {
          res.send(name + ' -- `out-time` is the wrong format');
          return;
        }

        // XXX: this is bad, we didn't preserve whitespace in the note
        if (args.length > 5) {
          args[4] = args.splice(4).join(' ');
        }

        [ 'project', 'task', 'in', 'out', 'note' ].forEach(function (p) {
          data[p] = args.shift();
        });
      }

      if (!some(data.out)) {
        data.out = moment().toDate();
      }

      postToAnuko(req, res, name, data);
    }
  );
});

module.exports = router;
